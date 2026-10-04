// 就医笺 · M2 字段校正量度量（纯逻辑：无 React/浏览器依赖，可被 node 直接导入断言）
// 设计依据：
//   - mvp-assessment-upgrade-v2-jiuyijian-2026-09-23.md M2「字段校正量与失败模式分布」：
//     证样本上行为确定，不证真实 OCR 准确率；是 H1「愿意整理」的降级代理指标（非用户行为数据）。
//   - u11-followup-closure-design-jiuyijian-2026-09-24.md 风险#2「跨任务合并的度量污染」：
//     带入字段的"校正"计入新任务 M2 时会稀释真实校正率——统计必须按 refFrom 分流。
//
// 分流口径（判据顺序即正确性，不可调换）：
//   1. 只有 confirmStatus === "corrected" 的字段计入（产品内"已修改"状态，与核对页徽章同源）；
//   2. refFrom 存在 → carriedAdjustments（带入调整）：值是上次就诊已确认的事实，本次调整是
//      据实更新（如体重、病情变化），不是提取错误——计入真实校正会虚增校正量、稀释提取质量信号；
//   3. 其余 source === "ai" → realCorrections（真实校正）：本次任务 AI 提取字段被用户修改，
//      是提取质量的代理信号；
//   4. 其余（source === "user" 且无 refFrom）→ userSelfEdits（自述修改）：用户改自己本次手工
//      补充的值，与提取质量无关。
// 边界：source === "ai" 且 refFrom 存在的病态组合（设计上不应出现，带入字段一律 source=user）
//   按第 2 条归 carriedAdjustments——数据异常时不虚报真实校正，方向保守。
import type { ExtractedField, VisitTask } from "./types";
import { carriedRefTarget } from "./reference";
import { finalValue, isUserConfirmed, hasOriginalEvidence } from "./sheet";

export interface CorrectionStats {
  /** 真实校正量：本次任务 AI 提取字段被用户修改（提取质量代理信号） */
  realCorrections: number;
  /** 带入调整量：复诊带入字段被用户据实调整（非提取错误，U11 风险#2 分流对象） */
  carriedAdjustments: number;
  /** 自述修改量：本次手工补充字段被用户自己修改 */
  userSelfEdits: number;
  /** corrected 字段合计（三项之和，供核对防漏） */
  total: number;
  /** 任务字段总数（分母参考） */
  fieldCount: number;
}

/** 单任务校正量分流统计 */
export function correctionStats(task: VisitTask): CorrectionStats {
  const stats: CorrectionStats = {
    realCorrections: 0,
    carriedAdjustments: 0,
    userSelfEdits: 0,
    total: 0,
    fieldCount: task.fields.length,
  };
  for (const f of task.fields) {
    if (f.confirmStatus !== "corrected") continue;
    stats.total += 1;
    if (f.refFrom) {
      stats.carriedAdjustments += 1;
    } else if (f.source === "ai") {
      stats.realCorrections += 1;
    } else {
      stats.userSelfEdits += 1;
    }
  }
  return stats;
}

/**
 * 多任务合并统计（跨任务场景：同一患者多次就诊的校正量汇总）。
 * 合并后 realCorrections 仍只含各任务自身的 AI 提取字段——带入字段的调整在任何合并口径下
 * 都不进入真实校正率，这是 U11 风险#2 的合并层防线。
 */
export function correctionBreakdown(tasks: VisitTask[]): CorrectionStats {
  return tasks.reduce<CorrectionStats>(
    (acc, t) => {
      const s = correctionStats(t);
      acc.realCorrections += s.realCorrections;
      acc.carriedAdjustments += s.carriedAdjustments;
      acc.userSelfEdits += s.userSelfEdits;
      acc.total += s.total;
      acc.fieldCount += s.fieldCount;
      return acc;
    },
    { realCorrections: 0, carriedAdjustments: 0, userSelfEdits: 0, total: 0, fieldCount: 0 },
  );
}

export interface RefTargetStats {
  /** 一跳落到原文档页块的带入字段数（两级链完整） */
  evidence: number;
  /** 降级落到源任务核对页的带入字段数（源字段无原文证据，如手工补充） */
  task: number;
  /** 链接断裂的带入字段数（源任务已删除，值保留） */
  none: number;
  /** 有 refFrom 的带入字段总数（分母；无 refFrom 的字段不是带入字段，不进分母） */
  total: number;
}

/**
 * 引用命中率统计（v2-U8 剩余范围「引用命中率可测」；M3 证据链回溯度量族）。
 * 口径：只统计 refFrom 存在的带入字段，按 carriedRefTarget 三态分桶。
 * "一跳到原文"的比例（evidence/total）由调用方按需计算——三种落点都是设计内行为
 * （task 是已知降级路径、none 是删除边界的结果），分桶比单一比率信息量大。
 */
export function refTargetBreakdown(tasks: VisitTask[]): RefTargetStats {
  const stats: RefTargetStats = { evidence: 0, task: 0, none: 0, total: 0 };
  for (const t of tasks) {
    for (const f of t.fields) {
      if (!f.refFrom) continue;
      stats.total += 1;
      const kind = carriedRefTarget(tasks, f.refFrom).kind;
      if (kind === "evidence") stats.evidence += 1;
      else if (kind === "task") stats.task += 1;
      else stats.none += 1;
    }
  }
  return stats;
}

/**
 * 失败模式分类（M2「字段校正量与失败模式分布」的分布维度；U7 schema 落地）。
 * 封闭性：全部从产品状态机可观测属性派生（confidence / confirmStatus / conflictWith /
 * highRisk / 证据链 / 有效值），不含任何医学判断——"为什么这个字段不能干净入单"
 * 是工程问题，不是诊断问题。
 * 多标签：一个字段可同时命中多个模式（如低置信且待确认），分桶之和 ≥ 字段数；
 * 这与 correctionStats 的单标签互补——后者回答"用户改了多少"，前者回答"改的是哪类问题"。
 */
export type FailureMode =
  | "ocr_failed"
  | "low_confidence"
  | "empty_value"
  | "pending"
  | "uncertain"
  | "conflict_unresolved"
  | "high_risk_without_evidence";

export const FAILURE_MODE_LABELS: Record<FailureMode, string> = {
  ocr_failed: "识别失败（confidence=failed）",
  low_confidence: "识别置信度低",
  empty_value: "无有效值",
  pending: "待确认",
  uncertain: "用户标记不确定",
  conflict_unresolved: "冲突未决（多资料不一致且未确认）",
  high_risk_without_evidence: "高风险字段缺原文证据链",
};

/** 单字段命中的失败模式（多标签；干净字段返回空数组） */
export function failureModes(f: ExtractedField): FailureMode[] {
  const modes: FailureMode[] = [];
  if (f.confidence === "failed") modes.push("ocr_failed");
  if (f.confidence === "low") modes.push("low_confidence");
  if (!finalValue(f)) modes.push("empty_value");
  if (f.confirmStatus === "pending") modes.push("pending");
  if (f.confirmStatus === "uncertain") modes.push("uncertain");
  // 冲突以"用户已确认/修改"为已决：选定其一并确认后冲突展示消失，不算未决
  if (f.conflictWith?.length && !isUserConfirmed(f)) {
    modes.push("conflict_unresolved");
  }
  // 与 eligibleForSheet 高风险证据门槛同口径（R67 起两边都走 hasOriginalEvidence）
  if (f.highRisk && !hasOriginalEvidence(f)) modes.push("high_risk_without_evidence");
  return modes;
}

export type FailureModeCounts = Record<FailureMode, number>;

/** 多任务失败模式分布（每桶独立计数；字段可命中多桶，分桶之和 ≥ 字段数） */
export function failureModeBreakdown(tasks: VisitTask[]): FailureModeCounts {
  const counts: FailureModeCounts = {
    ocr_failed: 0,
    low_confidence: 0,
    empty_value: 0,
    pending: 0,
    uncertain: 0,
    conflict_unresolved: 0,
    high_risk_without_evidence: 0,
  };
  for (const t of tasks) {
    for (const f of t.fields) {
      for (const m of failureModes(f)) counts[m] += 1;
    }
  }
  return counts;
}
