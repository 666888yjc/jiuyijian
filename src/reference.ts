// 就医笺 · U11 复诊闭环：跨任务字段引用（纯逻辑：无 React/浏览器依赖，可被 node 直接导入断言）
// 设计依据：deliverables/product-strategy/u11-followup-closure-design-jiuyijian-2026-09-24.md
//   - I1 带入字段一律 pending（上次核对过≠这次仍成立，且 U9 未确认不入单天然兼容）
//   - I2 带入字段 source=user（值来自用户上次确认，不污染 M2 字段校正量）
//   - I4 原任务删除不阻塞、不清空引用方值（链接断裂是展示层降级，不是数据损坏）
//   - I5 引用事件与断裂事件都写审计（跨任务操作不能成为审计盲区）
import type { ExtractedField, FieldGroup, VisitTask } from "./types";
import { GROUP_ORDER, finalValue, isUserConfirmed, hasSourcePage } from "./sheet";
import { now, uid } from "./sheet";

/** 任务的最小标识（科室 + 拟就诊日期）：purpose 常含症状、patientLabel 常含亲属关系，均属资料内容（HE-08 同口径） */
export function taskStub(task: VisitTask): string {
  const dept = task.dept.trim() || "科室未填";
  const visitDate = task.visitDate.trim() || "日期未填";
  return `${dept} · 拟就诊 ${visitDate}`;
}

/**
 * 带入字段的来源标注（U11 A5，核对页与复诊摘要视图共用的唯一实现，防两处文案漂移）：
 * 原任务在 → 科室+拟就诊日期最小存根；原任务已删 → 明示链接断裂、值已保留（删除边界选项 b 的展示层降级）。
 */
export function carriedRefNote(allTasks: VisitTask[], refFrom: { taskId: string; fieldId: string } | undefined): string | null {
  if (!refFrom) return null;
  const src = allTasks.find((t) => t.id === refFrom.taskId);
  return src ? `引自历史任务（${taskStub(src)}）` : "引自历史任务（原任务已删除，链接已断裂，值已保留）";
}

/**
 * 带入字段来源标注的跳转目标（U11 A3 证据链两级跳转）：
 * 证据页（EvidencePage，`/evidence/:docId/:pageId/:fieldId`）自早期版本即在线，A3 只多认一种来源（refFrom）——
 * 源字段有原文证据 → 一步到原文档页块（高亮源字段 blockIds，跨任务可达：EvidencePage 按 docId 在全量任务里查找）；
 * 源字段无原文证据（如手工补充）→ 一步到源任务核对页（没有原文档可回，不制造"有证据"的错觉）；
 * 源任务已删除 → 不跳转（断裂文字，展示层降级）。
 * 纯函数：路径可单测，页面只负责渲染与 navigate。
 */
export function carriedRefTarget(
  allTasks: VisitTask[],
  refFrom: { taskId: string; fieldId: string } | undefined,
): { kind: "evidence" | "task" | "none"; path: string } {
  if (!refFrom) return { kind: "none", path: "" };
  const src = allTasks.find((t) => t.id === refFrom.taskId);
  if (!src) return { kind: "none", path: "" };
  const srcField = src.fields.find((f) => f.id === refFrom.fieldId);
  // 这里是**页级**跳转（"去原件那一页对照"），成立条件比"能指认到原文行"弱，故用 hasSourcePage；
  // 行级主张（"病历原文"标签、高风险入单门槛、高亮）一律走 `hasOriginalEvidence`（R67）。
  if (srcField && hasSourcePage(srcField)) {
    return { kind: "evidence", path: `/evidence/${srcField.docId}/${srcField.pageId}/${srcField.id}` };
  }
  return { kind: "task", path: `/t/${src.id}/review` };
}

/**
 * 字段级来源跳转目标（交接单编辑页等屏幕态入口用，v2-U8 剩余范围）：
 * 带入字段（refFrom 存在）优先走 carriedRefTarget 三态——带到新任务的字段没有本任务证据，
 * 它的"来源"是源任务字段（证据/核对页/断裂），不是本任务的 docId；
 * 其余字段有本任务原文证据 → 一步到原文档页块；
 * 两者皆无（手工补充、资料已删）→ none，调用方不渲染入口（"无证据"徽章已表达，不制造按钮）。
 * 与 EvidenceLink 的分工：EvidenceLink 面向核对页既有 docId 字段（缺 docId 时报"来源资料已被删除"）；
 * 本函数面向混合来源场景（带入字段的缺证据不是被删，是不携带）。打印区（外发文档）不设入口。
 */
export function fieldSourceTarget(
  allTasks: VisitTask[],
  f: ExtractedField,
): { kind: "evidence" | "task" | "none"; path: string } {
  if (f.refFrom) return carriedRefTarget(allTasks, f.refFrom);
  if (hasSourcePage(f)) {
    return { kind: "evidence", path: `/evidence/${f.docId}/${f.pageId}/${f.id}` };
  }
  return { kind: "none", path: "" };
}

/** 可被带入的字段：用户亲自确认过（confirmed/corrected）、未被交接单隐藏、有有效值 */
export function isCarriable(f: ExtractedField, source: VisitTask): boolean {
  if (!isUserConfirmed(f)) return false;
  if (source.sheetHidden.includes(f.id)) return false;
  return true;
}

/** 按字段组统计可带入字段数（新建页引用选择器用） */
export function carriedGroupCounts(source: VisitTask): Array<{ group: FieldGroup; count: number }> {
  return GROUP_ORDER.map((group) => ({
    group,
    count: source.fields.filter((f) => f.group === group && isCarriable(f, source)).length,
  })).filter((g) => g.count > 0);
}

/** 带入字段生成（I1/I2）：只带用户确认过的值，落入新任务全部回到 pending、source=user、无本任务证据 */
export function buildCarriedFields(source: VisitTask, groups: FieldGroup[]): ExtractedField[] {
  const picked = new Set(groups);
  return source.fields
    .filter((f) => picked.has(f.group) && isCarriable(f, source))
    .map((f) => ({
      id: uid("fld-"),
      group: f.group,
      label: f.label,
      ocrRaw: "",
      aiValue: null,
      // 生效值只有一处算法（`sheet.finalValue`）：这里曾另抄一份，注释里的"避免循环依赖"是假的——本文件头顶就 import 了 ./sheet
      userValue: finalValue(f),
      highRisk: f.highRisk,
      confidence: "high" as const,
      confirmStatus: "pending" as const,
      source: "user" as const,
      refFrom: { taskId: source.id, fieldId: f.id },
      updatedAt: now(),
    }));
}

/** 引用事件文案（写入新任务审计） */
export function referenceAuditDetail(source: VisitTask, count: number): string {
  return `引用历史任务（${taskStub(source)}）的 ${count} 个字段；带入字段全部回到待确认，需重新核对后才会进入交接单`;
}

/** 链接断裂事件文案（源任务被删时写入引用方审计）：只含最小标识与数量，不含资料内容 */
export function brokenRefAuditDetail(source: VisitTask, count: number): string {
  return `引用任务（${taskStub(source)}）的 ${count} 个字段链接已断裂：原任务已删除，字段值已保留`;
}

/** 哪些任务引用了给定任务（删除边界判定用） */
export function referencingTasks(tasks: VisitTask[], deletedTaskId: string): Array<{ task: VisitTask; count: number }> {
  return tasks
    .filter((t) => t.id !== deletedTaskId)
    .map((t) => ({ task: t, count: t.fields.filter((f) => f.refFrom?.taskId === deletedTaskId).length }))
    .filter((r) => r.count > 0);
}
