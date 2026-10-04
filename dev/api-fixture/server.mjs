// Local credential-free fixture API for M2 development (Node 22, no Deno needed).
// Runs the REAL functions/handler.mjs business logic against in-memory fakes for
// Supabase and Storage, and the REAL functions/extraction.mjs adapter against an
// in-process fake Cloud Agents (fake OCR) service.
// Fixture/user context headers are injected here; caller-supplied x-qoder-* headers are discarded.
// Usage: node dev/api-fixture/server.mjs [port]
// Open /functions/v1/app?fixture=A|B|anonymous on the frontend origin to switch user.
// 假模型端点：默认挂在自己的端口上（GET /health、GET /_fake/state）；
// 想单独跑就 `node dev/fake-ocr/server.mjs 5000` 并用 FAKE_OCR_URL=http://127.0.0.1:5000 起本夹具。
import http from "node:http";

const PORT = Number(process.argv[2] || 8000);

// QCA 通路端点从 R115 起只从环境变量取（产品侧 `functions/extraction.mjs` 的 `JYJ_QCA_ORIGIN`）。
// 夹具在这里**代位站点 Settings**给一个值，而不是往产品里塞参数：这样 QCA 那条路跑的就是生产同一条
// 读 env 的代码，"端点写死"与"夹具特殊照顾"两种漂移都进不来。域名不可解析——传输层随后改道 127.0.0.1。
process.env.JYJ_QCA_ORIGIN ??= "https://qca.fixture.invalid";

const { createHandler } = await import("../../functions/handler.mjs");
const { QUOTA_DEFAULTS } = await import("../../functions/quota.mjs");
const { makeUsageLedger, usageKeyFor } = await import("../../functions/usage-ledger.mjs");
// 真实抽取 adapter：夹具不再自带假适配器（评审方 F-1），只替换传输层目标。
// 两条通路平行存在，用 JYJ_EXTRACT_ADAPTER=qca|llm 选一条（默认 qca —— 评审方 S2 的 21 条账目判在这条上；
// llm 通路必须能被同一套 A2 断言跑绿，否则不许替换线上通道）。
const { createFakeOcrHandler } = await import("../fake-ocr/handler.mjs");
const { createFakeLlmHandler } = await import("../fake-llm/handler.mjs");
const { CLOUD_AGENTS_ORIGIN, PROMPT_VERSION, AGENT_SYSTEM } = await
  import("../../functions/extraction.mjs");
// 适配器装配走产品那一份（functions/adapters.mjs）：夹具不再自己拼 createHandler 的参数，
// 因此"生产接了、夹具漏接"这类漂移在结构上不可能再发生（R35 撞过的洞）。
const { makeExtractFactory, pickExtractAdapter } = await import("../../functions/adapters.mjs");
const { makeCloudLlmChat } = await import("../../functions/cloud-llm-http.mjs");
// 上传体积上限从产品那一份取（不在夹具里再抄一个数）：夹具与生产的注入面一旦分叉，链路级主张就失效。
const { MAX_UPLOAD_BYTES } = await import("../../functions/validate.mjs");
const EXTRACT_ADAPTER = pickExtractAdapter(process.env.JYJ_EXTRACT_ADAPTER, "qca");

// ---------- 查询引擎（与 dev/local-app/server.mjs 共用同一份实现，R123 搬出） ----------
// 夹具缺省**不落盘**：/_fixture/reset 之后必须是干净的，这是测试语义；本机服务器传 onChange 才落盘。
// 差异只以参数表达——两边各写一份引擎，就会长出"夹具绿、真服务器另一套"那种没人报警的漂移。
const { makeSupabaseLite } = await import("../backend-local/supabase-lite.mjs");
const { tables, client: fakeSupabase } = makeSupabaseLite();

// ---------- 对象存储（与 dev/local-app/server.mjs 共用同一份实现，R123 搬出） ----------
// 单文件上限照抄产品那一份常量（R71）：超限必须当场拒，否则"前端已把超限照片压进上限"在这套件上永远不可能失败。
const { makeObjectStore } = await import("../backend-local/object-store.mjs");
const store = makeObjectStore({ maxSizeBytes: MAX_UPLOAD_BYTES });
const fakeStorage = store.storage;
const oversize = store.oversize;
// 每个 action 被真实调到的次数（R74：写穿次数这种主张要能数出来）——这是夹具自己的取证面，不在共享存储里。
const actionCounts = {};
const resetActionCounts = () => { for (const k of Object.keys(actionCounts)) delete actionCounts[k]; };

// ---------- 假 Cloud Agents / 假 OCR（真实 adapter 的上游） ----------
// 评审方 F-1 的正解：这里**不再自带假适配器**。抽取走的是产品里的真实
// functions/extraction.mjs（makeQcaExtractionAdapter → parseAgentJson → normalizeResult），
// 夹具只把「传输层目标」换成下面的假 Cloud Agents API 面。
// 因此：证据映射（pageNo/blockIds）、字段 id、docType 降级、版本戳前缀全部由真实管线算出（F-3/F-5）。
const fakeOcr = createFakeOcrHandler();
// llm 通路（JYJ_EXTRACT_ADAPTER=llm）用这个假多模态 LLM：OpenAI 兼容 SSE，形状不对直接 400，
// 于是"提示词被改""忘传 stream""图片没带上"都会让断言当场转红。
const fakeLlm = createFakeLlmHandler({ getSystemPrompt: () => AGENT_SYSTEM });
// FAKE_OCR_URL 指到独立进程（node dev/fake-ocr/server.mjs 5000）时用它；默认挂在夹具自己的端口上，
// 这样「一条命令」就能跑完整链路，且传输层仍是真实 HTTP（走 127.0.0.1 回环，不外发一个包）。
const FAKE_OCR_BASE = process.env.FAKE_OCR_URL || `http://127.0.0.1:${PORT}`;
const FAKE_LLM_BASE = process.env.FAKE_LLM_URL || `http://127.0.0.1:${PORT}`;
const QCA_ORIGIN = new URL(CLOUD_AGENTS_ORIGIN);

// adapter 的凭据契约要求非空 token；夹具给的是**固定假串**，不是任何账号凭据，也不出本机。
const FIXTURE_TOKEN = "fixture-token-not-a-secret";
if (!globalThis.Deno) globalThis.Deno = { env: { get: (k) => (k === "QODER_PAT" ? FIXTURE_TOKEN : undefined) } };

// ---- 剧本队列：每条描述「假模型可能吐出的原始文本」，不是归一化后的结果 ----
//   { name }        内置场景名（report/rx/outpatient/inpatient/ambiguous/conflict_a/similar_drug/injection/…）
//   { json }        直接给对象 → JSON.stringify 后作为模型原文（真实 parseAgentJson 负责解析）
//   { fenced }      同上但包在 ```json 围栏里（只有真实 parseAgentJson 的剥围栏分支能解析）
//   { text }        任意原文（非 JSON 垃圾 / 拒答语 / 截断 JSON）
//   { polls: n }    前 n-1 次轮询只回 pending（默认 2）
//   { never: true } 永不回 agent.message（配 /_fixture/backdate 命中服务端 ai_timeout 分支）
//   { http: 500 }   传输层注入：该会话的轮询直接回该 HTTP 状态
const scenarioQueue = [];
let scenarioSeq = 0;

const declareScenario = async (spec) => {
  if (typeof spec?.name === "string") {
    if (!fakeOcr.scenarios.includes(spec.name)) throw new Error(`unknown_scenario:${spec.name}`);
    return spec.name;
  }
  const id = `q${++scenarioSeq}`;
  const r = await fetch(`${FAKE_OCR_BASE}/_fake/declare`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, ...spec }),
  });
  if (!r.ok) throw new Error(`declare_failed:${r.status}`);
  // 同一条剧本同时喂给 llm 通路，这样两条通路的对比测试用的是**完全相同**的模型原文。
  const r2 = await fetch(`${FAKE_OCR_BASE}/_fake-llm/declare`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, ...spec }),
  });
  if (!r2.ok) throw new Error(`llm_declare_failed:${r2.status}`);
  return id;
};

// ---- 传输层：只改目标地址，不改任何一行业务逻辑；同时留下可取证的调用流水 ----
const transcript = [];
const transportViolations = [];
let fakeOcrRequests = 0;

const fixtureFetch = async (href, init = {}) => {
  const u = new URL(href);
  // 真实 client 构造出来的必须还是生产 QCA 地址（https + 同 origin），否则说明有人放宽了校验
  if (u.origin !== QCA_ORIGIN.origin || u.protocol !== "https:") {
    transportViolations.push({ href, why: "origin_not_qca" });
    throw new Error("fixture_transport_origin_violation");
  }
  const target = new URL(u.pathname + u.search, FAKE_OCR_BASE);
  const headers = new Headers(init.headers ?? {});
  headers.set("authorization", `Bearer ${FIXTURE_TOKEN}`);
  let bound = null;
  if (init.method === "POST" && u.pathname === "/api/v1/cloud/sessions") {
    bound = scenarioQueue.shift() ?? null;
    if (bound) headers.set("x-fake-scenario", bound);
  }
  fakeOcrRequests += 1;
  const entry = {
    at: new Date().toISOString(),
    method: init.method ?? "GET",
    qcaUrl: u.href,
    path: u.pathname,
    proxiedTo: target.origin,
    ...(bound ? { scenario: bound } : {}),
    bodyBytes: typeof init.body === "string" ? Buffer.byteLength(init.body) : 0,
    hasAuthHeader: headers.has("authorization"),
  };
  try {
    const response = await fetch(target.href, {
      method: init.method ?? "GET",
      headers,
      ...(init.body === undefined ? {} : { body: init.body }),
      redirect: "manual",
      ...(init.signal ? { signal: init.signal } : {}),
    });
    entry.status = response.status;
    transcript.push(entry);
    if (transcript.length > 400) transcript.shift();
    return response;
  } catch (error) {
    entry.status = 0;
    entry.error = String(error?.name ?? error?.message ?? error);
    transcript.push(entry);
    if (transcript.length > 400) transcript.shift();
    throw error;
  }
};

// ---- llm 通路的传输层 ----
// 关键：这里用的就是**产品要发出去的那段代码** `functions/cloud-llm-http.mjs`（真 HTTP + 真 SSE + 真生产路径
// `/.cloud/llm/chat/completions`），夹具只在 `fetchImpl` 这一层改目的地并记账。
// 于是 A2 的 llm 模式绿 = 线上那份传输代码绿；不再是夹具自己抄一份 SSE 解析（那样永远测不到 shipped 的那份）。
const llmUsage = [];
// R122（2026-10-02）：这一格**曾经**是一串以那家 publishable key 的前缀开头、长 25、sha256 前 12 位 `843bcb793949` 的字面量，
// 随包发到 `backend/dev/api-fixture/server.mjs`，而全仓库没有任何一处记录它的来源。R98 已排除它是真 key
// （真 key 实测长 60、sha 前缀是另一串），所以那不是泄漏事故，而是**交付卫生风险**：凭证形状＋零来源＋发给别人。
// 签发这一类前缀的对岸平台已退出协作 ⇒ 换成一眼假的占位串：它的唯一作用是"非空"，让产品那份
// `makeCloudLlmChat` 的 `if (!key)` 在**假通路**上照样过得去（`functions/cloud-llm-http.mjs:103`）。
// 真值只从环境变量来：`FIXTURE_LLM_REAL=1` 时读无前缀的 `LLM_ENDPOINT`／`LLM_PUBLISHABLE_KEY`（见下面 LLM_REAL 那一段），
// 这个常量在那条路上根本不参与。常驻判据见 `dev/credential-shape-scan.mjs`（A 组 R122 段每轮真跑，扫到凭证形状就判红）。
const FIXTURE_LLM_KEY = "fixture-not-a-credential";
const llmFetchImpl = async (target, init) => {
  const scenarioId = scenarioQueue.shift() ?? null;
  const href = String(target);
  const body = JSON.parse(String(init?.body ?? "{}"));
  fakeOcrRequests += 1;
  const entry = {
    at: new Date().toISOString(), method: init?.method ?? "GET",
    path: new URL(href).pathname, proxiedTo: new URL(href).origin, transport: "llm-sse",
    ...(scenarioId ? { scenario: scenarioId } : {}),
    bodyBytes: Buffer.byteLength(String(init?.body ?? "")),
    model: body?.model ?? null, streamFlag: body?.stream === true,
    // R108：温度档实验的证据要的是"发出去的那一个数"，不是"我以为设上的那一个数"——
    // 这个字段进流水（`/_fixture/state` 的 transcript），跑完能当场数出 4 次请求各带多少。
    temperature: body?.temperature ?? null,
    systemIsProductPrompt: body?.messages?.[0]?.content === AGENT_SYSTEM,
    hasImage: Array.isArray(body?.messages?.[1]?.content) && body.messages[1].content.some((p) => p?.type === "image_url"),
  };
  if (entry.proxiedTo !== new URL(LLM_TARGET).origin) {
    // 判据是"只去声明过的那一个端点"：假模式=本机回环，真机模式=交接文档给的那个 endpoint。
    transportViolations.push({ href, why: "llm_origin_not_declared" });
  }
  try {
    const response = await fetch(href, {
      ...init,
      headers: { ...(init?.headers ?? {}), ...(scenarioId ? { "x-fake-scenario": scenarioId } : {}) },
    });
    entry.status = response.status;
    transcript.push(entry);
    if (transcript.length > 400) transcript.shift();
    return response;
  } catch (error) {
    entry.status = 0;
    transcript.push(entry);
    throw error;
  }
};
// FIXTURE_LLM_REAL=1 ⇒ 真机端到端模式：传输层打到**真实云服务通道**（凭据只从环境变量来），
// 其余链路（同源函数、鉴权、存储校验、落库、轮询、前端合并）与回归夹具完全一致。
// 记账用的 fetchImpl 两种模式都保留 ⇒ 真实调用同样进流水，"只许去声明过的那一个端点"这条判据也照样生效。
const LLM_REAL = process.env.FIXTURE_LLM_REAL === "1";
const LLM_TARGET = LLM_REAL ? process.env.LLM_ENDPOINT : FAKE_LLM_BASE;
if (LLM_REAL && !LLM_TARGET) { console.error("FIXTURE_LLM_REAL=1 但缺 LLM_ENDPOINT"); process.exit(2); }
const llmChat = makeCloudLlmChat({
  endpoint: LLM_TARGET,
  publishableKey: LLM_REAL ? process.env.LLM_PUBLISHABLE_KEY : FIXTURE_LLM_KEY,
  fetchImpl: llmFetchImpl,
});

// qca：coordinator 由真实 handler 注入（跑在夹具内存 ai_resources 上），资源创建/选型走产品那套栅栏单写锁。
// llm：supabase 传给真实 adapter，让它把 completed 结果落回 extract_jobs（owner 作用域、不新增列）。
// 装配只有一份实现（functions/adapters.mjs），生产与夹具共用 ⇒ 注入面没法再各自漏接一个键。
// R35 之前正是这里"少传一个 onUsage"让成本账本在 300+ 条链路断言下从来没被写过而无人察觉。
// 差异只以**参数**表达：qca 换传输目标（fixtureFetch，origin 仍是产品常量、https 强校验不放宽）、
// llm 换 chat 实现与 timeoutMs（夹具压到 1.5 秒好测"不回话/回得慢"，真机模式回到 30 秒）。
const extraction = makeExtractFactory({
  which: EXTRACT_ADAPTER,
  llmChat,
  ledgerFor: ({ db }) => {
    const ledger = makeUsageLedger({ db });
    return (e) => {
      llmUsage.push(e);
      if (llmUsage.length > 50) llmUsage.shift();
      return ledger(e);
    };
  },
  qca: { origin: CLOUD_AGENTS_ORIGIN, fetchImpl: fixtureFetch },
  llm: {
    timeoutMs: Number(process.env.FIXTURE_LLM_TIMEOUT_MS || (LLM_REAL ? 30_000 : 1500)),
    // R108 温度档实验：只有显式设了 `FIXTURE_LLM_TEMPERATURE` 才注入，**不设就沿用产品那一份默认值**
    // （`functions/cloud-llm.mjs` 的 `temperature = 1` 一处；生产入口 `functions/index.ts` 从不传这个键）。
    // 为什么要在这里拒起服务而不是"忽略掉"：温度档实验的结论全靠"发出去的那一个数是不是 0.2"，
    // 一个拼错的值（`0,2`／`０.2`）若被静默忽略，跑完 4 次真病历换来的却是默认 1 的账——而且屏幕上看不出来。
    ...(() => {
      const raw = process.env.FIXTURE_LLM_TEMPERATURE;
      if (raw === undefined || raw === "") return {};
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0 || n > 2) {
        console.error(`拒绝：FIXTURE_LLM_TEMPERATURE=${JSON.stringify(raw)} 不是 0–2 之间的数。` +
          `温度档实验的账要求"发出去的数与设的数一致"，拼错不许被静默忽略。`);
        process.exit(2);
      }
      return { temperature: n };
    })(),
  },
});

const transportEvidence = () => ({
  extractAdapter: EXTRACT_ADAPTER,
  // 产品这一刻声明的 QCA origin（`JYJ_QCA_ORIGIN` 经 `functions/extraction.mjs` 读出来的那一个串）：
  // A2 拿它去核对流水里的 URL，判据因此不写死主机名——端点换了，判据跟着现读走。
  qcaOrigin: CLOUD_AGENTS_ORIGIN,
  // 真机模式必须自报家门：A2/B 的断言是按"剧本可控"写的，对着真模型跑只会得出无意义结果，
  // 还会白花积分 ⇒ 两个套件都在开头拒绝 real 模式。
  llmMode: LLM_REAL ? "real" : "fake",
  qcaRequests: fakeOcrRequests,
  offOriginRequests: transportViolations.length,
  sessionsCreated: fakeOcr.stats().sessionsCreated,
  pollsServed: fakeOcr.stats().pollsServed,
  agentMessagesDelivered: fakeOcr.stats().agentMessagesDelivered,
  transportErrorsInjected: fakeOcr.stats().transportErrorsInjected,
  llm: fakeLlm.stats(),
  // 作业行的**状态列**（不含 result）：R25 需要验"dispatch 结果未知时行留在 pending"——
  // 那条 503 响应本来就不带 jobId（客户端无从轮询一个自己没拿到的作业），所以测试只能从服务端状态核对。
  // 这里刻意不映射 result 列：那是医疗正文，夹具状态端点会被断言打印出来，不能把正文带进取证输出。
  jobs: tables.extract_jobs.map((r) => ({ id: r.id, state: r.state, sessionId: r.session_id, errorCode: r.error_code, createdAt: r.created_at })),
  llmUsageEvents: llmUsage.length,
  lastLlmUsage: llmUsage[llmUsage.length - 1] ?? null,
  promptVersion: PROMPT_VERSION,
  promptChars: AGENT_SYSTEM.length,
  quotaLimits,
  // 产品那份成本账本今天的行（配额全局闸门的输入；测试要能等到它落账再断言，否则测的是竞态不是行为）
  // 行形状是 { scope_key, record: { fence, data } } —— 账本内容在 record.data 里，别读错一层。
  ledgerDay: tables.ai_resources.find((r) => r.scope_key === usageKeyFor(new Date().toISOString().slice(0, 10)))?.record?.data ?? null,
});

// 配额上限：产品侧是常量，测试侧要能在**不起新进程**的前提下把上限压低（否则一条配额断言
// 要先烧掉 60 次派发，还会污染同端口的其它用例）。这个对象按引用交给 handler，改它即时生效。
const quotaLimits = {
  ownerPerDay: Number(process.env.JYJ_QUOTA_OWNER_PER_DAY) || QUOTA_DEFAULTS.ownerPerDay,
  globalPerDay: Number(process.env.JYJ_QUOTA_GLOBAL_PER_DAY) || QUOTA_DEFAULTS.globalPerDay,
};
const QUOTA_DEFAULTS_LIVE = { ...quotaLimits };
// R96：这一格决定界面会不会对患者说「这一条识别值来自测试假模型」，所以**按真实传输目标判**，不按进程身份判：
//   · llm 通路且 FIXTURE_LLM_REAL=1 ⇒ 打的是真端点（值从环境变量来）⇒ "real"
//   · 其余一律 "test"（qca 通路哪怕在真机模式下也仍然打到 dev/fake-ocr 那台剧本服务）
const MODEL_KIND = LLM_REAL && EXTRACT_ADAPTER === "llm" ? "real" : "test";
const business = createHandler({ storage: fakeStorage, extract: extraction, quotaLimits, modelKind: MODEL_KIND });

// ---------- user context ----------
const USERS = {
  A: { user_id: "fixture-user-a", name: "夹具用户A", picture: "" },
  B: { user_id: "fixture-user-b", name: "夹具用户B", picture: "" },
};

const contextHeader = (user) => {
  const value = { ...user, site_id: "fixture-site", host_id: "fixture-host", session_expires_at: Math.floor(Date.now() / 1000) + 3600 };
  const b64 = Buffer.from(JSON.stringify(value)).toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};


const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  try {
    if (url.pathname.startsWith("/_fixture/upload/")) {
      const path = decodeURIComponent(url.pathname.slice("/_fixture/upload/".length));
      if (req.method === "PUT") {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const put = Buffer.concat(chunks);
        if (oversize(put.length)) {
          // 与平台同一句话：对象过大。前端"先压到限内"这条路有没有真的生效，就看这里会不会被打通（R71）。
          res.writeHead(413, { "content-type": "application/json" }).end(JSON.stringify({ error: "object_too_large", bytes: put.length }));
          return;
        }
        store.put(path, new Uint8Array(put), req.headers["content-type"] || "application/octet-stream");
        res.writeHead(200).end("{}");
        return;
      }
      const item = store.get(path);
      if (!item) {
        res.writeHead(404).end();
        return;
      }
      if (req.method === "DELETE") {
        store.del(path);
        res.writeHead(200).end("{}");
        return;
      }
      res.writeHead(200, { "content-type": item.contentType, "cache-control": "no-store" });
      res.end(Buffer.from(item.bytes));
      return;
    }
    if (url.pathname === "/_fixture/reset") {
      for (const key of Object.keys(tables)) tables[key].length = 0;
      store.reset();
      scenarioQueue.length = 0;
      transcript.length = 0;
      transportViolations.length = 0;
      fakeOcrRequests = 0;
      fakeOcr.reset();
      fakeLlm.reset();
      llmUsage.length = 0;
      resetActionCounts();
      res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      return;
    }
    // 传输层自证：夹具把每一次 QCA 调用的真实 URL/方法/状态都记下来了（证明不是前端硬编码）
    if (url.pathname === "/_fixture/state") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
        .end(JSON.stringify({ ok: true, queued: scenarioQueue.length, actionCounts, ...transportEvidence(), transcript: transcript.slice(-60) }));
      return;
    }
    // 假 Cloud Agents / 假 OCR 服务面（默认挂在夹具自己的端口；FAKE_OCR_URL 时转发到独立进程）
    if (
      (url.pathname === "/health" || url.pathname.startsWith("/_fake/") || url.pathname.startsWith("/api/v1/cloud/"))
      && FAKE_OCR_BASE !== `http://127.0.0.1:${PORT}`
    ) {
      const upstream = await fetch(`${FAKE_OCR_BASE}${url.pathname}${url.search}`, {
        method: req.method,
        headers: { "content-type": req.headers["content-type"] || "application/json", ...(req.headers["x-fake-scenario"] ? { "x-fake-scenario": String(req.headers["x-fake-scenario"]) } : {}) },
        ...(req.method === "POST" ? { body: new Uint8Array(await new Response(req).arrayBuffer()) } : {}),
      });
      res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") || "application/json", "cache-control": "no-store" });
      res.end(Buffer.from(await upstream.arrayBuffer()));
      return;
    }
    if (url.pathname === "/health" || url.pathname.startsWith("/_fake/") || url.pathname.startsWith("/api/v1/cloud/")) {
      if (await fakeOcr.handle(req, res, url)) return;
    }
    // 假多模态 LLM（llm 通路）：两条挂载路径都要有——
    //   · `/.cloud/llm/chat/completions` = **生产真实路径**（`functions/cloud-llm-http.mjs` 的 CLOUD_LLM_PATH），
    //     走这条才证明"夹具测的 URL 与线上发的 URL 是同一个"；
    //   · `/llm/*` = 旧路径，保留给手工 curl 与历史脚本。控制面在 /_fake-llm/*。
    if (url.pathname.startsWith("/.cloud/llm/")) {
      if (await fakeLlm.handle(req, res, url)) return;
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "fake_llm_not_found", pathname: url.pathname }));
      return;
    }
    if (url.pathname.startsWith("/llm/") || url.pathname.startsWith("/_fake-llm/")) {
      const mapped = new URL(url.href);
      mapped.pathname = url.pathname.startsWith("/_fake-llm/") ? url.pathname.replace("/_fake-llm", "/_fake") : url.pathname.slice("/llm".length) || "/";
      if (await fakeLlm.handle(req, res, mapped)) return;
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "fake_llm_not_found", pathname: mapped.pathname }));
      return;
    }
    // 假 OCR 控制台：只在夹具里存在，不属于产品接口，也不接受任何凭据
    if (url.pathname === "/_fixture/ocr" && req.method === "POST") {
      const raw = new Uint8Array(await new Response(req).arrayBuffer());
      const parsed = raw.length ? JSON.parse(new TextDecoder().decode(raw)) : {};
      const list = Array.isArray(parsed?.scenarios) ? parsed.scenarios : [];
      if (!list.every((s) => s && typeof s === "object")) {
        res.writeHead(400, { "content-type": "application/json" }).end('{"ok":false,"error":"bad_scenario"}');
        return;
      }
      try {
        for (const s of list) scenarioQueue.push(await declareScenario(s));
      } catch (error) {
        res.writeHead(400, { "content-type": "application/json" })
          .end(JSON.stringify({ ok: false, error: "bad_scenario", detail: String(error?.message ?? error), known: fakeOcr.scenarios }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, queued: scenarioQueue.length }));
      return;
    }
    // 测试专用控制面：临时压低/复原识别配额上限（产品侧是常量，见 functions/quota.mjs）。
    // 不给这个口子，一条配额断言就得先烧掉几十次派发，还会把同端口上其它用例一起挡掉。
    if (url.pathname === "/_fixture/quota" && req.method === "POST") {
      const b = JSON.parse(Buffer.from(await new Response(req).arrayBuffer()).toString("utf8") || "{}");
      for (const k of ["ownerPerDay", "globalPerDay"]) {
        if (b?.[k] === "default") { quotaLimits[k] = QUOTA_DEFAULTS_LIVE[k]; continue; }
        if (Number.isInteger(b?.[k]) && b[k] > 0) quotaLimits[k] = b[k];
      }
      // 配额是按"当日该 owner 的作业行数"算的，而同一端口上前面的用例已经建过若干行；
      // 不清零就没法写出"第 3 次必须被挡"这种确定性断言。只动 extract_jobs，资料与任务保留。
      if (b?.wipeJobs === true) tables.extract_jobs.length = 0;
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, jobs: tables.extract_jobs.length, ...quotaLimits }));
      return;
    }
    // 把未完成识别任务的创建时间拨旧，用来真实触发服务端 JOB_TIMEOUT 分支（否则要等 10 分钟）
    if (url.pathname === "/_fixture/backdate" && req.method === "POST") {
      // minutes 可给：默认 11（越过 QCA 的 10 分钟老上限）；同步通路要测"90 秒就该报超时"，
      // 需要一个落在 90 秒与 10 分钟之间的值（如 3）——两个通道各自的上限才能被分别取证。
      const reqBody = JSON.parse(Buffer.from(await new Response(req).arrayBuffer()).toString("utf8") || "{}");
      const minutes = Number.isFinite(+reqBody?.minutes) && +reqBody.minutes > 0 ? +reqBody.minutes : 11;
      const ago = new Date(Date.now() - minutes * 60 * 1000).toISOString();
      let n = 0;
      for (const row of tables.extract_jobs) {
        if (row.state !== "completed" && row.state !== "failed") {
          row.created_at = ago;
          n += 1;
        }
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, backdated: n }));
      return;
    }
    if (url.pathname.startsWith("/functions/v1/app")) {
      const which = url.searchParams.get("fixture") || "A";
      const action = url.searchParams.get("action") || "(空)";
      // R74：数一下每个 action 真的被调了几次——"每次本机改动恰好对应一次写穿"这种主张得能数出来才算量过
      actionCounts[action] = (actionCounts[action] ?? 0) + 1;
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (k === "cookie") headers.set(k, v);
      }
      headers.set("content-type", req.headers["content-type"] || "");
      if (which !== "anonymous") headers.set("x-qoder-user-context", contextHeader(USERS[which] ?? USERS.A));
      const body = ["POST", "PUT", "PATCH"].includes(req.method)
        ? new Uint8Array(await new Response(req).arrayBuffer())
        : undefined;
      const request = new Request(`http://127.0.0.1:8000${req.url}`, {
        method: req.method,
        headers,
        body: body && body.length ? body : (req.method === "POST" ? new Uint8Array(0) : undefined),
      });
      const response = await business({ request, supabase: fakeSupabase });
      res.writeHead(response.status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(await response.text());
      return;
    }
    res.writeHead(404).end("not found");
  } catch (error) {
    // 与 R103 给前门补的那一课同形：响应头已经写出去之后再 writeHead 会抛 ERR_HTTP_HEADERS_SENT，
    // 而这个异常在 createServer 回调里**没人接** ⇒ 整个夹具进程当场死掉，后续每个请求都变成连接被拒，
    // 排障时看到的是"服务没起"而不是"某一步抛了"。现在：原始异常先印出来（否则错误被自己吞掉），头写过了就只收尾。
    console.error(`[fixture] ${req.method} ${url.pathname} 处理失败：${String(error?.stack ?? error?.message ?? error).split("\n").slice(0, 4).join(" ⏐ ")}`);
    if (res.headersSent) { res.end(); return; }
    res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: "fixture_error", detail: String(error?.message ?? error) }));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[fixture] API ready at http://127.0.0.1:${PORT}/functions/v1/app?fixture=A`);
});
