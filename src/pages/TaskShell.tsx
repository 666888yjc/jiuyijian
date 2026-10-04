import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { navigate } from "../router";
import { eligibleForSheet } from "../sheet";
import { isSyncable, useSync } from "../sync";
import { overLimitFields, overLimitWhere, payloadOversizeNotice, payloadOversizeTail } from "../fieldLimits";
import { payloadOf } from "../syncMerge";
import { ConflictPicker } from "./ConflictPicker";
import type { VisitTask } from "../types";

export const TABS = [
  { key: "docs", label: "1 资料上传" },
  { key: "review", label: "2 信息核对" },
  { key: "sheet", label: "3 交接单" },
  { key: "actions", label: "4 行动清单" },
  { key: "summary", label: "5 复诊摘要" },
] as const;

export function TaskShell({
  task,
  tab,
  children,
}: {
  task: VisitTask;
  tab: (typeof TABS)[number]["key"];
  children: ReactNode;
}) {
  // HE-05：变量名与徽章术语对齐——这是入单门槛口径（eligibleForSheet），不是核对页的「已确认」进度口径
  const eligibleCount = task.fields.filter(eligibleForSheet).length;
  // R75：只有"这条任务本该存在服务器上"时才说"存不上"——本机模式下压根没有在往服务器写，
  // 拿云端的话在本机模式下说话是 R68 那条纪律禁止的（同一句话在两种留存位置下含义不同）。
  const sync = useSync();
  const pushable = sync.serverMode && sync.signedIn && isSyncable(task);
  const payload = payloadOf(task);
  const over = pushable ? overLimitFields(payload).map((o) => ({ ...o, where: overLimitWhere(o.at) })) : [];
  // R76：整份合计超过服务端那一兆时，一栏一栏看全都是合规的——所以这两件事**分开说**，
  // 不许在"没有哪一栏超长"时保持沉默（那正是 413 的那一种）。判据与页头那句同出一处。
  // R83：这道口现在管两件事（合计字节、操作记录条数）——"整份存不上"那一句只在 `payloadOversizeNotice` 一处排序。
  const oversize = pushable && !over.length ? payloadOversizeNotice(payload) : "";
  // R83：补充说明要跟着**是哪道门**变——条数那道门上说"那个合计"是指一个屏幕上根本不存在的数字。
  const oversizeTail = oversize ? payloadOversizeTail(payload) : "";
  return (
    <div className="space-y-4">
      <div className="no-print flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <button
            type="button"
            className="text-sm text-muted-foreground underline-offset-2 hover:underline"
            onClick={() => navigate("/")}
          >
            ← 返回任务列表
          </button>
          {/* 大字号下不得截断任务目的：截了就等于把「评估胸闷加重原因」这类关键信息藏起来 */}
          <h1 className="text-lg font-semibold break-words">{task.purpose || "（未命名任务）"}</h1>
          <p className="text-sm text-muted-foreground">
            {task.patientLabel} · {task.dept || "科室未填"} · 拟就诊 {task.visitDate || "未定"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" title="已确认且满足入单门槛的字段数；高风险字段还需有原文证据">
            可入单 {eligibleCount}/{task.fields.length} 项
          </Badge>
          <button
            type="button"
            className="text-sm text-primary underline underline-offset-2"
            onClick={() => navigate(`/t/${task.id}/edit`)}
          >
            编辑任务
          </button>
        </div>
      </div>
      {/*
        R97：这条任务本机与服务器各有一份 ⇒ 就地给出"并排看两份、挑一份"的处置入口。
        放任务页而不是页头，是因为处置对象是**这一条**；页头那句只说"有这么几条"（R84 指认到哪一条那条纪律）。
      */}
      {(sync.conflictTaskIds.includes(task.id) || sync.justResolved?.id === task.id) && <ConflictPicker task={task} />}
      {/*
        R75：这份任务里有服务器收不下的长度 ⇒ 就地列出是哪一栏、超了多少、去哪一栏删。
        页头那句「存不上：内容超出服务器上限」不带细节，而超长内容可以藏在任何一页——只靠页头，家属找不到要改哪里，
        而写短之前每一条改动都推不出去（不是丢一次，是从此存不上）。
      */}
      {over.length > 0 && (
        <div role="status" className="no-print rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          <p className="font-medium">这条任务暂时存不上，因为下面这些栏超出服务器可存的长度：</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {over.map((o) => (
              <li key={o.at}>
                「{o.label}」现在 {o.bytes} 字节，最多 {o.limit} 字节 —— 去{o.where}删短一些
              </li>
            ))}
          </ul>
          <p className="mt-1">长度按 UTF-8 字节算（一个汉字占 3 字节、表情符号 4 字节）；删短之后会自动重新保存，本机上这些内容现在照旧可以看、可以改。</p>
        </div>
      )}
      {oversize && (
        <div role="status" className="no-print rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          <p className="font-medium">这条任务暂时存不上：{oversize}。</p>
          <p className="mt-1">{oversizeTail}</p>
        </div>
      )}
      <nav
        aria-label="整理步骤"
        className="no-print scrollbar-thin flex gap-1 overflow-x-auto rounded-lg border bg-card p-1"
      >
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            aria-current={tab === t.key ? "step" : undefined}
            className={
              "flex-1 whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium " +
              (tab === t.key
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent")
            }
            onClick={() => navigate(`/t/${task.id}/${t.key}`)}
          >
            {t.label}
          </button>
        ))}
      </nav>
      {children}
    </div>
  );
}
