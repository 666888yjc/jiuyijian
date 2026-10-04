// 本机查询引擎：与 `functions/db.mjs` 对话的"类 Supabase"面。
//
// 为什么单独成模块（R123）：这份实现原来只活在 `dev/api-fixture/server.mjs` 里。本机识别链路
// （`dev/local-app/server.mjs`）需要同样的查询语义才能说"线上那套业务逻辑在本机也在跑"，
// 而**再抄一份就是本项目一直在打的那类漂移**——夹具绿、真服务器上行为却不同。搬出来之后
// 两边共用这一份：夹具不落盘（缺省），本机服务器传 `onChange` 把每一笔写落到磁盘。
//
// 语义必须与 PostgREST 对齐的地方都写在注释里，改这里要同时跑夹具那两组链路断言（A2 两条通路＋B 组）。

export const TABLE_NAMES = ["tasks", "doc_files", "extract_jobs", "ai_resources"];

/** 每次开工给一份干净的表；本机服务器用 `hydrate` 从磁盘把上次的行装回来 */
export function makeEmptyTables() {
  return { tasks: [], doc_files: [], extract_jobs: [], ai_resources: [] };
}

const PK = (table) => (table === "ai_resources" ? "scope_key" : "id");

// ISO-8601（带 Z、定长）字典序＝时间序，所以 gte 用字符串比较就与真 Postgres 的 timestamptz 行为一致
const getCol = (row, key) => {
  if (key.startsWith("record->>")) return row.record?.[key.slice(9).replace(/"/g, "")];
  return row[key];
};

class Builder {
  constructor(engine, table, op, payload) {
    this.engine = engine;
    this.table = table;
    this.op = op;
    this.payload = payload;
    this.filters = [];
    this.returns = false;
    this.single = false;
    this.count = null;
  }
  eq(k, v) { this.filters.push([k, v, "eq"]); return this; }
  gte(k, v) { this.filters.push([k, v, "gte"]); return this; }
  order() { return this; }
  limit(n) { this.limitN = n; return this; }
  select(cols, opts) { this.returns = true; if (opts?.count === "exact") this.count = 0; return this; }
  single() { this.single = true; return this; }
  maybeSingle() { this.single = true; return this; }
  matchFilters(row) {
    return this.filters.every(([k, v, op]) => {
      const got = String(getCol(row, k));
      return op === "gte" ? got >= String(v) : got === String(v);
    });
  }
  then(resolve, reject) {
    return Promise.resolve(this.execute()).then(resolve, reject);
  }
  execute() {
    const rows = this.engine.tables[this.table];
    try {
      if (this.op === "insert") {
        const items = Array.isArray(this.payload) ? this.payload : [this.payload];
        const pk = PK(this.table);
        for (const item of items) {
          if (rows.some((r) => String(r[pk]) === String(item[pk]))) {
            return { data: null, error: { code: "23505", message: "duplicate key" } };
          }
        }
        rows.push(...items.map((item) => structuredClone(item)));
        this.engine.markDirty(this.table);
        const returned = items.length ? [items[items.length - 1]] : [];
        return this.returns || this.single
          ? { data: this.single ? (returned[0] ?? null) : returned, error: null }
          : { data: null, error: null };
      }
      if (this.op === "update") {
        const matches = rows.filter((r) => this.matchFilters(r));
        for (const row of matches) Object.assign(row, structuredClone(this.payload));
        if (matches.length) this.engine.markDirty(this.table);
        return this.returns || this.single
          ? { data: this.single ? (matches[0] ?? null) : matches, error: null }
          : { data: null, error: null };
      }
      if (this.op === "delete") {
        const keep = [];
        const removed = [];
        for (const row of rows) (this.matchFilters(row) ? removed : keep).push(row);
        this.engine.tables[this.table] = keep;
        rows.length = 0;
        rows.push(...keep);
        if (removed.length) this.engine.markDirty(this.table);
        return this.returns || this.single
          ? { data: this.single ? (removed[0] ?? null) : removed, error: null }
          : { data: null, error: null };
      }
      let found = rows.filter((r) => this.matchFilters(r)).map((r) => structuredClone(r));
      if (this.returns && this.count !== null) {
        const total = found.length;
        if (this.limitN) found = found.slice(0, this.limitN);
        return { data: found, count: total, error: null };
      }
      if (this.limitN) found = found.slice(0, this.limitN);
      return this.single
        ? { data: found[0] ?? null, error: null }
        : { data: this.returns ? found : null, error: null };
    } catch (error) {
      return { data: null, error: { code: "local_query_error", message: String(error?.message ?? error) } };
    }
  }
}

/**
 * @param {{ tables?: object, onChange?: (table: string) => void }} options
 * @returns {{ client: object, tables: object, markDirty: (table: string) => void }}
 */
export function makeSupabaseLite({ tables = makeEmptyTables(), onChange = null } = {}) {
  const engine = {
    tables,
    markDirty(table) {
      if (typeof onChange === "function") onChange(table);
    },
  };
  const client = {
    from(table) {
      return new Proxy(new Builder(engine, table, "select"), {
        get(target, prop) {
          if (prop === "insert") return (payload) => ((target.op = "insert"), (target.payload = payload), target);
          if (prop === "update") return (payload) => ((target.op = "update"), (target.payload = payload), target);
          if (prop === "delete") return () => ((target.op = "delete"), target);
          return target[prop]?.bind?.(target) ?? target[prop];
        },
      });
    },
  };
  return { client, tables: engine.tables, markDirty: (t) => engine.markDirty(t) };
}

/** 把磁盘上读回来的行装进一个已存在的 tables 对象（保持引用不变，引擎与持久化层看的是同一份） */
export function hydrateTables(target, loaded) {
  for (const name of TABLE_NAMES) {
    const rows = Array.isArray(loaded?.[name]) ? loaded[name] : [];
    if (target[name] === undefined) target[name] = [];
    target[name].length = 0;
    target[name].push(...rows);
  }
  return target;
}
