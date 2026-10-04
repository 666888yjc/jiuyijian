import type { VisitTask } from "./types";
import { ACTION_TYPE_LABELS } from "./types";
import { buildSheetSections, GROUP_TITLES } from "./sheet";
import { BOUNDARY_NOTICES } from "./redLine";
import { taskStub } from "./reference";

/**
 * 带入字段的纯文本来源标注（U11 A5 复诊摘要视图）：
 * 原任务在 → 科室+拟就诊日期存根；原任务已删 → 明示删除（值仍来自上次确认，展示层降级）。
 * 与页面版 carriedRefNote 同源不同形：页面用完整句式，纯文本用紧凑后缀。
 */
function carriedNote(refFrom: { taskId: string; fieldId: string } | undefined, allTasks: VisitTask[]): string {
  if (!refFrom) return "";
  const src = allTasks.find((t) => t.id === refFrom.taskId);
  return src ? `（复诊带入，${taskStub(src)}）` : "（复诊带入，原任务已删除）";
}

/** 复诊摘要纯组装：只使用已确认信息、行动执行记录与用户自述；无 AI 生成内容 */
export function buildSummaryText(task: VisitTask, allTasks: VisitTask[] = []): string {
  const lines: string[] = [];
  lines.push(`复诊摘要 · ${task.patientLabel} · 生成于 ${new Date().toLocaleDateString("zh-CN")}`);
  lines.push(`上次就诊：${task.purpose}${task.visitDate ? `（${task.visitDate}）` : ""}${task.dept ? ` · ${task.dept}` : ""}`);
  lines.push("");

  lines.push("【行动执行情况】");
  const done = (task.actions ?? []).filter((a) => a.done);
  const pending = (task.actions ?? []).filter((a) => !a.done);
  if (!done.length && !pending.length) lines.push("（暂无行动记录）");
  for (const a of done) lines.push(`已完成 · ${ACTION_TYPE_LABELS[a.type] ?? a.type}：${a.content}（${a.date}${a.doneNote ? `；记录：${a.doneNote}` : ""}）`);
  for (const a of pending) lines.push(`未完成 · ${ACTION_TYPE_LABELS[a.type] ?? a.type}：${a.content}（计划 ${a.date}）`);
  lines.push("");

  lines.push("【已确认的关键信息】");
  const sections = buildSheetSections(task);
  if (!sections.length) lines.push("（尚无已确认信息）");
  for (const s of sections) {
    lines.push(`- ${s.title}：`);
    for (const i of s.items) {
      // A5：带入字段标来源存根（不是本次自述）；本任务用户补充字段才标「患者自述」
      const note = i.refFrom ? carriedNote(i.refFrom, allTasks) : i.origin === "user" ? "（患者自述）" : "";
      lines.push(`  · ${i.label}：${i.value}${note}`);
    }
  }
  lines.push("");

  lines.push("【就诊后新变化（患者/照护者自述）】");
  lines.push(task.summaryNote?.trim() || "（未填写）");
  lines.push("");

  if (task.questions.length) {
    lines.push("【本次想问医生的问题】");
    task.questions.forEach((q, i) => lines.push(`${i + 1}. ${q.text}`));
    lines.push("");
  }

  lines.push(BOUNDARY_NOTICES.summaryText);
  return lines.join("\n");
}
