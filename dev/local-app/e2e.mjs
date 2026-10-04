// 就医笺 · 本机识别链路的端到端自证（R123）。
//
// 这条脚本存在的理由：`dev/local-app/server.mjs` 是"给家属在自己电脑上跑"的东西，
// 它坏了不会有人收到一条红判据，只会有一位在诊室里打不开页面的家属。所以这里跑的是
// **真进程、真 HTTP、真落盘、真重启**，而不是把 handler 拉进内存假装走过。
//
// 全程不出本机：模型端点是 `dev/local-app/fake-model.mjs`（只绑 127.0.0.1），
// 用的图片是仓库里那份标着 synthetic 的合成件（`dev/real-samples/prep/fx-ct-report-20260926.jpg`），不是真实病历。
//
// 用法：node dev/local-app/e2e.mjs [--keep]   （--keep 保留临时数据目录给人工复查）
// 三态退出码：0 全过｜1 有断言红｜2 前置不满足（起不来进程／找不到合成件／一条断言都没跑成）——绝不给部分绿。
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
const { scopedTempName } = await import("../regression/mutant-paths.mjs");

const KEEP = process.argv.includes("--keep");
// 数据目录按 R123 那条闸门**必须在仓库外**（本机服务器自己会拒仓库内目录，e2e 不能例外于被测方的规矩），
// 又按 R120/R121 那条规矩必须按 pid 命名并在收场删干净——落点选系统临时目录。
const DATA_DIR = resolve(tmpdir(), scopedTempName("jyj-r123-e2e-data", process.pid));
const PASSCODE = `e2e-${process.pid}`;
const IMAGE = join(ROOT, "dev/real-samples/prep/fx-ct-report-20260926.jpg");
const NOW = "2026-10-03T00:00:00.000Z";

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

if (!existsSync(IMAGE)) {
  console.error(`前置不满足：找不到合成件 ${IMAGE} —— 端到端要拿它跑真上传＋真识别，不用真实病历。`);
  process.exit(2);
}
const imageBytes = new Uint8Array(readFileSync(IMAGE));
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

  // ── 22～23 重启之后还在（这才叫本机服务器，不是内存玩具）──────────────────
  await kill(boot.child);
  const boot2 = await start("dev/local-app/server.mjs", bootArgs(serverPort), "本机识别链路", keyEnv);
  children.length = 0;
  children.push(model.child, boot2.child);
  const tasksAfter = await api("tasks");
  t("22 重启后任务还在（从磁盘读回，不是内存残留）",
    tasksAfter.status === 200 && (tasksAfter.body?.tasks ?? []).some((x) => x?.payload?.patientLabel === "本机链路自测"),
    JSON.stringify(tasksAfter.body).slice(0, 160));
  const signedAgain = await (await fetch(`${BASE}/functions/v1/app?action=file-url&docId=${intent.body.docId}`, { headers: { cookie } })).json();
  const backAgain = new Uint8Array(await (await fetch(`${BASE}${signedAgain.url}`, { headers: { cookie } })).arrayBuffer());
  t("23 重启后原件仍能逐字节取回（对象存储真的落盘）",
    createHash("sha256").update(backAgain).digest("hex") === imageSha, `取回 ${backAgain.byteLength}B`);

  // ── 24～26 三条"配置不对就不起"（宁可不起来，也不带着错配置跑）────────────
  const repoData = await runOnce(["--port", String(sparePort), "--data", join(ROOT, "e2e-escape-data"), "--passcode", "x"], {});
  t("24 数据目录指进仓库 ⇒ 拒起服务（退出码 2）：真实病历不许躺在随包外发的面里",
    repoData.code === 2 && repoData.out.includes("数据目录在仓库内"), `code=${repoData.code}`);
  const noKey = await runOnce(["--port", String(sparePort), "--data", DATA_DIR, "--passcode", PASSCODE,
    "--ai-endpoint", aiEndpoint, "--key-env", "E2E_LOCAL_MODEL_KEY"], { E2E_LOCAL_MODEL_KEY: "" });
  t("25 给了端点但环境变量里的 key 是空的 ⇒ 拒起服务（不静默降级成假通路）",
    noKey.code === 2 && noKey.out.includes("拒绝"), `code=${noKey.code}`);
  const httpRemote = await runOnce(["--port", String(sparePort), "--data", DATA_DIR, "--passcode", PASSCODE,
    "--ai-endpoint", "http://example.com/v1/chat/completions", "--key-env", "K"], { K: "x" });
  t("26 端点校验用的是产品那一条口径：非 https 的公网地址 ⇒ 拒起服务",
    httpRemote.code === 2 && httpRemote.out.includes("拒绝"), `code=${httpRemote.code}`);

  // ── 27 限流（最后测：它会挡住后续登录）────────────────────────────────────
  let last = null;
  for (let i = 0; i < 10; i += 1) {
    last = await fetch(`${BASE}/__qoder_auth/passcode`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "passcode=guess",
    });
    await last.text();
    if (last.status === 429) break;
  }
  t("27 连错口令到阈值后回 429（不是可以无限慢慢试）", last?.status === 429, `status=${last?.status}`);
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
