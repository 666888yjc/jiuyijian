// 「哪些识别还在路上」——本页之外的第二现场。
//
// 为什么需要这个模块（R69 的真浏览器实测）：轮询循环原先只活在 DocsPage 的组件里
// （`pollingRef` + `useState<Record<string, DocJob>>`）。家属点一下「识别此资料」再切到
// 「信息核对」看一眼别的东西，回来时循环已经随组件卸载被掐断——实测切走 36 秒期间
// 服务端收到 **0 次轮询**，那份作业一直躺在 `dispatched`：**云端那一次调用是要花钱的，
// 而结果永远不会落到他手上**（除非他恰好又点一次「识别此资料」）。刷新页面同理。
//
// 所以这里只存"凭据"（docId → jobId + 起跑时间），不存结果：作业本身在服务端，
// 客户端任何时候回到这一页，都凭这条记录把轮询接回去。换设备/清了本机数据就没得接，
// 这是诚实的边界——本机数据本来也只在这台设备上。
import type { SourceDocument, VisitTask } from "./types";

const STORAGE_KEY = "jiuyijian-inflight-extracts-v1";

/** 单次识别在前端这边的预算：超过它，这条凭据就当作过期丢掉（服务端另有自己的 ai_timeout 口径） */
export const POLL_BUDGET_MS = 8 * 60 * 1000;
export const POLL_MS = 5000;

export interface InflightExtract {
  taskId: string;
  jobId: string;
  startedAt: number;
}

export type InflightMap = Record<string, InflightExtract>;

const UUID_LIKE = /^[0-9a-f-]{8,}$/i;

function sane(v: unknown): v is InflightExtract {
  const o = v as InflightExtract;
  return !!o && typeof o.taskId === "string" && typeof o.jobId === "string" &&
    typeof o.startedAt === "number" && Number.isFinite(o.startedAt);
}

/**
 * 读回来顺手打扫：过期、docId 形状不对、以及**这条资料已经不在了**的，一律丢掉。
 * `liveDocIds` 传 null 表示"还没拿到任务列表，先不判存在性"（只按时间打扫）。
 */
export function pruneInflight(raw: unknown, now: number, liveDocIds: Set<string> | null): InflightMap {
  const out: InflightMap = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [docId, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!sane(v)) continue;
    if (!UUID_LIKE.test(docId) || !UUID_LIKE.test(v.jobId)) continue;
    if (now - v.startedAt > POLL_BUDGET_MS) continue;
    if (liveDocIds && !liveDocIds.has(docId)) continue;
    out[docId] = { taskId: v.taskId, jobId: v.jobId, startedAt: v.startedAt };
  }
  return out;
}

/** 从本机存储读回全部仍在预算内的在途识别（存储不可用／内容损坏 ⇒ 空表，不抛） */
export function readInflight(now: number = Date.now(), liveDocIds: Set<string> | null = null): InflightMap {
  try {
    return pruneInflight(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null"), now, liveDocIds);
  } catch {
    return {};
  }
}

function writeInflight(map: InflightMap) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* 存储不可用：退回"只在本页活着"的旧行为，不影响识别本身 */
  }
}

/** 记下一次刚派发的识别；同一份资料只保留最后一次的凭据 */
export function rememberExtract(taskId: string, docId: string, jobId: string, now: number = Date.now()): InflightMap {
  const map = readInflight(now);
  map[docId] = { taskId, jobId, startedAt: now };
  writeInflight(map);
  return map;
}

/**
 * 识别到达终态（完成／失败／超时）或这条资料被删 ⇒ 凭据就没意义了。
 * 传 `jobId` 时**只清这一份**：旧循环迟到的终态（例如用户又发起了一次识别）不许把新凭据抹掉。
 */
export function forgetExtract(docId: string, jobId: string | null = null, now: number = Date.now()): InflightMap {
  const map = readInflight(now);
  const v = map[docId];
  if (!v || (jobId !== null && v.jobId !== jobId)) return map;
  delete map[docId];
  writeInflight(map);
  return map;
}

/** 任务被删：它名下所有在途凭据一起清掉（否则 docId 再也对不上，只能等 TTL） */
export function forgetTask(taskId: string, now: number = Date.now()): InflightMap {
  const map = readInflight(now);
  let changed = false;
  for (const [docId, v] of Object.entries(map)) {
    if (v.taskId === taskId) {
      delete map[docId];
      changed = true;
    }
  }
  if (changed) writeInflight(map);
  return map;
}

/** 这一页要接回去的：属于本任务、且这份资料还处于 pending/processing 的那些 */
export function resumableFor(map: InflightMap, task: VisitTask): Array<{ doc: SourceDocument; jobId: string }> {
  const out: Array<{ doc: SourceDocument; jobId: string }> = [];
  for (const doc of task.documents) {
    const v = map[doc.id];
    if (!v || v.taskId !== task.id) continue;
    if (doc.status === "done" || doc.status === "failed") continue;
    out.push({ doc, jobId: v.jobId });
  }
  return out;
}
