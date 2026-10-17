// 就医笺 · 本机识别链路的端到端自证。
//
// 这条脚本存在的理由：`dev/local-app/server.mjs` 是"给家属在自己电脑上跑"的东西，
// 它坏了不会有人收到一条红判据，只会有一位在诊室里打不开页面的家属。所以这里跑的是
// **真进程、真 HTTP、真落盘、真重启**，而不是把 handler 拉进内存假装走过。
//
// 全程不出本机：模型端点是 `dev/local-app/fake-model.mjs`（只绑 127.0.0.1），
// 用的图片是下面 `syntheticImage()` 现场生成的确定性合成件（棋盘格灰度图，不含任何真实病历内容）。
//
// 用法：node dev/local-app/e2e.mjs [--keep]   （--keep 保留临时数据目录给人工复查）
// 三态退出码：0 全过｜1 有断言红｜2 前置不满足（起不来进程／一条断言都没跑成）——绝不给部分绿。
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");

// 与判据层临时名生成同形的一行工具（公开仓不随包外发判据层，此处内联；
// 语义只有一条：同名临时件按 pid 加后缀，两轮并发不互相踩）。
function scopedTempName(name, pid) {
  const tail = "-" + pid;
  const m = /^(.+?)(\.[A-Za-z][A-Za-z0-9]*)$/.exec(name);
  return m ? m[1] + tail + m[2] : name + tail;
}

const KEEP = process.argv.includes("--keep");
// 数据目录按闸门**必须在仓库外**（本机服务器自己会拒仓库内目录，e2e 不能例外于被测方的规矩），
// 又必须按 pid 命名并在收场删干净——落点选系统临时目录。
const DATA_DIR = resolve(tmpdir(), scopedTempName("jyj-e2e-data", process.pid));
const PASSCODE = `e2e-${process.pid}`;
const NOW = "2026-10-03T00:00:00.000Z";

// 端到端要一张图跑真上传＋真识别。完整树里有一份标 synthetic 的合成件
// （dev/real-samples/prep/fx-ct-report-20260926.jpg，导出白名单不把它外发给公开仓）；
// 在就用它，不在（公开仓）就现场生成一段确定性的最小 JPEG——两条路给 e2e 的字节职责相同：
// 真上传＋真取回逐字节一致。假模型按场景回话、不解图，图只承担那一类断言，因此字节确定即可复现。
const SYNTHETIC_IMAGE = join(ROOT, "dev/real-samples/prep/fx-ct-report-20260926.jpg");
function syntheticImage() {
  if (existsSync(SYNTHETIC_IMAGE)) return new Uint8Array(readFileSync(SYNTHETIC_IMAGE));
  const b64 = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABQODxIPDRQSEBIXFRQYHjIhHhwcHj0sLiQySUBMS0dARkVQWnNiUFVtVkVGZIhlbXd7gYKBTmCNl4x9lnN+gXz/wAALCACAAGABAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/ALtWbT+P8KsVnVZtP4/wqxWdVm0/j/CrFZ1WbT+P8KsVX+yf7f6Uf8ev+1u/Cj7X/sfrR9k/2/0o/wCPX/a3fhR9r/2P1o+yf7f6Uf8AHr/tbvwo+1/7H60fZP8Ab/Sj/j1/2t34Ufa/9j9asVXu/wCD8arVo1Xu/wCD8arVo1Xu/wCD8arVo1Xu/wCD8arUVZtP4/wqxWdVm0/j/CrFZ1WbT+P8KsVnVZtP4/wqxVf7J/t/pR/x6/7W78KPtf8AsfrR9k/2/wBKP+PX/a3fhR9r/ANj9aPsn+3+lH/Hr/tbvwo+1/wCx+tH2T/b/AEo/49f9rd+FH2v/AGP1qxVe7/g/Gq1aNV7v+D8arVo1Xu/4PxqtWjVe7/g/Gq1FWbT+P8KsVnVZtP4/wqxWdVm0/j/CrFZ1WbT+P8KsVX+yf7f6Uf8AHr/tbvwo+1/7H60fZP8Ab/Sj/j1/2t34Ufa/9j9aPsn+3+lH/Hr/ALW78KPtf+x+tH2T/b/Sj/j1/wBrd+FH2v8A2P1qxVe7/g/Gq1aNV7v+D8arVo1Xu/4PxqtWjVe7/g/Gq1FWbT+P8KsVnVZtP4/wqxWdVm0/j/CrFZ1WbT+P8KsVX+yf7f6Uf8ev+1u/Cj7X/sfrR9k/2/0o/49f8Aa3fhR9r/2P1o+yf7f6Uf8AHr/tbvwo+1/7H60fZP8Ab/Sj/j1/2t34Ufa/9j9asVXu/wCD8arVo1Xu/wCD8arVo1Xu/wCD8arVo1Xu/wCD8arUVZtP4/wqxWdVm0/j/CrFZ1WbT+P8KsVnVZtP4/wqxX//2Q==";
  return new Uint8Array(Buffer.from(b64, "base64"));
}
const imageBytes = syntheticImage();

const results = [];
const failed = [];
const t = (name, ok, detail = "") => {
  results.push({ name, status: ok ? "PASS" : "FAIL", detail });
  if (!ok) failed.push(name);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : ` << ${detail}`}`);
};

const freePort = async () => {
  const s = createServer();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const { port } = s.address();
  s.close();
  await once(s, "close");
  return port;
};

/** 起一个子进程并等它自己报"我好了"；超时或提前退出即前置失败（退出码 2，不给部分绿） */
const start = (script, args, marker, env = {}) => new Promise((resolve_, reject) => {
  const child = spawn(process.execPath, [join(ROOT, script), ...args], {
    cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let settled = false;
  const done = (fn, value) => { if (!settled) { settled = true; fn(value); } };
  const onData = (buf) => { out += String(buf); if (out.includes(marker)) done(resolve_, { child, out }); };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("exit", (code) => { if (!settled) done(reject, new Error(`${script} 提前退出（码 ${code}）：${out.slice(0, 400)}`)); });
  setTimeout(() => done(reject, new Error(`${script} 30 秒内没报「${marker}」：${out.slice(0, 400)}`)), 30_000).unref();
});
const kill = async (child) => {
  if (!child || child.exitCode !== null || child.signalCode) return;
  const gone = new Promise((r) => child.once("exit", r));
  child.kill("SIGTERM");
  await Promise.race([gone, new Promise((r) => setTimeout(r, 3000))]);
};
/** 跑一条命令到它自己结束：拒起服务的形状 8 秒内会以码 2 回来，正常起服务则一直活着 */
const runOnce = (args, env, holdMs = 3500) => new Promise((r) => {
  const c = spawn(process.execPath, [join(ROOT, "dev/local-app/server.mjs"), ...args], {
    cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  c.stdout.on("data", (b) => { out += String(b); });
  c.stderr.on("data", (b) => { out += String(b); });
  c.on("exit", (code) => r({ code, out }));
  setTimeout(() => { if (c.exitCode === null) { c.kill("SIGKILL"); } r({ code: null, out }); }, holdMs).unref();
});
const uuid = () => {
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Buffer.from(b).toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
/** 落盘是防抖的（120ms），所以核对磁盘要等而不是假定"写完了一定在"——否则测的是竞态不是行为 */
const waitFor = async (fn, ms = 2500) => {
  const until = Date.now() + ms;
  for (;;) {
    if (fn()) return true;
    if (Date.now() > until) return false;
    await new Promise((r) => setTimeout(r, 80));
  }
};

const imageSha = createHash("sha256").update(imageBytes).digest("hex");

const children = [];
let exitCode = 0;
try {
  const modelPort = await freePort();
  const serverPort = await freePort();
  const sparePort = await freePort();
  const model = await start("dev/local-app/fake-model.mjs", [String(modelPort)], "[local-fake-model]");
  children.push(model.child);

  const aiEndpoint = `http://127.0.0.1:${modelPort}/v1/chat/completions`;
  const keyEnv = { E2E_LOCAL_MODEL_KEY: "e2e-fake-key-not-a-secret" };
  const bootArgs = (port) => ["--port", String(port), "--loopback-only", "--data", DATA_DIR, "--passcode", PASSCODE,
    "--ai-endpoint", aiEndpoint, "--key-env", "E2E_LOCAL_MODEL_KEY"];
  const boot = await start("dev/local-app/server.mjs", [...bootArgs(serverPort), "--ai-timeout", "8000"], "本机识别链路", keyEnv);
  children.push(boot.child);

  const BASE = `http://127.0.0.1:${serverPort}`;
  let cookie = "";
  const api = async (action, body, extra = "") => {
    const res = await fetch(`${BASE}/functions/v1/app?action=${action}${extra}`, {
      method: body ? "POST" : "GET",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const putObject = (signedUrl) => fetch(`${BASE}${signedUrl}`, {
    method: "PUT", headers: { "content-type": "image/jpeg", cookie }, body: imageBytes,
  });

  // ── 1～5 口令门 ────────────────────────────────────────────────────────────
  const anonPage = await fetch(`${BASE}/`);
  const anonText = await anonPage.text();
  t("01 未登录：首页不是产品本体而是口令页（401）",
    anonPage.status === 401 && anonText.includes("口令") && !anonText.includes('<div id="root"'), `status=${anonPage.status}`);
  const anonMe = await api("me");
  t("02 未登录：数据接口回 401 login_required（不是空数据、不是 200）",
    anonMe.status === 401 && anonMe.body?.error === "login_required", JSON.stringify(anonMe.body));
  const anonPut = await fetch(`${BASE}/_local/object/docs/abcd1234/deadbeef.jpg`, { method: "PUT", body: imageBytes });
  t("03 未登录：签名上传地址也不能写（401）", anonPut.status === 401, `status=${anonPut.status}`);
  const wrong = await fetch(`${BASE}/__qoder_auth/passcode`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "passcode=wrong-on-purpose",
  });
  const wrongCookies = (wrong.headers.getSetCookie?.() ?? []).join(";");
  t("04 口令不对：401 且不发会话 cookie",
    wrong.status === 401 && !wrongCookies.includes("jyj_local_session="), `status=${wrong.status}`);
  const login = await fetch(`${BASE}/__qoder_auth/passcode`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `passcode=${PASSCODE}`, redirect: "manual",
  });
  const setCookie = (login.headers.getSetCookie?.() ?? []).find((c) => c.startsWith("jyj_local_session="));
  if (setCookie) cookie = setCookie.split(";")[0];
  t("05 口令对：302 并发出 HttpOnly＋SameSite=Lax 的会话 cookie",
    login.status === 302 && Boolean(cookie) && /HttpOnly/i.test(setCookie ?? "") && /SameSite=Lax/i.test(setCookie ?? ""),
    `status=${login.status} cookie=${setCookie ?? "无"}`);

  // ── 6～9 登录后：发的是本次产物，业务走线上那份 handler ───────────────────
  const page = await fetch(`${BASE}/`, { headers: { cookie } });
  const pageText = await page.text();
  const entry = /assets\/(index-[A-Za-z0-9_-]+\.js)/.exec(pageText)?.[1] ?? "";
  t("06 登录后：首页就是构建产物本体（现读入口名）",
    page.status === 200 && pageText.includes('<div id="root"') && Boolean(entry), `status=${page.status} 入口=${entry || "没读到"}`);
  const me = await api("me");
  t("07 产品那套鉴权在本机也通：me 回本机账户",
    me.status === 200 && me.body?.ok === true && Boolean(me.body?.user?.id), JSON.stringify(me.body).slice(0, 160));
  const taskId = uuid();
  const basePayload = {
    patientLabel: "本机链路自测", purpose: "端到端", dept: "", visitDate: "",
    createdAt: NOW, updatedAt: NOW, documents: [], fields: [], questions: [], sheetHidden: [], audit: [],
  };
  const saved = await api("task-save", { id: taskId, payload: basePayload });
  t("08 task-save 新建任务（真 handler＋真 validate＋落盘）",
    saved.status === 200 && saved.body?.ok === true, JSON.stringify(saved.body).slice(0, 200));
  const onDisk = await waitFor(() => existsSync(join(DATA_DIR, "tables.json"))
    && readFileSync(join(DATA_DIR, "tables.json"), "utf8").includes(taskId));
  t("09 落盘可核：tables.json 里确实有这一行（防抖写盘之后）", onDisk, "等 2.5 秒仍找不到该任务 id");

  // ── 10～14 上传与原件 ──────────────────────────────────────────────────────
  const intent = await api("upload-intent", { taskId, name: "e2e.jpg", mime: "image/jpeg", size: imageBytes.byteLength });
  t("10 upload-intent 给回同源签名地址",
    intent.status === 200 && intent.body?.docId && String(intent.body?.signedUrl ?? "").startsWith("/_local/object/"),
    JSON.stringify(intent.body).slice(0, 200));
  const put = await putObject(intent.body.signedUrl);
  t("11 PUT 原件进本机对象存储（合成件 219KB）", put.status === 200, `status=${put.status}`);
  const complete = await api("upload-complete", { docId: intent.body.docId });
  t("12 upload-complete 按真实字节记账（服务端下载回来的字节数＝发出去的）",
    complete.status === 200 && complete.body?.size === imageBytes.byteLength, JSON.stringify(complete.body));
  const signed = await (await fetch(`${BASE}/functions/v1/app?action=file-url&docId=${intent.body.docId}`, { headers: { cookie } })).json();
  t("13 file-url 给回可读地址", signed?.ok === true && String(signed.url ?? "").startsWith("/_local/object/"), JSON.stringify(signed).slice(0, 160));
  const backBytes = new Uint8Array(await (await fetch(`${BASE}${signed.url}`, { headers: { cookie } })).arrayBuffer());
  t("14 取回的原件与发出去的逐字节相同（sha256 对死）",
    backBytes.byteLength === imageBytes.byteLength && createHash("sha256").update(backBytes).digest("hex") === imageSha,
    `取回 ${backBytes.byteLength}B`);

  // ── 15～19 识别：请求真发出去、SSE 真收回来、结果一律停待确认 ──────────────
  const b64 = Buffer.from(imageBytes).toString("base64");
  const started = await api("extract-start", { docId: intent.body.docId, mediaType: "image/jpeg", imageBase64: b64 });
  t("15 extract-start 拿到 jobId", started.status === 200 && Boolean(started.body?.jobId), JSON.stringify(started.body).slice(0, 200));
  const poll = async (jobId) => {
    if (!jobId) return { state: "no_jobId" };
    for (let i = 0; i < 40; i += 1) {
      const s = await (await fetch(`${BASE}/functions/v1/app?action=extract-status&jobId=${jobId}`, { headers: { cookie } })).json().catch(() => null);
      if (!s?.ok && s?.error) return { state: "接口报错", code: s.error };   // 不把"请求本身失败"演成"还在跑"
      if (s?.state === "completed" || s?.state === "failed") return s;
      await new Promise((r) => setTimeout(r, 300));
    }
    return { state: "pending" };
  };
  const status = await poll(started.body.jobId);
  const fields = status?.result?.fields ?? [];
  t("16 识别完成：SSE 收流＋真 parseAgentJson＋真 normalizeResult 全跑过",
    status?.state === "completed" && Array.isArray(fields) && fields.length > 0,
    `state=${status?.state} code=${status?.code ?? ""} 字段=${fields.length}`);
  t("17 红线：识别结果一律停在待确认，绝不自动入单",
    fields.length > 0 && fields.every((f) => (f.confirmStatus ?? "pending") === "pending"),
    fields.filter((f) => (f.confirmStatus ?? "pending") !== "pending").map((f) => f.label).join(","));
  t("18 诚实披露：打到回环假端点时 modelKind 必须是 test（不能报 real）",
    status?.modelKind === "test", `modelKind=${status?.modelKind}`);
  const modelState = await (await fetch(`http://127.0.0.1:${modelPort}/_fake/state`)).json().catch(() => null);
  t("19 假端点确实收到过这一单，且核过产品提示词／stream／图片三项",
    (modelState?.requests ?? 0) >= 1 && (modelState?.promptMismatch ?? 0) === 0 && (modelState?.imageMissing ?? 0) === 0,
    JSON.stringify(modelState));

  // ── 20 越界防护那一格在本机链路上不是"另外一套"：走的就是产品里那份解析与闸门 ─
  const declared = await fetch(`http://127.0.0.1:${modelPort}/_default`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scenario: "refuse" }),
  });
  const doc2 = await api("upload-intent", { taskId, name: "e2e2.jpg", mime: "image/jpeg", size: imageBytes.byteLength });
  await putObject(doc2.body.signedUrl);
  await api("upload-complete", { docId: doc2.body.docId });
  const started2 = await api("extract-start", { docId: doc2.body.docId, mediaType: "image/jpeg", imageBase64: b64 });
  // 同步通路（llm）在 `extract-start` 那一刻就把整单跑完，所以"模型拒答"这一档**当场回 503**、
  // 带的是产品自己那个 `ai_refused@refusal` 阶段码——而不是硬造一个"空结果"让界面显示出几个字段来。
  const detail2 = String(started2.body?.detail ?? "");
  t("20 模型拒答那一档在本机链路上如实失败、不硬凑成结果（阶段码走的是产品那份解析与闸门）",
    declared.status === 200 && started2.status === 503 && started2.body?.error === "ai_service_unavailable"
    && /ai_refused@refusal/.test(detail2) && !started2.body?.jobId,
    `declare=${declared.status} start2=${started2.status} ${JSON.stringify(started2.body ?? {}).slice(0, 120)}`);
  await fetch(`http://127.0.0.1:${modelPort}/_default`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scenario: "" }),
  });

  // ── 21 对象地址不是文件浏览器 ──────────────────────────────────────────────
  const escapePut = await fetch(`${BASE}/_local/object/${encodeURIComponent("../../escape-probe.txt")}`, {
    method: "PUT", headers: { "content-type": "text/plain", cookie }, body: "x",
  });
  const escapeGet = await fetch(`${BASE}/_local/object/${encodeURIComponent("../../package.json")}`, { headers: { cookie } });
  const escapeBody = await escapeGet.text();
  t("21 路径穿越被拒：写 400、读拿不到目录外文件",
    escapePut.status === 400 && (escapeGet.status === 404 || !escapeBody.includes('"dependencies"')),
    `PUT=${escapePut.status} GET=${escapeGet.status}`);

  // ── 22～26 R141 那一格搬到真进程这条路上：同一张图三次失败之后，第四次不许再花钱，也不许报成数据库坏了 ──
  // 20 那条已经证过一次「拒答当场 503＋带阶段码」；这一组要的是**幂等位次用尽之后**的形状，
  // 而且核的是本机服务器**真落盘**的那份作业表与假端点**自己的计数**——夹具绿不算绿（R123 立这条 e2e 的理由）。
  const setScenario = async (name) => (await fetch("http://127.0.0.1:" + modelPort + "/_default", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scenario: name }),
  })).status;
  const modelCount = async () => (await (await fetch("http://127.0.0.1:" + modelPort + "/_fake/state")).json().catch(() => null)) ?? {};
  const jobsOnDisk = async (docId, limit = 50) => {
    // 落盘是**去抖**写的（scheduleFlush 120ms），而建行的那一刻与"失败回写"是两笔：读到"建行后、回写前"那份快照就会看见一条 pending。
    // 所以要等到**这一批都落成终态**再判（R74 那条老纪律：不记得≠没有，没等够≠没发生）；等不到就用最后读到的那份去判——真卡住仍然会红，不会被掩盖。
    // 窗口取 50×200ms＝10s：单跑几百毫秒就落定，这道余量是给**整机重载**留的——完整 logic.test 会连起多个子进程，
    //   去抖写盘被拉长，4s 老窗口会偶发读到 pending 行让 test 25 假红（2026-10-16 实测：干净环境下也间歇复犯，
    //   是真实负载时序，不是环境注入噪音）。加宽不放松判据——落不成终态照样红，只是不再把"慢"误报成"产品坏"。
    const file = join(DATA_DIR, "tables.json");
    let rows = [];
    for (let i = 0; i < limit; i += 1) {
      const t2 = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
      rows = (t2.extract_jobs ?? []).filter((r) => r.doc_id === docId);
      if (rows.length && rows.every((r) => r.state === "failed" || r.state === "completed")) return rows;
      await new Promise((r) => setTimeout(r, 200));
    }
    return rows;
  };

  const declare141 = await setScenario("refuse");
  const doc141 = await api("upload-intent", { taskId, name: "e2e-exhaust.jpg", mime: "image/jpeg", size: imageBytes.byteLength });
  await putObject(doc141.body.signedUrl);
  await api("upload-complete", { docId: doc141.body.docId });
  const rounds141 = [];
  for (let i = 0; i < 3; i += 1) rounds141.push(await api("extract-start", { docId: doc141.body.docId, mediaType: "image/jpeg", imageBase64: b64 }));
  t("22 同一张图三次发起各占一个位次、每次都如实回当次成因（真进程这条路上也是 503＋阶段码，不塌成一个万能串）",
    declare141 === 200 && rounds141.every((r) => r.status === 503 && r.body?.error === "ai_service_unavailable"
      && /ai_refused@/.test(String(r.body?.detail ?? "")) && !r.body?.jobId),
    JSON.stringify(rounds141.map((r) => r.status + "/" + String(r.body?.detail ?? r.body?.error ?? ""))).slice(0, 240));

  const diskBefore = await jobsOnDisk(doc141.body.docId);
  const modelBefore = await modelCount();
  const fourth141 = await api("extract-start", { docId: doc141.body.docId, mediaType: "image/jpeg", imageBase64: b64 });
  const modelAfter = await modelCount();
  const detail141 = String(fourth141.body?.detail ?? "");
  t("23 位次用尽后的第四次回 409 extract_retry_exhausted、不再发 jobId，detail 的头是码、尾是那几行里记着的阶段",
    fourth141.status === 409 && fourth141.body?.error === "extract_retry_exhausted" && !fourth141.body?.jobId &&
      /^extract_retry_exhausted@[a-z0-9_]+$/.test(detail141) && /refusal/.test(detail141),
    "status=" + fourth141.status + " " + JSON.stringify(fourth141.body ?? {}).slice(0, 160));
  t("24 第四次模型侧一个新请求都不发、一分积分都不花（假端点自己报的 requests／creditsSpent 前后一字不动）＝「同一张图最多烧三次」在真通路上真兜住了",
    (modelBefore.requests ?? -1) === (modelAfter.requests ?? -2) && (modelBefore.creditsSpent ?? -1) === (modelAfter.creditsSpent ?? -2) &&
      (modelAfter.requests ?? 0) >= 5,
    JSON.stringify({ 前: { r: modelBefore.requests, c: modelBefore.creditsSpent }, 后: { r: modelAfter.requests, c: modelAfter.creditsSpent } }));
  const diskAfter = await jobsOnDisk(doc141.body.docId);
  t("25 落盘那本账上：这三轮只多出 3 条 failed、第四次没有再建行，也没有 id 为空的幽灵行（夹具那份收 null 主键的引擎今天正是漏掉的那一半）",
    diskBefore.length === 3 && diskAfter.length === 3 && diskAfter.every((r) => r.state === "failed" && typeof r.id === "string" && r.id.length > 0),
    JSON.stringify({ 前三次后: diskBefore.length, 第四次后: diskAfter.length, 状态: diskAfter.map((r) => r.state).join(","), 空id行: diskAfter.filter((r) => !r.id).length }));

  // 先把它换回"能认出来"那一档再发这一单：否则"换一张照常受理"那条正样本测的仍是拒答（仪器自己不合格）
  await setScenario("");
  const docAlt141 = await api("upload-intent", { taskId, name: "e2e-alt.jpg", mime: "image/jpeg", size: imageBytes.byteLength });
  await putObject(docAlt141.body.signedUrl);
  await api("upload-complete", { docId: docAlt141.body.docId });
  const altStart141 = await api("extract-start", { docId: docAlt141.body.docId, mediaType: "image/jpeg", imageBase64: b64 });
  const altPoll141 = await poll(altStart141.body?.jobId);
  const altFields = altPoll141?.result?.fields ?? [];
  t("26 正样本：换一张资料（新幂等键）后同一张图仍能正常发起并拿到结果——这道闸挡的是「反复烧同一张」，不是识别本身",
    altStart141.status === 200 && Boolean(altStart141.body?.jobId) && altPoll141?.state === "completed" && altFields.length > 0,
    JSON.stringify({ start: altStart141.status, state: altPoll141?.state, 字段: altFields.length }).slice(0, 200));

  // ── 27～28 重启之后还在（这才叫本机服务器，不是内存玩具）──────────────────
  await kill(boot.child);
  const boot2 = await start("dev/local-app/server.mjs", bootArgs(serverPort), "本机识别链路", keyEnv);
  children.length = 0;
  children.push(model.child, boot2.child);
  const tasksAfter = await api("tasks");
  t("27 重启后任务还在（从磁盘读回，不是内存残留）",
    tasksAfter.status === 200 && (tasksAfter.body?.tasks ?? []).some((x) => x?.payload?.patientLabel === "本机链路自测"),
    JSON.stringify(tasksAfter.body).slice(0, 160));
  const signedAgain = await (await fetch(`${BASE}/functions/v1/app?action=file-url&docId=${intent.body.docId}`, { headers: { cookie } })).json();
  const backAgain = new Uint8Array(await (await fetch(`${BASE}${signedAgain.url}`, { headers: { cookie } })).arrayBuffer());
  t("28 重启后原件仍能逐字节取回（对象存储真的落盘）",
    createHash("sha256").update(backAgain).digest("hex") === imageSha, `取回 ${backAgain.byteLength}B`);

  // ── 29～31 三条"配置不对就不起"（宁可不起来，也不带着错配置跑）────────────
  const repoData = await runOnce(["--port", String(sparePort), "--data", join(ROOT, "e2e-escape-data"), "--passcode", "x"], {});
  t("29 数据目录指进仓库 ⇒ 拒起服务（退出码 2）：真实病历不许躺在随包外发的面里",
    repoData.code === 2 && repoData.out.includes("数据目录在仓库内"), `code=${repoData.code}`);
  const noKey = await runOnce(["--port", String(sparePort), "--data", DATA_DIR, "--passcode", PASSCODE,
    "--ai-endpoint", aiEndpoint, "--key-env", "E2E_LOCAL_MODEL_KEY"], { E2E_LOCAL_MODEL_KEY: "" });
  t("30 给了端点但环境变量里的 key 是空的 ⇒ 拒起服务（不静默降级成假通路）",
    noKey.code === 2 && noKey.out.includes("拒绝"), `code=${noKey.code}`);
  const httpRemote = await runOnce(["--port", String(sparePort), "--data", DATA_DIR, "--passcode", PASSCODE,
    "--ai-endpoint", "http://example.com/v1/chat/completions", "--key-env", "K"], { K: "x" });
  t("31 端点校验用的是产品那一条口径：非 https 的公网地址 ⇒ 拒起服务",
    httpRemote.code === 2 && httpRemote.out.includes("拒绝"), `code=${httpRemote.code}`);

  // ── 32～33 ai-ping 在本机通路上现在给得出读数（R144 之前它只会回 llm_probe_missing：那条通路压根没有探针）
  const ping32 = await api("ai-ping");
  const b32 = ping32.body ?? {};
  t("32 ai-ping：本机通路现在答得出「配没配上」——ok:true・probed:false（这份传输层一个字节都不发）・outcome=config_ok・endpoint 只报形状（回环为真、协议 http）",
    ping32.status === 200 && b32.ok === true && b32.probed === false && b32.outcome === "config_ok" &&
      b32.adapter === "cloud-llm" && b32.endpoint?.loopback === true && b32.endpoint?.protocol === "http" &&
      b32.key?.configured === true && b32.key?.length > 0,
    JSON.stringify(b32).slice(0, 220));
  t("33 同一份读数里不许出现端点原文与 key 本体（它会回浏览器，也会进证据件）",
    !JSON.stringify(b32).includes("://") && !JSON.stringify(b32).includes("e2e-fake-key") &&
      !Object.keys(b32.endpoint ?? {}).includes("host"),
    JSON.stringify(b32).slice(0, 160));
  // ── 34 限流（最后测：它会挡住后续登录）────────────────────────────────────
  let last = null;
  for (let i = 0; i < 10; i += 1) {
    last = await fetch(`${BASE}/__qoder_auth/passcode`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "passcode=guess",
    });
    await last.text();
    if (last.status === 429) break;
  }
  t("34 连错口令到阈值后回 429（不是可以无限慢慢试）", last?.status === 429, `status=${last?.status}`);
} catch (error) {
  console.error(`前置失败：${error?.message ?? error}`);
  exitCode = 2;
} finally {
  for (const c of children) await kill(c);
  if (!KEEP) rmSync(DATA_DIR, { recursive: true, force: true });
}

const pass = results.filter((r) => r.status === "PASS").length;
console.log(`\n本机链路端到端：${pass}/${results.length} 通过${failed.length ? `｜失败：${failed.join(" / ")}` : ""}`);
if (!results.length) console.log("（一条断言都没跑成 ⇒ 无从判定，退出码 2）");
if (exitCode === 0 && (!results.length || failed.length === results.length)) exitCode = 2;
else if (exitCode === 0 && failed.length) exitCode = 1;
console.log(`RESULT: ${exitCode === 0 ? "PASS" : exitCode === 2 ? "无结论" : "FAIL"}`);
process.exit(exitCode);
