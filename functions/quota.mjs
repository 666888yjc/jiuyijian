// 识别调用配额闸门：挡的是**成本失控**这一类真实事故——脚本化重放、前端重试风暴、会话被人拿住反复点识别。
// R31 的账本让"花了多少"可见，这一层让"最多能花多少"可控；两者读同一份账，避免两套数。
//
// 两道闸门：
//   · 单人单日：查 extract_jobs 当日该 owner 的行数（每行背后就是一次真实派发）；
//   · 全局单日：读成本账本当天的 calls（账本按完成计数 ⇒ 在途请求有少量滞后，用于护栏足够）。
//
// 三条刻意的边界：
//   1. **只挡要发模型请求的那一步**。复用幂等键、上传原件、人工编辑、交接单输出、行动清单都不受配额影响
//      ——清单 D 段"模型不可用时上传/人工编辑仍可用"这条红线不能因为加了配额被自己拆掉。
//   2. **计数读失败就放行**（fail-open）：账本或查询坏了，不能让一个正在给父亲整理病历的家属识别不了资料；
//      成本护栏不是安全边界，可用性优先，但要 console.warn 留痕。
//   3. 上限值是**按"一轮就诊几十份资料 × 少量重试"取整**得到的，不是从平台额度算出来的（平台额度取不到）；
//      改数值要同时改 A2 里那条"配额耗尽后仍放行幂等复用与人工路径"的断言。
//   4. 两道闸门在**两条通路上都有效**：R36 起 QCA 适配器也在派发点报量（此前只有 cloud-llm 报，
//      全局上限在 QCA 通道上是惰性的）。记账时点有意不同——llm 同步通路在完成/失败时记，
//      qca 异步通路在派发时记（pollJob 会被反复调用，在完成态记会重复计数）。
import { usageKeyFor } from "./usage-ledger.mjs";

export const QUOTA_DEFAULTS = { ownerPerDay: 60, globalPerDay: 400 };

const dayOf = (d) => new Date(d).toISOString().slice(0, 10);

export function makeQuotaGuard({ db, now = () => new Date(), limits = QUOTA_DEFAULTS }) {
  return {
    async check(ownerId) {
      const day = dayOf(now());
      try {
        const mine = await db.countJobsSince(ownerId, `${day}T00:00:00.000Z`);
        if (Number.isFinite(mine) && mine >= limits.ownerPerDay) {
          return { allowed: false, reason: "owner", used: mine, limit: limits.ownerPerDay };
        }
        const row = await db.resGet(usageKeyFor(day));
        const total = Number(row?.data?.calls ?? 0);
        if (Number.isFinite(total) && total >= limits.globalPerDay) {
          return { allowed: false, reason: "global", used: total, limit: limits.globalPerDay };
        }
        return { allowed: true, used: Number.isFinite(mine) ? mine : 0, limit: limits.ownerPerDay };
      } catch (error) {
        // 契约（本文件头第 2 条边界 + A 组 R35 判据）：计数读失败就放行——成本护栏不是安全边界，
        // 不能让一个正在给父亲整理病历的家属因为账本读不出来就识别不了资料；degraded 留痕供观测。
        // （2026-10-15 门禁抓出此处实现在 fail-closed，与契约相反，已按契约订正。）
        console.warn(`quota_check_degraded:${error?.code ?? "unknown"}`);
        return { allowed: true, reason: "degraded", degraded: true, used: 0, limit: limits.ownerPerDay };
      }
    },
  };
}
