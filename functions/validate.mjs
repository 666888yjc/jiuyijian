// Server-side input validation. Whitelist shapes only; unknown keys are dropped by sanitize.
import { DbError } from "./db.mjs";

const str = (v, max) => (typeof v === "string" && new TextEncoder().encode(v).length <= max ? v : null);
const uuid = (v) => (typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v : null);
const pageId = (v) => (typeof v === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(v) ? v : null);
const isoDate = (v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
const isoTime = (v) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : null);
const oneOf = (v, set) => (typeof v === "string" && set.has(v) ? v : null);
const int = (v) => (Number.isSafeInteger(v) ? v : null);
const bool = (v) => (typeof v === "boolean" ? v : null);

export const DOC_TYPES = new Set(["outpatient", "prescription", "report", "inpatient", "unknown"]);
export const DOC_STATUSES = new Set(["uploaded", "processing", "done", "failed"]);
export const FIELD_GROUPS = new Set(["meta", "timeline", "history", "medication", "exam", "allergy"]);
export const CONFIDENCES = new Set(["high", "medium", "low", "failed"]);
export const CONFIRM_STATUSES = new Set(["pending", "confirmed", "corrected", "uncertain"]);
export const FIELD_SOURCES = new Set(["ai", "user"]);
export const UPLOAD_MIMES = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["application/pdf", "pdf"],
]);
export const EXTRACT_MIMES = new Set(["image/jpeg", "image/png"]);
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_EXTRACT_IMAGE_BYTES = 680 * 1024;
const OBJECT_PATH = /^docs\/[0-9a-f]{16}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|pdf)$/;

const bad = () => new DbError("invalid_payload", 400);

function sanitizeBlock(v) {
  const id = str(v?.id, 40);
  const text = str(v?.text, 8000);
  if (!id || text === null) throw bad();
  return { id, text };
}

function sanitizePage(v) {
  if (!v || typeof v !== "object") throw bad();
  const pageNo = int(v.pageNo);
  const id = pageId(v.id);
  const kind = oneOf(v.kind, new Set(["image", "pdf"]));
  if (pageNo === null || pageNo < 1 || pageNo > 200 || !id || !kind) throw bad();
  if (!Array.isArray(v.blocks) || v.blocks.length > 300) throw bad();
  return { id, pageNo, kind, empty: bool(v.empty) ?? false, blocks: v.blocks.map(sanitizeBlock) };
}

function sanitizeDoc(v) {
  if (!v || typeof v !== "object") throw bad();
  const id = uuid(v.id);
  const name = str(v.name, 300);
  const docType = oneOf(v.docType, DOC_TYPES);
  const status = oneOf(v.status, DOC_STATUSES);
  const addedAt = isoTime(v.addedAt);
  if (!id || name === null || !docType || !status || !addedAt) throw bad();
  const out = { id, name, docType, status, addedAt, pages: [] };
  if (v.fileSize !== undefined) {
    const size = int(v.fileSize);
    if (size === null || size < 0) throw bad();
    // 与上传侧同一道 10MB 上限对齐：载荷声明的尺寸不得大于对象存储所能允许的最大对象
    if (size > MAX_UPLOAD_BYTES) throw new DbError("payload_too_large", 413);
    out.fileSize = size;
  }
  if (v.mime !== undefined) {
    const mime = str(v.mime, 100);
    if (mime === null) throw bad();
    out.mime = mime;
  }
  if (v.objectPath !== undefined) {
    if (typeof v.objectPath !== "string" || !OBJECT_PATH.test(v.objectPath)) throw bad();
    out.objectPath = v.objectPath;
  }
  // R76：「这份资料的文本层一共多少字节 / PDF 一共多少页」是要披露给家属看的两个数（本机只留了一部分时）。
  // 必须在这里认下来：未知键会被 sanitize 丢掉 ⇒ 本机比服务器多两个键 ⇒ 两份"内容不同"而时间戳都没动，
  // 正好撞上 R74 的合并判据（它看见"无从判断"就暂停同步）。A 组拿真函数双向对死这件事。
  if (v.textSeenBytes !== undefined) {
    const seen = int(v.textSeenBytes);
    if (seen === null || seen < 0 || seen > 200_000_000) throw bad();
    out.textSeenBytes = seen;
  }
  if (v.pagesTotal !== undefined) {
    const total = int(v.pagesTotal);
    if (total === null || total < 1 || total > 2000) throw bad();
    out.pagesTotal = total;
  }
  if (!Array.isArray(v.pages) || v.pages.length > 60) throw bad();
  out.pages = v.pages.map(sanitizePage);
  return out;
}

function sanitizeField(v) {
  if (!v || typeof v !== "object") throw bad();
  const id = pageId(v.id);
  const group = oneOf(v.group, FIELD_GROUPS);
  const label = str(v.label, 200);
  const confidence = oneOf(v.confidence, CONFIDENCES);
  const confirmStatus = oneOf(v.confirmStatus, CONFIRM_STATUSES);
  const source = oneOf(v.source, FIELD_SOURCES);
  const updatedAt = isoTime(v.updatedAt);
  if (!id || !group || label === null || !confidence || !confirmStatus || !source || !updatedAt) throw bad();
  const out = {
    id, group, label,
    ocrRaw: str(v.ocrRaw, 12000) ?? (() => { throw bad(); })(),
    aiValue: v.aiValue === null ? null : (str(v.aiValue, 4000) ?? (() => { throw bad(); })()),
    userValue: v.userValue === null ? null : (str(v.userValue, 4000) ?? (() => { throw bad(); })()),
    highRisk: bool(v.highRisk) ?? (() => { throw bad(); })(),
    confidence, confirmStatus, source, updatedAt,
  };
  if (v.docId !== undefined && v.docId !== null) out.docId = uuid(v.docId) ?? (() => { throw bad(); })();
  if (v.pageId !== undefined && v.pageId !== null) out.pageId = pageId(v.pageId) ?? (() => { throw bad(); })();
  if (v.blockIds !== undefined && v.blockIds !== null) {
    if (!Array.isArray(v.blockIds) || v.blockIds.length > 60) throw bad();
    out.blockIds = v.blockIds.map((b) => str(b, 40) ?? (() => { throw bad(); })());
  }
  if (v.conflictWith !== undefined && v.conflictWith !== null) {
    if (!Array.isArray(v.conflictWith) || v.conflictWith.length > 20) throw bad();
    out.conflictWith = v.conflictWith.map((c) => pageId(c) ?? (() => { throw bad(); })());
  }
  if (v.modelVersion !== undefined && v.modelVersion !== null) out.modelVersion = str(v.modelVersion, 80) ?? (() => { throw bad(); })();
  // R96「这一条是谁认出来的」：只认这三个值，别的（含拼错的、含 null）一律当作没这个键——
  // 与 modelVersion 同形处理，**不给默认值**：一旦服务端替客户端补一个 `"unknown"`，本机那些没这个键的旧字段
  // 就会与服务器那一行永远差一个键，把 R74 那个"多余写穿／永久冲突"重新造出来（`projectPayload` 的折算只覆盖 documents/summary）。
  if (v.modelKind === "real" || v.modelKind === "test" || v.modelKind === "unknown") out.modelKind = v.modelKind;
  // R101：只认真值、false/缺省一律不写这个键（与 modelKind 同一配方）——写了 false 就等于给每条字段凭空多一个键
  if (v.docGone === true) out.docGone = true;
  // R112「算同一项」：只认非空字符串（字节上限与 label 同一档），别的（含 `""`、含数字、含 null）一律不写这个键。
  // 与 docGone/modelKind 同一配方：**不补默认值**，也**不因形状不对就整单拒收**——并项只是个看法，
  // 客户端真发出畸形值时丢掉这一格比把家属那次保存判成 invalid_payload 好（保存里有他别的判断）。
  if (typeof v.itemGroup === "string" && v.itemGroup.trim() !== "" && str(v.itemGroup, 200) !== null) {
    out.itemGroup = v.itemGroup;
  }
  return out;
}

const ACTION_TYPES = new Set(["followup", "medication", "observation"]);

function sanitizeAction(v) {
  if (!v || typeof v !== "object") throw bad();
  const id = pageId(v.id);
  const type = oneOf(v.type, ACTION_TYPES);
  const content = str(v.content, 300);
  const date = isoDate(v.date);
  const done = bool(v.done);
  const createdAt = isoTime(v.createdAt);
  if (!id || !type || content === null || !date || done === null || !createdAt) throw bad();
  const out = { id, type, content, date, done, createdAt };
  if (v.doneAt != null) out.doneAt = isoTime(v.doneAt) ?? (() => { throw bad(); })();
  if (v.doneNote != null) out.doneNote = str(v.doneNote, 300) ?? (() => { throw bad(); })();
  if (v.fieldId != null) out.fieldId = pageId(v.fieldId) ?? (() => { throw bad(); })();
  return out;
}

export function sanitizeTaskPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw bad();
  const purpose = str(payload.purpose, 600);
  const patientLabel = str(payload.patientLabel, 200);
  const dept = str(payload.dept, 120);
  const createdAt = isoTime(payload.createdAt);
  const updatedAt = isoTime(payload.updatedAt);
  if (purpose === null || patientLabel === null || dept === null || !createdAt || !updatedAt) throw bad();
  if (payload.visitDate !== "" && !isoDate(payload.visitDate)) throw bad();
  if (!Array.isArray(payload.documents) || payload.documents.length > 100) throw bad();
  if (!Array.isArray(payload.fields) || payload.fields.length > 800) throw bad();
  if (!Array.isArray(payload.questions) || payload.questions.length > 200) throw bad();
  if (!Array.isArray(payload.sheetHidden) || payload.sheetHidden.length > 800) throw bad();
  if (!Array.isArray(payload.audit) || payload.audit.length > 2000) throw bad();
  const seen = new Set();
  const fields = payload.fields.map(sanitizeField);
  for (const f of fields) {
    if (seen.has(f.id)) throw bad();
    seen.add(f.id);
  }
  const docIds = new Set(payload.documents.map((d) => d.id));
  for (const f of fields) {
    if (f.docId !== undefined && !docIds.has(f.docId)) throw bad();
  }
  const actions = (Array.isArray(payload.actions) ? payload.actions : []).map(sanitizeAction);
  if (actions.length > 100) throw bad();
  let summaryNote = "";
  if (payload.summaryNote != null) {
    if (typeof payload.summaryNote !== "string" || new TextEncoder().encode(payload.summaryNote).length > 6000) throw bad();
    summaryNote = payload.summaryNote.slice(0, 2000);
  }
  const summaryVersions = (Array.isArray(payload.summaryVersions) ? payload.summaryVersions : []).map((v) => {
    const id = pageId(v?.id);
    const savedAt = isoTime(v?.savedAt);
    const text = str(v?.text, 9000);
    if (!id || !savedAt || text === null) throw bad();
    return { id, savedAt, text };
  }).slice(0, 20);
  // 安全：行动条目只允许引用已确认/已修改的字段（不引入未核实内容）
  // R62：这句原来多一条 `|| f.source === "user"`，与它上面的注释不符——复诊带入字段就是
  // source=user + pending，于是"上次核对过、本次没核对"的字段在服务端也能被挂上行动。
  // 客户端 `sheet.isUserConfirmed` 与这里必须是同一个口径；两份因运行时不同（函数是纯 .mjs，
  // 不能 import .ts）没法合成一份，所以由回归层 A 逐形状比对两边（R62 断言），漂了就红。
  const confirmedIds = new Set(
    fields.filter((f) => f.confirmStatus === "confirmed" || f.confirmStatus === "corrected").map((f) => f.id),
  );
  for (const a of actions) {
    if (a.fieldId !== undefined && !confirmedIds.has(a.fieldId)) throw bad();
  }
  return {
    purpose, patientLabel, dept, visitDate: payload.visitDate, createdAt, updatedAt,
    documents: payload.documents.map(sanitizeDoc),
    fields,
    actions,
    summaryNote,
    summaryVersions,
    questions: payload.questions.map((q) => {
      const id = pageId(q?.id);
      const text = str(q?.text, 2000);
      if (!id || text === null) throw bad();
      return { id, text };
    }),
    sheetHidden: payload.sheetHidden.map((id) => pageId(id) ?? (() => { throw bad(); })()),
    audit: payload.audit.map((a) => {
      const id = pageId(a?.id);
      const at = isoTime(a?.at);
      const action = str(a?.action, 60);
      const detail = str(a?.detail, 500);
      if (!id || !at || action === null || detail === null) throw bad();
      return { id, at, action, detail };
    }).slice(-2000),
  };
}

export async function readJson(request, maxBytes) {
  const type = request.headers.get("content-type")?.split(";")[0].trim();
  if (type !== "application/json") throw new DbError("unsupported_media", 415);
  const reader = request.body?.getReader();
  if (!reader) throw new DbError("invalid_payload", 400);
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) {
        await reader.cancel();
        throw new DbError("payload_too_large", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new DbError("invalid_payload", 400);
  }
}

export { uuid, str, bad, OBJECT_PATH };
