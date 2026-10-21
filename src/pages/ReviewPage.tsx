import { memo, useEffect, useMemo, useRef, useState } from "react";
import { requiredNotice } from "../requiredNotice";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useStore, makeAudit } from "../store";
import type { Action } from "../state";
import { GROUP_ORDER, GROUP_TITLES, uid, now, isUserConfirmed, hasOriginalEvidence, finalValue } from "../sheet";
import {
  LEDGER_SECTION_TITLE,
  MERGE_LABEL,
  UNMERGE_LABEL,
  buildItemClusters,
  clusterRecordCountLabel,
  dateMarkerOf,
  entrySourceLabel,
  jumpLabel,
  ledgerLegend,
  mergeChoice,
  mergedNotice,
  multiRecordClusters,
  suspectPairNotice,
  suspectPairs,
} from "../itemLedger";
import type { ItemCluster, SuspectPair } from "../itemLedger";
import { carriedRefNote, carriedRefTarget } from "../reference";
import { navigate } from "../router";
import {
  ConfirmBadge,
  ConfidenceBadge,
  EvidenceLink,
  HighRiskBadge,
  OriginBadge,
  OverLimitHint,
} from "../shared";
import type { ExtractedField, FieldGroup, VisitTask } from "../types";
// R96：那句"来自测试假模型"的措辞与判定只有一处出处
import { SYNTHETIC_MODEL_NOTICE, isSyntheticField, syntheticNoticeCount, syntheticNoticeSummary, visibleReviewFields } from "../modelDisclosure";
import { SOURCE_GONE_NOTICE, isSourceGoneField } from "../sheet";
import { isSyncable } from "../sync";
import { TaskShell } from "./TaskShell";

/**
 * 字段卡（2026-10-21 流畅度那一轮重写成纯 props＋memo）：
 * 以前它自己 `useStore()` 订阅全量 state、还收整个 `task` ⇒ 任何一次 dispatch
 * （确认一个字段、并一项）都让屏幕上每张卡重画一遍——24 份资料 934 字段时量到 88ms/次。
 * 现在：dispatch 走独立的 DispatchCtx（值终生不变，见 store.tsx），数据全部由父级
 * 按字段 id 发下来（refNote/refTarget 由父级缓存守住「内容没变就还是同一个引用」；
 * conflictPartners 同理）⇒ 重画范围回到 props 真变了的那几张。
 */
const FieldCard = memo(function FieldCard({
  field,
  focused = false,
  taskId,
  refNote,
  refTarget,
  conflictPartners,
  syncable,
  dispatch,
}: {
  field: ExtractedField;
  focused?: boolean;
  taskId: string;
  refNote: string | null;
  refTarget: { kind: "evidence" | "task" | "none"; path: string };
  conflictPartners: ExtractedField[];
  syncable: boolean;
  dispatch: (a: Action) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(field.userValue ?? field.aiValue ?? "");
  /** R106：这颗「保存修改并确认」以前在内容为空时是禁用的 ⇒ 按下什么都不会发生，且没有一句话说为什么 */
  const [draftEmpty, setDraftEmpty] = useState(false);
  // HE-16：卡片标题跟随确认状态，已确认的字段不再显示「待你确认」
  const valueTitle =
    field.confirmStatus === "corrected"
      ? "你修改后的内容"
      : field.confirmStatus === "confirmed"
        ? "核对后的内容"
        : "识别出的内容（待你确认）";

  const hasConflict =
    conflictPartners.length > 0 &&
    conflictPartners.some((o) => (o.aiValue ?? o.userValue ?? "") !== (field.aiValue ?? field.userValue ?? ""));

  const confirm = (status: ExtractedField["confirmStatus"], value?: string) => {
    dispatch({
      type: "field.confirm",
      taskId,
      fieldId: field.id,
      status,
      userValue: value,
      audit: makeAudit("field.confirm", `「${field.label}」→ ${status}`),
    });
    setEditing(false);
  };

  // 确认/标不确定会把卡片里的「确认无误」按钮换掉，浏览器于是把焦点丢回 body：
  // 键盘用户逐项核对 14 条就得每次从页首重新 Tab。状态一变就把焦点收回这张卡。
  const prevStatus = useRef(field.confirmStatus);
  useEffect(() => {
    if (prevStatus.current === field.confirmStatus) return;
    prevStatus.current = field.confirmStatus;
    document.querySelector<HTMLElement>(`[data-field-id="${field.id}"]`)?.focus({ preventScroll: true });
  }, [field.confirmStatus, field.id]);

  return (
    <li
      data-field-id={field.id}
      tabIndex={-1}
      aria-labelledby={`fld-${field.id}-t`}
      className={
        "rounded-lg border bg-card p-4 " +
        (field.source === "user" ? "field-user" : "field-ai") +
        (field.highRisk ? " field-highrisk" : "") +
        (focused ? " field-focus" : "")
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={`fld-${field.id}-t`} className="font-medium">{field.label}</h3>
        {field.highRisk && <HighRiskBadge />}
        {field.source === "ai" && <ConfidenceBadge level={field.confidence} />}
        <ConfirmBadge status={field.confirmStatus} />
        <span className="ml-auto">
          <OriginBadge field={field} />
        </span>
      </div>
      {refNote &&
        (refTarget.kind === "none" ? (
          <p className="mt-1 text-xs text-muted-foreground">{refNote}</p>
        ) : (
          <button
            type="button"
            className="mt-1 text-xs text-primary underline"
            onClick={() => navigate(refTarget.path)}
          >
            {refNote} · 查看来源
          </button>
        ))}

      {field.source === "ai" && (
        <div className="mt-3 space-y-2 text-sm">
          <div className="field-doc rounded-r-md bg-muted/60 p-2.5">
            {/* R24：ocrRaw 只是模型自己声称的出处，blockIds 为空说明这行在本件转写结果里根本没找到。
                一律标「病历原文」会让家属以为它能回溯——标签必须区分"对上了"和"没对上"。 */}
            <p className={hasOriginalEvidence(field) ? "text-xs text-muted-foreground" : "text-xs text-destructive"}>
              {hasOriginalEvidence(field) ? "病历原文" : "模型自称的出处（未在本件转写结果中找到，不可回溯）"}
            </p>
            <p className="font-mono">{field.ocrRaw}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{valueTitle}</p>
            <p className="font-medium">{field.aiValue ?? "（未能识别，请人工补填或标记不确定）"}</p>
            {/* R96：这一刻跑的是测试假模型时，患者必须看见这句话（可见文本、role="status"，不靠 hover／title）。
                判据来自服务端自己声明的 modelKind——`modelVersion` 分不出真假：假 llm 通路回的那串与真通路逐字节相同。 */}
            {isSyntheticField(field) && (
              <p role="status" className="mt-1 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
                {SYNTHETIC_MODEL_NOTICE}
              </p>
            )}
          </div>
        </div>
      )}
      {field.source === "user" && (
        <p className="mt-2 text-sm font-medium">{field.userValue}</p>
      )}

      {hasConflict && (
        <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/5 p-2.5 text-sm">
          <p className="font-medium text-destructive">与另一份资料不一致，系统不代为判断：</p>
          <ul className="mt-1 list-disc pl-5 text-muted-foreground">
            {conflictPartners.map((o) => (
              <li key={o.id}>
                {o.label}：{o.aiValue ?? o.userValue ?? o.ocrRaw}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-muted-foreground">请按原件核对后选择其一，或标记「不确定」留给医生确认。</p>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {field.confirmStatus !== "confirmed" && (
          <Button
            size="sm"
            onClick={() => confirm("confirmed")}
            disabled={!field.aiValue?.trim() && field.source === "ai"}
          >
            确认无误
          </Button>
        )}
        {editing ? (
          <div className="w-full space-y-2">
            <Label htmlFor={`edit-${field.id}`} className="sr-only">
              修改「{field.label}」
            </Label>
            <Textarea
              id={`edit-${field.id}`}
              rows={2}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="按原件抄录正确内容"
              aria-invalid={draftEmpty || undefined}
              aria-describedby={draftEmpty ? `edit-required-${field.id}` : undefined}
            />
            <OverLimitHint field="fieldValue" value={draft} syncable={syncable} />
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={(e) => {
                  if (!draft.trim()) {
                    setDraftEmpty(true);
                    // 不用 `getElementById(`edit-${field.id}`)`：动态 id 的引用会被 S10 判成指不到东西的引用（R86）
                    (e.currentTarget.parentElement?.parentElement?.querySelector("textarea") as HTMLElement | null)?.focus();
                    return;
                  }
                  confirm("corrected", draft.trim());
                }}
              >
                保存修改并确认
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                取消
              </Button>
            </div>
            {draftEmpty && (
              <p id={`edit-required-${field.id}`} role="status" className="text-sm text-destructive">
                {requiredNotice("fieldValue")}
              </p>
            )}
          </div>
        ) : (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setDraft(field.userValue ?? field.aiValue ?? field.ocrRaw ?? "");
              setEditing(true);
            }}
          >
            修改
          </Button>
        )}
        {field.confirmStatus !== "uncertain" && (
          <Button size="sm" variant="ghost" onClick={() => confirm("uncertain")}>
            不确定
          </Button>
        )}
        {field.confirmStatus === "uncertain" && (
          <span className="text-xs text-muted-foreground">已标记不确定：将以原文呈现，不写成事实</span>
        )}
        {field.source === "ai" && <EvidenceLink field={field} />}
      </div>
    </li>
  );
});

/** 没有冲突伙伴时的稳定空数组（模块级常量 ⇒ 不会每次渲染换引用把 memo 打穿） */
const NO_PARTNERS: ExtractedField[] = [];

/**
 * R112「同一项目的多次记录」：被两份以上资料记过的项目排在一起，新的在前面，每个值后面括号写这一条的日期来处。
 * 只读不判断——值不改、确认态不改、`conflictWith` 那句「系统不代为判断」也照旧在卡片里说；
 * 这里唯一能改变数据的是家属点那一次「算同一项」（写审计，可「拆开」）。
 * 名单跟着本页的过滤条件走（`shownFields`）：过滤后只剩一条的项目就不算"多次记录"，不许在归纳里出现页面上没有的东西。
 */
function ItemLedger({ task, fields, onJump }: { task: VisitTask; fields: ExtractedField[]; onJump: (id: string) => void }) {
  const { dispatch } = useStore();
  // 三段计算各记住一次：这一页每次界面重画（点「跳到这一条」、高亮、过滤开关）都会重新渲染这个组件，
  // 而 task 与这份名单没变时重算是白算——R118 在 934 字段的任务上量到一次重算 ≈ 46 毫秒的主线程占用。
  const clusters = useMemo(() => buildItemClusters(task, fields), [task, fields]);
  const multi = useMemo(() => multiRecordClusters(clusters), [clusters]);
  const suspects = useMemo(() => suspectPairs(clusters), [clusters]);
  if (multi.length === 0 && suspects.length === 0) return null;
  const merge = (pair: SuspectPair) => {
    const { name, fieldIds } = mergeChoice(pair);
    dispatch({
      type: "field.setItemGroup",
      taskId: task.id,
      fieldIds,
      itemGroup: name,
      audit: makeAudit("item.merge", `把「${pair.a.title}」与「${pair.b.title}」并成一项「${name}」（${fieldIds.length} 条记录）`),
    });
  };
  const unmerge = (c: ItemCluster) => {
    dispatch({
      type: "field.setItemGroup",
      taskId: task.id,
      fieldIds: c.entries.map((e) => e.field.id),
      itemGroup: null,
      audit: makeAudit("item.unmerge", `拆开「${c.title}」（${c.entries.length} 条记录退回各自原来的写法）`),
    });
  };
  return (
    <section className="rounded-lg border bg-card p-4" aria-labelledby="grp-ledger">
      <h2 id="grp-ledger" className="font-semibold">{LEDGER_SECTION_TITLE}</h2>
      <p className="mt-1 text-xs text-muted-foreground">{ledgerLegend()}</p>
      {multi.length > 0 && (
        <ul className="mt-3 space-y-3">
          {multi.map((c) => (
            <li key={c.key} className="rounded-md border bg-background p-3">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-medium">{c.title}</h3>
                <span className="text-xs text-muted-foreground">{clusterRecordCountLabel(c)}</span>
                {c.humanMerged && (
                  <Button size="sm" variant="ghost" onClick={() => unmerge(c)}>
                    {UNMERGE_LABEL}
                  </Button>
                )}
              </div>
              {c.humanMerged && <p className="mt-1 text-xs text-muted-foreground">{mergedNotice(c)}</p>}
              <ul className="mt-2 space-y-1">
                {c.entries.map((e) => (
                  <li key={e.field.id} className="flex flex-wrap items-baseline gap-2 text-sm">
                    <span className="font-medium">{finalValue(e.field) || "（没有识别出内容）"}</span>
                    <span className="text-xs text-muted-foreground">{dateMarkerOf(e.date)}</span>
                    {/* R113：每条值都写清它出自哪份资料——两份单子里同一个标签的两行，靠这个才分得开是谁的剂量 */}
                    <span className="text-xs text-muted-foreground">来自：{entrySourceLabel(e)}</span>
                    <button
                      type="button"
                      className="ml-auto text-xs text-primary underline"
                      aria-label={jumpLabel(c, e)}
                      onClick={() => onJump(e.field.id)}
                    >
                      跳到这一条
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
      {suspects.length > 0 && (
        <ul className="mt-3 space-y-2">
          {suspects.map((p) => (
            <li key={`${p.a.key}::${p.b.key}`} className="rounded-md border border-dashed p-3 text-sm">
              <p className="text-muted-foreground">{suspectPairNotice(p.a, p.b)}</p>
              <div className="mt-2">
                <Button size="sm" variant="outline" onClick={() => merge(p)}>
                  {MERGE_LABEL}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AddManualField({ task }: { task: VisitTask }) {
  const { dispatch } = useStore();
  const [open, setOpen] = useState(false);
  const [group, setGroup] = useState<FieldGroup>("medication");
  const [label, setLabel] = useState("");
  const [value, setValue] = useState("");
  /** R106：只填一栏时这颗「保存」以前是禁用的，而对话框里没有任何一句话说明是哪一栏没填 */
  const [manualEmpty, setManualEmpty] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          ＋ 手工补充信息
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>手工补充一条信息</DialogTitle>
          <DialogDescription>用于识别失败或资料里没有记录、但你知道的情况。内容会标注「用户补充」。</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>分组</Label>
            <Select value={group} onValueChange={(v) => setGroup(v as FieldGroup)}>
              <SelectTrigger aria-label="选择分组">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {GROUP_ORDER.filter((g) => g !== "meta").map((g) => (
                  <SelectItem key={g} value={g}>
                    {GROUP_TITLES[g]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mf-label">名称</Label>
            <Input
              id="mf-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="例如：阿司匹林肠溶片"
              aria-invalid={(manualEmpty && !label.trim()) || undefined}
              aria-describedby={manualEmpty ? "mf-required" : undefined}
            />
            <OverLimitHint field="fieldLabel" value={label} task={task} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mf-value">内容</Label>
            <Textarea
              id="mf-value"
              rows={2}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="例如：100mg 每日一次 口服"
              aria-invalid={(manualEmpty && !value.trim()) || undefined}
              aria-describedby={manualEmpty ? "mf-required" : undefined}
            />
            <OverLimitHint field="fieldValue" value={value} task={task} />
          </div>
        </div>
        <DialogFooter>
          {manualEmpty && (
            <p id="mf-required" role="status" className="text-sm text-destructive">
              {requiredNotice("manualField")}
            </p>
          )}
          <Button
            onClick={() => {
              if (!label.trim() || !value.trim()) {
                setManualEmpty(true);
                document.getElementById(!label.trim() ? "mf-label" : "mf-value")?.focus();
                return;
              }
              setManualEmpty(false);
              dispatch({
                type: "field.add",
                taskId: task.id,
                field: {
                  id: uid("fld-"),
                  group,
                  label: label.trim(),
                  ocrRaw: "",
                  aiValue: null,
                  userValue: value.trim(),
                  highRisk: group === "medication" || group === "allergy",
                  confidence: "high",
                  confirmStatus: "confirmed",
                  source: "user",
                  updatedAt: now(),
                },
              });
              dispatch({ type: "audit.push", taskId: task.id, audit: makeAudit("field.add", `手工补充「${label.trim()}」`) });
              setLabel("");
              setValue("");
              setOpen(false);
            }}
          >
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ReviewPage({ task, focusFieldId }: { task: VisitTask; focusFieldId?: string | null }) {
  const { state: allState, dispatch } = useStore();
  const [q, setQ] = useState("");
  /** R106：这句以前靠 `disabled` 挡着——空着时按钮是灰的，家属不知道是按钮坏了还是别的 */
  const [qEmpty, setQEmpty] = useState(false);
  const [onlyPending, setOnlyPending] = useState(false);
  // HE-09：从交接单编辑页排除列表逐条「去处理」跳入时，定位并高亮目标字段卡片。
  // 字段不存在（id 写错/字段已删）时不定位、不假装找到——与其他降级路径同一口径；
  // 存在性检查同时充当 querySelector 选择符的安全闸（字段 id 均为程序生成的安全字符）。
  const [focusedId, setFocusedId] = useState<string | null>(null);
  useEffect(() => {
    if (!focusFieldId) return;
    if (!task.fields.some((f) => f.id === focusFieldId)) return;
    setFocusedId(focusFieldId);
    document.querySelector(`[data-field-id="${focusFieldId}"]`)?.scrollIntoView({ block: "center" });
    const timer = window.setTimeout(() => setFocusedId(null), 2400);
    return () => window.clearTimeout(timer);
    // task.fields 不进依赖：确认字段会换数组引用，不该把用户刚操作过的卡片再次滚动+高亮
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusFieldId]);
  // 已确认数口径与 eligibleForSheet 对齐（U11 订正）：确认态对所有来源生效，
  // 带入字段（source=user + pending）在重新确认前不计入
  const eligible = task.fields.filter(isUserConfirmed).length;
  // 来源资料已删除的那批：确认了也进不了交接单（sheet.eligibleForSheet 里那条规则），所以不能算进"待确认"里催用户去点
  const staleFields = task.fields.filter(isSourceGoneField);
  const pendingCount = task.fields.filter(
    (f) => !isSourceGoneField(f) && (f.confirmStatus === "pending" || f.confirmStatus === "uncertain"),
  ).length;
  const pendingHigh = task.fields.filter(
    (f) => !isSourceGoneField(f) && f.highRisk && f.confirmStatus === "pending" && (f.aiValue?.trim() || f.ocrRaw.trim() || f.userValue?.trim()),
  ).length;
  // 待确认项清零时自动回退到全量视图，避免过滤后出现空列表
  const effectiveOnlyPending = onlyPending && pendingCount > 0;
  // 这一页真渲染出来的那些字段：分组列表与「这一页有 N 条」那句**共用同一个谓词**（R96 的范围纪律）
  // 记住一次（R118 量测：归纳段与这份名单每次界面重画都全量重算一次；不重算的前提是 task.fields 与过滤条件都没变）
  const shownFields = useMemo(() => visibleReviewFields(task.fields, effectiveOnlyPending), [task.fields, effectiveOnlyPending]);
  // 字段卡的派生数据（2026-10-21 流畅度）：一次算好按字段 id 发下去，卡片才收得住 memo。
  // 三张缓存各守一种"换了引用但内容没变"的打穿路径：
  // · refNote/refTarget：carriedRefTarget 每次返回**新对象**，不缓存的话父级每重算一次，
  //   每张卡的 refTarget prop 就换一次引用 ⇒ memo 全白做（第一版实测：确认耗时不降反升 16%）。
  //   命中条件＝同一字段＋同一 refFrom＋**同一个来源任务对象**（来源任务没变，note/target 就不会变）；
  // · conflictPartners：伙伴的值真变了（对方被改过）才换新数组，否则沿用旧引用。
  const partnersCache = useRef(new Map<string, ExtractedField[]>());
  const refCache = useRef(new Map<string, { src: VisitTask | undefined; rfTask: string; rfField: string; note: string | null; target: { kind: "evidence" | "task" | "none"; path: string } }>());
  const cardData = useMemo(() => {
    const note = new Map<string, string | null>();
    const target = new Map<string, { kind: "evidence" | "task" | "none"; path: string }>();
    const partners = new Map<string, ExtractedField[]>();
    for (const field of task.fields) {
      const rf = field.refFrom;
      const src = rf ? allState.tasks.find((t) => t.id === rf.taskId) : undefined;
      const hit = refCache.current.get(field.id);
      // 命中条件：同一字段＋refFrom 指向同一处＋**同一个来源任务对象**。来源任务没变 ⇒ note/target 不会变
      // （refFrom 用值比而不是引用比：reducer 重建字段时 refFrom 对象会换，但指向没变就不该算变）。
      if (hit && hit.src === src && hit.rfTask === (rf?.taskId ?? "") && hit.rfField === (rf?.fieldId ?? "")) {
        note.set(field.id, hit.note);
        target.set(field.id, hit.target);
      } else {
        const n = carriedRefNote(allState.tasks, field.refFrom);
        const t2 = carriedRefTarget(allState.tasks, field.refFrom);
        refCache.current.set(field.id, { src, rfTask: rf?.taskId ?? "", rfField: rf?.fieldId ?? "", note: n, target: t2 });
        note.set(field.id, n);
        target.set(field.id, t2);
      }
      if (field.conflictWith?.length) {
        const resolved = field.conflictWith
          .map((id) => task.fields.find((o) => o.id === id))
          .filter((o): o is ExtractedField => Boolean(o));
        const prev = partnersCache.current.get(field.id);
        partners.set(
          field.id,
          prev && prev.length === resolved.length && prev.every((p, i) => p === resolved[i]) ? prev : resolved,
        );
      }
    }
    partnersCache.current = partners;
    return { note, target, partners };
  }, [task.fields, allState.tasks]);
  const jumpTimer = useRef<number | undefined>(undefined);
  /** R112：归纳行上的「跳到这一条」——存在性检查同时充当 querySelector 选择符的安全闸（与上面 focusFieldId 同一口径） */
  const jumpTo = (id: string) => {
    if (!task.fields.some((f) => f.id === id)) return;
    setFocusedId(id);
    const el = document.querySelector<HTMLElement>(`[data-field-id="${id}"]`);
    el?.scrollIntoView({ block: "center" });
    el?.focus({ preventScroll: true });
    window.clearTimeout(jumpTimer.current);
    jumpTimer.current = window.setTimeout(() => setFocusedId(null), 2400);
  };
  return (
    <TaskShell task={task} tab="review">
      <section className="rounded-lg border bg-card p-4 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p>
            已确认 <strong>{eligible}</strong>/{task.fields.length} 项
            {pendingHigh > 0 && (
              <span className="ml-2 font-medium text-destructive">还有 {pendingHigh} 个高风险字段未确认，不会进入交接单</span>
            )}
            {staleFields.length > 0 && (
              <span role="status" className="ml-2 font-medium text-destructive">
                {SOURCE_GONE_NOTICE}（{staleFields.length} 条）
                <button
                  type="button"
                  className="ml-2 underline underline-offset-2"
                  onClick={() => {
                    dispatch({
                      type: "field.dropSourceGone",
                      taskId: task.id,
                      dropIds: staleFields.map((f) => f.id),
                    });
                    dispatch({
                      type: "audit.push",
                      taskId: task.id,
                      audit: makeAudit("field.drop", `清掉 ${staleFields.length} 条来源资料已删除的字段`),
                    });
                  }}
                >
                  把这些清掉
                </button>
              </span>
            )}
          </p>
          {/* HE-05 术语统一：「已确认」=核对进度口径，与任务头部「可入单」（入单门槛口径）是两个概念，
              数字通常一致（高风险字段的证据被删后会分叉），在此明示定义，不让用户自行推断 */}
          <p className="mt-1 text-xs text-muted-foreground">
            「已确认」是核对进度；能进入交接单的字段还要过入单门槛（高风险字段需有原文证据），门槛数以任务头部「可入单」徽章为准。
          </p>
          <div className="flex gap-2">
            {pendingCount > 0 && (
              <Button
                size="sm"
                variant={effectiveOnlyPending ? "default" : "outline"}
                aria-label="切换只看待确认项"
                onClick={() => setOnlyPending((v) => !v)}
              >
                {effectiveOnlyPending ? "显示全部字段" : `只看待确认项（${pendingCount}）`}
              </Button>
            )}
            <AddManualField task={task} />
          </div>
        </div>
        {/* R96：整页那一句只报**数得出的条数**——它是逐条判定汇出来的，不是"本次识别都是假的"那种全局承诺（R84 范围纪律） */}
        {syntheticNoticeCount(shownFields) > 0 && (
          <p role="status" className="mt-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
            {syntheticNoticeSummary(syntheticNoticeCount(shownFields))}
          </p>
        )}
      </section>

      {task.fields.length === 0 && (
        <section className="rounded-lg border border-dashed bg-card p-6 text-center text-sm">
          <p className="font-medium">还没有提取到任何信息</p>
          <p className="mt-1 text-muted-foreground">
            上传就诊资料后，识别出的字段会逐项出现在这里核对；也可以直接手工补充你知道的情况。
          </p>
          <div className="mt-3 flex justify-center gap-2">
            <Button size="sm" onClick={() => navigate(`/t/${task.id}/docs`)}>
              去上传资料
            </Button>
          </div>
        </section>
      )}

      <ItemLedger task={task} fields={shownFields} onJump={jumpTo} />

      {GROUP_ORDER.map((group) => {
        const fields = shownFields.filter((f) => f.group === group);
        if (!fields.length) return null;
        return (
          <section key={group} aria-labelledby={`grp-${group}`}>
            <h2 id={`grp-${group}`} className="mb-2 mt-5 font-semibold">
              {GROUP_TITLES[group]}
            </h2>
            <ul className="space-y-3">
              {fields.map((f) => (
                <FieldCard
                  key={f.id}
                  field={f}
                  focused={focusedId === f.id}
                  taskId={task.id}
                  refNote={cardData.note.get(f.id) ?? null}
                  refTarget={cardData.target.get(f.id) ?? { kind: "none", path: "" }}
                  conflictPartners={cardData.partners.get(f.id) ?? NO_PARTNERS}
                  syncable={isSyncable(task)}
                  dispatch={dispatch}
                />
              ))}
            </ul>
          </section>
        );
      })}

      <section aria-labelledby="grp-questions">
        <h2 id="grp-questions" className="mb-2 mt-5 font-semibold">
          待向医生提问
        </h2>
        <ul className="space-y-2">
          {task.questions.map((item) => (
            <li key={item.id} className="flex items-start justify-between gap-2 rounded-lg border bg-card p-3 text-sm">
              <span>{item.text}</span>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`删除问题：${item.text}`}
                onClick={() => dispatch({ type: "question.delete", taskId: task.id, questionId: item.id })}
              >
                删除
              </Button>
            </li>
          ))}
        </ul>
        <form
          className="mt-2 space-y-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (!q.trim()) {
              setQEmpty(true);
              document.getElementById("question-new")?.focus();
              return;
            }
            setQEmpty(false);
            dispatch({ type: "question.add", taskId: task.id, question: { id: uid("q-"), text: q.trim() } });
            setQ("");
          }}
        >
          <div className="flex gap-2">
            <Input
              id="question-new"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="例如：夜间憋醒是否需要进一步检查？"
              aria-label="新增问题"
              aria-invalid={qEmpty || undefined}
              aria-describedby={qEmpty ? "question-required" : undefined}
            />
            <Button type="submit">
              添加
            </Button>
          </div>
          {qEmpty && (
            <p id="question-required" role="status" className="text-sm text-destructive">
              {requiredNotice("questionText")}
            </p>
          )}
          <OverLimitHint field="questionText" value={q} task={task} />
        </form>
      </section>
    </TaskShell>
  );
}
