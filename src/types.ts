export type DocType = "outpatient" | "prescription" | "report" | "inpatient" | "unknown";
export type DocStatus = "uploaded" | "processing" | "done" | "failed";

export type FieldGroup =
  | "meta"
  | "timeline"
  | "history"
  | "medication"
  | "exam"
  | "allergy";

export type ConfirmStatus = "pending" | "confirmed" | "corrected" | "uncertain";
export type Confidence = "high" | "medium" | "low" | "failed";
export type FieldSource = "ai" | "user";

export interface EvidenceBlock {
  id: string;
  text: string;
}

export interface SourcePage {
  id: string;
  pageNo: number;
  kind: "image" | "pdf";
  blocks: EvidenceBlock[];
  imageDataUrl?: string;
  empty?: boolean;
}

export interface SourceDocument {
  id: string;
  name: string;
  docType: DocType;
  status: DocStatus;
  pages: SourcePage[];
  addedAt: string;
  /** M1 模拟上传的文件元信息 */
  fileSize?: number;
  mime?: string;
  /** 服务端加密存储中的原件路径（登录后上传才有） */
  objectPath?: string;
  /**
   * 这份资料的文本层**一共**多少字节（解析时数，剪之前）。留着它是为了让"只保留了 44%"这件事
   * 在刷新、换设备之后仍然说得出口（R76）；没有这个数就当没截过，不许拿 0 冒充事实。
   */
  textSeenBytes?: number;
  /** PDF 自己报的总页数（本机只解析了前若干页时，资料行那句「共 N 页」要说两半，不能只报解析过的数） */
  pagesTotal?: number;
}

export interface ExtractedField {
  id: string;
  group: FieldGroup;
  label: string;
  ocrRaw: string;
  aiValue: string | null;
  userValue: string | null;
  highRisk: boolean;
  confidence: Confidence;
  confirmStatus: ConfirmStatus;
  source: FieldSource;
  docId?: string;
  pageId?: string;
  blockIds?: string[];
  /** 来源资料已被删除（`doc.delete` 打的标记）：这条永不进入交接单，界面上要说得出原因 */
  docGone?: boolean;
  /**
   * R112「算同一项」：把「血肌酐」和「血肌酐 / Cr」并成一项时，人挑的那个项目名就写在这里（几条记录各写同一个值）。
   * **只有人点过才有这个键**——产品不自动并项（认别名是医学判断）；「拆开」把它去掉后一切退回原样，值本身一个字不动。
   * 服务端 `sanitizeField` 只认非空字符串，别的（含 `""`、含拼错类型）一律不写这个键（与 `docGone` 同一配方，R74）。
   */
  itemGroup?: string;
  /** 与其他字段值冲突时，双方互相记录对方 id，UI 并列展示、不代用户判断 */
  conflictWith?: string[];
  modelVersion?: string;
  /**
   * R96「这一条到底是谁认出来的」：`"test"` ＝ 服务端这一侧的传输目标是**测试剧本服务**（`dev/fake-llm`／`dev/fake-ocr`），
   * 于是界面对患者说一句"这一条来自测试假模型"；`"real"` ＝ 打的是真端点；**没有这个键＝不知道，一律不许显示那句话**
   * （2026-09-28 的真实事故：主理人在手机上看到假模型写好的台词，以为是产品认出了他上传的单据）。
   * 服务端 `sanitizeField` 只认这三个值、且不替旧数据补默认值——补了就与"本机那些没这个键的字段"永远差一个键（R74 那一族）。
   */
  modelKind?: "real" | "test" | "unknown";
  /** U11 复诊闭环：本字段引自历史任务的哪个字段（字段级引用，反推 referencedBy，不落双写） */
  refFrom?: { taskId: string; fieldId: string };
  updatedAt: string;
}

export interface QuestionItem {
  id: string;
  text: string;
}

export type ActionType = "followup" | "medication" | "observation";

// 三处展示共用同一份标签；类型是 Record<ActionType,...>，新增类型而未补标签时 tsc 直接报错
export const ACTION_TYPE_LABELS: Record<ActionType, string> = {
  followup: "复查",
  medication: "服药",
  observation: "观察",
};

export interface ActionItem {
  id: string;
  type: ActionType;
  content: string;
  /** YYYY-MM-DD；来自已确认资料或用户手动填写，产品不生成医学建议 */
  date: string;
  done: boolean;
  doneAt?: string;
  doneNote?: string;
  /** 来源：已确认字段的 id（可回溯证据） */
  fieldId?: string;
  createdAt: string;
}

export interface AuditEvent {
  id: string;
  at: string;
  action: string;
  detail: string;
}

export interface SummaryVersion {
  id: string;
  savedAt: string;
  text: string;
}

export interface VisitTask {
  id: string;
  patientLabel: string;
  purpose: string;
  dept: string;
  visitDate: string;
  createdAt: string;
  updatedAt: string;
  documents: SourceDocument[];
  fields: ExtractedField[];
  questions: QuestionItem[];
  actions: ActionItem[];
  /** 复诊摘要：就诊后新变化（用户自述） */
  summaryNote?: string;
  summaryVersions?: SummaryVersion[];
  /** 交接单编辑页中被隐藏的字段 id */
  sheetHidden: string[];
  audit: AuditEvent[];
}

export const HIGH_RISK_LABELS = [
  "药品名称",
  "剂量",
  "频次",
  "给药途径",
  "过敏史",
  "诊断原文",
  "检查数值/单位/参考区间",
  "复查日期",
];
