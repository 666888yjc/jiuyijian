import { buildItemClusters, dateMarkerOf, multiRecordClusters } from "./itemLedger";
import type { ItemCluster } from "./itemLedger";
import type { ExtractedField, FieldGroup, VisitTask } from "./types";

export const GROUP_TITLES: Record<FieldGroup, string> = {
  meta: "就诊信息",
  timeline: "症状与就诊时间线",
  history: "重要病史",
  medication: "当前用药",
  exam: "近期检查",
  allergy: "过敏史",
};

export const GROUP_ORDER: FieldGroup[] = [
  "meta",
  "timeline",
  "history",
  "medication",
  "allergy",
  "exam",
];

export function finalValue(f: ExtractedField): string {
  if (f.confirmStatus === "corrected" && f.userValue?.trim()) return f.userValue.trim();
  if (f.source === "user" && f.userValue?.trim()) return f.userValue.trim();
  return (f.aiValue ?? f.ocrRaw ?? "").trim();
}

/**
 * 「用户在**本次**核对里确认过了」——只有这一种算法（R61）。
 *
 * 为什么单列：这句此前在六处各写一遍（`eligibleForSheet`、`reference.isCarriable`、`metrics.failureModes`、
 * 隐私页计数、核对页进度、行动页的「关联已确认信息」下拉），而六处**已经不一样了**：行动页那份多了一条
 * `|| f.source === "user"`，于是复诊带入字段（I1/I2：`source=user` 但 `confirmStatus=pending`）会出现在
 * 标签写着「已确认」的下拉里，用户把行动挂到一个本次根本没核对过的字段上。
 * 入单门槛（`eligibleForSheet`）与"确认过"是**两件事**（前者还叠加占位值/证据要求），所以这里只表达后者。
 *
 * ⚠ 与 `confirmStatus !== "confirmed"` 那种**单状态**判断不是一回事（核对页用它决定"确认无误"按钮还显不显）：
 * 那是状态机分支，不是"确认过"口径，不要往这个函数上收。
 */
export function isUserConfirmed(f: ExtractedField): boolean {
  return f.confirmStatus === "confirmed" || f.confirmStatus === "corrected";
}

/**
 * 「这条字段指认得出原文的哪一行」——只算这一次（R67）。
 *
 * 为什么单列：判"有没有原文证据"此前有两种写法并存。入单门槛、排除列表、度量用
 * `docId && pageId && blockIds?.length`；而核对页的"查看原文证据"、交接单屏幕态的来源跳转、
 * 带入字段的跳转只看 `docId && pageId`。差的那一格是真实存在的：识别回来的字段若没匹配上任何原文块，
 * `DocsPage` 就是按 `blockIds: []` 落库的（同时保留 docId/pageId）⇒ 于是产品给一个写着
 * 「查看原文证据」的入口，点进去页面说"下方黄色高亮为该内容的来源原文"，而高亮是空的。
 * **那是在声称一种它并不具备的可回溯性**（红线③：重要事实必须可回溯到原文）。
 * 现在两边同一个判据；证据不完整时不制造入口，改说"只能整页对照"。
 */
export function hasOriginalEvidence(f: ExtractedField): boolean {
  return Boolean(f.docId && f.pageId && f.blockIds?.length);
}

/**
 * 「知不知道这条内容出自原件的哪一页」——**页级**，比 `hasOriginalEvidence` 弱一档（后者要求指认到行）。
 * 只可用于"去这一页对照"这类页级主张；凡是要说「病历原文」「可查看原文证据」「高亮来源」，
 * 必须用 `hasOriginalEvidence`（R67 立的分工：两件事两个名字，免得又拿弱条件去兑现强主张）。
 */
export function hasSourcePage(f: ExtractedField): boolean {
  return Boolean(f.docId && f.pageId);
}

/**
 * 「这条字段能回溯到什么程度」⇒「界面上 accordingly 能说什么、能给什么入口」。
 *
 * 为什么收成一张表（R67 续）：核对页那一格改成"行级/页级两档措辞"之后，`ActionsPage` 仍然无条件写
 * 「XX 的原文证据」、`SummaryPage` 仍然自己抄一遍 `docId && pageId`。手工补录的字段本就没有原件，
 * 那条入口在真浏览器里点出去是 `#/evidence/undefined/undefined/…` ⇒ 页面说「该资料可能已被删除」——
 * 它从来没被上传过，何来删除。**判据、措辞、入口三者必须同源**，否则修一处、漏两处，
 * 而漏掉的那一处正好是家属最容易点的那一个（行动清单挂在自述项上是常态）。
 */
export interface EvidenceAffordance {
  /** 三档强弱：能指认到行 / 只知道出自哪一页 / 根本没有原件 */
  level: "line" | "page" | "none";
  /** 是否给跳转入口。none 一律不给——死链比没有链更坏 */
  navigable: boolean;
  /** 回溯入口按钮文字（navigable=false 时不使用） */
  linkLabel: string;
  /** 行文里「来源：X 的〈noun〉」的那个名词 */
  noun: string;
  /** 复诊摘要条目上的短标签 */
  tag: string;
}

const EVIDENCE_AFFORDANCE: Record<"line" | "page" | "none-user" | "none-doc", EvidenceAffordance> = {
  line: { level: "line", navigable: true, linkLabel: "查看原文证据", noun: "原文证据", tag: "证据" },
  page: {
    level: "page",
    navigable: true,
    linkLabel: "查看该页原件（未指认到具体行）",
    noun: "该页原件（未指认到具体行）",
    tag: "整页对照",
  },
  // 到"没有原件"这一档只剩两种原因，而两种原因要说不同的话：手工补录的东西从来没上过云，
  // 不能被说成"资料已被删除"（那是另一种恐慌）。
  "none-user": { level: "none", navigable: false, linkLabel: "", noun: "手工补充，无原件可回溯", tag: "自述" },
  "none-doc": { level: "none", navigable: false, linkLabel: "", noun: "来源资料已被删除，无法回溯原文", tag: "原件已删" },
};

export function evidenceAffordance(f: ExtractedField): EvidenceAffordance {
  if (hasOriginalEvidence(f)) return EVIDENCE_AFFORDANCE.line;
  if (hasSourcePage(f)) return EVIDENCE_AFFORDANCE.page;
  return f.source === "user" ? EVIDENCE_AFFORDANCE["none-user"] : EVIDENCE_AFFORDANCE["none-doc"];
}

/** 摘要页那句图例：标签逐字取自上面那张表（图例另抄一份，就是下一轮的对账缺陷）。 */
export function evidenceTagLegend(): string {
  const t = (k: keyof typeof EVIDENCE_AFFORDANCE) => EVIDENCE_AFFORDANCE[k].tag;
  return `来源标注：「复诊带入」= 从历史任务带入、本次已重新核对的信息；「${t("none-user")}」= 你本人本次补充；`
    + `「${t("line")}」= 能指认到原文里的具体一行；「${t("page")}」= 只定位到该页、未指认到具体行。`;
}

/**
 * 「看不清」占位值判定：`?`、`？`、`无法辨认`… 这类值不是一条事实，只是转写纪律留下的洞。
 * 交接单是给医生看的定稿，出现「医师：?」等于把没读出的东西冒充成读出的东西 ⇒ 一律不入单，
 * 留在核对页让家属对着原件补。提示词只能要求模型别猜，这一行才是绕不过去的闸门。
 */
export function isUnreadablePlaceholder(value: string): boolean {
  const v = String(value ?? "").trim();
  if (!v) return true;
  return /^[\s?？。、\-.]+$/.test(v) || /^(无法|难以|不能|不)(辨认|识别|确定|看清|清晰|清楚)/.test(v);
}

/**
 * 安全硬门槛（代码级，不依赖提示词）：
 * 未确认、不确定、内容无法辨认的字段一律不得进入交接单；**高风险**字段还必须有可回联的原文证据。
 *
 * U11 订正（2026-09-24）：确认态要求对**所有来源**生效。此前 source=user 可跳过确认态直接入单，
 * 手工补充字段因创建时即 confirmed 而未暴露；复诊带入字段（source=user + pending，I1）会击穿该缺口，
 * 导致"上次核对过"的字段未经本次确认进入交接单，与 U9「未确认不入单」矛盾。
 * user 来源保留的豁免仅指"无原文证据要求"（手工补充/带入字段本任务内无 docId 证据）。
 *
 * R24 注释订正（不是放宽代码，是让注释别说过头话）：本函数头曾写着"无原文证据的字段一律不得进入"，
 * 但实际只有高风险字段要求证据；非高风险的无证据字段**故意入单并在导出文本里标「无证据」**
 * （见 §11 的两条断言）。把证据要求扩到全部字段会真的丢内容——病人确实在吃的药因为证据回联失败而消失，
 * 比带着"无证据"标注交给医生更危险。所以这里维持原口径，缺证据的问题改由"不许静默消失"那条路解决。
 */
export function eligibleForSheet(f: ExtractedField): boolean {
  if (isUnreadablePlaceholder(finalValue(f))) return false;
  // 依据已被撤掉的东西不许进单：家属删掉那份资料＝把它的出处撤了，让这种值继续入单等于把撤回过的信息交给医生。
  // 这一条必须排在「是否已确认」之前——否则他多点一次确认就把它放进去了。
  if (isSourceGoneField(f)) return false;
  if (!isUserConfirmed(f)) return false;
  if (f.source === "user") return true;
  if (f.highRisk) return hasOriginalEvidence(f);
  return true;
}

export interface SheetItem {
  fieldId: string;
  label: string;
  value: string;
  /** doc=医疗原文提取 ai=AI提取待确认 user=用户补充 */
  origin: "doc" | "user";
  hasEvidence: boolean;
  highRisk: boolean;
  /**
   * U11 A5：复诊带入字段的字段级引用指针（原样透传，不解析）。
   * 摘要视图据此把「上次就诊确认后带入的值」与「本次自述」区分开；
   * 原任务被删后指针仍在，由展示层降级为断裂文案（删除边界选项 b）。
   */
  refFrom?: ExtractedField["refFrom"];
  /**
   * 「（2026-09-26 · 按报告日期）」那一句；只有**同一个项目被两份以上资料记过**的行才有，
   * 其余行是空串。内容来自 `itemLedger.dateMarkerOf`，纸面不自己拼日期（R116：屏幕与纸面一套口径）。
   */
  dateNote: string;
}

export interface SheetSection {
  key: FieldGroup;
  title: string;
  items: SheetItem[];
}

function toOrigin(f: ExtractedField): "doc" | "user" {
  return f.source === "user" ? "user" : "doc";
}

/**
 * 纸面上「同一个项目被几份资料记过」这三件事——**谁与谁算一件事、谁新谁旧、每个值后面带什么日期**——
 * 一律吃 `src/itemLedger.ts` 那一套实现，这里不写第二份判定（R116）。
 * 此前屏幕上的归纳段与医生手里那张纸是两处逻辑：屏幕按新→旧排、每个值自带日期、配套说明栏不被当成
 * 第二次测量，而纸上还是读入顺序、值后面什么日期都没有 ⇒ 家属核对的那一屏与交出去的那张纸口径分叉。
 *
 * 范围要说清（这是**重排与加注**，不是筛选）：
 *  · 只动「同一个项目被两份以上来源记过」的那几行——让它们相邻、新的在前，各带自己的日期；
 *  · 其余行**留在各自原来的格子上**，家属在编辑页用 ↑↓ 排好的顺序不被改动；
 *  · 「参考区间／单位／提示」那一类配套栏、「药品名／剂量／频次」那一类一行的列名、文书抬头、
 *    日期栏都不被并成"第二次测量"（那是 `itemLedger` 的四类排除），但它们**每一行照旧印在纸上**——
 *    少不少一行由 `eligibleForSheet` 那一道门决定，这一层一行都不删。
 */
function arrangeSheetRows(task: VisitTask, rows: ExtractedField[]): { field: ExtractedField; dateNote: string }[] {
  const clusterOf = new Map<string, ItemCluster>();
  for (const c of multiRecordClusters(buildItemClusters(task, rows))) {
    for (const e of c.entries) clusterOf.set(e.field.id, c);
  }
  const out: { field: ExtractedField; dateNote: string }[] = [];
  const emitted = new Set<string>();
  for (const f of rows) {
    if (emitted.has(f.id)) continue;
    const c = clusterOf.get(f.id);
    if (!c) {
      out.push({ field: f, dateNote: "" });
      continue;
    }
    for (const e of c.entries) {
      if (emitted.has(e.field.id)) continue;
      emitted.add(e.field.id);
      out.push({ field: e.field, dateNote: dateMarkerOf(e.date) });
    }
  }
  return out;
}

export function buildSheetSections(task: VisitTask): SheetSection[] {
  const sections: SheetSection[] = [];
  for (const key of GROUP_ORDER) {
    const rows = task.fields.filter((f) => f.group === key && !task.sheetHidden.includes(f.id) && eligibleForSheet(f));
    const items = arrangeSheetRows(task, rows).map<SheetItem>(({ field: f, dateNote }) => ({
      fieldId: f.id,
      label: f.label,
      value: finalValue(f),
      origin: toOrigin(f),
      hasEvidence: hasOriginalEvidence(f),
      highRisk: f.highRisk,
      refFrom: f.refFrom,
      dateNote,
    }));
    if (items.length) sections.push({ key, title: GROUP_TITLES[key], items });
  }
  return sections;
}

/** 被拦下、未进入交接单的原因。四态各不同义，界面必须照实说，不能一律写成"尚未确认"。 */
export type BlockedReason = "unconfirmed" | "uncertain" | "unreadable" | "noevidence" | "sourceGone";

/** 「这条识别字段的来源资料已被删除」是一个**显式事实**，不是靠"没有 docId"猜出来的：
 *  · 猜出来的那一版会误伤——内置示例任务与历史数据里的 AI 字段本来就可能没有 docId，而本项目**有意**保留"非高风险、无原文证据的字段仍入单并标注无证据"（R61 的裁定：病人确实在吃的药消失，比带着标注交给医生更危险）；
 *  · 所以 `doc.delete` 当场打 `docGone: true`，服务端 `sanitizeField` 只认真值、缺这个键时**不补默认值**（补了就与那些没有这个键的旧数据永久差一个键，撞上 R74 那类"永久有未推改动"）。 */
export function isSourceGoneField(f: { docGone?: boolean }): boolean {
  return f.docGone === true;
}

/** 这一句在核对页与交接单提示里共用（判据、措辞、入口同源，R64/R67 那条纪律） */
export const SOURCE_GONE_NOTICE = "来源资料已被删除：这条不会再进入交接单。"

export function blockedReason(f: ExtractedField): BlockedReason | null {
  if (eligibleForSheet(f)) return null;
  const value = finalValue(f);
  // 顺序有讲究：先说内容层面的原因（值本身没读出来），再说流程层面的（没确认），
  // 最后才是"确认了但查无出处"——那种情况家属最需要知道，因为再点一次确认也没用。
  if (isUnreadablePlaceholder(value)) return "unreadable";
  if (f.confirmStatus === "uncertain") return "uncertain";
  if (isSourceGoneField(f)) return "sourceGone";
  if (f.confirmStatus === "pending") return "unconfirmed";
  return "noevidence";
}

/**
 * 被规则拦下、未进入交接单的字段（核对页提示用）。
 * 口径刻意保守：**沿用现网的"只提示 pending/uncertain"**，额外只放进来一类——
 * 值本身是「?」（无法辨认）的字段。那一类即使已确认也必须看得见，否则家属会以为它进了交接单。
 * （"已确认但缺证据的高风险字段"仍不进名单，那是另一条现网行为，不在此轮改动范围。）
 */
export function blockedFields(task: VisitTask): ExtractedField[] {
  return task.fields.filter((f) => {
    const reason = blockedReason(f);
    if (reason === null) return false;
    // 「无法辨认」与「缺原文证据」一律列出，即使家属已确认——否则条目从界面上静默消失，
    // 家属会以为它进了交接单（R21b 就是真浏览器里抓到这条）。纯"尚未确认"沿用现网口径。
    if (reason === "unreadable" || reason === "noevidence" || reason === "sourceGone") return finalValue(f).trim() !== "";
    return (f.confirmStatus === "pending" || f.confirmStatus === "uncertain") && Boolean(finalValue(f));
  });
}

/** 同一条识别事实的身份：同一份资料 + 同一组 + 同一标签 + 同一识别值。用户改过值不影响身份（aiValue 未变）。 */
function extractedFactKey(f: ExtractedField): string {
  return `${f.docId ?? `#${f.id}`}|${f.group}|${f.label}|${(f.aiValue ?? f.ocrRaw ?? "").trim()}`;
}

/**
 * 同一份资料被重复识别（双击、慢响应后再点、失败重试）时去掉重复行：
 * 一条事实排两行，家属要多点一次确认，交接单上同一项会印两遍。
 * 跨资料的相同值**不**去重——那是两处原文互相印证，各行都要留自己的出处。
 */
export function dedupeExtractedFields(existing: ExtractedField[], incoming: ExtractedField[]): ExtractedField[] {
  const seen = new Set(existing.map(extractedFactKey));
  const out: ExtractedField[] = [];
  for (const f of incoming) {
    const key = extractedFactKey(f);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

export function uid(prefix = ""): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function now(): string {
  return new Date().toISOString();
}
