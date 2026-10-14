// 「同一台设备上只允许一个可写上下文」——租约的判定（R136，known-issues ⑳ 的③路，主理人 10-11 拍定）。
//
// 为什么不装"采纳另一页那一份"（候选①）：R133 按主理人拍的三道守卫装上并干净量过——
// 回声与凭空 409 确实治住了，但两边同一百毫秒内各自动一次手时，后写存储那一方时间戳更新，
// 先写那一方的守卫不拦 ⇒ 它采纳、又被标成"已同步" ⇒ 它那一次**既没推上服务器也没留在本机**，
// 比不装守卫时更糟。全过程与读数写在 docs/known-issues.md ⑳ 的进展（R132／R133 两段），
// 原始件留在仓库外的 r133-readings.json（不进包、不进仓——R128 那条「产品源码里不许写个人绝对路径」的门本轮又真拦了一次）。
//
// 为什么这里**没有定时器**（R135 定的形状，别在下一轮加回来）：
// 早先的草案是"持有者每 4 秒续一次心跳、12 秒不算陈旧"，那等于把"谁能写"交给
// Chrome 对后台标签页的节流脾气（未验、会变）。改成事件驱动之后：
//   · 交还＝页面关掉时 `pagehide` 释放（正常情况立刻可接管）；
//   · 降级＝看到别人 claim 的 `storage` 事件（即时，不需要轮询）；
//   · 接管＝**用户按下那一刻**判一次陈旧（那一刻页面必然在前台，谈不上节流）；
//   · TTL 只剩一个用途：给"崩溃/进程被杀、来不及释放"那一种兜底。
//
// 判定全做成纯函数（输入是"串 + 自己是谁 + 此刻几点"），回归层 A 组能直接拿真输入输出吃它；
// 浏览器侧（`src/store.tsx`）只负责读写字典里那一个小键与放不放行，不再藏第二份判断。
export const LEASE_KEY = "jiuyijian-writer-lease-v1";

/**
 * 陈旧判定只用在"按下时能不能接管"这一处。30 秒的来由：一次正常的"另一页关了"由 `pagehide` 即时释放，
 * 走不到这里；能走到的只有崩溃/被杀，那时用户下一次按下多半在几十秒之后。
 * 它不参与任何降级决定，所以取大取小都不会误锁住活人——取小反而会让两个上下文同时写。
 */
export const LEASE_STALE_MS = 30_000;

export interface Lease {
  tab: string;
  at: number;
}

/** 解析租约串。认不出（空、别的版本写的、时间戳不是数）一律回 null＝"现在没人持有" */
export function parseLease(raw: string | null | undefined): Lease | null {
  if (typeof raw !== "string" || !raw) return null;
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!o || typeof o !== "object") return null;
  const item = o as { tab?: unknown; at?: unknown };
  if (typeof item.tab !== "string" || !item.tab) return null;
  if (typeof item.at !== "number" || !Number.isFinite(item.at)) return null;
  return { tab: item.tab, at: item.at };
}

/** 这一页能不能写：没人持有 / 自己持有 / 别人持有但已陈旧（陈旧即可接管） */
export function canWrite(lease: Lease | null, selfTab: string, nowMs: number): boolean {
  if (!lease) return true;
  if (lease.tab === selfTab) return true;
  return nowMs - lease.at > LEASE_STALE_MS;
}

/**
 * 反过来那一面：别人持有一条**还不陈旧**的租约 ⇒ 这一页必须只读。
 * 与 `canWrite` 是同尺两面，分开写是要让判据能各钉各的（合成一条就看不见"抢回来"与"被抢下台"这两形）。
 */
export function mustStepDown(lease: Lease | null, selfTab: string, nowMs: number): boolean {
  return lease !== null && lease.tab !== selfTab && nowMs - lease.at <= LEASE_STALE_MS;
}

/** 持有者写下的那串。`at` 由调用方传进来，判据才能喂一个明确的老值（时间类判据不许比两次 now()） */
export function leaseStringOf(selfTab: string, nowMs: number): string {
  return JSON.stringify({ tab: selfTab, at: nowMs } satisfies Lease);
}

/** 家属可见的那句话（**草稿**，等主理人定稿）：只说"另一个页面正在核对"与"要改回那一个页面"，不猜是谁开的、也不说"那边已经存好了" */
export const WRITER_LOCK_NOTICE = "这份就诊记录正在另一个页面里核对，这个页面只读。要修改，请回到那一个页面。";

/** 按下被拦下时补的那半句（同一条纪律：不许只让按钮没反应——R72／R105／R106 那一族） */
export const WRITER_LOCK_BLOCKED = "刚才那一次修改在这个页面没有生效：请回到正在核对的那个页面改。";
