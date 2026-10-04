import type { ExtractedField } from "./types";

/**
 * 「这一条是谁认出来的」那句话的唯一出处（R96）。
 *
 * 由来是 2026-09-28 的真实事故：主理人拿手机上传一张真单据，屏幕上出现一段**测试剧本预先写好的台词**
 * （虚构医院、HGB 132、PLT 186），他据此问"识别结果是错的，是你自己杜撰的吗"——杜撰的不是我方，
 * 是**界面上没有任何一处说明这一刻跑的是假模型**。`modelVersion` 帮不上这个忙：假 `llm` 通路回的那串
 * 与真通路**逐字节相同**（同一个 `PROMPT_VERSION|model` 形状），所以判据必须是服务端自己声明的 `modelKind`。
 *
 * 三条纪律写在这里，都由回归层 A 钉住：
 * ① **只有 `modelKind === "test"` 才说这句话**——`"real"` 与"没有这个键"一律不说（不知道就不断言，R68 同形）；
 * ② 措辞的范围与代码一致：这是**逐条字段**的判断，所以句子说「这一条」，整页那句只能说"有 N 条"，
 *    不许写成"这台设备上／本次识别的所有结果都是假的"那种全局承诺（R84 那一条纪律的同形）；
 * ③ 这句话必须是**可见文本**（`role="status"`，不靠 hover、不靠 title）——手机上根本没有 hover（R81 实测）。
 */
export const SYNTHETIC_MODEL_NOTICE = "这一条识别值来自测试假模型，不是从你上传的资料中识别出来的。";

/** 逐条：这一条字段该不该挂那句话（"real"／缺键 ⇒ 都不挂） */
export const isSyntheticField = (field: Pick<ExtractedField, "modelKind">): boolean => field.modelKind === "test";

/** 整页：把逐条的判定汇成一个**数得出的**范围，句子只说这个数 */
export const syntheticNoticeCount = (fields: readonly Pick<ExtractedField, "modelKind">[]): number =>
  fields.filter(isSyntheticField).length;

/**
 * 「这一页有 N 条」里的 N 只能数**这一页真渲染出来的那些**——核对页有「只看待确认项」这颗过滤钮，
 * 拿全量 `task.fields` 去数、却对着过滤后的列表说"这一页"，就是超出代码事实的范围主张（R84 那条纪律的现场形态）。
 * 所以列表渲染与那句计数**共用这一个谓词**，不许各抄一份过滤条件。
 */
export const isPendingReview = (field: Pick<ExtractedField, "confirmStatus">): boolean =>
  field.confirmStatus === "pending" || field.confirmStatus === "uncertain";

export const visibleReviewFields = <T extends Pick<ExtractedField, "confirmStatus">>(
  fields: readonly T[],
  onlyPending: boolean,
): T[] => (onlyPending ? fields.filter(isPendingReview) : [...fields]);

export const syntheticNoticeSummary = (count: number): string | null =>
  count > 0
    ? `这一页有 ${count} 条写着「来自测试假模型」：那是本机测试服务预先备好的剧本，不是从你上传的资料里认出来的。逐条核对时请以原件为准。`
    : null;
