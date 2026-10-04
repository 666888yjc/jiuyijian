// 抽取适配器的**唯一**装配点：生产入口（index.ts）与本地夹具（dev/api-fixture/server.mjs）共用这一份。
//
// 为什么要收成一份：R35 发现夹具的 `onUsage` 只写自己的数组、没接产品成本账本 ⇒ 成本可观测在
// 300+ 条链路断言之下从来没被链路级验过（只有 A 组用假 db 验过）。这类"注入面漂移"不会让任何
// 一条断言变红，它只是悄悄让"绿"失去含义。装配代码只有一份以后，差异只能通过**显式传参**表达
// （换 transport、换 origin、换超时），没法再靠"少传一个键"漂移。
//
// 红线不变：cloud-agents 的 https 强校验、凭据只从环境变量来，都不在这个文件里放宽。
import { makeQcaExtractionAdapter } from "./extraction.mjs";
import { makeCloudLlmExtractionAdapter } from "./cloud-llm.mjs";

/** 通路选择：默认 llm（QCA 端点自 2026-09-19 不可达）；qca 是显式回退开关，不是死代码 */
export function pickExtractAdapter(envValue, fallback = "llm") {
  const v = String(envValue ?? "").trim().toLowerCase();
  if (v === "qca" || v === "llm") return v;
  return fallback;
}

/**
 * @param which     "llm" | "qca"
 * @param llmChat   cloud-llm 的传输实现（生产=裸 fetch SSE；夹具=假服务）
 * @param ledgerFor (ctx) => onUsage | undefined —— 成本账本的唯一接入口，两边都必须传
 * @param qca/llm   各适配器的额外构造参数（origin/fetchImpl/timeoutMs 等）
 */
export function makeExtractFactory({ which, llmChat, ledgerFor, qca = {}, llm = {} }) {
  const kind = pickExtractAdapter(which, "llm");
  return ({ supabase, db, coordinator }) => {
    const onUsage = ledgerFor ? ledgerFor({ supabase, db, coordinator }) : undefined;
    if (!onUsage) throw new Error("extract_wiring_missing_ledger");
    return kind === "qca"
      ? makeQcaExtractionAdapter({ coordinator, onUsage, ...qca })
      : makeCloudLlmExtractionAdapter({ supabase, chat: llmChat, onUsage, ...llm });
  };
}
