import type { VisitTask } from "./types";

/**
 * 「本机与服务器各有一份」之后，让家属自己挑一份留下（主理人 2026-09-28 批准，R97 实现）。
 *
 * 这个文件存在的理由，是把三件最容易各说各话的东西收在一处：
 * ① 两份的差别怎么说（哪些项只在一份里、哪些同名不同值）；
 * ② 挑了之后另一份会怎么样；
 * ③ 按钮叫什么、点了写哪一条操作记录。
 *
 * **"取不回来"这一句不是修辞，是 2026-09-28 在真实夹具上量出来的**：
 *   · 服务器一条任务只存一行——另一台设备写进去那句「另一台设备写的复诊要点」，在本机那份推上去之后
 *     从 `action=tasks` 里**读不到了**（现测 false）；
 *   · 没有版本可读——`action=task-versions` 与 `action=task-history` 实测都回 **404 `not_found`**，
 *     `functions/handler.mjs` 支持的 action 名单里也没有任何历史类接口。
 * ⇒ 所以这句话必须在**按下去之前**出现，并且要指一条此刻界面上真存在的出路
 *   （「隐私与数据」页的「导出我的数据（JSON）」，或把交接单打印／另存为 PDF）。
 */
export type ConflictChoice = "local" | "server";

export interface ConflictDiff {
  /** 本机这份数据里最后写上的时间 */
  localAt: string;
  /** 服务器写在那一行上的时间（服务器时钟，与上面那个不是同一个来源） */
  serverAt: string;
  onlyLocal: string[];
  onlyServer: string[];
  differs: string[];
  /** 复诊要点这一栏两边文字不同：患者最常看的一栏，单独点名 */
  summaryDiffers: boolean;
}

/** 一条任务里"患者看得见的东西"的名字：字段名／行动内容／提问文字（不比时间戳这类噪音） */
const itemNames = (t: VisitTask, kind: "field" | "action" | "question"): Map<string, string> => {
  const out = new Map<string, string>();
  if (kind === "field") for (const f of t.fields) out.set((f.label || f.id).trim(), (f.userValue ?? f.aiValue ?? f.ocrRaw ?? "").trim());
  if (kind === "action") for (const a of t.actions) out.set(a.content.trim(), a.content.trim());
  if (kind === "question") for (const q of t.questions ?? []) out.set(q.text.trim(), q.text.trim());
  return out;
};

export function diffConflict(local: VisitTask, server: VisitTask, serverAt: string): ConflictDiff {
  const onlyLocal: string[] = [];
  const onlyServer: string[] = [];
  const differs: string[] = [];
  const tag = { field: "", action: "行动：", question: "提问：" } as const;
  for (const kind of ["field", "action", "question"] as const) {
    const a = itemNames(local, kind);
    const b = itemNames(server, kind);
    for (const [k] of a) if (!b.has(k)) onlyLocal.push(`${tag[kind]}${k}`);
    for (const [k] of b) if (!a.has(k)) onlyServer.push(`${tag[kind]}${k}`);
    if (kind === "field") {
      for (const [k, v] of a) {
        const w = b.get(k);
        if (w !== undefined && v !== w) differs.push(`${k}（本机「${v || "空"}」／服务器「${w || "空"}」）`);
      }
    }
  }
  return {
    localAt: local.updatedAt,
    serverAt,
    onlyLocal,
    onlyServer,
    differs,
    summaryDiffers: (local.summaryNote ?? "").trim() !== (server.summaryNote ?? "").trim(),
  };
}

/** 一句范围准确的总结。范围＝**这一条任务**，不是"这台设备"（R84 那条范围纪律） */
export function conflictDiffLine(d: ConflictDiff): string {
  const parts: string[] = [];
  if (d.differs.length) parts.push(`${d.differs.length} 项同名的内容两边不一样`);
  if (d.onlyLocal.length) parts.push(`${d.onlyLocal.length} 项只有本机这份有`);
  if (d.onlyServer.length) parts.push(`${d.onlyServer.length} 项只有服务器那份有`);
  if (d.summaryDiffers) parts.push("复诊要点两边写的不同");
  return parts.length ? parts.join("；") : "两份逐项比过是一样的（差别只在记录时间），可以随便挑一份";
}

/** 两份各自动过的时间：各自标明是谁的时间，别让人以为同一栏里两个数字是同一回事 */
export const LOCAL_AT_LABEL = "本机这份最后写入的时间";
export const SERVER_AT_LABEL = "服务器那一行最后被写的时间（服务器时钟）";

/** 按下去之前必须看见的那句代价：只说这一条任务、只说"被替换"与"取不回来"，不承诺任何自动合并 */
export function conflictConsequence(keep: ConflictChoice): string {
  return keep === "local"
    ? "这样做的结果：本机这一份会原样留下，服务器那一行会被它替换掉。服务器一条任务只存一行，也没有版本可以查，所以被替换掉的那一份，我方取不回来。要先把那一份留住，就到「隐私与数据」页按「导出我的数据（JSON）」存一份，或把交接单打印／另存为 PDF。"
    : "这样做的结果：服务器那一版会原样留下，本机这一份会被它替换掉。被替换掉的本机那一份，在本机上也找不回来（我方没有地方能把它取回）。要先把这一份留住，就到「隐私与数据」页按「导出我的数据（JSON）」存一份，或把交接单打印／另存为 PDF。";
}

/** 操作记录那一句：写清挑了哪份、另一份怎样了——不写成「已同步」那种兑不了诺的话 */
export function conflictAudit(keep: ConflictChoice): { action: string; detail: string } {
  return keep === "local"
    ? { action: "conflict.resolve", detail: "并排看过两份后选了本机这份；服务器那一行被替换（不可恢复）" }
    : { action: "conflict.resolve", detail: "并排看过两份后用了服务器那一版；本机这份被替换（不可恢复）" };
}

/** 按钮与标题的措辞：界面与判据共用，同一句话不许在两处各抄一遍 */
export const CONFLICT_PICKER_TITLE = "这条任务有两份，各改各的——请挑一份留下";
export const CONFLICT_PICKER_TRIGGER = "并排看这两份，挑一份留下";
export const conflictButtonLabel = (keep: ConflictChoice): string => (keep === "local" ? "留下本机这份" : "用服务器那一版");
export const conflictConfirmLabel = (keep: ConflictChoice): string => (keep === "local" ? "确认：留下本机这份" : "确认：用服务器那一版");
/** 挑完之后给读屏与键盘用户的一句结果话（只在真挑完时出现） */
export const conflictDoneNotice = (keep: ConflictChoice): string =>
  keep === "local"
    ? "已按你选的留下本机这份，正在把这一份存到服务器；服务器那一份已被替换，无法恢复。"
    : "已按你选的用服务器那一版，本机这一份已被替换；这台设备上找不回来。";

/**
 * 挑了服务器那一版之后本机这份长什么样：**那一版原样 + 一条操作记录，但 `updatedAt` 换成这次选择自己的时刻**。
 * 单独放一处是因为这一格错过一次：先前按「不许盖新时刻」写（怕刚采纳完就把服务器那份推回去盖掉，来回震荡），
 * 真浏览器复验量到的是反面——队列只比时间戳，不盖就判「本机没动」，于是屏幕写着「已同步」而这次决定从不上服务器。
 * 不会震荡的原因：采纳进来的就是服务器那一版的内容，推上去内容与服务器那行相同，只是多了一条操作记录。
 */
export function adoptedTask(server: VisitTask, audit: VisitTask["audit"][number]): VisitTask {
  // `updatedAt` 取这条审计自己的时刻。不盖新时刻的话，队列那边只比时间戳（锚点路径），
  // 会把这次选择当成「本机没动」而永不推上去 ⇒ 屏幕上说「已同步」，服务器上却看不到这次决定。
  return { ...server, updatedAt: audit.at, audit: [...server.audit, audit] };
}

/** 服务器那一版本轮没读到时给的那句：没有对手就不许出现"挑一份"的按钮 */
export const NO_SERVER_COPY_NOTICE = "现在拿不到服务器那一版的原样（这一轮没能连上，或它已不在冲突名单里），所以这里不做选择：等两份都读到了再并排比。";
