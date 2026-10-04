// 「今天是哪天」只有一个算法：本地时区的 YYYY-MM-DD。
//
// 为什么要单列（R60）：这句原先在 ActionsPage / SummaryPage / TaskListPage 各写了一遍（三份逐字相同的实现）。
// 三处独立实现意味着**可以互相不一致而没人发现**：同一条复查行动可能在任务列表上顶着"N 项行动已逾期"，
// 点进行动页却不标红；或摘要页判定「拟就诊日期未到」而列表页判定已过期。对一款给家属用的交接工具，
// "还剩几天 / 已经逾期"是会被拿去做决定的信息，两个页面说法不一致就等于把判断依据交给了运气。
// 同 R44/R45 那条口径（数据在哪里必须一个口径出）是同一类问题，只是这次落在日期上。
//
// ⚠ 服务端 `functions/quota.mjs` / `usage-ledger.mjs` 里的 UTC 日切（`toISOString().slice(0,10)`）
//   是**另一件事**：配额要一个全球一致的计账桶，不是用户眼中的"今天"。两者不要合并。

/** 本地时区的 YYYY-MM-DD（给定任一时刻）；跨时区不换算——原件上写哪天就按本机日历落成哪一天 */
export function localDateStr(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** 本地时区的 YYYY-MM-DD；`now` 仅为可测试性而存在（默认取当前时刻） */
export function todayDateStr(now: Date = new Date()): string {
  return localDateStr(now);
}
