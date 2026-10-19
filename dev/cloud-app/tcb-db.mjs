// CloudBase NoSQL 版的 db 适配器（2026-10-18，主理人拍板「建在这个 env 上」后起）。
//
// 与 `functions/db.mjs`（Supabase 版）是**同一接口**：handler／协调器（fence CAS）／成本账本
// 三个消费者分不出背后是哪一家——R35 那条「注入面漂移」的纪律，在这里是同义反复。
// 错误码沿用 db.mjs 的 DbError（import 同一个类，不新造一套码表）。
//
// 两处条件写在 NoSQL 里的落地方式：把期望值并进 where，靠 update 返回的 `updated` 计数判成败
// （0 行＝没匹配上）——与 Supabase 版「WHERE 里带条件、看命中行数」是同一条语义，不是新发明的招。
//   · 任务条件写（R107）：where 带 `updated_at = 期望值` ⇒ 别人的改写插队时这一次写不中；
//   · fence CAS（coordinator）：where 带 `record.fence = 期望值`（点路径，文档库原生支持）。
//
// 集合名带 `jyj_` 前缀：这个 env 里住着 med-assistant／吉小农／codeguard 等好几个应用
// （documents/chunks/codes/feedback… 都在这儿），前缀把归属写清楚，也防将来者撞名。
import { DbError } from "../../functions/db.mjs";

const T = { tasks: "jyj_tasks", docFiles: "jyj_doc_files", jobs: "jyj_extract_jobs", res: "jyj_ai_resources" };

const pick = (row, fields) => {
  if (!row) return null;
  const out = {};
  for (const f of fields) out[f] = row[f] ?? null;
  return out;
};

export function makeDbTcb(app) {
  if (!app || typeof app.database !== "function") throw new Error("tcb_app_missing_database");
  const db = app.database();
  const _ = db.command;
  // 读路径的兜底码与 db.mjs 对齐：查不动＝read_rejected，写不动＝write_rejected，其余 db_unavailable
  const read = (p, code = "read_rejected") => p.catch(() => { throw new DbError(code); });
  const write = (p, code = "write_rejected") => p.catch(() => { throw new DbError(code); });

  const dbTcb = {
    // ---------- 任务 ----------
    async listTasks(ownerId) {
      const r = await read(db.collection(T.tasks).where({ owner_id: ownerId }).orderBy("updated_at", "desc").limit(50).get());
      return (r.data ?? []).map((row) => pick(row, ["id", "payload", "updated_at"]));
    },
    async getTask(id, ownerId) {
      const r = await read(db.collection(T.tasks).where({ id, owner_id: ownerId }).limit(1).get());
      return pick(r.data?.[0], ["id", "payload", "updated_at"]);
    },
    async insertTask(row) {
      await write(db.collection(T.tasks).add(row));
    },
    async updateTask(id, ownerId, patch, expectedUpdatedAt) {
      const where = { id, owner_id: ownerId };
      // R107：期望值进 where——「读之后、写之前」被人插队时，这一发写不中（0 行），
      // 由调用方按语境改判 409；不并发时它与普通更新无差别。
      if (typeof expectedUpdatedAt === "string" && expectedUpdatedAt) where.updated_at = expectedUpdatedAt;
      const r = await write(db.collection(T.tasks).where(where).update({ ...patch, updated_at: new Date().toISOString() }));
      if (!r.updated) throw new DbError("not_found", 404);
    },
    async deleteTask(id, ownerId) {
      await write(db.collection(T.tasks).where({ id, owner_id: ownerId }).remove());
    },

    // ---------- 资料原件 ----------
    async insertDoc(row) {
      await write(db.collection(T.docFiles).add(row));
    },
    async getDoc(id, ownerId) {
      const r = await read(db.collection(T.docFiles).where({ id, owner_id: ownerId }).limit(1).get());
      return pick(r.data?.[0], ["id", "owner_id", "task_id", "object_path", "name", "mime", "size", "state", "created_at"]);
    },
    async listDocsByTask(taskId, ownerId) {
      const r = await read(db.collection(T.docFiles).where({ task_id: taskId, owner_id: ownerId }).limit(200).get());
      return (r.data ?? []).map((row) => pick(row, ["id", "object_path"]));
    },
    async markDocStored(id, ownerId, size) {
      // 条件写：只认 pending→stored 这一跳；已经被并发完成过 ⇒ 0 行 ⇒ not_found（与 Supabase 版同义）
      const r = await write(db.collection(T.docFiles).where({ id, owner_id: ownerId, state: "pending" }).update({ state: "stored", size }));
      if (!r.updated) throw new DbError("not_found", 404);
    },
    async deleteDoc(id, ownerId) {
      await write(db.collection(T.docFiles).where({ id, owner_id: ownerId }).remove());
    },
    async deleteDocsByTask(taskId, ownerId) {
      await write(db.collection(T.docFiles).where({ task_id: taskId, owner_id: ownerId }).remove());
    },

    // ---------- 识别作业 ----------
    async insertJob(row) {
      await write(db.collection(T.jobs).add(row));
    },
    // 配额用：某 owner 自某时刻起的作业数。上限远小于单次返回行数，真被撑爆也只会多算不少算。
    async countJobsSince(ownerId, isoStart) {
      const r = await read(db.collection(T.jobs).where({ owner_id: ownerId, created_at: _.gte(isoStart) }).count());
      return Number(r.total ?? 0);
    },
    async getJob(id, ownerId) {
      const r = await read(db.collection(T.jobs).where({ id, owner_id: ownerId }).limit(1).get());
      return pick(r.data?.[0], ["id", "owner_id", "task_id", "doc_id", "session_id", "state", "error_code", "result", "model_id", "created_at", "updated_at"]);
    },
    async updateJob(id, ownerId, patch) {
      // 与 Supabase 版一致：0 行不抛（失败状态回写允许行已不在的场景，由调用方决定）
      await write(db.collection(T.jobs).where({ id, owner_id: ownerId }).update({ ...patch, updated_at: new Date().toISOString() }));
    },

    // ---------- KV＋fence（成本账本与协调器共用这一张表） ----------
    async resGet(key) {
      const r = await read(db.collection(T.res).where({ scope_key: key }).limit(1).get());
      return r.data?.[0]?.record ?? null;
    },
    async resList() {
      const r = await read(db.collection(T.res).limit(200).get());
      return (r.data ?? []).map((row) => pick(row, ["scope_key", "record"]));
    },
    async resDelete(key) {
      await write(db.collection(T.res).where({ scope_key: key }).remove());
    },
    async resInsert(key, record) {
      if ((await dbTcb.resGet(key)) !== null) return false;
      const r = await write(db.collection(T.res).add({ scope_key: key, record, updated_at: new Date().toISOString() }));
      return Boolean(r.inserted ?? r.ids?.length ?? r.id);
    },
    async resCas(key, expectedFence, record) {
      // 点路径进 where：`record.fence = 期望值`。0 行＝这期间别人赢了她那一局，调用方重读重试。
      const r = await write(db.collection(T.res).where({ scope_key: key, "record.fence": expectedFence }).update({ record, updated_at: new Date().toISOString() }));
      return Boolean(r.updated);
    },

    // ---------- cloud-llm 的直连续写（按 id，不带 owner） ----------
    // 这两个**不是** handler 用的路径（那边一律走上面带 owner 的方法），是
    // `makeJobsSupabaseShim` 的落点：cloud-llm.mjs 自己直连读写 extract_jobs
    // （persist／read 两处）。拆出来并注释，是为了让「谁在绕过 owner 作用域」只有这一处、且有名有姓。
    async getJobById(id) {
      const r = await read(db.collection(T.jobs).where({ id }).limit(1).get());
      return pick(r.data?.[0], ["id", "state", "result", "model_id", "created_at", "owner_id"]);
    },
    async updateJobById(id, patch) {
      await write(db.collection(T.jobs).where({ id }).update({ ...patch, updated_at: new Date().toISOString() }));
    },
  };
  return dbTcb;
}

/**
 * cloud-llm.mjs 除了注入的 `chat`，还有一处**直连 supabase**：它自己拿
 * `.from("extract_jobs").update/select…maybeSingle()` 读写作业行（见 cloud-llm.mjs:65-82）。
 * 这给它造一个只覆盖这两处调用形状的小面，桥到上面的 dbTcb——**不是第二套查询语言**。
 * 换表／换列直接抛：那意味着 cloud-llm 改了接缝，必须显式决定，不许静默兜底。
 */
export function makeJobsSupabaseShim(dbTcb) {
  const chain = (state) => {
    const q = {
      select: () => q,
      eq: (col, val) => {
        if (col !== "id") throw new Error(`tcb_jobs_shim_unexpected_column:${col}`);
        state.id = val;
        return q;
      },
      update: (patch) => { state.patch = patch; return q; },
      maybeSingle: async () => {
        if (state.patch) {
          await dbTcb.updateJobById(state.id, state.patch);
          return { data: { id: state.id }, error: null };
        }
        return { data: await dbTcb.getJobById(state.id), error: null };
      },
    };
    return q;
  };
  return {
    from(table) {
      if (table !== "extract_jobs") throw new Error(`tcb_jobs_shim_unexpected_table:${table}`);
      return chain({});
    },
  };
}
