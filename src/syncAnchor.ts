// 本机记下的"这份任务上次跟服务器上那份是什么关系"——只存 id 与两条时间戳，不存任何资料内容（R74）。
//
// 为什么需要它（2026-09-27 真浏览器实测，产物 `index-XKoIuelR.js`）：
// R70 把合并判据做成"本机这份 ≠ 上次写穿的那份 ⇒ 有未推的改动，保住本机"，那份基线放在内存里
// （`savedRef`）。内存意味着**每次刷新都清零**，而清零后的判据恒为真——于是每次打开页面，
// 每一条本机已有、服务器也有的任务都被判成"本机有未推改动"：
// ① 服务端那份永远不被采纳（合并这条路整条失效）；
// ② 本机那份被无条件推回去，把**另一台设备刚写上去的更新覆盖掉**。
// 实测：本机零改动，只按一次 F5，夹具侧 `task-save` 从 4 变成 5；再造一次"另一台设备"的服务端写入
// （`purpose` 改成新值、`updatedAt` 更晚）后刷新，服务器上那条新值被本机旧内容**盖掉**，界面显示的
// 还是旧标题。R70 承诺"不许悄悄吃掉人的核对"，这次吃掉的是别人那台的核对。
//
// 所以需要一份跨刷新还在的账，且它必须能回答两个问题：**本机这份动过吗？服务器那份动过吗？**
// 两条时间戳就够，而且都不依赖时钟：
//   · `localAt` = 本机上次与服务端一致时，任务自己的 `updatedAt`（本机自己写的字符串，
//     只跟自己的历史比 ⇒ 设备时钟偏多少都无所谓）；
//   · `serverAt` = 那次一致时服务端行的 `updatedAt`（`functions/handler.mjs` 的 task-save 用
//     服务器时钟写、并回给客户端；列表里也带着）⇒ 跨设备可比，同样不读客户端钟。
// 于是"只有本机动了"＝保住本机再推上去（R70 那条），"只有服务器动了"＝采纳服务器那份（就是同步本身），
// "两边都动了"＝**谁也不许盖谁**，停下并说出来。
//
// 三条刻意的取舍：
// ① 只装 id + 两条 ISO 串，不含 purpose / 字段 / 任何资料内容——与 `src/deletedLedger.ts` 同一条纪律
//    （回归层 A 拿一条含 canary 的任务写进去，再断言账本原文里搜不到那个 canary）。
// ② 不设 TTL：忘了就等于回到"未知"，而未知的那一支会多问一次，不该由时钟替用户决定。
// ③ 有上限（FIFO 丢最旧的一条），撑爆本机存储比少记一条更要命；记满丢旧的行为做成可断言的。
const KEY = "jiuyijian-sync-anchor-v1";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CAP = 1000;

export interface SyncAnchor {
  /** 服务端行上次与本机一致时的 `updated_at`（服务器时钟，跨设备可比） */
  serverAt: string;
  /** 那次一致时任务自己的 `updatedAt`（本机时钟，只跟自己的历史比） */
  localAt: string;
}

const isIso = (v: unknown): v is string => typeof v === "string" && v.length > 0 && !Number.isNaN(Date.parse(v));

/** 账本条目：`id` 与两条时间戳成对存，数组顺序就是写入顺序（FIFO 靠它） */
interface Entry {
  id: string;
  serverAt: string;
  localAt: string;
}

const readEntries = (): Entry[] => {
  try {
    const parsed = JSON.parse(globalThis.localStorage.getItem(KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    // 坏数据整表降级为空：这条账只用来"少做一件危险的事"，它坏了不该拖住同步这条路
    return parsed.filter(
      (e): e is Entry => !!e && typeof e.id === "string" && UUID_RE.test(e.id) && isIso(e.serverAt) && isIso(e.localAt),
    );
  } catch {
    return [];
  }
};

const writeEntries = (entries: Entry[]) => {
  try {
    globalThis.localStorage.setItem(KEY, JSON.stringify(entries));
  } catch {
    // 写不进去（隐私模式 / 配额）就当没记过——宁可下次多问一次，也不许因为记账失败而把用户的改动推出去覆盖别人
  }
};

export function readSyncAnchors(): Map<string, SyncAnchor> {
  const m = new Map<string, SyncAnchor>();
  for (const e of readEntries()) m.set(e.id, { serverAt: e.serverAt, localAt: e.localAt });
  return m;
}

/** 合并算完后整表落盘（顺序沿用合并结果：新写入的排在后面，超出上限时丢最旧的） */
export function writeSyncAnchors(anchors: Map<string, SyncAnchor>): number {
  const entries: Entry[] = [];
  for (const [id, a] of anchors) {
    if (!UUID_RE.test(id) || !isIso(a?.serverAt) || !isIso(a?.localAt)) continue;
    entries.push({ id, serverAt: a.serverAt, localAt: a.localAt });
  }
  const trimmed = entries.length > CAP ? entries.slice(entries.length - CAP) : entries;
  writeEntries(trimmed);
  return trimmed.length;
}

export function getSyncAnchor(taskId: string): SyncAnchor | undefined {
  return readSyncAnchors().get(taskId);
}

/** 记一笔"这个 id 的本机这份，上次和服务器上那份是同一份" */
export function setSyncAnchor(taskId: string, anchor: SyncAnchor): void {
  const anchors = readSyncAnchors();
  anchors.delete(taskId); // 重新 append：这条 id 刚被确认过，不该是最先被淘汰的
  anchors.set(taskId, anchor);
  writeSyncAnchors(anchors);
}

export function forgetSyncAnchor(taskId: string): void {
  const anchors = readSyncAnchors();
  if (!anchors.delete(taskId)) return;
  writeSyncAnchors(anchors);
}

export const SYNC_ANCHOR_KEY = KEY;
export const SYNC_ANCHOR_CAP = CAP;
