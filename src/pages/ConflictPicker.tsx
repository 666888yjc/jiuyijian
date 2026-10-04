import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useSync } from "../sync";
import type { VisitTask } from "../types";
import {
  CONFLICT_PICKER_TITLE,
  CONFLICT_PICKER_TRIGGER,
  LOCAL_AT_LABEL,
  NO_SERVER_COPY_NOTICE,
  SERVER_AT_LABEL,
  conflictButtonLabel,
  conflictConsequence,
  conflictConfirmLabel,
  conflictDiffLine,
  conflictDoneNotice,
  diffConflict,
  type ConflictChoice,
} from "../conflictChoice";

/**
 * 冲突那一档的处置入口（R97）。放在任务页里，是因为**处置的是这一条任务**，
 * 而页头那句只负责说出"有这么几条"（R84：列表要指得出是哪一条）。
 *
 * 三条铁律写在这里，都有判据钉：
 * ① 拿不到服务器那一版的原样 ⇒ **不出现任何选择按钮**，只说一句"现在不做选择"——
 *    看不见对手就不许让人签字；
 * ② 代价必须出现在**确认之前**，且范围只说这一条任务、只说"被替换"与"取不回来"（实测服务器无版本可查）；
 * ③ 挑完之后这一档就不给了：留在映射里的那份副本是**上一轮**读到的，而服务器一行随时会被后写的盖掉，
 *    再给一次选择等于让人对着过期的一版签第二次字（R97b，真浏览器复验换一页路由时撞出来的形状）。
 */
export function ConflictPicker({ task }: { task: VisitTask }) {
  const sync = useSync();
  const copy = sync.conflictServerCopies[task.id];
  const inConflict = sync.conflictTaskIds.includes(task.id);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<ConflictChoice | null>(null);
  const [done, setDone] = useState<ConflictChoice | null>(null);

  // R97b：这一档已经不在了（挑完 ⇒ 冲突名单里被摘掉），组件还挂着只为把结果话说完。
  // 此时**不给第二次选择**：留在 `conflictServerCopies` 里那份是上一轮读到的，服务器一行会被后写的盖掉，
  // 再挑一次可能挑的就不是屏幕上说的那一版（真浏览器复验时从一条路由换到另一条就撞到了这个形状）。
  // R107：`!inConflict` 是这句话的**前提**，不是装饰——条件写落空时同一任务的冲突会**重新成立**，
  // 而那时副本已是这一轮刚读回来的那一版，必须重新给一次选择。先前那种"本地 done 优先"的写法
  // 会让人只剩一句「已按你选的…」，横幅叫他按的那颗按钮却再也不出现（2026-09-29 真浏览器复验撞到的第二格）。
  const finished = inConflict ? null : done ?? sync.justResolved?.keep ?? null;
  if (finished) {
    return (
      <div role="status" className="no-print rounded-lg border bg-card p-3 text-sm">
        {conflictDoneNotice(finished)}
      </div>
    );
  }
  if (!inConflict) return null;

  if (!copy) {
    return (
      <div role="status" className="no-print rounded-lg border bg-card p-3 text-sm text-muted-foreground">
        {NO_SERVER_COPY_NOTICE}
      </div>
    );
  }

  const diff = diffConflict(task, copy.task, copy.serverAt);
  const countsOf = (t: VisitTask) => `${t.documents.length} 份资料 · ${t.fields.length} 项信息 · ${t.actions.length} 条行动 · 复诊要点${(t.summaryNote ?? "").trim() ? "已写" : "没写"}`;
  const pick = (keep: ConflictChoice) => {
    setPending(keep);
    setDone(null);
  };
  const confirm = () => {
    if (!pending) return;
    const keep = pending;
    sync.resolveConflict(task.id, keep);
    setPending(null);
    setDone(keep);
    setOpen(false);
    // 结果话不放在窗里（窗一关就没人看得见），也不靠本组件还挂在冲突状态上——
    // 挑完冲突就消失了，所以挂载条件里带了 `sync.justResolved`，让这句真的出现在页面上。
  };

  return (
    <>
      <div role="status" className="no-print rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
        <p className="font-medium">{CONFLICT_PICKER_TITLE}</p>
        <p className="mt-1">{conflictDiffLine(diff)}。</p>
        <p className="mt-1">
          {LOCAL_AT_LABEL}：{task.updatedAt}；{SERVER_AT_LABEL}：{copy.serverAt}。
        </p>
        <p className="mt-1">系统不替你判断哪一份对——要留哪一份由你看完两份之后定。</p>
        <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) setPending(null); }}>
          <DialogTrigger asChild>
            <Button variant="outline" size="sm" className="mt-2">
              {CONFLICT_PICKER_TRIGGER}
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{CONFLICT_PICKER_TITLE}</DialogTitle>
              <DialogDescription>
                下面两份来自同一台设备与服务器，各自都被改过。挑一份留下，另一份会被替换掉，而我方没有地方能把它取回来。
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-3 sm:grid-cols-2">
              {(
                [
                  { key: "local" as const, head: "本机这一份（你现在屏幕上看到的）", atLabel: LOCAL_AT_LABEL, at: task.updatedAt, t: task },
                  { key: "server" as const, head: "服务器那一版（另一台设备或网页上的）", atLabel: SERVER_AT_LABEL, at: copy.serverAt, t: copy.task },
                ]
              ).map((col) => (
                <div key={col.key} className="rounded-md border bg-muted/40 p-2.5 text-sm">
                  <p className="font-medium">{col.head}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{col.atLabel}：{col.at}</p>
                  <p className="mt-1 text-xs">{countsOf(col.t)}</p>
                </div>
              ))}
            </div>

            <p className="text-sm">{conflictDiffLine(diff)}。</p>
            {diff.differs.length > 0 && (
              <ul className="list-disc pl-5 text-sm text-muted-foreground">
                {diff.differs.slice(0, 8).map((x) => (
                  <li key={x}>{x}</li>
                ))}
                {diff.differs.length > 8 && <li>其余 {diff.differs.length - 8} 项差别在这一页逐项核对时也会看到</li>}
              </ul>
            )}

            {!pending ? (
              <DialogFooter>
                <Button variant="outline" onClick={() => setOpen(false)}>
                  先不挑
                </Button>
                <Button variant="outline" onClick={() => pick("local")}>
                  {conflictButtonLabel("local")}
                </Button>
                <Button onClick={() => pick("server")}>
                  {conflictButtonLabel("server")}
                </Button>
              </DialogFooter>
            ) : (
              <>
                <p className="rounded-md border border-destructive/40 bg-destructive/5 p-2.5 text-sm text-destructive">
                  {conflictConsequence(pending)}
                </p>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setPending(null)}>
                    取消
                  </Button>
                  <Button onClick={confirm}>
                    {conflictConfirmLabel(pending)}
                  </Button>
                </DialogFooter>
              </>
            )}
          </DialogContent>
        </Dialog>
      </div>
    </>
  );
}
