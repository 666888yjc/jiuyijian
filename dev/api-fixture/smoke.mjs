// 回归层 B：本地夹具 HTTP 冒烟（真实跑 functions/handler.mjs 的业务逻辑）。
// 用法：node dev/api-fixture/smoke.mjs [port]   默认 8000，也读环境变量 FIXTURE_PORT。
// 全部通过退出码 0；任一失败退出码 1；夹具不可达退出码 2。
import { MAX_UPLOAD_BYTES } from "../../functions/validate.mjs";

const PORT = Number(process.env.FIXTURE_PORT || process.argv[2] || 8000);
const BASE = `http://127.0.0.1:${PORT}`;
const API = (a, f = "A") => `${BASE}/functions/v1/app?fixture=${f}&${a}`;

const j = async (url, init) => {
  const r = await fetch(url, init);
  let body = null;
  try { body = await r.json(); } catch { body = null; }
  return { status: r.status, body };
};
const call = (action, bodyObj, f = "A") => j(API(`action=${action}`, f), {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(bodyObj),
});
const get = (action, f = "A") => j(API(`action=${action}`, f));

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: Boolean(pass), detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${pass ? "" : `  << ${detail}`}`);
};
const err = (r) => r?.body?.error ?? `status=${r?.status}`;

// 真机模式下剧本不生效，冒烟断言（按可控输出写的）会给出无意义结果 ⇒ 拒绝运行而不是跑出假绿。
{
  const st = await j(`${BASE}/_fixture/state`);
  if (st.body?.llmMode === "real") {
    console.error("夹具处于真机模式 ⇒ B 冒烟拒绝运行（去掉 FIXTURE_LLM_REAL 再起夹具）。");
    process.exit(2);
  }
}

const finish = (exitCode) => {
  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== 夹具冒烟：${results.length - failed.length}/${results.length} PASS ===`);
  for (const f of failed) console.log(`  FAIL ${f.name} << ${f.detail}`);
  process.exit(failed.length ? 1 : exitCode);
};
// 夹具自身的前置步骤失败时立即给出可诊断输出（不当作产品断言，但算红）
const setup = (name, r) => {
  if (!r || (r.status !== undefined && r.status !== 200)) {
    check(`[前置] ${name}`, false, `status=${r?.status} error=${err(r)}`);
    finish(1);
  }
  return r.body ?? r;
};

const NOW = "2026-09-19T00:00:00Z";
const NEW_TASK = "8f14e45f-ea0a-4b3a-9e1d-2c3d4e5f6a7b";
const OTHER_TASK = "7a13d34e-d939-3a29-8d0c-1b2c3d4e5f6a";
// 24b 要的是一个"从来没存在过"的任务 id。写死常量会让 smoke 只能对新鲜夹具跑一次：
// 夹具还活着时第二遍会在 219 行之前就把这个 id 建出来（评审方连着跑两遍就会看到假红 200）。
const GHOST_TASK = `0f14e45f-ea0a-4b3a-9e1d-${Date.now().toString(16).padStart(12, "0").slice(-12)}`;
const bytes = new Uint8Array(120).fill(255);
const b64 = Buffer.from(bytes).toString("base64");

const basePayload = (over = {}) => ({
  patientLabel: "A", purpose: "smoke", dept: "", visitDate: "",
  createdAt: NOW, updatedAt: NOW,
  documents: [], fields: [], questions: [], sheetHidden: [], audit: [],
  ...over,
});
const docOf = (d, over = {}) => ({
  id: d.docId, name: "t.jpg", docType: "report", status: "done", addedAt: NOW,
  fileSize: 120, mime: "image/jpeg", objectPath: d.objectPath,
  pages: [{ id: `${d.docId}-p1`, pageNo: 1, kind: "image", blocks: [{ id: "b1", text: "血红蛋白 HGB 132 g/L" }] }],
  ...over,
});
const fieldOf = (over = {}) => ({
  id: "f1", group: "exam", label: "血红蛋白", ocrRaw: "血红蛋白 HGB 132 g/L",
  aiValue: "132 g/L", confidence: "high", confirmStatus: "pending", source: "ai",
  highRisk: true, userValue: null, updatedAt: NOW, ...over,
});
const payloadOf = (taskId, p, f = "A") => call("task-save", { id: taskId, payload: p }, f);
const readTask = async (taskId, f = "A") => {
  const r = await get("tasks", f);
  return (r.body?.tasks ?? []).find((t) => t.id === taskId)?.payload ?? null;
};
const uploadIntent = (taskId, size, f = "A", name = "t.jpg", mime = "image/jpeg") =>
  call("upload-intent", { taskId, name, mime, size }, f);
const putBytes = (signedUrl, raw, type = "image/jpeg") =>
  fetch(`${BASE}${signedUrl}`, { method: "PUT", headers: { "content-type": type }, body: raw });

// ---------- 0. 前置：夹具可达 ----------
const probe = await fetch(`${BASE}/functions/v1/app?fixture=anonymous&action=me`)
  .then((r) => r.json()).catch(() => null);
if (!probe?.ok) {
  console.error(`夹具不可达：${BASE} —— 先起 npm run dev:api（或 FIXTURE_PORT=<port> node dev/api-fixture/smoke.mjs <port>）`);
  process.exit(2);
}
console.log(`夹具可达：${BASE}（me 匿名 user=${JSON.stringify(probe.user)}）\n`);

// ---------- 1. 黄金路径（原有 14 项，现为真实断言） ----------
const t1 = await payloadOf(NEW_TASK, basePayload());
check("01 task-save 新建任务", t1.status === 200 && t1.body.ok === true, err(t1));

const i1 = await uploadIntent(NEW_TASK, 120);
check("02 upload-intent 合法请求返回 docId/signedUrl/objectPath",
  i1.status === 200 && !!i1.body.docId && !!i1.body.signedUrl && /^docs\/[0-9a-f]{16}\//.test(i1.body.objectPath ?? ""), err(i1));

const put1 = await putBytes(i1.body.signedUrl, bytes);
check("03 PUT 签名地址上传成功", put1.status === 200, `status=${put1.status}`);

const c1 = await call("upload-complete", { docId: i1.body.docId });
check("04 upload-complete 通过并按真实字节记账 size=120",
  c1.status === 200 && c1.body.size === 120, JSON.stringify(c1.body));

const c1b = await call("upload-complete", { docId: i1.body.docId }, "B");
check("05 他人不能 complete 我的文档 404", c1b.status === 404 && c1b.body.error === "not_found", err(c1b));

const t2 = await payloadOf(NEW_TASK, basePayload({ documents: [docOf(i1.body)] }));
check("06 task-save 带完整资料引用", t2.status === 200 && t2.body.ok === true, err(t2));

const forged = await payloadOf(NEW_TASK, basePayload({
  documents: [docOf({ docId: "11111111-1111-4111-8111-111111111111", objectPath: i1.body.objectPath })],
}));
check("07 伪造 doc 引用被拒 422 doc_reference_invalid",
  forged.status === 422 && forged.body.error === "doc_reference_invalid", err(forged));

const x1 = await call("extract-start", { docId: i1.body.docId, mediaType: "image/jpeg", imageBase64: b64 });
check("08 extract-start 返回 jobId", x1.status === 200 && !!x1.body.jobId, err(x1));

let poll = null;
for (let i = 1; i <= 3; i++) {
  poll = await get(`extract-status&jobId=${x1.body.jobId}`);
  if (poll.body?.state === "completed") break;
}
check("09 extract-status 轮询到 completed 且带回字段与证据块",
  poll.body?.state === "completed"
  && (poll.body.result?.fields ?? []).length === 3
  && poll.body.result.pages[0].blocks.some((b) => b.id === "b2"),
  JSON.stringify(poll.body).slice(0, 200));

const x1b = await get(`extract-status&jobId=${x1.body.jobId}`, "B");
check("10 他人轮询我的识别任务 404", x1b.status === 404, err(x1b));

const fu1 = await get(`file-url&docId=${i1.body.docId}`);
check("11 file-url 返回签名地址", fu1.status === 200 && !!fu1.body.url, err(fu1));

const got1 = await fetch(`${BASE}${fu1.body.url}`);
check("12 签名地址取回原始 120 字节", got1.status === 200 && (await got1.arrayBuffer()).byteLength === 120, `status=${got1.status}`);

const dd1 = await call("doc-delete", { docId: i1.body.docId });
check("13 doc-delete 成功", dd1.status === 200 && dd1.body.ok === true, err(dd1));

const fu2 = await get(`file-url&docId=${i1.body.docId}`);
check("14 删除后 file-url 404", fu2.status === 404, err(fu2));

// 后续各节需要一个长期有效的已存文档引用（doc-delete 会把引用它的载荷清掉，不能复用 i1）
const ref = setup("upload-intent（后续引用基准）", await uploadIntent(NEW_TASK, 120));
await putBytes(ref.signedUrl, bytes);
setup("upload-complete（后续引用基准）", await call("upload-complete", { docId: ref.docId }));
await payloadOf(NEW_TASK, basePayload({ documents: [docOf(ref)] }));

// ---------- 2. 大小护栏（声明侧 + 真实字节侧） ----------
const over11 = new Uint8Array(MAX_UPLOAD_BYTES + 1_000_000).fill(7);

const bigIntent = await uploadIntent(NEW_TASK, MAX_UPLOAD_BYTES + 1);
check("15 upload-intent 声明 >10MB 直接拒（400 invalid_payload）",
  bigIntent.status === 400 && bigIntent.body.error === "invalid_payload", err(bigIntent));

const zeroIntent = await uploadIntent(NEW_TASK, 0);
check("16 upload-intent 声明 size=0 拒", zeroIntent.status === 400, err(zeroIntent));

const gifIntent = await uploadIntent(NEW_TASK, 120, "A", "t.gif", "image/gif");
check("17 upload-intent 白名单外 mime（image/gif）拒", gifIntent.status === 400, err(gifIntent));

const bypass = setup("11MB 谎报用例 intent", await uploadIntent(NEW_TASK, 120));
await putBytes(bypass.signedUrl, over11);
const bypassDone = await call("upload-complete", { docId: bypass.docId });
check("18 谎报 size=120 实传 11MB：upload-complete 按真实字节拒绝 422",
  bypassDone.status === 422 && bypassDone.body.error === "upload_validation_failed", err(bypassDone));

const bypassUrl = await get(`file-url&docId=${bypass.docId}`);
check("19 超限文档不留存：file-url 404 且对象已删", bypassUrl.status === 404, err(bypassUrl));
const bypassObj = await fetch(`${BASE}${bypass.signedUrl}`);
check("20 超限对象在存储侧被清除（GET 404）", bypassObj.status === 404, `status=${bypassObj.status}`);

const mismatch = setup("尺寸不符用例 intent", await uploadIntent(NEW_TASK, 120));
await putBytes(mismatch.signedUrl, new Uint8Array(200).fill(3));
const mismatchDone = await call("upload-complete", { docId: mismatch.docId });
check("21 声明与真实字节不符（120 vs 200）→ 422 且未标记 stored",
  mismatchDone.status === 422 && (await get(`file-url&docId=${mismatch.docId}`)).status === 404, err(mismatchDone));

// R4（轮次 8）收紧：载荷侧 fileSize 上限由 2×MAX_UPLOAD_BYTES 对齐到上传侧的 1×MAX
const oversize = await payloadOf(NEW_TASK, basePayload({ documents: [{ ...docOf(ref), fileSize: 11 * 1024 * 1024 }] }));
check("22 task-save fileSize=11MB 拒 413 payload_too_large（与上传侧 10MB 对齐）",
  oversize.status === 413 && oversize.body.error === "payload_too_large", err(oversize));
const atCap = await payloadOf(NEW_TASK, basePayload({ documents: [{ ...docOf(ref), fileSize: MAX_UPLOAD_BYTES }] }));
check("22b task-save fileSize 恰好 10MB（边界）通过，收紧未误伤", atCap.status === 200, err(atCap));
const wayOver = await payloadOf(NEW_TASK, basePayload({ documents: [{ ...docOf(ref), fileSize: MAX_UPLOAD_BYTES * 2 + 1 }] }));
check("23 task-save fileSize 超原 2×MAX 也拒 413（收紧前为 400）", wayOver.status === 413, err(wayOver));
const fracSize = await payloadOf(NEW_TASK, basePayload({ documents: [{ ...docOf(ref), fileSize: 1.5 }] }));
check("23b task-save fileSize 非整数仍拒 400 invalid_payload（未误改为 413）",
  fracSize.status === 400 && fracSize.body.error === "invalid_payload", err(fracSize));
const negSize = await payloadOf(NEW_TASK, basePayload({ documents: [{ ...docOf(ref), fileSize: -1 }] }));
check("23c task-save fileSize 负数拒 400", negSize.status === 400, err(negSize));
// 被拒的写入不得污染已存载荷
const afterCapChecks = await readTask(NEW_TASK);
check("23d 超限载荷被拒后，已存任务未被改写（仍能读到基准文档）",
  afterCapChecks?.documents?.[0]?.id === ref.docId, `documents=${JSON.stringify(afterCapChecks?.documents)}`);
await payloadOf(NEW_TASK, basePayload({ documents: [docOf(ref)] }));

// ---------- 3. 载荷白名单、鉴权与越权 ----------
const beforeBad = JSON.stringify(await readTask(NEW_TASK));
const badPath = await payloadOf(NEW_TASK, basePayload({
  documents: [{ ...docOf(ref), objectPath: "docs/../../../../etc/passwd" }],
}));
const afterBadPath = JSON.stringify(await readTask(NEW_TASK));
check("24 路径穿越式 objectPath 拒 400，且不覆盖已存任务",
  badPath.status === 400 && beforeBad === afterBadPath,
  `status=${badPath.status} 载荷被改写=${beforeBad !== afterBadPath}`);

const ghostTaskIntent = await uploadIntent(GHOST_TASK, 120, "B");
check("24b upload-intent 引用不存在的任务 → 404（防止跨任务塞对象）",
  ghostTaskIntent.status === 404 && ghostTaskIntent.body.error === "not_found", err(ghostTaskIntent));

setup("B 建立自己的任务", await payloadOf(OTHER_TASK, basePayload({ patientLabel: "B" }), "B"));
const bIntent = setup("B upload-intent", await uploadIntent(OTHER_TASK, 120, "B"));
await putBytes(bIntent.signedUrl, bytes);
setup("B upload-complete", await call("upload-complete", { docId: bIntent.docId }, "B"));
const stealRef = await payloadOf(NEW_TASK, basePayload({ documents: [docOf(bIntent)] }));
check("25 A 引用 B 的文档 → 422（跨租户引用被拒）",
  stealRef.status === 422 && stealRef.body.error === "doc_reference_invalid", err(stealRef));

const bdd = await call("doc-delete", { docId: bIntent.docId }, "A");
const bStill = await get(`file-url&docId=${bIntent.docId}`, "B");
check("26 A 删 B 的文档不生效：B 侧 file-url 仍 200",
  bdd.status === 200 && bStill.status === 200, `A=${err(bdd)} B=${err(bStill)}`);

const bStealSave = await payloadOf(NEW_TASK, basePayload({ purpose: "overwritten-by-B" }), "B");
const ownerAView = await readTask(NEW_TASK);
check("27 B 用 A 的任务 id 保存不能改写 A 的数据",
  bStealSave.status !== 200 && ownerAView?.purpose === "smoke",
  `B status=${bStealSave.status} A.purpose=${ownerAView?.purpose}`);

const anonSave = await call("task-save", { id: NEW_TASK, payload: basePayload() }, "anonymous");
const anonList = await get("tasks", "anonymous");
const anonMe = await j(API("action=me", "anonymous"));
check("28 匿名写/读被拒 401 login_required，me 仍 200 user:null",
  anonSave.status === 401 && anonSave.body.error === "login_required"
  && anonList.status === 401 && anonMe.status === 200 && anonMe.body.user === null,
  `save=${anonSave.status} list=${anonList.status} me=${anonMe.status}`);

const big = Array.from({ length: 120 }, (_, i) => fieldOf({ id: `bf${i}`, ocrRaw: "x".repeat(11000) }));
const overCap = await payloadOf(NEW_TASK, basePayload({ fields: big }));
const underCap = await payloadOf(NEW_TASK, basePayload({ fields: big.slice(0, 80) }));
check("29 请求体 ~1.3MB >1MB 上限 → 413 payload_too_large（控制组 0.9MB 通过）",
  overCap.status === 413 && overCap.body.error === "payload_too_large" && underCap.status === 200,
  `big=${err(overCap)} small=${underCap.status}`);

const wrongType = await j(API("action=task-save"), {
  method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ id: NEW_TASK, payload: basePayload() }),
});
check("30 非 application/json → 415 unsupported_media",
  wrongType.status === 415 && wrongType.body.error === "unsupported_media", err(wrongType));

const dirty = await payloadOf(NEW_TASK, {
  ...basePayload({ fields: [fieldOf()], audit: [{ id: "a1", at: NOW, action: "载入", detail: "x", evil: 9 }] }),
  isAdmin: true, patientName: "张三", pinyin: "zhangsan",
  documents: [{ ...docOf(ref), apiKey: "nope" }],
  questions: [{ id: "q1", text: "问诊问题", injected: "<script>" }],
  sheetHidden: ["f1"],
});
const dirtyView = await readTask(NEW_TASK);
const leaked = JSON.stringify(dirtyView ?? {});
check("31 sanitize 丢弃顶层/doc/field/question/audit 白名单外键",
  dirty.status === 200
  && !("isAdmin" in (dirtyView ?? {})) && !("patientName" in (dirtyView ?? {})) && !("pinyin" in (dirtyView ?? {}))
  && !("apiKey" in (dirtyView?.documents?.[0] ?? {}))
  && !("injected" in (dirtyView?.questions?.[0] ?? {}))
  && !("evil" in (dirtyView?.audit?.[0] ?? {})),
  leaked.slice(0, 240));

// ---------- 4. 行动项引用与截断不变量 ----------
const actPending = await payloadOf(NEW_TASK, basePayload({
  fields: [fieldOf({ confirmStatus: "pending" })],
  actions: [{ id: "ac1", type: "observation", content: "观察", date: "2026-09-20", done: false, createdAt: NOW, fieldId: "f1" }],
}));
check("32 行动项引用未确认字段 → 400 拒", actPending.status === 400, err(actPending));

const actConfirmed = await payloadOf(NEW_TASK, basePayload({
  fields: [fieldOf({ confirmStatus: "confirmed" })],
  actions: [{ id: "ac1", type: "observation", content: "观察", date: "2026-09-20", done: false, createdAt: NOW, fieldId: "f1" }],
}));
check("33 控制组：行动项引用已确认字段 → 通过并落库 1 条",
  actConfirmed.status === 200 && (await readTask(NEW_TASK))?.actions?.length === 1, err(actConfirmed));

const dupField = await payloadOf(NEW_TASK, basePayload({ fields: [fieldOf(), fieldOf()] }));
const ghostDoc = await payloadOf(NEW_TASK, basePayload({
  fields: [fieldOf({ docId: "22222222-2222-4222-8222-222222222222" })],
}));
const tooManyDocs = await payloadOf(NEW_TASK, basePayload({
  documents: Array.from({ length: 101 }, (_, i) => docOf(i1.body, { id: crypto.randomUUID(), name: `d${i}.jpg` })),
}));
check("34 重复 field id 拒 400", dupField.status === 400, err(dupField));
check("35 字段引用不存在的 docId 拒 400", ghostDoc.status === 400, err(ghostDoc));
check("36 documents 超 100 拒 400", tooManyDocs.status === 400, err(tooManyDocs));

const omitUserValue = await payloadOf(NEW_TASK, basePayload({ fields: [{ ...fieldOf(), userValue: undefined }] }));
check("36b [现状] 字段缺省 userValue 键 → 400（sanitizeField 要求显式 null；客户端类型恒必填故不触发，但第三方/老客户端会被拒）",
  omitUserValue.status === 400, "status=" + omitUserValue.status);

const auditAt = await payloadOf(NEW_TASK, basePayload({ audit: Array.from({ length: 2000 }, (_, i) => ({ id: "au" + i, at: NOW, action: "审计", detail: "#" + i })) }));
const auditAtView = await readTask(NEW_TASK);
const auditOver = await payloadOf(NEW_TASK, basePayload({ audit: Array.from({ length: 2001 }, (_, i) => ({ id: "au" + i, at: NOW, action: "审计", detail: "#" + i })) }));
check("37 audit 恰好 2000 条通过并完整保留",
  auditAt.status === 200 && auditAtView?.audit?.length === 2000,
  "status=" + auditAt.status + " len=" + auditAtView?.audit?.length);
check("37b [现状] audit 2001 条 → 400 整体拒收（validate 的 .slice(-2000) 实为死代码）",
  auditOver.status === 400, "status=" + auditOver.status);

// 客户端 src/store.tsx:152 的写入顺序是 [新版本, ...旧版本]（新在前）；服务端按数组位置保留前 20 条
const manyVersions = [
  ...Array.from({ length: 20 }, (_, i) => ({ id: "new" + i, savedAt: NOW, text: "第 " + i + " 版" })),
  ...Array.from({ length: 5 }, (_, i) => ({ id: "old" + i, savedAt: NOW, text: "旧 " + i + " 版" })),
];
const svCut = await payloadOf(NEW_TASK, basePayload({ summaryVersions: manyVersions }));
const svView = await readTask(NEW_TASK);
check("38 summaryVersions 25 条 → 按数组位置保留前 20（新在前即保留最新 20 版）",
  svCut.status === 200 && svView?.summaryVersions?.length === 20
  && svView.summaryVersions[0]?.id === "new0" && !svView.summaryVersions.some((v) => String(v.id).startsWith("old")),
  "status=" + svCut.status + " len=" + svView?.summaryVersions?.length + " first=" + svView?.summaryVersions?.[0]?.id);

const noteLong = await payloadOf(NEW_TASK, basePayload({ summaryNote: "x".repeat(2500) }));
const noteView = await readTask(NEW_TASK);
check("39 summaryNote 超 2000 字符按字符截断（UTF-8 6000 字节内放行）",
  noteLong.status === 200 && noteView?.summaryNote?.length === 2000,
  `status=${noteLong.status} len=${noteView?.summaryNote?.length}`);
const noteHuge = await payloadOf(NEW_TASK, basePayload({ summaryNote: "x".repeat(6001) }));
check("40 summaryNote 超 6000 字节拒 400", noteHuge.status === 400, err(noteHuge));

// ---------- 5. doc-delete 级联不留悬空引用 ----------
const cascDoc = setup("级联用例 intent", await uploadIntent(NEW_TASK, 120));
await putBytes(cascDoc.signedUrl, bytes);
await call("upload-complete", { docId: cascDoc.docId });
const withField = await payloadOf(NEW_TASK, basePayload({
  documents: [docOf(ref), docOf(cascDoc)],
  fields: [
    fieldOf({ id: "keep", confirmStatus: "confirmed" }),
    fieldOf({ id: "casc", confirmStatus: "confirmed", docId: cascDoc.docId, pageId: `${cascDoc.docId}-p1`, blockIds: ["b1"] }),
  ],
  questions: [], sheetHidden: [], audit: [{ id: "a1", at: NOW, action: "载入", detail: "x" }],
}));
check("41 级联前置态：2 份资料 / 高风险字段已确认带证据",
  withField.status === 200 && (await readTask(NEW_TASK))?.fields?.find((f) => f.id === "casc")?.confirmStatus === "confirmed",
  err(withField));

const cascDel = await call("doc-delete", { docId: cascDoc.docId });
const cascView = await readTask(NEW_TASK);
const cascField = (cascView?.fields ?? []).find((f) => f.id === "casc");
check("42 doc-delete 级联：任务载荷无该资料引用",
  cascDel.status === 200 && (cascView?.documents ?? []).length === 1
  && !(cascView.documents ?? []).some((d) => d.id === cascDoc.docId),
  `status=${cascDel.status} docs=${cascView?.documents?.length}`);
check("43 doc-delete 级联：引用它的字段退回 pending 且证据指针清空",
  !!cascField && cascField.confirmStatus === "pending"
  && cascField.docId === undefined && cascField.pageId === undefined && cascField.blockIds === undefined,
  JSON.stringify(cascField));
check("44 级联不误伤：无关字段保持已确认",
  (cascView?.fields ?? []).find((f) => f.id === "keep")?.confirmStatus === "confirmed",
  JSON.stringify((cascView?.fields ?? []).map((f) => [f.id, f.confirmStatus])));
const rescuable = await payloadOf(NEW_TASK, basePayload({
  documents: [docOf(ref)],
  fields: [fieldOf({ id: "keep", confirmStatus: "confirmed" }), fieldOf({ id: "casc", confirmStatus: "pending" })],
}));
check("45 级联后任务载荷仍可保存（无悬空引用阻塞）", rescuable.status === 200, err(rescuable));

const badJob = await get("extract-status&jobId=not-a-uuid");
check("46 非 uuid jobId → 400", badJob.status === 400, err(badJob));

// ---------- 汇总 ----------
finish(0);
