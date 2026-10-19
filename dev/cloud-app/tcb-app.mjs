// 就医笺 · CloudBase 公网识别链路（函数入口，2026-10-18 主理人拍板「建在这个 env 上」后起）。
//
// 与另外两个入口的关系，先钉住再读码：
//   · **handler 还是那一份**（functions/handler.mjs＋adapters.mjs 唯一装配）——三个消费者
//     （Qoder 退役入口／本机链／这里）分不出背后是哪一家，R35 的纪律；
//   · **ingress 逻辑与 dev/cloud-app/server.mjs 同一套**（设备 cookie＋先剥再铸上下文），
//     区别只在这个入口跑在 CloudBase 函数里：凭据由函数运行时隐式提供（env 里不需要 TCB key），
//     模型走 SiliconFlow（这个 env 里 med-assistant 用了三个月的现成路子）；
//   · **前后端同源**：网关把 `/functions/v1/app` 路由到本函数、`/` 路由到静态托管
//     （吉小农的 `/api` 路由是同款形状），前端零改动；所以**不设 CORS**——同源不需要，
//     而它是白送的横向移动面。将来若改跨域（站点留 sites、函数放 CloudBase），CORS 是那时
//     显式加的东西，不是现在顺手开的门。
//
// 路由：
//   /functions/v1/app?action=…   handler 全量动作（设备身份 ingress）
//   /_tcb/object/<docs/…>        PUT＝上传字节（归属校验后进桶）・GET＝取回字节
//   /_tcb/state                  运维面：只报形状与计数，不报路径、不报凭据
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import tcb from "@cloudbase/node-sdk";

const { createHandler } = await import("../../functions/handler.mjs");
const { makeExtractFactory } = await import("../../functions/adapters.mjs");
const { makeUsageLedger, DEFAULT_LLM_MODEL } = await import("../../functions/usage-ledger.mjs").then(async (m) => ({ ...m, DEFAULT_LLM_MODEL: (await import("../../functions/cloud-llm.mjs")).DEFAULT_LLM_MODEL }));
const { QUOTA_DEFAULTS } = await import("../../functions/quota.mjs");
const { MAX_UPLOAD_BYTES } = await import("../../functions/validate.mjs");
const { CloudAgentsError } = await import("../../functions/cloud-agents.mjs");
const { makeDbTcb, makeJobsSupabaseShim } = await import("./tcb-db.mjs");
const { makeStorageTcb, objectPathParts, objectPathBelongsTo, EXT_TO_MIME } = await import("./tcb-storage.mjs");
// 回环名单与 OpenAI 兼容传输都只用现成的那一份（R144／R126 的单实现纪律）
const { isLoopbackHost } = await import("../../functions/cloud-llm-http.mjs");
const { assertModelEndpoint, makeOpenAiCompatChat } = await import("../backend-local/openai-chat.mjs");

const PORT = Number(process.env.PORT || 9000);

// ---------- CloudBase 装配 ----------
// 函数运行时里 tcb.init() 无参即用函数自己的凭据（med-assistant 同款：env 里只有 PORT/key，没有 TCB key）。
// 本地/别处显式给 env 时也认（TCB_ENV／TCB_SECRET_ID／TCB_SECRET_KEY），便于将来在函数外做联调。
const app = tcb.init({
  ...(process.env.TCB_ENV ? { env: process.env.TCB_ENV } : {}),
  ...(process.env.TCB_SECRET_ID && process.env.TCB_SECRET_KEY
    ? { secretId: process.env.TCB_SECRET_ID, secretKey: process.env.TCB_SECRET_KEY }
    : {}),
});
const db = makeDbTcb(app);
const storage = makeStorageTcb({ app });

// ---------- 设备身份（与 dev/cloud-app 同一套） ----------
const DEVICE_COOKIE = "jyj_device";
const DEVICE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEVICE_TTL_DAYS = Number(process.env.JYJ_DEVICE_TTL_DAYS || "730");
const parseCookies = (header) => Object.fromEntries(String(header || "").split(";").map((p) => p.trim()).filter(Boolean).map((p) => {
  const i = p.indexOf("=");
  return [p.slice(0, i), decodeURIComponent(p.slice(i + 1))];
}));
// 认不出的 cookie 值一律当没有（不猜、不修）：种一个新的，比把伪造的值当身份强
const deviceIdOf = (req) => {
  const raw = parseCookies(req.headers.cookie)[DEVICE_COOKIE];
  return DEVICE_RE.test(raw || "") ? raw.toLowerCase() : null;
};
const userFor = (deviceId) => ({ user_id: `device-${deviceId}`, name: "本机设备", picture: "" });
const base64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const contextHeader = (user) => base64url(JSON.stringify({
  ...user,
  site_id: "tcb-site",
  host_id: "tcb-host",
  session_expires_at: Math.floor(Date.now() / 1000) + DEVICE_TTL_DAYS * 86400,
}));
/**
 * 给 handler 造请求头。**先 delete 再 set** 是全部重点：auth.mjs 只认这个头里的身份，
 * 透传客户端自带的同名头＝任何人 curl 一发就能伪装成别人的 owner 读行。这行 delete
 * 永远不许被「优化」掉（它防的是未来有人改成复制入站头）。
 */
const buildContextHeaders = (req, user) => {
  const headers = new Headers();
  headers.set("content-type", req.headers["content-type"] || "");
  headers.set("cookie", req.headers.cookie || "");
  headers.delete("x-qoder-user-context");
  headers.set("x-qoder-user-context", contextHeader(user));
  return headers;
};
const deviceCookie = (deviceId) => `${DEVICE_COOKIE}=${deviceId}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${DEVICE_TTL_DAYS * 86400}`;

// ---------- 识别通路（SiliconFlow，OpenAI 兼容） ----------
// 与 ⑱ 那条 P0 的分界：**可选凭据缺失时识别不可用，其余动作照常**——绝不在入口期抛。
// （Qoder 那个入口当年就是模块顶层构造时抛，把 me／上传／同步一起拖成 503。）
const AI_ENDPOINT_RAW = process.env.JYJ_MODEL_ENDPOINT || "https://api.siliconflow.cn/v1/chat/completions";
const AI_KEY = (process.env.SILICONFLOW_API_KEY || process.env.JYJ_MODEL_KEY || "").trim();
const MODEL_NAME = process.env.JYJ_EXTRACT_MODEL || DEFAULT_LLM_MODEL;
const AI_TIMEOUT_MS = Number(process.env.JYJ_MODEL_TIMEOUT || "60000");
let modelKind = "test";
let chat = async () => {
  const error = new CloudAgentsError("ai_service_unavailable", 503, "not_sent");
  error.phase = "config";
  throw error;
};
let aiSummary = "未配置（界面照现有那句报「识别服务暂时不可用」，其余功能照常）";
if (AI_KEY) {
  try {
    const url = assertModelEndpoint(AI_ENDPOINT_RAW);
    chat = makeOpenAiCompatChat({ endpoint: url.href, key: AI_KEY, authStyle: "bearer", timeoutMs: AI_TIMEOUT_MS });
    // R96 纪律：按真实传输目标判 real／test，回环端点 ⇒ 界面按测试假模型逐条披露
    modelKind = isLoopbackHost(url.hostname) ? "test" : "real";
    aiSummary = `${url.host}${url.pathname}｜模型 ${MODEL_NAME}｜鉴权 Bearer（值未打印）`;
  } catch (error) {
    // 端点不合法也降级成「识别不可用」，不拖死整个入口（与缺 key 同一条路）
    console.error(`识别端点不可用，降级为未配置：${error?.code ?? error?.message}`);
  }
} else {
  console.error("未配置 SILICONFLOW_API_KEY：识别不可用，其余功能照常（⑱ 的纪律：可选凭据缺失不许杀死入口）");
}

const llmUsage = [];
const extraction = makeExtractFactory({
  which: "llm",
  llmChat: chat,
  ledgerFor: ({ db: ledgerDb }) => {
    const ledger = makeUsageLedger({ db: ledgerDb });
    return (e) => { llmUsage.push(e); if (llmUsage.length > 50) llmUsage.shift(); return ledger(e); };
  },
  llm: { model: MODEL_NAME, timeoutMs: AI_TIMEOUT_MS },
});
const business = createHandler({
  storage,
  extract: extraction,
  quotaLimits: { ...QUOTA_DEFAULTS },
  modelKind,
  // cloud-llm 直连 extract_jobs 的那两处，桥到 TCB 适配器（同一接口，无第二套查询语言）
  ...({ supabase: makeJobsSupabaseShim(db) }),
});

// ---------- 路由 ----------
const json = (res, status, obj, extraHeaders) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...(extraHeaders ?? {}) });
  res.end(JSON.stringify(obj));
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  const path = url.pathname;
  try {
    if (path === "/_tcb/state") {
      json(res, 200, {
        ok: true,
        modelKind,
        ai: aiSummary,
        quota: { ...QUOTA_DEFAULTS },
        usageEventsToday: llmUsage.filter((e) => String(e?.at ?? "").startsWith(new Date().toISOString().slice(0, 10))).length,
        uptimeSec: Math.round(process.uptime()),
        note: "只报形状与计数；不报路径、不报凭据、不报正文",
      });
      return;
    }

    // 对象路由：PUT 进桶／GET 取回。两道校验：路径形状＋归属（第二段＝调用者 owner 哈希）。
    if (path.startsWith("/_tcb/object/")) {
      const objectPath = decodeURIComponent(path.slice("/_tcb/object/".length));
      const known = deviceIdOf(req);
      const deviceId = known ?? randomUUID();
      if (!known) res.setHeader("set-cookie", deviceCookie(deviceId));
      const ownerId = userFor(deviceId).user_id;
      if (!objectPathParts(objectPath) || !(await objectPathBelongsTo(objectPath, ownerId))) {
        json(res, known ? 403 : 401, { ok: false, error: "object_forbidden" }, known ? undefined : { "set-cookie": deviceCookie(deviceId) });
        return;
      }
      if (req.method === "PUT") {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const put = Buffer.concat(chunks);
        if (put.length > MAX_UPLOAD_BYTES) { json(res, 413, { ok: false, error: "object_too_large", bytes: put.length }); return; }
        await app.uploadFile({ cloudPath: objectPath, fileContent: put });
        json(res, 200, { ok: true });
        return;
      }
      const item = await storage.download(objectPath);
      const buf = Buffer.from(await item.arrayBuffer());
      res.writeHead(200, { "content-type": item.headers.get("content-type") || "application/octet-stream", "cache-control": "no-store" });
      res.end(buf);
      return;
    }

    if (path.startsWith("/functions/v1/app")) {
      const known = deviceIdOf(req);
      const deviceId = known ?? randomUUID();
      const user = userFor(deviceId);
      const headers = buildContextHeaders(req, user);
      const body = ["POST", "PUT", "PATCH"].includes(req.method)
        ? new Uint8Array(await new Response(req).arrayBuffer())
        : undefined;
      const request = new Request(`http://localhost:${PORT}${req.url}`, {
        method: req.method,
        headers,
        body: body && body.length ? body : (req.method === "POST" ? new Uint8Array(0) : undefined),
      });
      const response = await business({ request, supabase: db });
      const text = await response.text();
      json(res, response.status, JSON.parse(text), known ? undefined : { "set-cookie": deviceCookie(deviceId) });
      return;
    }

    json(res, 404, { ok: false, error: "not_found" });
  } catch (error) {
    if (!res.headersSent) json(res, 500, { ok: false, error: "tcb_app_error", detail: String(error?.message ?? error) });
    else res.end();
  }
});

server.listen(PORT, () => {
  console.log(`就医笺 · CloudBase 识别链路（设备级匿名） listening on ${PORT}`);
  console.log(`  识别：${aiSummary}`);
});
