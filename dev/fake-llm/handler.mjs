// 假多模态 LLM 服务：OpenAI 兼容的 `POST /v1/chat/completions` SSE 流（长期回归夹具，仅本地）。
//
// 用途：让 `functions/cloud-llm.mjs` 的真实 adapter 代码**一行不改**地跑完整链路
// （评审方 F-1 的同一口径：只换模型端点，不在前端硬编码结果）。
//
// 它会主动核验请求形状，形状不对就 400 —— 于是"提示词被改动""忘了 stream""图片没带上"
// 这类事故会让断言当场转红，而不是悄悄通过：
//   · messages[0] 必须是 system；**有图**时 content 逐字等于产品的 AGENT_SYSTEM，
//     **无图**（PDF 文字层通路）时逐字等于 AGENT_SYSTEM_TEXT——两条通路各用各的尺子
//   · 必须 stream:true（真 SDK 不传就直接拒发）
//   · 有图时必须带 image_url 的 data: URL；无图时文字必须非空
// 注入开关（POST /_fake/declare 或内置名）：正常 JSON / 围栏 / 非 JSON / 拒答 / 空 / 永不回话 / 慢流 / HTTP 错误。
import { FAKE_SCENARIOS } from "../fake-ocr/handler.mjs";

// 生产真实路径。这里**故意写成字面量**，不 import 产品的 CLOUD_LLM_PATH：
// 上一版是 import 过来的，于是把产品常量改错一位，假服务和断言跟着一起变，A2 依然 278/278 全绿——
// 那就是"绿着什么都没测"。锚点必须独立于被测方：常量漂移 ⇒ 假服务 404 ⇒ 当场转红。
const PRODUCTION_LLM_PATH = "/.cloud/llm/chat/completions";
const LLM_PATHS = [PRODUCTION_LLM_PATH, "/v1/chat/completions"];   // 后者留给手工 curl

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

export const FAKE_LLM_TRANSPORTS = { ...FAKE_SCENARIOS, never: () => null };
export const FAKE_LLM_NAMES = Object.keys(FAKE_LLM_TRANSPORTS);

/**
 * @param {{ getSystemPrompt: () => string, getTextSystemPrompt?: () => string, model?: string }} expectations
 */
export function createFakeLlmHandler({ getSystemPrompt, getTextSystemPrompt, model = "deepseek-v4.1-flash" } = {}) {
  const state = {
    declared: new Map(),
    defaultScenario: "report",
    stats: { requests: 0, promptMismatch: 0, streamFlagMissing: 0, imageMissing: 0, completed: 0, chunksSent: 0, creditsSpent: 0 },
  };
  // 在途请求数：差值取证（after-before）前必须先把上一例遗留的流排空，
  // 否则一条迟到的 completed 会落进本例窗口，把"这次没成功投递"误判成"这次也投递成功了"（run-gates 里实测到一次）。
  let inFlight = 0;

  const reset = () => {
    state.declared.clear();
    state.defaultScenario = "report";
    state.stats = { requests: 0, promptMismatch: 0, streamFlagMissing: 0, imageMissing: 0, completed: 0, chunksSent: 0, creditsSpent: 0 };
  };

  const resolve = (name) => {
    if (typeof name === "string" && state.declared.has(name)) return state.declared.get(name);
    if (typeof name === "string" && FAKE_LLM_TRANSPORTS[name]) return { text: FAKE_LLM_TRANSPORTS[name]() };
    return null;
  };

  async function handle(req, res, url) {
    if (url.pathname === "/health") {
      json(res, 200, { ok: true, role: "fake-llm", transport: "openai-compatible-sse", model, scenarios: FAKE_LLM_NAMES });
      return true;
    }
    if (url.pathname === "/_fake/state") { json(res, 200, { scenario: state.defaultScenario, declared: [...state.declared.keys()], inFlight, ...state.stats }); return true; }
    if (url.pathname === "/_fake/reset" && req.method === "POST") { reset(); json(res, 200, { ok: true }); return true; }
    if (url.pathname === "/_fake/declare" && req.method === "POST") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { body = null; }
      const id = typeof body?.id === "string" && /^[A-Za-z0-9_:.-]{1,64}$/.test(body.id) ? body.id : null;
      if (!id) { json(res, 400, { ok: false, error: "bad_id" }); return true; }
      let text = null;
      if (typeof body?.text === "string") text = body.text;
      else if (body?.json !== undefined) text = JSON.stringify(body.json);
      else if (body?.fenced !== undefined) text = "```json\n" + JSON.stringify(body.fenced) + "\n```";
      if (text === null && (body.never === true || Number.isInteger(body.http) || Number.isInteger(body.slowMs))) text = FAKE_SCENARIOS.report();
      if (text === null) { json(res, 400, { ok: false, error: "bad_declaration" }); return true; }
      state.declared.set(id, {
        text,
        never: body.never === true,
        http: Number.isInteger(body.http) ? body.http : null,
        slowMs: Number.isInteger(body.slowMs) ? body.slowMs : 0,
        // 收尾帧的 finish_reason：默认 stop；给 "length" 就能造出"输出被 token 上限截断"这一类真失败
        finishReason: typeof body.finishReason === "string" && /^[a-z_]{1,20}$/.test(body.finishReason) ? body.finishReason : null,
      });
      json(res, 200, { ok: true, id });
      return true;
    }
    // 两条路径都收：`/.cloud/llm/chat/completions` 是**生产真实路径**（cloud-llm-http 的 CLOUD_LLM_PATH），
    // `/v1/chat/completions` 是旧的手工 curl 入口。别的产品路径一律 404 —— 这样"URL 拼错"会被断言抓到。
    if (!LLM_PATHS.includes(url.pathname) || req.method !== "POST") return false;

    const raw = [];
    for await (const c of req) raw.push(c);
    let body = null;
    try { body = JSON.parse(Buffer.concat(raw).toString("utf8") || "{}"); } catch { body = null; }
    state.stats.requests += 1;

    if (body?.stream !== true) { state.stats.streamFlagMissing += 1; json(res, 400, { error: { message: "request_stream_required" } }); return true; }
    const sys = body?.messages?.[0];
    const parts = Array.isArray(body?.messages?.[1]?.content) ? body.messages[1].content : [];
    const image = parts.find((p) => p?.type === "image_url");
    if (image) {
      // 图片通路：system 逐字等于 AGENT_SYSTEM，且必须带 data:image/ 的图
      if (!sys || sys.role !== "system" || sys.content !== getSystemPrompt()) {
        state.stats.promptMismatch += 1;
        json(res, 400, { error: { message: "system_prompt_mismatch", got: typeof sys?.content === "string" ? sys.content.slice(0, 60) : null } });
        return true;
      }
      if (!image?.image_url?.url?.startsWith("data:image/")) { state.stats.imageMissing += 1; json(res, 400, { error: { message: "image_part_missing" } }); return true; }
    } else {
      // 文字层通路（PDF）：system 逐字等于 AGENT_SYSTEM_TEXT，且文字非空。
      // 没注 getTextSystemPrompt 的调用方（旧注入点）在这一律 400——宁可红，不静默放行。
      if (typeof getTextSystemPrompt !== "function") {
        state.stats.promptMismatch += 1;
        json(res, 400, { error: { message: "text_mode_not_supported" } });
        return true;
      }
      if (!sys || sys.role !== "system" || sys.content !== getTextSystemPrompt()) {
        state.stats.promptMismatch += 1;
        json(res, 400, { error: { message: "system_prompt_mismatch", mode: "text", got: typeof sys?.content === "string" ? sys.content.slice(0, 60) : null } });
        return true;
      }
      const text = parts.map((p) => (p?.type === "text" ? String(p.text ?? "") : "")).join("");
      if (!text.trim()) { state.stats.imageMissing += 1; json(res, 400, { error: { message: "text_part_missing" } }); return true; }
      state.stats.textRequests = (state.stats.textRequests ?? 0) + 1;
    }

    const scenarioName = req.headers["x-fake-scenario"] || state.defaultScenario;
    const sc = resolve(String(Array.isArray(scenarioName) ? scenarioName[0] : scenarioName)) ?? resolve("report");
    // 在途 = 处理函数还在跑，不看 socket：产品侧超时后 res 会 close，但这里的 sleep 循环仍在继续、
    // 最后照样 completed += 1。按 socket 判"安静"会漏掉这一条（R25 的 slowMs=4000 剧本就是这么漏的）。
    inFlight += 1;
    try {
    if (sc?.http) { json(res, sc.http, { error: { message: "injected_transport_error" } }); return true; }

    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" });
    const send = (obj) => { res.write(`data: ${JSON.stringify(obj)}\n\n`); state.stats.chunksSent += 1; };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // 收尾的 [DONE] **不带尾随空行**，与真网关一致（2026-09-26 实测：真流的最后一个 data 帧之后连接直接结束）。
    // 假服务原来写的是 `data: [DONE]\n\n`，于是产品的 SSE 解析器"漏 flush 残帧"这个 bug 在夹具里永远测不到——
    // 直到拿裸 fetch 打真 API 才炸出来。改成像真的那样，A2 每轮都在替我们测这条路径。
    const endStream = (r) => r.end("data: [DONE]\n");
    if (sc?.never) { await sleep(50); res.write("data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n"); endStream(res); return true; }

    const text = sc?.text ?? FAKE_SCENARIOS.report();
    const size = 600;
    for (let i = 0; i < text.length; i += size) {
      if (sc?.slowMs) await sleep(sc.slowMs);
      send({ choices: [{ delta: { content: text.slice(i, i + size) } }] });
    }
    state.stats.completed += 1;
    const credit = Number((0.1 + Math.round(text.length / 5000) / 10).toFixed(2));
    state.stats.creditsSpent = Number((state.stats.creditsSpent + credit).toFixed(2));
    send({ choices: [{ delta: {}, finish_reason: sc?.finishReason ?? "stop" }], usage: { prompt_tokens: 1800, completion_tokens: Math.ceil(text.length / 4), total_tokens: 1800 + Math.ceil(text.length / 4), credit } });
    endStream(res);
    return true;
    } finally {
      inFlight -= 1;
    }
  }

  return { handle, reset, stats: () => ({ inFlight, ...state.stats }), scenarios: FAKE_LLM_NAMES };
}
