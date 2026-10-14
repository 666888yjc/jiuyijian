// 就医笺 · 本机识别链路（R123·方案 1）：一条命令在自己电脑上起一整套——同一个端口既发前端产物、
// 又接住前端发给 `/functions/v1/app` 的全部动作，数据与原件落在这台电脑的磁盘上，识别把图片送到
// **你自己指定的**一个 OpenAI 兼容端点。不依赖 Qoder 站点配置，也不依赖任何已经退出的第三方。
//
// 用法（Git Bash，node 不在 PATH 时用绝对路径）：
//   export PATH="<你本机 node22 的目录>:$PATH"
//   JYJ_LOCAL_MODEL_KEY=…… node dev/local-app/server.mjs \
//       --ai-endpoint https://那一家/v1/chat/completions --model 那家的模型名
//   手机与电脑连同一家 WiFi → 打开日志里那条 http://192.168.x.x:4340/ → 输口令。
//
// 三条结构上的选择（都不是随手写的）：
// · **业务逻辑一行不新写**：跑的就是线上那份 `functions/handler.mjs`，装配走 `functions/adapters.mjs`
//   那唯一一份工厂；查询引擎与对象存储用 `dev/backend-local/{supabase-lite,object-store}.mjs`——
//   与回归夹具同一份实现，所以"夹具绿而本机服务器另一套"这种漂移在结构上进不来（R35 那一族的正解）。
// · **暴露面默认保守**：整站（含产物）都要口令；数据接口再叠一层同一道口令的 cookie；`0.0.0.0` 只在
//   你显式不加 `--loopback-only` 时才绑。口令只存盐化哈希，会话是不落盘到期签名串（HMAC）。
// · **病历不进仓库**：数据目录若解析到仓库内直接拒起（退出码 2）。这条不是提示，是闸门——
//   本项目做过两次隐私回扫，最贵的一次就是"标着合成的文件里其实装着真病历"。
import { createServer } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DEV_ROOT = resolve(fileURLToPath(new URL("./", import.meta.url)), "..");
const REPO_ROOT = resolve(DEV_ROOT, "..");

const argv = process.argv.slice(2);
const flag = (name, fallback = "") => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : (argv.includes(`--${name}`) ? "" : fallback);
};
const has = (name) => argv.includes(`--${name}`);

const PORT = Number(flag("port", process.env.JYJ_LOCAL_PORT || "4340"));
const HOST = has("loopback-only") ? "127.0.0.1" : (flag("host", process.env.JYJ_LOCAL_HOST || "0.0.0.0"));
const DATA_DIR = resolve(flag("data", process.env.JYJ_LOCAL_DATA_DIR || join(homedir(), "jiuyijian-local")));
const KEY_ENV = flag("key-env", "JYJ_LOCAL_MODEL_KEY");
const AI_ENDPOINT = flag("ai-endpoint", process.env.JYJ_LOCAL_MODEL_ENDPOINT || "");
const AI_AUTH_STYLE = flag("auth-style", process.env.JYJ_LOCAL_MODEL_AUTH_STYLE || "bearer");
const MODEL_NAME = flag("model", process.env.JYJ_LOCAL_MODEL || "");
const AI_TIMEOUT_MS = Number(flag("ai-timeout", process.env.JYJ_LOCAL_MODEL_TIMEOUT || "60000"));

const die = (message) => { console.error(message); process.exit(2); };

// 数据目录不许落在仓库里（见文件顶第三条）：解析成绝对路径之后比前缀，不看"像不像"。
if (DATA_DIR === REPO_ROOT || DATA_DIR.startsWith(REPO_ROOT + sep)) {
  die(`拒绝：数据目录在仓库内（${DATA_DIR}）。真实病历与原件一旦进了仓库就会被随包外发的东西带走——` +
    "本项目为这类事故做过两次隐私回扫。换个目录：--data C:/Users/你/jiuyijian-local");
}
mkdirSync(DATA_DIR, { recursive: true });

const { createHandler } = await import("../../functions/handler.mjs");
const { makeExtractFactory } = await import("../../functions/adapters.mjs");
const { makeUsageLedger } = await import("../../functions/usage-ledger.mjs");
const { QUOTA_DEFAULTS } = await import("../../functions/quota.mjs");
const { MAX_UPLOAD_BYTES } = await import("../../functions/validate.mjs");
const { CloudAgentsError } = await import("../../functions/cloud-agents.mjs");
const { makeSupabaseLite, makeEmptyTables, hydrateTables, TABLE_NAMES } = await import("../backend-local/supabase-lite.mjs");
const { makeObjectStore } = await import("../backend-local/object-store.mjs");
const { assertModelEndpoint, makeOpenAiCompatChat } = await import("../backend-local/openai-chat.mjs");
// 回环名单只用产品那一份（R144）：这里再写一份数组，就等于允许它哪天与栅栏悄悄不一致
const { isLoopbackHost } = await import("../../functions/cloud-llm-http.mjs");
const { resolveDistRoot, distCandidatesReport, serveStatic, MIME } = await import("../backend-local/static.mjs");

// ---------- 落盘：表 ----------
const tablesFile = join(DATA_DIR, "tables.json");
const tables = makeEmptyTables();
if (existsSync(tablesFile)) {
  try {
    hydrateTables(tables, JSON.parse(readFileSync(tablesFile, "utf8")));
  } catch (error) {
    die(`拒绝：读不动 ${tablesFile}（${error?.message}）。这里不做"当它是空的"处理——静默清空会吃掉已经录进去的病历。`);
  }
}
let flushTimer = null;
const flushTables = () => {
  const out = {};
  for (const name of TABLE_NAMES) out[name] = tables[name];
  const tmp = `${tablesFile}.tmp`;
  writeFileSync(tmp, JSON.stringify(out));
  renameSync(tmp, tablesFile);
};
const scheduleFlush = () => {
  if (flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = null; try { flushTables(); } catch (e) { console.error(`落盘失败：${e?.message}`); } }, 120);
  flushTimer?.unref?.();
};
const { client: supabase } = makeSupabaseLite({ tables, onChange: scheduleFlush });

// ---------- 落盘：原件 ----------
const store = makeObjectStore({ dir: join(DATA_DIR, "objects"), maxSizeBytes: MAX_UPLOAD_BYTES, urlPrefix: "/_local/object" });

// ---------- 口令与会话 ----------
const authFile = join(DATA_DIR, "auth.json");
const readJson = (file, fallback) => {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return fallback; }
};
const sha = (s) => createHash("sha256").update(String(s)).digest("hex");
const GIVEN_PASSCODE = flag("passcode", process.env.JYJ_LOCAL_PASSCODE || "");
const auth = readJson(authFile, null) ?? (() => {
  const passcode = GIVEN_PASSCODE || randomBytes(9).toString("base64url");
  const salt = randomBytes(16).toString("hex");
  const created = { salt, hash: sha(salt + passcode), secret: randomBytes(32).toString("hex"), createdAt: new Date().toISOString() };
  writeFileSync(authFile, JSON.stringify(created, null, 2));
  // 口令本身不落盘（落的是盐化哈希）；只有"这次现生成"的那种才把它交给屏幕打印一次
  return { ...created, passcode: GIVEN_PASSCODE ? "" : passcode };
})();

const cookieName = "jyj_local_session";
const SESSION_HOURS = Number(flag("session-hours", process.env.JYJ_LOCAL_SESSION_HOURS || "72"));
const sessionValue = (expMs) => `${expMs}.${createHmac(expMs)}`;
function createHmac(expMs) {
  return createHash("sha256").update(`${auth.secret}|${expMs}`).digest("hex");
}
const parseCookies = (header) => Object.fromEntries(String(header || "").split(";").map((p) => p.trim()).filter(Boolean).map((p) => {
  const i = p.indexOf("=");
  return [p.slice(0, i), decodeURIComponent(p.slice(i + 1))];
}));
const sessionOk = (req) => {
  const value = parseCookies(req.headers.cookie)[cookieName];
  if (!value || !value.includes(".")) return false;
  const [expRaw, macRaw] = value.split(".");
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const expect = createHmac(exp);
  const a = Buffer.from(expect, "utf8");
  const b = Buffer.from(String(macRaw), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
};
const attempts = new Map();
const rateLimited = (ip) => {
  const now = Date.now();
  const rec = attempts.get(ip) ?? { n: 0, until: 0 };
  if (rec.until > now) return true;
  return rec.n >= 8;
};
const noteAttempt = (ip, ok) => {
  const now = Date.now();
  const rec = attempts.get(ip) ?? { n: 0, until: 0 };
  if (ok) { attempts.set(ip, { n: 0, until: 0 }); return; }
  rec.n += 1;
  if (rec.n >= 8) { rec.until = now + 5 * 60_000; rec.n = 0; }
  attempts.set(ip, rec);
};
const checkPasscode = (given) => {
  const a = Buffer.from(sha(auth.salt + String(given ?? "")), "utf8");
  const b = Buffer.from(auth.hash, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
};

const LOCAL_USER = readJson(join(DATA_DIR, "user.json"), null) ?? (() => {
  const u = { user_id: `local-${sha(auth.secret).slice(0, 16)}`, name: "本机账户", picture: "" };
  writeFileSync(join(DATA_DIR, "user.json"), JSON.stringify(u, null, 2));
  return u;
})();
const contextHeader = (user) => {
  const value = { ...user, site_id: "local-site", host_id: "local-host", session_expires_at: Math.floor(Date.now() / 1000) + 3600 };
  return Buffer.from(JSON.stringify(value)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

// ---------- 识别通路 ----------
let modelKind = "test";
let chat = async () => {
  const error = new CloudAgentsError("ai_service_unavailable", 503, "not_sent");
  error.phase = "config";
  throw error;
};
let aiSummary = "未配置（界面上会照现有那句报「识别服务暂时不可用」，其余功能照常）";
if (AI_ENDPOINT) {
  const key = process.env[KEY_ENV] ?? "";
  if (!String(key).trim()) die(`拒绝：给了 --ai-endpoint 但环境变量 ${KEY_ENV} 是空的。凭据只走环境变量——命令行上的 key 会进 shell 历史与进程列表。`);
  try {
    const url = assertModelEndpoint(AI_ENDPOINT);
    chat = makeOpenAiCompatChat({ endpoint: url.href, key, authStyle: AI_AUTH_STYLE, timeoutMs: AI_TIMEOUT_MS });
    // R96 那条纪律的另一面：**按真实传输目标判 `real`／`test`**，不按"配了没配"判。
    // 指向回环（本机那个假端点）时必须是 test——否则界面会对家属说"这一条是从你上传的资料里认出来的"，
    // 而那一段其实是剧本里的台词，正是 09-28 主理人拿手机撞见并质问的那一格。
    const loopback = isLoopbackHost(url.hostname);
    modelKind = loopback ? "test" : "real";
    aiSummary = `${url.host}${url.pathname}｜模型 ${MODEL_NAME || "（端点默认）"}｜鉴权头 ${AI_AUTH_STYLE === "wb" ? "x-wb-webapp-access-key" : "Authorization: Bearer"}（值未打印）`
      + (loopback ? "｜回环端点 ⇒ 界面按「测试假模型」逐条披露" : "");
  } catch (error) {
    die(`拒绝：识别端点不可用（${error?.code ?? error?.message}）。要求 https，只有 127.0.0.1／localhost 例外。`);
  }
}
const llmUsage = [];
const extraction = makeExtractFactory({
  which: "llm",
  llmChat: chat,
  ledgerFor: ({ db }) => {
    const ledger = makeUsageLedger({ db });
    return (e) => { llmUsage.push(e); if (llmUsage.length > 50) llmUsage.shift(); return ledger(e); };
  },
  llm: { timeoutMs: AI_TIMEOUT_MS, ...(MODEL_NAME ? { model: MODEL_NAME } : {}) },
});
const quotaLimits = { ...QUOTA_DEFAULTS };
const business = createHandler({ storage: store.storage, extract: extraction, quotaLimits, modelKind });

// ---------- 路由 ----------
const DIST = resolveDistRoot(["app/dist", "dist", "../dist"], DEV_ROOT);
if (!DIST) {
  die(`无从判定：找不到要发的产物目录。找过：\n  ${distCandidatesReport(["app/dist", "dist", "../dist"], DEV_ROOT).join("\n  ")}\n先构一份：node dev/build-probe.mjs dist`);
}
const loginPage = (message = "") => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>就医笺 · 本机版</title>
<style>body{font:16px/1.6 system-ui;padding:24px;max-width:30rem;margin:0 auto}input{font:16px;padding:10px;width:100%;box-sizing:border-box}button{font:16px;padding:10px 16px;margin-top:12px}.m{color:#a33}</style>
</head><body><h1>就医笺 · 本机版</h1>
<p>这台电脑上的服务需要口令。口令只挡住"谁能通过这台电脑读数据"，数据本身都存在这台电脑里。</p>
${message ? `<p class="m">${message}</p>` : ""}
<form method="POST" action="/__qoder_auth/passcode"><label for="p">口令</label>
<input id="p" name="passcode" type="password" autocomplete="current-password" inputmode="text"><button type="submit">进入</button></form>
</body></html>`;

const json = (res, status, obj) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(obj));
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  const path = url.pathname;
  const ip = req.socket.remoteAddress || "?";
  try {
    if (path === "/__qoder_auth/start") {
      const back = url.searchParams.get("return_path") || "/";
      if (sessionOk(req) && !back.startsWith("/__qoder_auth")) {
        res.writeHead(302, { location: back }).end();
        return;
      }
      res.writeHead(200, { "content-type": MIME[".html"] }).end(loginPage());
      return;
    }
    if (path === "/__qoder_auth/passcode" && req.method === "POST") {
      if (rateLimited(ip)) { json(res, 429, { ok: false, error: "too_many_attempts" }); return; }
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString("utf8");
      const given = /(?:^|&)passcode=([^&]*)/.exec(raw) ? decodeURIComponent(/(?:^|&)passcode=([^&]*)/.exec(raw)[1]) : "";
      const ok = checkPasscode(given);
      noteAttempt(ip, ok);
      if (!ok) { res.writeHead(401, { "content-type": MIME[".html"] }).end(loginPage("口令不对。")); return; }
      const exp = Date.now() + SESSION_HOURS * 3600_000;
      res.writeHead(302, {
        location: "/#/",
        "set-cookie": `${cookieName}=${sessionValue(exp)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_HOURS * 3600}`,
        "cache-control": "no-store",
      }).end();
      return;
    }
    if (path === "/__qoder_auth/logout") {
      res.writeHead(302, { location: "/__qoder_auth/start", "set-cookie": `${cookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0` }).end();
      return;
    }
    const authorized = sessionOk(req);
    // 本机服务的诊断面：只报形状与计数，不报正文、不报凭据——但它会印出数据目录与表行数，
    // 所以**也在口令之后**（同一 WiFi 下不该让人不问自取）。
    if (path === "/_local/state") {
      if (!authorized) { json(res, 401, { ok: false, error: "login_required" }); return; }
      json(res, 200, {
        ok: true,
        binding: `${HOST}:${PORT}`,
        distRoot: DIST,
        dataDir: DATA_DIR,
        modelKind,
        ai: aiSummary,
        usageEventsToday: llmUsage.filter((e) => String(e?.at ?? "").startsWith(new Date().toISOString().slice(0, 10))).length,
        counts: Object.fromEntries(TABLE_NAMES.map((n) => [n, tables[n].length])),
        objectCount: store.objects.size,
        maxUploadBytes: MAX_UPLOAD_BYTES,
        offlineShellActive: false,
        note: "本机链路在 http 局域网地址上跑：Service Worker 只在安全上下文注册，所以离线壳这一格不会生效（R100 测过的降级路径照常用）。",
      });
      return;
    }

    if (!authorized) {
      if (path.startsWith("/functions/v1/app") || path.startsWith("/_local/object")) {
        json(res, 401, { ok: false, error: "login_required" });
        return;
      }
      res.writeHead(401, { "content-type": MIME[".html"] }).end(loginPage());
      return;
    }

    if (path.startsWith("/_local/object/")) {
      const objectPath = decodeURIComponent(path.slice("/_local/object/".length));
      if (req.method === "PUT") {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const put = Buffer.concat(chunks);
        if (store.oversize(put.length)) { json(res, 413, { ok: false, error: "object_too_large", bytes: put.length }); return; }
        try {
          store.put(objectPath, new Uint8Array(put), req.headers["content-type"] || "application/octet-stream");
        } catch (error) {
          json(res, 400, { ok: false, error: String(error?.message ?? error) });
          return;
        }
        json(res, 200, { ok: true });
        return;
      }
      const item = store.get(objectPath);
      if (!item) { res.writeHead(404).end(); return; }
      res.writeHead(200, { "content-type": item.contentType, "cache-control": "no-store" });
      res.end(Buffer.from(item.bytes));
      return;
    }

    if (path.startsWith("/functions/v1/app")) {
      const headers = new Headers();
      headers.set("content-type", req.headers["content-type"] || "");
      headers.set("cookie", req.headers.cookie || "");
      headers.set("x-qoder-user-context", contextHeader(LOCAL_USER));
      const body = ["POST", "PUT", "PATCH"].includes(req.method)
        ? new Uint8Array(await new Response(req).arrayBuffer())
        : undefined;
      const request = new Request(`http://localhost:${PORT}${req.url}`, {
        method: req.method,
        headers,
        body: body && body.length ? body : (req.method === "POST" ? new Uint8Array(0) : undefined),
      });
      const response = await business({ request, supabase });
      res.writeHead(response.status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(await response.text());
      return;
    }

    await serveStatic({ res, root: DIST, rawUrl: req.url || "/" });
  } catch (error) {
    if (!res.headersSent) json(res, 500, { ok: false, error: "local_server_error", detail: String(error?.message ?? error) });
    else res.end();
  }
});

const lanUrls = HOST === "127.0.0.1"
  ? [`http://127.0.0.1:${PORT}/`]
  : Object.values(networkInterfaces()).flatMap((list) => (list ?? []).filter((i) => i.family === "IPv4" && !i.internal).map((i) => `http://${i.address}:${PORT}/`));

server.listen(PORT, HOST, () => {
  console.log("就医笺 · 本机识别链路");
  console.log(`  产物：${DIST ?? "（没找到，界面打不开）"}`);
  console.log(`  数据目录：${DATA_DIR}（任务、原件、口令哈希都在这，不在仓库里）`);
  console.log(`  监听：${HOST === "0.0.0.0" ? "本机所有网卡（同一家 WiFi 的手机可访问）" : "只本机回环"}`);
  for (const u of lanUrls) console.log(`  打开：${u}`);
  console.log(`  口令：${auth.passcode ? `${auth.passcode}（第一次生成，改的话删 ${authFile} 再起）` : "已按你给的口令/环境变量设好，屏幕上不打印"}`);
  console.log(`  识别：${aiSummary}${modelKind === "real" ? "" : ""}`);
  console.log("  注意：这是局域网 http——同一网络里别人的设备也能看到这台服务，所以口令必须留着；");
  console.log("        图片会以明文跑过家里那段网络，出了这段网络就到你自己指定的那一个 https 端点。");
});

const graceful = () => {
  try { flushTables(); } catch {}
  try { store.flush(); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
};
process.on("SIGINT", graceful);
process.on("SIGTERM", graceful);
