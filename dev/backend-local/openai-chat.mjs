// 通用 OpenAI 兼容 chat/completions 传输层（本机识别链路用，R123）。
//
// 为什么不直接复用 `functions/cloud-llm-http.mjs`：那份锁死了两件事——路径写死 `/.cloud/llm/chat/completions`、
// 鉴权头写死 `x-wb-webapp-access-key`，而那两者都属于**已经退出的那一家**。本机链路的目的是"家属电脑上
// 指向哪一家由主理人自己定"，所以这里只保留产品真正依赖的那一份契约：
//   · 请求体由上游 adapter 组好（`stream:true`、`messages`、`stream_options.include_usage`），
//     本文件只做传输，不碰提示词、不碰医疗正文的语义；
//   · 回的是 SSE，`choices[0].delta.content` / `finish_reason` / `usage` 三个字段形状不变——
//     所以上游 `collectStream`、`parseAgentJson`、`normalizeResult` 与零判断闸门
//     （`isUngroundedVerdict`）一行都不用改，越界句子照样被拦。
// 凭据只从入参来（调用方从环境变量读），本文件不打印、不写盘、也不把它放进任何错误对象。
import { CloudAgentsError } from "../../functions/cloud-agents.mjs";
// 回环名单只用产品那一份（R140 把"两处判定就可能一处放宽一处没放宽"钉成了判据；这一家多一份 Set 就是第三处）
import { isLoopbackHost } from "../../functions/cloud-llm-http.mjs";

/**
 * 端点校验与产品同一条口径：**必须 https**，只有回环例外（给本机假服务/自建代理用）。
 * 错误码沿用产品既有那几个（`llm_endpoint_invalid`／`llm_endpoint_not_https`），
 * 这样 `src/errorCopy.ts` 里的人话不用新增句子，界面上也不会出现没人解释过的新码。
 */
export function assertModelEndpoint(endpoint) {
  let url;
  try {
    url = new URL(String(endpoint ?? ""));
  } catch {
    throw new CloudAgentsError("llm_endpoint_invalid", 503, "not_sent");
  }
  if (!url.hostname) {
    const error = new CloudAgentsError("llm_endpoint_invalid", 503, "not_sent");
    error.phase = "config";
    throw error;
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
    const error = new CloudAgentsError("llm_endpoint_not_https", 503, "not_sent");
    error.phase = "config";
    throw error;
  }
  return url;
}

const sseError = (message, outcome = "sent") => {
  const error = new CloudAgentsError("ai_service_unavailable", 503, outcome);
  error.phase = "stream";
  error.localDetail = message;
  return error;
};

/** 把一段 SSE 文本切成事件（按空行分帧，只认 `data:` 行） */
function* parseSseText(text) {
  for (const frame of text.split(/\r?\n\r?\n/)) {
    const dataLines = frame.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
    if (!dataLines.length) continue;
    const payload = dataLines.join("\n");
    if (!payload || payload === "[DONE]") return;
    try {
      yield JSON.parse(payload);
    } catch {
      // 单帧解析不了就跳过：产品上游对"整段没解析出 JSON"另有闸门（ai_truncated@parse / ai_refused），
      // 在这里抛会把一个可恢复的毛刺放大成整次识别失败。
    }
  }
}

/**
 * @param {{ endpoint: string, key?: string, authStyle?: "bearer"|"wb", timeoutMs?: number, fetchImpl?: typeof fetch }} options
 * @returns {(body: object) => Promise<AsyncIterable<object>>} 与 `makeCloudLlmExtractionAdapter({ chat })` 的接缝同形
 */
export function makeOpenAiCompatChat({ endpoint, key = "", authStyle = "bearer", timeoutMs = 60_000, fetchImpl = globalThis.fetch } = {}) {
  // R144：栅栏**不在构造那一刻抛**（与产品 `makeCloudLlmChat` 在 R115 修的同一格）。
  // 之前这里一构造就 assert，配错协议/空端点的调用方连 `probe()` 都拿不到——而 `probe` 存在的目的正是
  // 「配错了也要说得出配错的是哪一种形状」。真发请求时照旧拒（下面 `const url = assertModelEndpoint(endpoint)`），
  // 本机服务器那一侧仍然\"配置不对就不起\"（它自己先调了一遍 assert），这条主张没被削弱。
  let endpointUrl = null;
  try {
    endpointUrl = assertModelEndpoint(endpoint);
  } catch { endpointUrl = null; }
  const chat = async (body) => {
    const url = endpointUrl ?? assertModelEndpoint(endpoint);
    if (!String(key).trim()) {
      const error = new CloudAgentsError("llm_key_missing", 503, "not_sent");
      error.phase = "config";
      throw error;
    }
    const headers = { "content-type": "application/json", accept: "text/event-stream" };
    if (authStyle === "wb") headers["x-wb-webapp-access-key"] = String(key);
    else headers.authorization = `Bearer ${String(key)}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer?.unref?.();
    let response;
    try {
      response = await fetchImpl(url.href, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...body, stream: true }),
        signal: controller.signal,
      });
    } catch (error) {
      // 请求已经发出去了才知道失败（连接断、被 abort）⇒ 结果未知，不能对家属承诺"资料没丢、没开始"。
      throw sseError(`fetch:${error?.name ?? error?.message ?? "failed"}`, "unknown");
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw sseError(`http:${response.status}`);

    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      // 有的兼容端点无视 `stream:true`，直接回整份 JSON。照样喂给上游同一套解析（delta 换成 message）。
      const json = await response.json().catch(() => null);
      const chunks = json ? [json] : [];
      return (async function* () { for (const chunk of chunks) yield chunk; })();
    }
    if (!response.body) throw sseError("empty_body");

    const decoder = new TextDecoder();
    return (async function* () {
      let buffer = "";
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let cut;
          while ((cut = buffer.search(/\r?\n\r?\n/)) >= 0) {
            const frame = buffer.slice(0, cut);
            buffer = buffer.slice(cut).replace(/^\r?\n\r?\n/, "");
            for (const chunk of parseSseText(frame + "\n\n")) yield chunk;
          }
        }
        for (const chunk of parseSseText(buffer)) yield chunk;
      } catch (error) {
        throw sseError(`stream:${error?.name ?? "interrupted"}`, "unknown");
      } finally {
        reader.releaseLock?.();
      }
    })();
  };
  /**
   * 本机这条通路的自检读数（R144）：与产品那份 `makeCloudLlmChat` 的 `chat.probe` **同一个形状**，
   * 因为 `functions/cloud-llm.mjs` 的 `ping()` 只认这一种接缝——少一格就会退成 `llm_probe_missing`，
   * 主理人在自己电脑上照样答不出\"配没配上\"那一半。
   *
   * 零外发：一个字节都不发、不落库、不建作业；只报**形状**不报值（端点原文与 key 本体都不许进读数，
   * 它会回到浏览器也会进证据件），栅栏用的就是本文件那一条 `assertModelEndpoint`（不另起第二份判定）。
   */
  chat.probe = () => {
    const raw = String(endpoint ?? "");
    const keyText = String(key ?? "");
    const keyShape = { configured: keyText !== "", length: keyText.length };
    let shape = { configured: raw !== "", protocol: null, loopback: null, hostChars: 0 };
    try {
      const parsed = new URL(raw);
      shape = {
        configured: true,
        protocol: parsed.protocol.replace(/:$/, ""),
        loopback: isLoopbackHost(parsed.hostname),
        hostChars: parsed.hostname.length,
      };
    } catch { /* 解析不了就是 protocol=null，下面那道栅栏会给出 llm_endpoint_invalid */ }
    try {
      assertModelEndpoint(raw);
    } catch (error) {
      // 两份传输层的 CloudAgentsError **构造位置不一样**：产品那份把成因名放在 outcome（第三个实参），
      // 这一份放在 code、outcome 是 not_sent。取\"有信息量的那一个\"，两条通路才能对同一个错配给同一个读数
      // （否则本机通路上\"配错协议\"与\"配错主机\"又塌成同一句，正是 R140 打掉的形状）。
      const diagnostic = error?.outcome && error.outcome !== "not_sent" ? error.outcome : (error?.code ?? "llm_endpoint_invalid");
      return { ok: false, outcome: diagnostic, endpoint: shape, key: keyShape, model: null };
    }
    if (keyText === "") return { ok: false, outcome: "llm_key_missing", endpoint: shape, key: keyShape, model: null };
    return { ok: true, endpoint: shape, key: keyShape, model: null };
  };
  return chat;
}
