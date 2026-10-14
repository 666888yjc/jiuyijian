// 识别失败"具体码"（`detail`）的生产端规则：字符集与长度预算。服务端一侧**只这一份**。
//
// 为什么要有这一份（2026-10-13 现读出来的两格）：
// · 界面上那句括号里的码是**原样显示**服务端给的 `detail`——`src/api.ts` 里过不了
//   `/^[a-z0-9_:@-]{1,64}$/` 就**整条丢掉**（不是截断，是丢掉）。而传输层的成因里天然带 `#`
//   （请求号的分隔符）和对岸给的任意文本 ⇒ 不在生产端先规范，R31 立"具体码要在界面上原样可见"
//   这件事就会在屏幕上无声失效，而且失效得没有任何迹象（屏幕上只是少了一截括号）。
// · 同一时刻 `cloud-llm.mjs` 把 `failure.phase` 写成常量 `"stream"`，而传输层的成因住在
//   `CloudAgentsError` 的**第三个字段 `outcome`**（`llm_key_missing`／`llm_endpoint_invalid`／
//   `llm_transport_error`／`llm_http_401#…`／`gateway_stream_interrupted`）——字段名对不上，
//   于是"没配 key""配了连不上""网关断了"三种完全不同的状况，家属和排查的人都只看到 `@stream`。
//   这条是 10-04 那一轮值守卡在门③ 时靠读源码才消歧的根因，本轮把它变成机器看得见的东西。
//
// 规则两端各有一份实现（这里管生产、`src/api.ts` 管消费），A 组 R140 段现读两边比对防漂移，
// 并把每一条真实成因喂进消费端那条**现读的正则**逐个测——不手抄字符集。
export const DETAIL_MAX = 64;

/** 只留界面吃得下的字符：小写、非 `[a-z0-9_:@-]` 一律换成 `-`、连续 `-` 收一个、两头不留分隔符。 */
export function detailTag(raw, max = DETAIL_MAX) {
  const s = String(raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_:@-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-:]+|[-:]+$/g, "");
  const cap = Math.max(8, Math.trunc(max));
  return s.length > cap ? s.slice(0, cap).replace(/[-:]+$/g, "") : s;
}

/**
 * 这次失败的**成因标签**：优先用显式 `phase`（QCA 通路给的是阶段名），
 * 否则用 `CloudAgentsError.outcome`（LLM 传输层给的是成因名）——两边字段名不同这件事本身就在塌缩的源头。
 * 预算按 `code@` 之后还剩多少算，保证拼出来的整条 `detail` 不会超界被界面整条丢掉。
 */
export function causeTag(error, code = "", fallback = "stream") {
  const phase = typeof error?.phase === "string" ? error.phase.trim() : "";
  const outcome = typeof error?.outcome === "string" ? error.outcome.trim() : "";
  const picked = phase || (outcome && outcome !== "unknown" ? outcome : "") || fallback;
  return detailTag(picked, DETAIL_MAX - `${code}@`.length);
}

/**
 * 把**已经落库的那条整串成因**（作业行的 `error_code`，形如 `ai_service_unavailable@llm_endpoint_invalid`）
 * 折成还能跟在码后面的那一截：带 `@阶段` 的取阶段——那才是排查要看的诊断核心，
 * 而码那一族在界面句子里已经说过了。整条仍按预算截断。
 * 为什么非要折：64 这个上限是消费端**整条丢掉**而不是截断（见文件头），而 `extract_retry_exhausted@`
 * 自己就占 24 格；原样堆上去会把最要紧的那个阶段名切成半截（`…_endpoint_invali`）——
 * 那不是诊断线索，那是一条看起来像编号的乱码。
 */
export function causeTail(errorCode, budget = DETAIL_MAX) {
  const s = String(errorCode ?? "").trim();
  const at = s.lastIndexOf("@");
  return detailTag((at >= 0 ? s.slice(at + 1) : s) || s, budget);
}
