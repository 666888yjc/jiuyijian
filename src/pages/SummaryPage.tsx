import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useStore, makeAudit } from "../store";
import { buildSheetSections, evidenceAffordance, evidenceTagLegend, uid, now } from "../sheet";
import { todayDateStr } from "../dates";
import { BOUNDARY_NOTICES } from "../redLine";
import { CLIPBOARD_UNAVAILABLE_NOTICE, copyToClipboard } from "../clipboard";
import { CopyFallback } from "../shared";
import { buildSummaryText } from "../summary";
import { carriedRefNote } from "../reference";
import { navigate } from "../router";
import type { VisitTask } from "../types";
import { ACTION_TYPE_LABELS } from "../types";
import { TaskShell } from "./TaskShell";

export function SummaryPage({ task }: { task: VisitTask }) {
  const { state: allState, dispatch, readOnly } = useStore();
  const [copied, setCopied] = useState(false);
  const [copyFallback, setCopyFallback] = useState<string | null>(null);
  const today = todayDateStr();
  const actions = task.actions ?? [];
  const done = actions.filter((a) => a.done);
  const pending = actions.filter((a) => !a.done);
  const sections = buildSheetSections(task);
  const versions = task.summaryVersions ?? [];
  // HE-14：拟就诊日期未到时不能说「上次就诊」；无日期按未就诊处理
  const visitPending = !task.visitDate || task.visitDate >= today;

  function saveVersion() {
    dispatch({
      type: "summary.saveVersion",
      taskId: task.id,
      version: { id: uid("sum-"), savedAt: now(), text: buildSummaryText(task, allState.tasks) },
    });
    dispatch({ type: "audit.push", taskId: task.id, audit: makeAudit("summary.save", "存档复诊摘要版本") });
  }

  async function copyText() {
    const text = buildSummaryText(task, allState.tasks);
    if (!(await copyToClipboard(text))) {
      setCopyFallback(text);
      setCopied(false);
      return;
    }
    setCopyFallback(null);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }

  return (
    <TaskShell task={task} tab="summary">
      <section className="rounded-lg border bg-card p-4 text-sm no-print">
        <p className="font-medium">复诊摘要（给下次就诊的医生看）</p>
        <p className="mt-1 text-muted-foreground">
          内容全部来自你已确认的信息、行动执行记录和你本人的自述；系统不做任何医学推断。
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" onClick={saveVersion}>存档当前摘要</Button>
          <Button size="sm" variant="outline" onClick={copyText}>{copied ? "已复制" : "复制纯文本"}</Button>
          {copyFallback && <CopyFallback text={copyFallback} notice={CLIPBOARD_UNAVAILABLE_NOTICE} />}
          <Button size="sm" variant="outline" onClick={() => window.print()}>打印本页</Button>
        </div>
      </section>

      <article className="print-area mt-4 rounded-lg border bg-card p-6">
        <header className="border-b pb-3">
          <h1 className="text-xl font-bold">复诊摘要</h1>
          <p className="mt-1 text-sm">{task.patientLabel}{task.dept && ` · ${task.dept}`}</p>
          <p className="text-sm font-medium">
            {visitPending ? "拟就诊" : "上次就诊"}：{task.purpose}
            {task.visitDate && `（${task.visitDate}）`}
          </p>
          {visitPending && (
            <p className="mt-1 text-xs text-muted-foreground">
              本次就诊尚未发生，就诊后请回填「就诊后新变化」再分享给下次的医生。
            </p>
          )}
          <p className="mt-1 text-xs text-muted-foreground">{BOUNDARY_NOTICES.summary}</p>
        </header>

        <section className="mt-4">
          <h2 className="border-b font-semibold">行动执行情况</h2>
          {actions.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">（行动清单暂无记录）</p>
          ) : (
            <ul className="mt-2 space-y-1.5 text-sm">
              {done.map((a) => (
                <li key={a.id}>
                  <Badge variant="secondary" className="mr-2">已完成·{ACTION_TYPE_LABELS[a.type]}</Badge>
                  {a.content}（计划 {a.date}
                  {a.doneNote && `；记录：${a.doneNote}`}）
                </li>
              ))}
              {pending.map((a) => (
                <li key={a.id}>
                  <Badge variant={a.date < today ? "destructive" : "outline"} className="mr-2">
                    {a.date < today ? "未完成·逾期" : "未完成"}·{ACTION_TYPE_LABELS[a.type]}
                  </Badge>
                  {a.content}（计划 {a.date}）
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="mt-4">
          <h2 className="border-b font-semibold">已确认的关键信息</h2>
          {/* A5：三部分来源可区分——复诊带入（上次确认后带入、本次已重新核对）/ 本次自述 / 资料原文 */}
          <p className="mt-1 text-xs text-muted-foreground">
            {evidenceTagLegend()}
          </p>
          {sections.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">（尚无已确认信息，请先完成信息核对）</p>
          ) : (
            sections.map((s) => (
              <div key={s.key} className="mt-2">
                <h3 className="text-sm font-medium text-muted-foreground">{s.title}</h3>
                <ul className="mt-1 space-y-1 text-sm">
                  {s.items.map((i) => {
                    const refNote = carriedRefNote(allState.tasks, i.refFrom);
                    return (
                      <li key={i.fieldId} className="flex gap-2">
                        <span className="w-40 shrink-0 text-muted-foreground">{i.label}</span>
                        <span className="min-w-0 font-medium">
                          {i.value}
                          {refNote ? (
                            <>
                              <span className="ml-1 rounded border border-amber-700 px-1 text-xs text-amber-800">复诊带入</span>
                              <span className="ml-2 text-xs font-normal text-muted-foreground">{refNote}</span>
                            </>
                          ) : (
                            i.origin === "user" && (
                              <span className="ml-1 rounded border border-green-700 px-1 text-xs text-green-800">自述</span>
                            )
                          )}
                          {i.origin === "doc" && (() => {
                            const f = task.fields.find((x) => x.id === i.fieldId);
                            if (!f) return null;
                            const ev = evidenceAffordance(f);
                            // 行级/页级/没有原件三档各有各的说法，短标签与跳转都由同一张表给出（R67）
                            return ev.navigable ? (
                              <button
                                type="button"
                                className="ml-2 text-xs text-primary underline no-print"
                                onClick={() => navigate(`/evidence/${f.docId}/${f.pageId}/${f.id}`)}
                              >
                                {ev.tag}
                              </button>
                            ) : (
                              <span className="ml-2 text-xs text-muted-foreground">{ev.tag}</span>
                            );
                          })()}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))
          )}
        </section>

        <section className="mt-4">
          <h2 className="border-b font-semibold">就诊后新变化（患者/照护者自述）</h2>
          <div className="mt-2 no-print">
            <Label htmlFor="sum-note" className="sr-only">就诊后新变化</Label>
            <Textarea
              id="sum-note"
              rows={3}
              maxLength={2000}
              value={task.summaryNote ?? ""}
              readOnly={readOnly}
              onChange={(e) => dispatch({ type: "summary.setNote", taskId: task.id, note: e.target.value })}
              placeholder="例如：服药一周后夜间憋醒减少；本周两次头晕，持续数分钟。只写观察到的事实，不要写诊断结论。"
            />
          </div>
          <p className="mt-2 whitespace-pre-wrap text-sm">
            {task.summaryNote?.trim() || (
              <span className="text-muted-foreground no-print">（未填写——上面的输入框内补充）</span>
            )}
          </p>
        </section>

        {task.questions.length > 0 && (
          <section className="mt-4">
            <h2 className="border-b font-semibold">本次想问医生的问题</h2>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm">
              {task.questions.map((q) => <li key={q.id}>{q.text}</li>)}
            </ol>
          </section>
        )}

        <footer className="mt-5 border-t pt-2 text-xs text-muted-foreground">
          由「就医笺」生成 · {new Date().toLocaleDateString("zh-CN")} · 医学判断以医生为准
        </footer>
      </article>

      {versions.length > 0 && (
        <section className="no-print">
          <h2 className="mb-2 mt-5 font-semibold">历史存档（{versions.length}）</h2>
          <ul className="space-y-2">
            {versions.map((v) => (
              <li key={v.id} className="rounded-lg border bg-card p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">{new Date(v.savedAt).toLocaleString("zh-CN")}</span>
                  <div className="flex gap-2">
                    <details className="text-sm">
                      <summary className="cursor-pointer text-primary">查看内容</summary>
                      <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-muted p-3 text-xs">{v.text}</pre>
                    </details>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="ghost" size="sm" className="text-destructive" aria-label="删除该存档">删除</Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>删除该摘要存档？</AlertDialogTitle>
                          <AlertDialogDescription>删除后不可恢复；当前摘要内容不受影响。</AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>取消</AlertDialogCancel>
                          <AlertDialogAction onClick={() => dispatch({ type: "summary.deleteVersion", taskId: task.id, versionId: v.id })}>确认删除</AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </TaskShell>
  );
}
