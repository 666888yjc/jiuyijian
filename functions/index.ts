import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { storage } from "./_qoder/storage.mjs";
import { serveSite } from "./adapter.mjs";
import { createHandler } from "./handler.mjs";
import { makeExtractFactory } from "./adapters.mjs";
import { makeCloudLlmChat } from "./cloud-llm-http.mjs";
import { makeUsageLedger } from "./usage-ledger.mjs";

// 抽取通道：默认走**可达的多模态 LLM 通路**（云服务 keyless API，纯 fetch，Edge 运行时带得动）。
// JYJ_EXTRACT_ADAPTER=qca 可整体回退到 Cloud Agents 通路——两条是平行实现，不共用适配器。
// 为什么默认值仍是 llm（09-30 现测之后重新判过一次）：QCA 那台 09-19 映射的主机到今天仍 TCP 不可连，
// 而 09-30 现读的运行时映射已换成 `api.qoder.com.cn`（该主机 `/api/v1/cloud/models` 回 401 TOKEN_INVALID＝服务在应答）。
// 要把默认切回 qca，需要同时在 Settings 里给 `JYJ_QCA_ORIGIN`——端点从 R115 起只从环境变量取，源码里不再抄主机名。
const EXTRACT_ADAPTER = (Deno.env.get("JYJ_EXTRACT_ADAPTER") || "llm").toLowerCase() === "qca" ? "qca" : "llm";

// ⚠ 下面几行跑在**模块顶层**：顶层任何一抛＝worker 在 `Deno.serve` 之前就死、所有 action 一起没（09-30 的 P0）。
// 新增顶层构造请按「站点没配某项可选凭据也不许抛，只让那一项功能在调用那一刻报错」写，判据见 `dev/entry-boot-check.mjs`。
// 凭据只从环境变量来（发布键本身不带权限，服务端按 Origin 校验，但仍不进源码）。
const llmChat = makeCloudLlmChat({
  endpoint: Deno.env.get("JYJ_LLM_ENDPOINT") ?? "",
  publishableKey: Deno.env.get("JYJ_LLM_PUBLISHABLE_KEY") ?? "",
  ...(Deno.env.get("JYJ_LLM_MODEL") ? { model: Deno.env.get("JYJ_LLM_MODEL") } : {}),
});

// 装配只有一份（functions/adapters.mjs），本地夹具调用同一函数 ⇒ 注入面不会各说各话。
// 成本账本在这里接上：credit/token/耗时累加进 ai_resources 的日汇总行（只有数字，无病历内容；写失败不影响识别）
// R96：`modelKind: "real"` —— 生产这份的两种通路（QCA 走平台注入的 QODER_PAT、llm 走运维配的 JYJ_LLM_ENDPOINT）
// 都是**真端点**；剧本服务（dev/fake-llm、dev/fake-ocr）不在部署面里。拿不到凭据时通路直接 fail（ai_not_configured），
// 不会带着"completed"回来，所以这里不需要、也不许用"猜"去填这一格。
const business = createHandler({
  storage,
  modelKind: "real",
  extract: makeExtractFactory({
    which: EXTRACT_ADAPTER,
    llmChat,
    ledgerFor: ({ db }: { db: never }) => makeUsageLedger({ db }),
  }),
});

Deno.serve(serveSite(business, {
  createClient,
  env: (name: string) => Deno.env.get(name),
}));
