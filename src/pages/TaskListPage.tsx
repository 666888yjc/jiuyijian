import { memo, useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { OverLimitHint } from "../shared";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useStore } from "../store";
import { useSync, isSyncable } from "../sync";
import { CONFLICT_LABEL, dataLocationOfTask, storageBadgeLabel, storageBadgeTitle, taskListFootnote } from "../storageNotice";
import { buildSeedTask } from "../seed";
import { newUuid } from "../uuid";
import { eligibleForSheet, now, uid, GROUP_TITLES } from "../sheet";
import { todayDateStr } from "../dates";
import { BOUNDARY_NOTICES } from "../redLine";
import { buildCarriedFields, carriedGroupCounts, referenceAuditDetail } from "../reference";
import { navigate } from "../router";
import type { FieldGroup, VisitTask } from "../types";

/**
 * 任务卡（2026-10-21 流畅度）：从主页的内联 map 提出来＋memo。
 * 以前任何一次 state 变化（别处确认一个字段、同步状态跳变）都让主页把每张卡重画一遍；
 * 现在卡只认自己的 props（task／冲突标记／存储位置都是原语或按引用稳定的对象），
 * 别的任务怎么变都不关它的事。
 */
const TaskCard = memo(function TaskCard({
  task,
  conflict,
  loc,
  onOpen,
}: {
  task: VisitTask;
  conflict: boolean;
  loc: ReturnType<typeof dataLocationOfTask>;
  onOpen: (id: string) => void;
}) {
  // HE-05：变量名与徽章术语对齐——这是入单门槛口径（eligibleForSheet），不是核对页的「已确认」进度口径
  const eligibleCount = task.fields.filter(eligibleForSheet).length;
  const overdue = (task.actions ?? []).filter((a) => !a.done && a.date < todayDateStr()).length;
  return (
    <Card
      className="cursor-pointer transition hover:border-primary"
      onClick={() => onOpen(task.id)}
      role="link"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && onOpen(task.id)}
    >
      <CardHeader>
        <CardTitle className="text-base">{task.purpose || "（未命名任务）"}</CardTitle>
        <CardDescription>
          {task.patientLabel} · 目标科室 {task.dept || "未填"} · 拟就诊 {task.visitDate || "未定"}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2 text-sm">
        <Badge variant="secondary">{task.documents.length} 份资料</Badge>
        <Badge
          variant={eligibleCount === task.fields.length && task.fields.length > 0 ? "default" : "outline"}
          title="已确认且满足入单门槛的字段数；高风险字段还需有原文证据"
        >
          可入单 {eligibleCount}/{task.fields.length} 项
        </Badge>
        {task.documents.some((d) => d.docType === "unknown") && (
          <Badge variant="destructive">有资料待分类</Badge>
        )}
        {conflict && <Badge variant="destructive">{CONFLICT_LABEL}</Badge>}
        <Badge variant={loc === "cloud" ? "default" : "outline"} title={storageBadgeTitle(loc)}>
          {storageBadgeLabel(loc)}
        </Badge>
        {overdue > 0 && <Badge variant="destructive">{overdue} 项行动已逾期</Badge>}
      </CardContent>
    </Card>
  );
});

export function TaskListPage() {
  const { state, dispatch } = useStore();
  const sync = useSync();
  const hasSeed = state.tasks.some((t) => t.id.startsWith("seed-task"));
  // R84：页头那句只说"有 N 个任务"，列表里必须指得出是哪几条（R81 实测：以前屏幕上给不出第三条信息）
  const conflictIds = new Set(sync.conflictTaskIds);
  // 打开任务的稳定回调（模块级 navigate 的薄包装）：每次渲染都新建闭包会把 TaskCard 的 memo 打穿
  const openTask = useCallback((id: string) => navigate(`/t/${id}/docs`), []);
  return (
    <div className="space-y-6">
      <section className="rounded-lg border bg-card p-5">
        <h1 className="text-xl font-semibold">我的就诊任务</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          把分散的病历和医嘱，整理成一份可核对、可追溯、医生看得懂的就诊交接单。
          <span className="ml-1 font-medium text-destructive">{BOUNDARY_NOTICES.taskList}</span>
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button onClick={() => navigate("/new")}>新建就诊任务</Button>
          {!hasSeed && (
            <Button
              variant="outline"
              onClick={() => dispatch({ type: "task.create", task: buildSeedTask() })}
            >
              载入脱敏示例（M1 模拟资料）
            </Button>
          )}
          <Button variant="ghost" onClick={() => navigate("/privacy")}>
            隐私与数据管理
          </Button>
        </div>
      </section>

      {state.tasks.length === 0 ? (
        <p className="text-sm text-muted-foreground">还没有任务。点击右上角「新建就诊任务」开始。</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {state.tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              conflict={conflictIds.has(task.id)}
              // R45：资料在哪里是**每个任务**的事实，不能拿"有没有登录"一概而论（示例任务、离线新增过资料的任务都不上云）
              loc={dataLocationOfTask({ backend: sync.backend, serverMode: sync.serverMode, signedIn: sync.signedIn, syncable: isSyncable(task) })}
              onOpen={openTask}
            />
          ))}
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        {taskListFootnote({ backend: sync.backend, serverMode: sync.serverMode, signedIn: sync.signedIn })}
      </p>
    </div>
  );
}

type TaskMeta = Pick<VisitTask, "patientLabel" | "purpose" | "dept" | "visitDate">;

function TaskForm({
  initial,
  submitLabel,
  onSubmit,
  task,
}: {
  initial: TaskMeta;
  submitLabel: string;
  onSubmit: (v: TaskMeta) => void;
  /** 编辑已有任务时传进来：本机专属的任务（示例任务）不该听见"服务器存不下"这句话 */
  task?: VisitTask;
}) {
  const [v, setV] = useState(initial);
  const [missingPurpose, setMissingPurpose] = useState(false);
  // 这里必须用**函数式更新**。原先写的是 `setV({ ...v, [k]: e.target.value })`，读的是这一次渲染闭包里的 `v`：
  // 手机输入法在一次拼音合成里连发两个 input 事件时，第二个事件带的还是"改动前"的那份 `v`，
  // 于是把第一个刚写进去的值整个盖掉 ⇒ 屏幕上明明有字、React 状态却是空的，
  // 而那颗按状态判定的提交按钮因此永远点不动（2026-09-28 主理人在微信内置浏览器里实测到，桌面端敲字复现不出来）。
  const set =
    (k: keyof TaskMeta) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const value = e.target.value;
      setV((prev) => ({ ...prev, [k]: value }));
    };
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        const purpose = v.purpose.trim();
        if (!purpose) {
          // 不许只把按钮变灰不给原因：手机上"点不动又不知道为什么"是一条死路（与 R68/R84 同一族）
          setMissingPurpose(true);
          document.getElementById("purpose")?.focus();
          return;
        }
        setMissingPurpose(false);
        onSubmit({ ...v, purpose, patientLabel: v.patientLabel.trim() || "本人" });
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="patient">为谁准备（备注名即可，不必填真实姓名）</Label>
        <Input id="patient" value={v.patientLabel} onChange={set("patientLabel")} placeholder="例如：母亲 / 张先生" />
        <OverLimitHint field="patientLabel" value={v.patientLabel} task={task} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="purpose">
          就诊目的 <span className="text-destructive">*</span>
        </Label>
        <Textarea
          id="purpose"
          rows={2}
          value={v.purpose}
          onChange={set("purpose")}
          placeholder="例如：心内科复诊，评估近两周胸闷加重的情况"
          aria-invalid={missingPurpose || undefined}
          aria-describedby={missingPurpose ? "purpose-required" : undefined}
        />
        <OverLimitHint field="purpose" value={v.purpose} task={task} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="dept">目标科室（可选）</Label>
          <Input id="dept" value={v.dept} onChange={set("dept")} placeholder="例如：心内科" />
          <OverLimitHint field="dept" value={v.dept} task={task} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="date">就诊日期（可选）</Label>
          <Input id="date" type="date" value={v.visitDate} onChange={set("visitDate")} />
        </div>
      </div>
      {missingPurpose && (
        <p id="purpose-required" role="status" className="text-sm text-destructive">
          请先写一句「就诊目的」——这一项必填，其余三栏可以留空。
        </p>
      )}
      {/* 提交按钮**不按状态禁用**：状态没同步时（手机输入法那种场合）灰掉的按钮就是一条没有解释的死路 */}
      <Button type="submit" className="w-full">
        {submitLabel}
      </Button>
    </form>
  );
}

export function NewTaskPage() {
  const { state, dispatch } = useStore();
  // U11 复诊闭环：引用历史任务（第一步：文字标注，无 U8 跳转）
  const sources = state.tasks.filter((t) => carriedGroupCounts(t).length > 0);
  const [refFrom, setRefFrom] = useState("");
  const [refGroups, setRefGroups] = useState<FieldGroup[]>([]);
  const source = state.tasks.find((t) => t.id === refFrom);
  const groupCounts = source ? carriedGroupCounts(source) : [];
  const carriedCount = source ? buildCarriedFields(source, refGroups).length : 0;
  return (
    <Card className="mx-auto max-w-xl">
      <CardHeader>
        <CardTitle className="text-lg">创建就诊任务</CardTitle>
        <CardDescription>先写清这次看病要解决什么，资料可以随后上传。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {sources.length > 0 && (
          <section className="rounded-lg border bg-card p-4 text-sm" aria-label="引用历史任务">
            <h2 className="font-medium">引用历史任务（可选）</h2>
            <p className="mt-1 text-muted-foreground">
              复诊时可以把上次已核对的字段带进来。带入字段全部回到「待确认」——上次核对过不代表这次仍成立，需重新核对后才会进入交接单。
            </p>
            <div className="mt-3 space-y-1.5">
              <Label htmlFor="ref-source">选择要引用的任务</Label>
              <select
                id="ref-source"
                className="w-full rounded-md border bg-background p-2 text-sm"
                value={refFrom}
                onChange={(e) => {
                  setRefFrom(e.target.value);
                  setRefGroups([]);
                }}
              >
                <option value="">不引用，从零开始</option>
                {sources.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.purpose || "（未命名任务）"}（{t.dept || "科室未填"} · 拟就诊 {t.visitDate || "日期未填"}）
                  </option>
                ))}
              </select>
            </div>
            {source && groupCounts.length > 0 && (
              <fieldset className="mt-3 space-y-1.5">
                <legend className="text-sm text-muted-foreground">选择要带入的字段组</legend>
                {groupCounts.map((g) => (
                  <label key={g.group} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={refGroups.includes(g.group)}
                      onChange={(e) =>
                        setRefGroups((prev) =>
                          e.target.checked ? [...prev, g.group] : prev.filter((x) => x !== g.group),
                        )
                      }
                    />
                    {GROUP_TITLES[g.group]}（{g.count} 项已确认）
                  </label>
                ))}
                {carriedCount > 0 && (
                  <p className="text-xs text-muted-foreground">将带入 {carriedCount} 个字段，全部回到待确认。</p>
                )}
              </fieldset>
            )}
          </section>
        )}
        <TaskForm
          initial={{ patientLabel: "", purpose: "", dept: "", visitDate: "" }}
          submitLabel="保存并去上传资料"
          onSubmit={(v) => {
            // 不用 crypto.randomUUID()：它在非安全上下文（内网 http 地址）下不存在，会让"新建任务"整条路静默失败
            const id = newUuid();
            const carried = source && refGroups.length ? buildCarriedFields(source, refGroups) : [];
            const audit = [{ id: uid("a-"), at: now(), action: "task.create", detail: "创建就诊任务" }];
            if (carried.length && source) {
              audit.push({ id: uid("a-"), at: now(), action: "task.reference", detail: referenceAuditDetail(source, carried.length) });
            }
            dispatch({
              type: "task.create",
              task: {
                id,
                ...v,
                createdAt: now(),
                updatedAt: now(),
                documents: [],
                fields: carried,
                questions: [],
                actions: [],
                sheetHidden: [],
                audit,
              },
            });
            navigate(`/t/${id}/docs`);
          }}
        />
      </CardContent>
    </Card>
  );
}

export function TaskEditPage({ task }: { task: VisitTask }) {
  const { dispatch } = useStore();
  return (
    <Card className="mx-auto max-w-xl">
      <CardHeader>
        <CardTitle className="text-lg">编辑任务信息</CardTitle>
      </CardHeader>
      <CardContent>
        <TaskForm
          initial={{
            patientLabel: task.patientLabel,
            purpose: task.purpose,
            dept: task.dept,
            visitDate: task.visitDate,
          }}
          task={task}
          submitLabel="保存修改"
          onSubmit={(v) => {
            dispatch({ type: "task.updateMeta", taskId: task.id, patch: v });
            navigate(`/t/${task.id}/docs`);
          }}
        />
      </CardContent>
    </Card>
  );
}
