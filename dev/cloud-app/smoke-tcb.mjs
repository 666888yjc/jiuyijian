// 部署版冒烟（R155 配套）：对**已经部署的** CloudBase 函数跑设备级匿名会话的六条断言。
// 与 dev/cloud-app/smoke.mjs（本机 harness）的分工：那个自己起服务，这个打真 URL——
// 它证明的是 NoSQL 适配器／存储适配器在真 env 上通，不是本机代码通。
//
// 用法（路由建好后）：
//   node dev/cloud-app/smoke-tcb.mjs --base https://<域名>/functions/v1/app
// 模型 key 没配也能跑：第 ⑤ 条自动降级成「识别 fail-closed 且不拖死其余功能」（⑱ 的纪律），
// 配了 key 才断言整圈 completed。脚本只读你自己的函数，不碰任何真实患者数据（任务名带 smoke-）。
import { randomUUID } from "node:crypto";

const argv = process.argv.slice(2);
const flag = (n, d = "") => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const BASE = flag("base").replace(/\/+$/, "");
if (!BASE) { console.error("用法：node dev/cloud-app/smoke-tcb.mjs --base https://<域名>/functions/v1/app"); process.exit(2); }

const failures = [];
const ok = (name, cond, detail = "") => {
  console.log(`  ${cond ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures.push(name);
};

const call = async (action, { method = "GET", body, cookie, forgeContext, query = "" } = {}) => {
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (forgeContext) headers["x-qoder-user-context"] = forgeContext;
  const res = await fetch(`${BASE}?action=${action}${query}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const setCookie = res.headers.get("set-cookie") || "";
  return { status: res.status, json: await res.json().catch(() => null), deviceCookie: /jyj_device=([0-9a-f-]{36})/.exec(setCookie)?.[1] ?? "" };
};

// 1×1 PNG（合成件，无真实患者数据）；size 必须与实际上传字节一致——storage-validation 逐字节核
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const TASK_ID = "d0d0d0d0-d0d0-4d0d-8d0d-d0d0d0d0d0d0";

console.log(`目标：${BASE}`);
try {
  // ① 首见即铸身份（真 env：证明函数运行时＋ingress 在 CloudBase 上工作）
  const me1 = await call("me");
  ok("① 免登录首见即铸设备身份（me 回 device-* 且种 cookie）",
    me1.status === 200 && /^device-[0-9a-f-]{36}$/.test(me1.json?.user?.id ?? "") && me1.deviceCookie.length === 36,
    `user=${me1.json?.user?.id ?? "（无）"}`);
  const cookieA = `jyj_device=${me1.deviceCookie}`;

  // ② 本设备任务读写（真 env：证明 NoSQL 适配器通）
  const saved = await call("task-save", {
    method: "POST", cookie: cookieA,
    body: { id: TASK_ID, payload: { id: TASK_ID, patientLabel: "冒烟测试", purpose: "部署链路验证", dept: "测试科", visitDate: "2026-10-19", documents: [], fields: [], questions: [], actions: [], sheetHidden: [], audit: [], createdAt: "2026-10-19T00:00:00.000Z", updatedAt: "2026-10-19T00:00:00.000Z" } },
  });
  const listA = await call("tasks", { cookie: cookieA });
  ok("② 本设备写的任务本设备读得回（NoSQL 适配器在真 env 上通）",
    saved.status === 200 && (listA.json?.tasks ?? []).some((t) => t.id === TASK_ID),
    `任务数=${(listA.json?.tasks ?? []).length}`);

  // ③ 设备隔离
  const me2 = await call("me");
  const listB = await call("tasks", { cookie: `jyj_device=${me2.deviceCookie}` });
  ok("③ 设备隔离：换台设备读不到别人的任务",
    me2.json?.user?.id !== me1.json?.user?.id && !(listB.json?.tasks ?? []).some((t) => t.id === TASK_ID),
    `B 设备看到 ${(listB.json?.tasks ?? []).length} 条`);

  // ④ 上传三步（真 env：证明存储适配器＋对象路由通）
  const intent = await call("upload-intent", { method: "POST", cookie: cookieA, body: { taskId: TASK_ID, name: "smoke.png", mime: "image/png", size: PNG.length } });
  const putRes = await fetch(`${BASE.replace(/\/functions\/v1\/app$/, "")}/_tcb/object/${encodeURIComponent(intent.json?.objectPath ?? "x")}`, {
    method: "PUT", headers: { cookie: cookieA, "content-type": "image/png" }, body: PNG,
  });
  const complete = await call("upload-complete", { method: "POST", cookie: cookieA, body: { docId: intent.json?.docId } });
  ok("④ 上传三步（intent→PUT→complete，存储适配器在真 env 上通）",
    intent.status === 200 && putRes.status === 200 && complete.status === 200,
    `docId=${(intent.json?.docId ?? "").slice(0, 8)}…`);

  // ⑤ 识别：配了 key 断言整圈；没配则断言 fail-closed 且不拖死其余功能
  const started = await call("extract-start", { method: "POST", cookie: cookieA, body: { docId: intent.json?.docId, mediaType: "image/png", imageBase64: PNG.toString("base64") } });
  if (started.status === 200 && started.json?.jobId) {
    let status = null;
    for (let i = 0; i < 80; i++) {
      status = await call("extract-status", { cookie: cookieA, query: `&jobId=${encodeURIComponent(started.json.jobId)}` });
      if (status.json?.state !== "pending") break;
      await new Promise((r) => setTimeout(r, 500));
    }
    ok("⑤ 识别整圈（extract-start→轮询→completed，模型 key 已配）",
      status.json?.state === "completed" && (status.json?.result?.fields?.length ?? 0) > 0,
      `state=${status.json?.state}｜字段数=${status.json?.result?.fields?.length ?? 0}`);
  } else {
    const stillWorks = (await call("tasks", { cookie: cookieA })).status === 200;
    ok("⑤ 识别 fail-closed（key 未配：识别报不可用，但任务读写照常——⑱ 的纪律）",
      started.status >= 400 && started.status < 500 && Boolean(started.json?.error) && stillWorks,
      `错误码=${started.json?.error ?? "（无）"}｜其余功能=${stillWorks ? "正常" : "被拖死"}`);
  }

  // ⑥ 伪造身份头不生效
  const forged = Buffer.from(JSON.stringify({
    user_id: "device-ffffffff-ffff-4fff-8fff-ffffffffffff", name: "冒名", picture: "",
    site_id: "tcb-site", host_id: "tcb-host", session_expires_at: Math.floor(Date.now() / 1000) + 86400,
  })).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const meForged = await call("me", { cookie: cookieA, forgeContext: forged });
  ok("⑥ 伪造身份头不生效（入口先剥再铸）",
    meForged.json?.user?.id === me1.json?.user?.id,
    `带头后身份仍=${meForged.json?.user?.id}`);
} catch (error) {
  console.error(`\n打到一半出错：${error?.message ?? error}`);
  failures.push("（异常中断）");
}

console.log(failures.length ? `\n结果：${failures.length} 失败 → ${failures.join("；")}` : "\n结果：PASS");
process.exit(failures.length ? 1 : 0);
