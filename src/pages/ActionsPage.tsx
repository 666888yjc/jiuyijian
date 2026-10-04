import { useState } from "react";
import { requiredNotice } from "../requiredNotice";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useStore, makeAudit } from "../store";
import { OverLimitHint } from "../shared";
import { uid, now, finalValue, isUserConfirmed, evidenceAffordance } from "../sheet";
import { todayDateStr } from "../dates";
import { navigate } from "../router";
import type { ActionItem, ActionType, VisitTask } from "../types";
import { ACTION_TYPE_LABELS } from "../types";
import { TaskShell } from "./TaskShell";

function ActionRow({ task, item }: { task: VisitTask; item: ActionItem }) {
  const { dispatch } = useStore();
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState(item.doneNote ?? "");
  // R77：一条行动的**内容**以前改不了（`state.ts` 只有 add/toggle/delete）⇒ 打错字、或者它顶到了
  // 服务器那道 300 字节门（R75），唯一的出路是整条删掉重填：把家属自己写的话删掉，日期与挂的字段还要重挑。
  const [editOpen, setEditOpen] = useState(false);
  const [draft, setDraft] = useState(item.content);
  /** R106：这颗「保存修改」以前在内容为空时是禁用的（按下什么都不会发生、也没有一句话说明），改成按下时点名 */
  const [editEmpty, setEditEmpty] = useState(false);
  const overdue = !item.done && item.date < todayDateStr();
  const sourceField = item.fieldId ? task.fields.find((f) => f.id === item.fieldId) : undefined;
  const sourceEv = sourceField ? evidenceAffordance(sourceField) : undefined;

  return (
    <li className={"rounded-lg border bg-card p-3 " + (overdue ? "border-destructive/60" : "")}>
      <div className="flex items-start gap-3">
        <Checkbox
          checked={item.done}
          aria-label={`标记完成：${item.content}`}
          onCheckedChange={(c) => {
            const done = c === true;
            if (done) {
              setNoteOpen(true);
            } else {
              dispatch({ type: "action.toggle", taskId: task.id, actionId: item.id, done: false });
              dispatch({ type: "audit.push", taskId: task.id, audit: makeAudit("action.undo", `撤销完成：${item.content.slice(0, 30)}`) });
            }
          }}
          className="mt-1"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{ACTION_TYPE_LABELS[item.type]}</Badge>
            <span className={item.done ? "text-sm text-muted-foreground line-through" : "font-medium"}>{item.content}</span>
            {overdue && <Badge variant="destructive">已逾期</Badge>}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            日期：{item.date}
            {item.done && item.doneAt && ` · 完成于 ${new Date(item.doneAt).toLocaleDateString("zh-CN")}`}
            {item.done && item.doneNote && ` · 记录：${item.doneNote}`}
            {sourceField && sourceEv && (
              <>
                {" · 来源："}
                {sourceEv.navigable ? (
                  <button
                    type="button"
                    className="text-primary underline underline-offset-2"
                    onClick={() => navigate(`/evidence/${sourceField.docId}/${sourceField.pageId}/${sourceField.id}`)}
                  >
                    {sourceField.label} 的{sourceEv.noun}
                  </button>
                ) : (
                  // 手工补录的项没有原件：以前这里照样写「XX 的原文证据」，点过去是 /evidence/undefined/undefined/…
                  // 并回一句"该资料可能已被删除"。没上传过，谈何删除——不可跳转就别冒充可回溯（红线③）。
                  <span>{sourceField.label}（{sourceEv.noun}）</span>
                )}
              </>
            )}
          </p>
          {editOpen && (
            <div className="mt-2 space-y-2">
              <Label htmlFor={`act-${item.id}`} className="sr-only">修改行动内容</Label>
              <Textarea
                id={`act-${item.id}`}
                rows={2}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                aria-invalid={editEmpty || undefined}
                aria-describedby={editEmpty ? `act-edit-required-${item.id}` : undefined}
              />
              {/* R77：改的目的常常就是"把它删短到服务器收得下"，所以那两个字节数必须**在改的当场**说，
                  不能等人保存完了再由页头去说「存不上」。判据与页头那句同出一处（`fieldLimits`）。 */}
              <OverLimitHint field="actionContent" value={draft} task={task} />
              <div className="flex gap-2">
                <Button size="sm" onClick={(e) => {
                  const content = draft.trim();
                  // R106：按下时点名这一栏并把光标送回去，而不是让按钮一直灰着（同一颗按钮曾按状态禁用）。
                  // 取元素走"这个编辑块里的 textarea"，不用 `getElementById(\`act-${item.id}\`)`：
                  // 那种动态 id 的引用无障碍闸门 S10 判成"指不到东西的引用"（R86 立的规矩），而它确实证明不了——那就别留这种引用形状。
                  if (!content) {
                    setEditEmpty(true);
                    (e.currentTarget.parentElement?.parentElement?.querySelector("textarea") as HTMLElement | null)?.focus();
                    return;
                  }
                  setEditEmpty(false);
                  setEditOpen(false);
                  if (content === item.content) return;
                  dispatch({ type: "action.update", taskId: task.id, actionId: item.id, content });
                  dispatch({ type: "audit.push", taskId: task.id, audit: makeAudit("action.update", `改行动内容：「${item.content.slice(0, 30)}」→「${content.slice(0, 30)}」`) });
                }}>保存修改</Button>
                <Button size="sm" variant="ghost" onClick={() => setEditOpen(false)}>取消</Button>
              </div>
              {editEmpty && (
                <p id={`act-edit-required-${item.id}`} role="status" className="text-sm text-destructive">
                  {requiredNotice("actionEdit")}
                </p>
              )}
            </div>
          )}
          {noteOpen && !item.done && (
            <div className="mt-2 space-y-2">
              <Label htmlFor={`note-${item.id}`} className="sr-only">执行记录（可选）</Label>
              <Textarea id={`note-${item.id}`} rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="执行记录（可选）：例如已完成复查、医院与结果" />
              <OverLimitHint field="actionDoneNote" value={note} task={task} />
              <div className="flex gap-2">
                <Button size="sm" onClick={() => {
                  dispatch({ type: "action.toggle", taskId: task.id, actionId: item.id, done: true, doneNote: note.trim() || undefined });
                  dispatch({ type: "audit.push", taskId: task.id, audit: makeAudit("action.done", `完成：${item.content.slice(0, 30)}`) });
                  setNoteOpen(false);
                }}>保存并完成</Button>
                <Button size="sm" variant="ghost" onClick={() => setNoteOpen(false)}>取消</Button>
              </div>
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {/* 已完成的那条不改内容：改了就等于把"当时做过什么"的记录换掉，那是另一件事（要改请先撤销完成）。 */}
          {!item.done && (
            <Button
              variant="ghost"
              size="sm"
              aria-label={`修改行动内容：${item.content}`}
              onClick={() => {
                setDraft(item.content);
                setEditOpen(true);
              }}
            >
              改内容
            </Button>
          )}
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="ghost" size="sm" className="shrink-0 text-destructive" aria-label={`删除行动：${item.content}`}>删除</Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>删除该行动项？</AlertDialogTitle>
              <AlertDialogDescription>
                删除后不可恢复{item.done ? "，完成时间与执行记录将一并删除" : ""}。当前任务的其他内容不受影响。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>取消</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-white hover:bg-destructive/90"
                onClick={() => {
                  dispatch({ type: "action.delete", taskId: task.id, actionId: item.id });
                  dispatch({ type: "audit.push", taskId: task.id, audit: makeAudit("action.delete", `删除行动项：${item.content.slice(0, 30)}`) });
                }}
              >
                确认删除
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        </div>
      </div>
    </li>
  );
}

export function ActionsPage({ task }: { task: VisitTask }) {
  const { dispatch } = useStore();
  const [type, setType] = useState<ActionType>("followup");
  const [content, setContent] = useState("");
  const [date, setDate] = useState("");
  const [fieldId, setFieldId] = useState("none");
  /** R105：缺哪一栏就说哪一栏（照 R99 的配方：提交按钮不按状态禁用，改成"按下时校验＋就地说明"） */
  const [missingField, setMissingField] = useState<"" | "content" | "date">("");
  const actions = task.actions ?? [];
  // R61：这里原本多一条 `|| f.source === "user"`，于是复诊带入字段（source=user 但本次仍 pending）
  // 会出现在标签写着「已确认信息」的下拉里——行动可以挂到一个本次没核对过的值上。口径只认 isUserConfirmed。
  const confirmedFields = task.fields.filter(isUserConfirmed);
  const overdue = actions.filter((a) => !a.done && a.date < todayDateStr());
  const upcoming = actions.filter((a) => !a.done && a.date >= todayDateStr()).sort((x, y) => x.date.localeCompare(y.date));
  const done = actions.filter((a) => a.done).sort((x, y) => (y.doneAt ?? "").localeCompare(x.doneAt ?? ""));

  function add() {
    // R105：这里以前是 `if (!content.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;` 配一颗按状态禁用的按钮——
    // 家属按下却什么都不会发生（2026-09-29 现测：`disabled=true`、`title` 与 `aria-describedby` 都是 null、整页没有一句"必填"），
    // 而"为什么加不进去"没有任何说法。改成按下时点名缺哪一栏并把光标送过去；仍然不许悄悄加进一条空内容或没有日期的行动。
    if (!content.trim()) {
      setMissingField("content");
      document.getElementById("act-content")?.focus();
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setMissingField("date");
      document.getElementById("act-date")?.focus();
      return;
    }
    setMissingField("");
    const item: ActionItem = {
      id: uid("act-"),
      type,
      // R75：这里原来写 `.slice(0, 300)`——按**字符**切，而服务端那道门是 300 **字节**（100 个汉字）。
      // 结果是"切够了照样存不上"，还会把家属写的第 301 个字之后悄悄抹掉。现在一个字都不删：
      // 超长的原样留在本机，由页头与输入框下面那两句点名说"哪一栏、超了多少字节"，并在删短之前不推。
      content: content.trim(),
      date,
      done: false,
      createdAt: now(),
    };
    const src = fieldId !== "none" ? confirmedFields.find((f) => f.id === fieldId) : undefined;
    if (src) item.fieldId = src.id;
    dispatch({ type: "action.add", taskId: task.id, item });
    dispatch({ type: "audit.push", taskId: task.id, audit: makeAudit("action.add", `新增${ACTION_TYPE_LABELS[type]}行动：${item.content.slice(0, 30)}（${date}）`) });
    setContent("");
    setDate("");
    setFieldId("none");
  }

  return (
    <TaskShell task={task} tab="actions">
      <section className="rounded-lg border bg-card p-4 text-sm">
        <p className="font-medium">复查 · 服药 · 观察提醒</p>
        <p className="mt-1 text-muted-foreground">
          内容只能来自你已确认的资料或你本人填写；本工具不会生成用药或复查建议。到期的条目会在任务列表和此页高亮提醒（应用内提醒，不发送消息）。
        </p>
      </section>

      <section className="rounded-lg border bg-card p-4">
        <h2 className="mb-3 font-medium">新增行动项</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>类型</Label>
            <Select value={type} onValueChange={(v) => setType(v as ActionType)}>
              <SelectTrigger aria-label="行动类型"><SelectValue /></SelectTrigger>
              <SelectContent>
                {(Object.keys(ACTION_TYPE_LABELS) as ActionType[]).map((t) => (
                  <SelectItem key={t} value={t}>{ACTION_TYPE_LABELS[t]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="act-date">日期</Label>
            <Input
              id="act-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              aria-invalid={missingField === "date" || undefined}
              aria-describedby={missingField === "date" ? "act-required" : undefined}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="act-content">内容（照抄医嘱原文或你的安排）</Label>
            <Input
              id="act-content"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="例如：三日后门诊复诊（据病历医嘱）"
              aria-invalid={missingField === "content" || undefined}
              aria-describedby={missingField === "content" ? "act-required" : undefined}
            />
            <OverLimitHint field="actionContent" value={content} task={task} />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label>关联已确认信息（可选，便于回溯证据）</Label>
            <Select value={fieldId} onValueChange={setFieldId}>
              <SelectTrigger aria-label="关联字段"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">不关联</SelectItem>
                {confirmedFields.map((f) => (
                  <SelectItem key={f.id} value={f.id}>{f.label}：{finalValue(f).slice(0, 30)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        {missingField === "content" && (
          <p id="act-required" role="status" className="mt-3 text-sm text-destructive">
            请先写「内容」——这一栏不能空着。写医嘱原文或你自己安排的那件事就行。
          </p>
        )}
        {missingField === "date" && (
          <p id="act-required" role="status" className="mt-3 text-sm text-destructive">
            请选一个日期——没有日期，这条就到期时高亮不了，也没法跟别的行动排先后。
          </p>
        )}
        {/* R105：这颗按钮**不按状态禁用**（与 R99 新建任务那条同一配方）。
            禁用态在这页上等于一条没有解释的死路：按下去什么都不会发生，屏幕上也没有一句话说为什么。 */}
        <Button className="mt-3" onClick={add}>添加</Button>
      </section>

      {overdue.length > 0 && (
        <section>
          <h2 className="mb-2 mt-4 font-semibold text-destructive">已逾期（{overdue.length}）</h2>
          <ul className="space-y-2">{overdue.map((a) => <ActionRow key={a.id} task={task} item={a} />)}</ul>
        </section>
      )}
      <section>
        <h2 className="mb-2 mt-4 font-semibold">待办（{upcoming.length}）</h2>
        {upcoming.length === 0 ? <p className="text-sm text-muted-foreground">暂无待办。</p> : (
          <ul className="space-y-2">{upcoming.map((a) => <ActionRow key={a.id} task={task} item={a} />)}</ul>
        )}
      </section>
      {done.length > 0 && (
        <section>
          <h2 className="mb-2 mt-4 font-semibold">已完成（{done.length}）</h2>
          <ul className="space-y-2">{done.map((a) => <ActionRow key={a.id} task={task} item={a} />)}</ul>
        </section>
      )}
    </TaskShell>
  );
}
