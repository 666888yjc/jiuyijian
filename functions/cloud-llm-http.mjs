// 云服务 LLM 的**裸 HTTP 传输层**（Edge/Deno/Node 通用，不依赖任何 Node SDK）。
//
// 为什么要自己写：那家官方云 SDK 是 Node/CJS 形态的包，站点的 Edge Function 运行时带不动它。
// 契约不是猜的，是从已装好的 SDK 源码里逐处读出来的（`dev/real-samples/read-sdk-contract.mjs` 可复跑取证）：
//   · 路径   CLOUD_PATH_PREFIX="/.cloud" + CLOUD_MODULE_PATHS.llm="/llm" + "/chat/completions"
//   · 鉴权   createCloudFetch 里 PUBLISHABLE_KEY_HEADER = "x-wb-webapp-access-key"
//   · 流式   createStreaming 发 `Accept: text/event-stream`，body.stream 强制 true，SSE 以 `data: [DONE]` 收尾
//   · 中断   SDK 把"流里没有 [DONE]"当作 gateway_stream_interrupted —— 这里保持同样口径，不静默吞截断
//
// 与 `cloud-agents.mjs` 的关系：那是 QCA 通路的客户端（端点不可达，保留作平行实现），两者不混在一个工厂里。
import { CloudAgentsError } from "./cloud-agents.mjs";

export const CLOUD_LLM_PATH = "/.cloud/llm/chat/completions";
export const PUBLISHABLE_KEY_HEADER = "x-wb-webapp-access-key";

/**
 * 端点栅栏：必须是 https；只有回环地址允许 http（给本机夹具/假服务用）。
 * 与 `cloud-agents.mjs` 的 https 强校验同一口径——放宽它等于把病历正文发去明文链路。
 */
export function assertCloudLlmEndpoint(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw new CloudAgentsError("ai_service_unavailable", 503, "llm_endpoint_invalid");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new CloudAgentsError("ai_service_unavailable", 503, "llm_endpoint_not_https");
  }
  return url.origin;
}

/** SSE 帧解析：累积到空行为止，`data:` 行可能是多行；`event: error` 直接抛错；缺 `[DONE]` 判中断。 */
async function* iterateSse(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done: ended } = await reader.read();
      if (ended) break;
      buffer += decoder.decode(value, { stream: true });
      let sep = /\r?\n\r?\n/.exec(buffer);
      while (sep) {
        const rawEvent = buffer.slice(0, sep.index);
        buffer = buffer.slice(sep.index + sep[0].length);
        const frame = parseEvent(rawEvent);
        if (frame === "done") return;
        if (frame !== null) yield frame;
        sep = /\r?\n\r?\n/.exec(buffer);
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* 锁已释放 */ }
  }
  // 收尾必须 flush 残帧：真流的最后一个 `data: [DONE]` 后面常常没有空行，连接就直接结束了。
  // （SDK 的 iterSSEEvents 同样有 flush()；漏掉这一步会把一次成功的识别误判成"网关中断"。）
  if (buffer.trim()) {
    const frame = parseEvent(buffer);
    if (frame === "done") return;
    if (frame !== null) yield frame;
  }
  // 走到这里说明流结束前没见到 [DONE] ⇒ 真中断，不静默当成完整结果
  throw new CloudAgentsError("ai_service_unavailable", 503, "gateway_stream_interrupted");
}

function parseEvent(rawEvent) {
  const dataLines = [];
  let isError = false;
  for (const line of rawEvent.split(/\r?\n/)) {
    if (line.startsWith(":")) continue;                      // SSE 注释/心跳
    if (line.startsWith("event:")) isError = line.slice(7).trim() === "error";
    if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
  }
  if (!dataLines.length) return null;
  const payload = dataLines.join("\n");
  if (payload === "[DONE]") return "done";
  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new CloudAgentsError("result_invalid", 503, "llm_frame_unparseable");
  }
  if (isError) {
    throw new CloudAgentsError("ai_service_unavailable", 503, String(parsed?.error?.message ?? "llm_stream_error").slice(0, 200));
  }
  return parsed;
}

/**
 * 产出 `chat(body)` —— 正是 `makeCloudLlmExtractionAdapter({ chat })` 要的接缝。
 * @param {{ endpoint: string, publishableKey: string, model?: string, fetchImpl?: typeof fetch }} options
 */
export function makeCloudLlmChat({ endpoint, publishableKey, model, fetchImpl }) {
  // 凭据断言推迟到 chat() 真被调用那一刻：构造函数跑在部署入口的模块顶层（functions/index.ts），
  // 站点没配 JYJ_LLM_* 时这里一抛，Edge worker 就在 Deno.serve 之前死掉——同步/上传/删除/存储本来
  // 全都还能用，却被拖成全站「云端暂不可用」（09-30 的 P0）。两道栅栏一行没松，只是把失败面缩到识别。
  const doFetch = fetchImpl ?? globalThis.fetch;
  return async (body) => {
    const origin = assertCloudLlmEndpoint(endpoint);
    const key = String(publishableKey ?? "");
    if (!key) throw new CloudAgentsError("ai_service_unavailable", 503, "llm_key_missing");
    let response;
    try {
      response = await doFetch(`${origin}${CLOUD_LLM_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          [PUBLISHABLE_KEY_HEADER]: key,
        },
        // stream 恒为 true：该 API 只支持流式（SDK 里也是 createStreaming 强制 body.stream = true）
        body: JSON.stringify({ ...body, ...(model ? { model } : {}), stream: true }),
      });
    } catch {
      throw new CloudAgentsError("ai_service_unavailable", 503, "llm_transport_error");
    }
    const requestId = response.headers?.get?.("x-request-id") ?? "";
    if (!response.ok || !response.body) {
      // 状态码与 requestId 只进 outcome 摘要（审计用），绝不带正文
      throw new CloudAgentsError("ai_service_unavailable", 503, `llm_http_${response.status}${requestId ? `#${String(requestId).slice(0, 32)}` : ""}`);
    }
    return iterateSse(response.body);
  };
}
