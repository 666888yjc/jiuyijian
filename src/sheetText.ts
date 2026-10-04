import type { VisitTask } from "./types";
import type { SheetSection } from "./sheet";
import { buildSheetSections } from "./sheet";
import { BOUNDARY_NOTICES } from "./redLine";

// R64：纸上与导出文本共用同一句边界声明（原先两处各写一份，导出那份多了"面诊为准"、两处都没说"处方"）
export const SHEET_TEXT_DISCLAIMER = BOUNDARY_NOTICES.sheet;

/** 导出前勾选排除：与打印预览共用同一份过滤结果；组内无可见条目时整组不出现 */
export function applyExclusions(
  sections: SheetSection[],
  excludedFieldIds: string[],
): SheetSection[] {
  if (!excludedFieldIds.length) return sections;
  return sections
    .map((s) => ({ ...s, items: s.items.filter((i) => !excludedFieldIds.includes(i.fieldId)) }))
    .filter((s) => s.items.length);
}

export function countSectionItems(sections: SheetSection[]): number {
  return sections.reduce((n, s) => n + s.items.length, 0);
}

/** 可粘贴进问诊聊天框的纯文本交接单：逐条内容来自 buildSheetSections，不新增任何判断或医学结论 */
export function buildSheetPlainText(task: VisitTask, excludedFieldIds: string[] = []): string {
  const lines: string[] = [];
  const head = ["就诊交接单", task.patientLabel];
  if (task.dept) head.push(task.dept);
  if (task.visitDate) head.push(`拟就诊 ${task.visitDate}`);
  lines.push(head.join(" · "));
  lines.push(`就诊目的：${task.purpose}`);
  lines.push(SHEET_TEXT_DISCLAIMER);
  lines.push("");

  for (const s of applyExclusions(buildSheetSections(task), excludedFieldIds)) {
    lines.push(`【${s.title}】`);
    for (const i of s.items) {
      const marks = [
        i.origin === "user" ? "补充" : "",
        i.origin === "doc" && !i.hasEvidence ? "无证据" : "",
      ].filter(Boolean);
      lines.push(`· ${i.label}：${i.value}${i.dateNote}${marks.length ? `（${marks.join(" · ")}）` : ""}`);
    }
    lines.push("");
  }

  if (task.questions.length) {
    lines.push("【想请医生解答的问题（尚未获得医学意见）】");
    task.questions.forEach((q, idx) => lines.push(`${idx + 1}. ${q.text}`));
    lines.push("");
  }

  lines.push(`由「就医笺」生成 · ${new Date().toLocaleDateString("zh-CN")}`);
  return lines.join("\n").trimEnd();
}
