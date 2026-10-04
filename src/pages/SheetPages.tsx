import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useStore, makeAudit } from "../store";
import { GROUP_ORDER, GROUP_TITLES, blockedFields, blockedReason, buildSheetSections, eligibleForSheet, finalValue } from "../sheet";
import { BOUNDARY_NOTICES } from "../redLine";
import { CLIPBOARD_UNAVAILABLE_NOTICE, copyToClipboard } from "../clipboard";
import { CopyFallback } from "../shared";

/** 排除原因必须三种分开说：把"无法辨认"写成"尚未确认"会让家属以为点一下确认就能入单。 */
const BLOCKED_REASON_TEXT: Record<NonNullable<ReturnType<typeof blockedReason>>, string> = {
  unconfirmed: "尚未确认",
  uncertain: "标记为不确定",
  unreadable: "内容无法辨认，需对照原件人工补录",
  noevidence: "查不到对应的病历原文，再确认也无法入单，请重新识别或人工补录",
  sourceGone: "来源资料已被删除，再确认也无法入单",
};
import { applyExclusions, buildSheetPlainText, countSectionItems } from "../sheetText";
import { navigate } from "../router";
import { fieldSourceTarget } from "../reference";
import type { VisitTask } from "../types";
import { TaskShell, TABS } from "./TaskShell";

export function SheetView({
  task,
  excludedFieldIds = [],
  compact = false,
}: {
  task: VisitTask;
  excludedFieldIds?: string[];
  compact?: boolean;
}) {
  const sections = applyExclusions(buildSheetSections(task), excludedFieldIds);
  return (
    <article className={compact ? "text-sm" : ""}>
      <header className="border-b pb-3">
        <h1 className="text-xl font-bold">就诊交接单</h1>
        <p className="mt-1 text-sm">
          {task.patientLabel}
          {task.dept && ` · ${task.dept}`}
          {task.visitDate && ` · 拟就诊 ${task.visitDate}`}
        </p>
        <p className="mt-1 text-sm font-medium">就诊目的：{task.purpose}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {BOUNDARY_NOTICES.sheet}
        </p>
      </header>
      {sections.map((s) => (
        <section key={s.key} className="mt-4">
          <h2 className="border-b font-semibold">{s.title}</h2>
          <ul className="mt-2 space-y-1.5">
            {s.items.map((i) => (
              <li key={i.fieldId} className="flex gap-2">
                <span className="w-40 shrink-0 text-muted-foreground">{i.label}</span>
                <span className="min-w-0 font-medium">
                  {i.value}
                  {/* R116：同一个项目被几份资料记过时，纸上也像屏幕上那样各带自己的日期来处（句子来自 itemLedger，这里不另拼一份） */}
                  {i.dateNote && <span className="ml-1 text-xs font-normal text-muted-foreground">{i.dateNote}</span>}
                  {/* A5 遗留修正：带入字段不是本次自述，不能标「补充」——与摘要页同口径（复诊带入=上次已确认、本次已重新核对） */}
                  {i.origin === "user" && (i.refFrom ? (
                    <span className="ml-1 rounded border border-amber-700 px-1 text-xs text-amber-800">复诊带入</span>
                  ) : (
                    <span className="ml-1 rounded border border-green-700 px-1 text-xs text-green-800">补充</span>
                  ))}
                  {!i.hasEvidence && i.origin === "doc" && (
                    <span className="ml-1 rounded border border-destructive px-1 text-xs text-destructive">无证据</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {task.questions.length > 0 && (
        <section className="mt-4">
          <h2 className="border-b font-semibold">想请医生解答的问题（尚未获得医学意见）</h2>
          <ol className="mt-2 list-decimal space-y-1 pl-5">
            {task.questions.map((q) => (
              <li key={q.id}>{q.text}</li>
            ))}
          </ol>
        </section>
      )}
      <footer className="mt-5 border-t pt-2 text-xs text-muted-foreground">
        由「就医笺」生成 · {new Date().toLocaleDateString("zh-CN")}
      </footer>
    </article>
  );
}

export function SheetEditorPage({ task }: { task: VisitTask }) {
  const { state: allState, dispatch } = useStore();
  const eligible = task.fields.filter(eligibleForSheet);
  const hidden = task.fields.filter((f) => eligibleForSheet(f) && task.sheetHidden.includes(f.id));
  const pending = blockedFields(task);
  return (
    <TaskShell task={task} tab="sheet">
      <section className="rounded-lg border bg-card p-4 text-sm">
        <p>
          {/* HE-05 术语统一：收录数（勾选后）与门槛数（可入单）同屏并列，两个数字各叫各的名字，
              不再把收录数混称「已确认内容」——已确认是核对页的进度口径，这里是门槛口径 */}
          交接单当前收录 <strong>{eligible.length - hidden.length}</strong> 项，可入单 {eligible.length}/{task.fields.length} 项。
          {pending.length > 0 && (
            <span className="ml-2 font-medium text-destructive">
              {pending.length} 项未确认/不确定/无法辨认/缺原文证据内容已被自动排除
            </span>
          )}
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => navigate(`/t/${task.id}/print`)}>
            预览完整交接单
          </Button>
          <Button size="sm" variant="outline" onClick={() => navigate(`/t/${task.id}/review`)}>
            去核对页处理未确认项
          </Button>
        </div>
      </section>

      {pending.length > 0 && (
        <section className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm">
          <h2 className="font-medium text-destructive">以下条目暂不会进入交接单</h2>
          {/* HE-09：排除列表逐条「去处理」——总入口之外，每条都能一步落到核对页对应字段卡片并高亮。
              打印页面板只报数量不罗列条目（外发场景不摆未确认内容），逐条入口只做在编辑页这个屏幕态 */}
          <ul className="mt-2 space-y-1">
            {pending.map((f) => (
              <li key={f.id} className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1">
                  {f.label}：{finalValue(f) || "（空）"}
                  <span className="ml-1 text-muted-foreground">
                    （{BLOCKED_REASON_TEXT[blockedReason(f) ?? "unconfirmed"]}{f.highRisk ? "，高风险" : ""}）
                  </span>
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-primary"
                  onClick={() => navigate(`/t/${task.id}/review?field=${encodeURIComponent(f.id)}`)}
                >
                  去处理
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {task.fields.length === 0 && (
        <section className="rounded-lg border border-dashed bg-card p-6 text-center text-sm">
          <p className="font-medium">还没有任何信息可以整理</p>
          <p className="mt-1 text-muted-foreground">
            先上传就诊资料（病历、处方、检查报告），提取后的信息会在核对页逐项确认，确认后才进入交接单。
          </p>
          <div className="mt-3 flex justify-center gap-2">
            <Button size="sm" onClick={() => navigate(`/t/${task.id}/docs`)}>
              去上传资料
            </Button>
            <Button size="sm" variant="outline" onClick={() => navigate(`/t/${task.id}/review`)}>
              去核对页
            </Button>
          </div>
        </section>
      )}

      {GROUP_ORDER.map((group) => {
        const fields = eligible.filter((f) => f.group === group);
        if (!fields.length) return null;
        return (
          <section key={group}>
            <h2 className="mb-2 mt-4 font-semibold">{GROUP_TITLES[group]}</h2>
            <ul className="space-y-2">
              {fields.map((f, idx) => {
                // v2-U8 剩余范围：交接单编辑页（屏幕态）的来源入口。带入字段走 refFrom 三态，
                // 本任务字段走 docId/pageId；none（手工补充/资料已删）不渲染入口——"无证据"徽章已表达。
                // 打印区（SheetView，外发文档）不设入口：纸上点不了，也不该有交互暗示。
                const srcTarget = fieldSourceTarget(allState.tasks, f);
                return (
                  <li key={f.id} className="flex items-center gap-2 rounded-lg border bg-card p-3">
                    <span className="min-w-0 flex-1">
                      <span className="text-sm text-muted-foreground">{f.label}：</span>
                      <span className={task.sheetHidden.includes(f.id) ? "text-sm line-through opacity-50" : "font-medium"}>
                        {finalValue(f)}
                      </span>
                      {f.refFrom && (
                        <span className="ml-1 rounded border border-amber-700 px-1 text-xs text-amber-800">复诊带入</span>
                      )}
                    </span>
                    <div className="flex shrink-0 items-center gap-1">
                      {srcTarget.kind !== "none" && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-primary"
                          onClick={() => navigate(srcTarget.path)}
                        >
                          查看来源
                        </Button>
                      )}
                      <Button variant="ghost" size="sm" aria-label="上移" disabled={idx === 0}
                        onClick={() => dispatch({ type: "field.move", taskId: task.id, fieldId: f.id, dir: -1 })}>
                        ↑
                      </Button>
                      <Button variant="ghost" size="sm" aria-label="下移" disabled={idx === fields.length - 1}
                        onClick={() => dispatch({ type: "field.move", taskId: task.id, fieldId: f.id, dir: 1 })}>
                        ↓
                      </Button>
                      <label className="flex items-center gap-1 text-sm">
                        <Checkbox
                          checked={!task.sheetHidden.includes(f.id)}
                          onCheckedChange={() => {
                            dispatch({ type: "sheet.toggleHidden", taskId: task.id, fieldId: f.id });
                            dispatch({
                              type: "audit.push",
                              taskId: task.id,
                              audit: makeAudit("sheet.toggle", `「${f.label}」${task.sheetHidden.includes(f.id) ? "重新显示" : "从交接单隐藏"}`),
                            });
                          }}
                        />
                        显示
                      </label>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </TaskShell>
  );
}

export function SheetPrintPage({ task }: { task: VisitTask }) {
  const { dispatch } = useStore();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  // 复制失败时把文字摊在页面上让人长按复制（内网 http 入口下剪贴板 API 根本不可用）
  const [copyFallback, setCopyFallback] = useState<string | null>(null);
  const [excluded, setExcluded] = useState<string[]>([]);
  const items = buildSheetSections(task).flatMap((s) => s.items);
  const effectiveExcluded = [...excluded, ...task.sheetHidden];
  const includedCount = countSectionItems(applyExclusions(buildSheetSections(task), effectiveExcluded));
  // U9：被安全门槛拦下、未进入交接单的字段（只用于屏幕提示，不进打印输出）
  const pending = blockedFields(task);
  const pendingHigh = pending.filter((f) => f.highRisk).length;

  async function copyPlainText() {
    const text = buildSheetPlainText(task, effectiveExcluded);
    if (!(await copyToClipboard(text))) {
      // 没复制成功就不写那条审计——审计说"复制了"而实际没有，是假账
      setCopyFallback(text);
      setCopied(false);
      return;
    }
    setCopyFallback(null);
    dispatch({
      type: "audit.push",
      taskId: task.id,
      audit: makeAudit("sheet.export", `复制纯文本交接单（勾选排除 ${excluded.length} 项）`),
    });
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="space-y-4">
      <nav
        aria-label="整理步骤"
        className="no-print mx-auto max-w-3xl scrollbar-thin flex gap-1 overflow-x-auto rounded-lg border bg-card p-1"
      >
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            aria-current={t.key === "sheet" ? "step" : undefined}
            className={
              "flex-1 whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium " +
              (t.key === "sheet"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent")
            }
            onClick={() => navigate(`/t/${task.id}/${t.key}`)}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <div className="no-print mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-2">
        <Button variant="outline" size="sm" onClick={() => navigate(`/t/${task.id}/sheet`)}>
          ← 返回编辑
        </Button>
        <div className="flex gap-2">
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button>导出 / 打印</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>分享前请再次确认内容</DialogTitle>
                <DialogDescription>取消勾选的条目不会出现在打印/导出结果中。</DialogDescription>
              </DialogHeader>
              <ul className="max-h-80 space-y-2 overflow-y-auto text-sm">
                {items.map((i) => (
                  <li key={i.fieldId} className="flex items-center gap-2">
                    <Checkbox
                      id={`exp-${i.fieldId}`}
                      checked={!excluded.includes(i.fieldId) && !task.sheetHidden.includes(i.fieldId)}
                      onCheckedChange={(c) =>
                        setExcluded((prev) =>
                          c ? prev.filter((id) => id !== i.fieldId) : [...prev, i.fieldId],
                        )
                      }
                    />
                    <Label htmlFor={`exp-${i.fieldId}`} className="font-normal">
                      {i.label}：{i.value}
                    </Label>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-muted-foreground">
                当前将交接 {includedCount} 项内容；打印与纯文本导出使用同一份勾选结果。
              </p>
              {copyFallback && <CopyFallback text={copyFallback} notice={CLIPBOARD_UNAVAILABLE_NOTICE} />}
              <DialogFooter>
                <Button variant="outline" disabled={includedCount === 0} onClick={copyPlainText}>
                  {copied ? "已复制到剪贴板" : "复制纯文本"}
                </Button>
                <Button
                  disabled={includedCount === 0}
                  onClick={() => {
                    setOpen(false);
                    dispatch({
                      type: "audit.push",
                      taskId: task.id,
                      audit: makeAudit("sheet.export", `导出交接单（勾选排除 ${excluded.length} 项）`),
                    });
                    window.print();
                  }}
                >
                  确认并打印
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>
      {pending.length > 0 && (
        <section
          aria-label="未确认内容提示"
          className="no-print mx-auto max-w-3xl rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm"
        >
          <h2 className="font-medium text-destructive">
            分享前请注意：本交接单未包含 {pending.length} 项未确认/不确定/无法辨认/缺原文证据内容
          </h2>
          <p className="mt-1 text-muted-foreground">
            这些内容尚未逐项与原件核对（其中 {pendingHigh} 项为高风险字段，如药名、剂量、过敏史），
            已按安全门槛自动排除，不会进入打印与导出结果。确认后可补充进交接单。
          </p>
          <div className="mt-2">
            <Button size="sm" variant="outline" onClick={() => navigate(`/t/${task.id}/review`)}>
              去核对页处理未确认项
            </Button>
          </div>
        </section>
      )}
      <div className="print-area mx-auto max-w-3xl rounded-lg border bg-card p-8 shadow-sm">
        <SheetView task={task} excludedFieldIds={effectiveExcluded} />
      </div>
    </div>
  );
}
