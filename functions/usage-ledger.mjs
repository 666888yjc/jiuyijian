// 成本可观测：把每次识别的 credit / token / 耗时 / 结果分类累加成"一天一行"的汇总。
//
// 为什么落在 ai_resources 而不是 extract_jobs：
//   · jobs 表没有用量列，而本循环**不跑数据库迁移**（也不该为一张统计表去改结构）；
//   · ai_resources 是既有 KV + fence CAS，天生适合"多个实例各自累加同一行"；
//   · 键与值里都只有数字、模型名与错误码，**没有任何病历内容**（隐私纪律优先于便利性）。
//
// 观测失败绝不影响业务：整个函数吞掉一切异常，只 console.warn 一个不含内容的短串。
const ALLOWED = ["event", "model", "ms", "finishReason", "reasoningChars", "credit", "totalTokens", "promptTokens", "completionTokens", "ok", "code"];

const today = () => new Date().toISOString().slice(0, 10);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** 只留白名单里的可计量字段——将来有人往事件里塞正文也不会进账本（jobId 也不留，它能关联到人） */
export function sanitizeUsage(event) {
  const out = {};
  for (const k of ALLOWED) if (event?.[k] !== undefined) out[k] = event[k];
  if (typeof out.model === "string") out.model = out.model.slice(0, 40);
  if (typeof out.finishReason === "string") out.finishReason = out.finishReason.slice(0, 20);
  // 错误码形如 ai_truncated@length；其它字符一律截掉，防止将来有人把消息塞进来
  if (typeof out.code === "string") out.code = out.code.replace(/[^a-z0-9_:@-]/gi, "").slice(0, 40);
  return out;
}

export function makeUsageLedger({ db, now = today, retries = 3 }) {
  const keyFor = () => `usage:extract:${now().slice(0, 10)}`;

  return async function recordUsage(event) {
    let db_;
    try {
      db_ = sanitizeUsage(event);
      const key = keyFor();
      for (let attempt = 0; attempt < retries; attempt += 1) {
        const cur = await db.resGet(key);
        const base = cur && typeof cur === "object" && cur.data ? cur.data : null;
        const next = merge(base, db_);
        if (!cur) {
          const created = await db.resInsert(key, { fence: newFence(), data: next });
          if (created) return next; // 别的实例抢先插了也行：下一轮重读再累加
          continue;
        }
        const won = await db.resCas(key, cur.fence, { fence: cur.fence, data: next });
        if (won) return next;
      }
      console.warn("usage_ledger_cas_exhausted");
      return null;
    } catch {
      console.warn("usage_ledger_failed");
      return null;
    }
  };
}

function merge(base, e) {
  const d = base ?? {
    calls: 0, ok: 0, failed: 0, credit: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0,
    reasoningChars: 0, sumMs: 0, maxMs: 0, byModel: {}, byFinish: {}, byCode: {}, updatedAt: null,
  };
  const out = { ...d, byModel: { ...(d.byModel ?? {}) }, byFinish: { ...(d.byFinish ?? {}) } };
  const model = typeof e.model === "string" && e.model ? e.model : "unknown";
  const ms = num(e.ms);
  out.calls += 1;
  if (e.ok === false) out.failed += 1;
  else out.ok += 1;
  out.credit = round2(num(out.credit) + num(e.credit));
  out.promptTokens += num(e.promptTokens);
  out.completionTokens += num(e.completionTokens);
  out.totalTokens += num(e.totalTokens);
  out.reasoningChars += num(e.reasoningChars);
  out.sumMs += ms;
  out.maxMs = Math.max(num(out.maxMs), ms);
  const m = out.byModel[model] ?? { calls: 0, credit: 0, sumMs: 0, maxMs: 0 };
  out.byModel[model] = {
    calls: num(m.calls) + 1,
    credit: round2(num(m.credit) + num(e.credit)),
    sumMs: num(m.sumMs) + ms,
    maxMs: Math.max(num(m.maxMs), ms),
  };
  if (typeof e.finishReason === "string" && e.finishReason) {
    out.byFinish[e.finishReason] = num(out.byFinish[e.finishReason]) + 1;
  }
  if (typeof e.code === "string" && e.code) {
    out.byCode = { ...(d.byCode ?? {}) };
    out.byCode[e.code] = num(out.byCode[e.code]) + 1;
  }
  out.updatedAt = new Date().toISOString();
  return out;
}

const round2 = (v) => Math.round(v * 100) / 100;
const newFence = () => (globalThis.crypto?.randomUUID?.() ?? `f${Date.now()}${Math.random().toString(16).slice(2)}`);

export const USAGE_KEY_PREFIX = "usage:extract:";
export const usageKeyFor = (day) => `${USAGE_KEY_PREFIX}${day}`;
