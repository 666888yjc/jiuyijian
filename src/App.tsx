import { lazy, Suspense, useEffect, useState } from "react";
import { StoreProvider, useStore, useTask } from "./store";
import { WRITER_LOCK_BLOCKED, WRITER_LOCK_NOTICE } from "./writerLease";
import { SyncProvider, useSync, type SyncState } from "./sync";
import { navigate, useHashPath } from "./router";
import { splitHashPath } from "./hashQuery";
import { BOUNDARY_NOTICES } from "./redLine";
import { CONFLICT_LABEL, syncConflictNotice } from "./storageNotice";
import type { VisitTask } from "./types";

// PERF-1：路由级懒加载——首屏只下载外壳与任务列表，其余页面按路由按需拉取。
// 约束：TaskListPage 导出三个组件，lazy 需逐个包 default；共享模块（store/sync/router）保持静态。
const TaskListPage = lazy(() => import("./pages/TaskListPage").then((m) => ({ default: m.TaskListPage })));
const NewTaskPage = lazy(() => import("./pages/TaskListPage").then((m) => ({ default: m.NewTaskPage })));
const TaskEditPage = lazy(() => import("./pages/TaskListPage").then((m) => ({ default: m.TaskEditPage })));
const DocsPage = lazy(() => import("./pages/DocsPage").then((m) => ({ default: m.DocsPage })));
const ReviewPage = lazy(() => import("./pages/ReviewPage").then((m) => ({ default: m.ReviewPage })));
const EvidencePage = lazy(() => import("./pages/EvidencePage").then((m) => ({ default: m.EvidencePage })));
const SheetEditorPage = lazy(() => import("./pages/SheetPages").then((m) => ({ default: m.SheetEditorPage })));
const SheetPrintPage = lazy(() => import("./pages/SheetPages").then((m) => ({ default: m.SheetPrintPage })));
const ActionsPage = lazy(() => import("./pages/ActionsPage").then((m) => ({ default: m.ActionsPage })));
const SummaryPage = lazy(() => import("./pages/SummaryPage").then((m) => ({ default: m.SummaryPage })));
const PrivacyPage = lazy(() => import("./pages/PrivacyPage").then((m) => ({ default: m.PrivacyPage })));

function RouteFallback() {
  return (
    <div role="status" aria-busy="true" className="flex min-h-[40vh] items-center justify-center text-sm text-muted-foreground">
      加载中…
    </div>
  );
}

const FS_KEY = "jiuyijian-fs";
const FS_OPTIONS = [
  { value: "", label: "标准字号" },
  { value: "lg", label: "大字号" },
  { value: "xl", label: "特大字号" },
] as const;

function FontSizeToggle() {
  const [fs, setFs] = useState<string>(() => localStorage.getItem(FS_KEY) ?? "");
  useEffect(() => {
    document.documentElement.dataset.fs = fs || "";
    localStorage.setItem(FS_KEY, fs);
  }, [fs]);
  return (
    <div role="group" aria-label="字号" className="flex items-center gap-0.5 rounded-full border bg-card p-0.5">
      {FS_OPTIONS.map((o) => (
        <button
          key={o.value || "md"}
          type="button"
          aria-pressed={fs === o.value}
          aria-label={o.label}
          title={o.label}
          className={
            "rounded-full px-2 leading-6 " +
            (o.value === "" ? "text-xs" : o.value === "lg" ? "text-sm" : "text-base") +
            (fs === o.value ? " bg-primary text-primary-foreground" : " text-muted-foreground hover:bg-accent")
          }
          onClick={() => setFs(o.value)}
        >
          A
        </button>
      ))}
    </div>
  );
}

// 路由是 hash 制（src/router.ts），任何 href="#x" 都会把站点带回任务列表，所以跳转用 focus 而非锚点。
function SkipLink() {
  return (
    <button
      type="button"
      className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:border focus:bg-card focus:px-3 focus:py-2 focus:text-sm focus:shadow-md"
      onClick={() => document.getElementById("jyj-main")?.focus()}
    >
      跳到主要内容
    </button>
  );
}

function NotFound() {
  return (
    <div className="rounded-lg border bg-card p-6 text-center">
      <p className="font-medium">页面不存在</p>
      <button type="button" className="mt-2 text-primary underline" onClick={() => navigate("/")}>
        返回任务列表
      </button>
    </div>
  );
}

function TaskRoute({
  taskId,
  tab,
}: {
  taskId: string;
  tab: (task: VisitTask) => React.ReactNode;
}) {
  const task = useTask(taskId);
  if (!task) return <NotFound />;
  return <>{tab(task)}</>;
}

/**
 * 每个同步状态都必须有中文标签（A3 无障碍闸门前两条：不许只剩颜色、不许新增状态没有标签）。
 * 写成 exhaustive Record 是为了让 TS 兜住"加了第 6 个状态、标签没跟上"这种事——
 * 上一次这类缺陷的实际后果是页头出现 `undefined`。
 */
const SYNC_STATE_LABEL: Record<SyncState, string> = {
  idle: "云端模式",
  saving: "云端保存中…",
  saved: "已同步",
  error: "云端保存失败",
  offline: "本地模式（未连接服务）",
  // R74：两边各有一份、都动过 ⇒ 既不推也不盖。这一句必须盖住「已同步」，否则界面就在说假话。
  // R84：标签与任务列表卡片上的标位共用 storageNotice 里那一个串（同一件事两处各写一遍，早晚不一致）
  conflict: CONFLICT_LABEL,
  // R75：不是云端坏了，是这一栏的长度它收不下——写「云端保存失败」会让人一直点重试。
  // R76：同一档还管「整条任务合计超过服务端一次能收的 1MB」（实测 6 份资料就到）——
  // 所以这句话不许只说"一栏"，理由在哪一处由页顶那段与 `payloadBlockReason` 那句给出。
  rejected: "存不上：内容超出服务器上限",
};

function SyncChip() {
  const sync = useSync();
  if (sync.user === "checking") return <span className="text-xs text-muted-foreground">检查登录…</span>;
  if (!sync.signedIn) {
    // 分两种"未登录"：云端可达但没登录（给登录入口），以及 me() 根本没答话（网络/服务不可达）。
    // 后者继续挂着一个指向 /__qoder_auth/start 的链接＝死路：点下去会离开应用掉进浏览器错误页，
    // 而家属此刻真正要做的是"先离线把资料整完，回头再连"。所以这里换成"重试连接"（只重跑 me()，不跳走）。
    if (sync.syncState === "offline") {
      return (
        <span className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={sync.reload}
            title="云端当前不可达，暂时打不开登录页；本机数据不会上传，恢复后点这里重新检查"
            className="rounded-full border px-2.5 py-1 text-xs text-primary hover:bg-accent"
          >
            重试连接
          </button>
          <span
            className="text-xs text-muted-foreground"
            title="登录状态检查失败：云端暂不可用，当前按本地模式使用，数据不会上传"
          >
            云端暂不可用
          </span>
        </span>
      );
    }
    return (
      <span className="flex items-center gap-1.5">
        <a
          href="/__qoder_auth/start?return_path=%2F"
          title="未登录时数据仅保存本设备；登录后可同步到你的账号"
          className="rounded-full border px-2.5 py-1 text-xs text-primary hover:bg-accent"
        >
          登录并同步
        </a>
      </span>
    );
  }
  const who = sync.user?.name || sync.user?.id || "";
  const withWho = sync.syncState === "idle" || sync.syncState === "saved";
  const label = SYNC_STATE_LABEL[sync.syncState] + (withWho && who ? ` · ${who}` : "");
  const alarming = sync.syncState === "error" || sync.syncState === "conflict" || sync.syncState === "rejected";
  // R84：冲突那句解释从 title 里搬走了（R81 实测：手机没有 hover，那句长在悬停里就等于不存在）。
  // rejected 仍把 lastError 放在悬停里——那一档的可见解释由页顶那段给出，两处不重复同一句话。
  const tip = sync.syncState === "rejected" ? sync.lastError : "";
  return (
    <span
      className="flex items-center gap-1 text-xs text-muted-foreground"
      title={tip || undefined}
    >
      {alarming && <span role="alert" className="text-destructive">{label}</span>}
      {!alarming && label}
      {sync.syncState === "error" && (
        <button type="button" className="text-primary underline" onClick={sync.retry}>重试</button>
      )}
    </span>
  );
}

function SyncConflictBanner() {
  const sync = useSync();
  if (!sync.signedIn || sync.syncState !== "conflict") return null;
  return (
    <div className="no-print mx-auto max-w-4xl px-4 pt-3">
      <p role="status" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
        {syncConflictNotice(sync.conflictTaskIds.length)}
      </p>
    </div>
  );
}

/**
 * R136（known-issues ⑳ 的③路）：这台设备上另有一个页面持有写权限 ⇒ 这一页只读，必须**当场说出来**。
 * 两条纪律一起才成立：① 只读不许靠"点了没反应"（R72／R105／R106 那一族），所以被拦下时要补那半句；
 * ② 这句话不许替别人表态——只说"另一个页面正在核对"与"要改回那一个页面"，不说那边存没存好、也不猜是谁开的。
 */
function WriterLockBanner() {
  const { readOnly, blockedEdits } = useStore();
  if (!readOnly) return null;
  return (
    <div className="no-print mx-auto max-w-4xl px-4 pt-3">
      <p role="status" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
        {WRITER_LOCK_NOTICE}
        {blockedEdits > 0 ? `　${WRITER_LOCK_BLOCKED}` : ""}
      </p>
    </div>
  );
}

function Routes() {
  const path = useHashPath();
  // HE-09：查询串（?field=）与路径分离后再匹配路由，否则 parts[2] 会带上查询串落进 NotFound
  const { pathname, query } = splitHashPath(path);
  const parts = pathname.split("/").filter(Boolean);

  if (pathname === "/") return <TaskListPage />;
  if (pathname === "/new") return <NewTaskPage />;
  if (pathname === "/privacy") return <PrivacyPage />;
  if (parts[0] === "evidence") return <EvidencePage />;
  if (parts[0] === "t" && parts[1]) {
    const id = parts[1];
    switch (parts[2]) {
      case "docs":
        return <TaskRoute taskId={id} tab={(t) => <DocsPage task={t} />} />;
      case "review":
        return (
          <TaskRoute
            taskId={id}
            tab={(t) => <ReviewPage task={t} focusFieldId={query.get("field")} />}
          />
        );
      case "sheet":
        return <TaskRoute taskId={id} tab={(t) => <SheetEditorPage task={t} />} />;
      case "print":
        return <TaskRoute taskId={id} tab={(t) => <SheetPrintPage task={t} />} />;
      case "actions":
        return <TaskRoute taskId={id} tab={(t) => <ActionsPage task={t} />} />;
      case "summary":
        return <TaskRoute taskId={id} tab={(t) => <SummaryPage task={t} />} />;
      case "edit":
        return <TaskRoute taskId={id} tab={(t) => <TaskEditPage task={t} />} />;
      default:
        return <NotFound />;
    }
  }
  return <NotFound />;
}

export default function App() {
  return (
    <StoreProvider>
      <SyncProvider>
        <div className="min-h-dvh">
          <SkipLink />
          <header className="no-print sticky top-0 z-10 border-b bg-background/95 backdrop-blur">
            <div className="mx-auto flex max-w-4xl items-center justify-between gap-3 px-4 py-3">
              <button
                type="button"
                className="flex items-baseline gap-2"
                onClick={() => navigate("/")}
              >
                <span className="text-lg font-bold text-primary">就医笺</span>
                <span className="hidden text-xs text-muted-foreground sm:inline">
                  就诊资料整理与交接单
                </span>
              </button>
              <div className="flex min-w-0 items-center gap-2">
                <SyncChip />
                <button
                  type="button"
                  className="hidden text-sm text-muted-foreground underline-offset-4 hover:underline sm:inline"
                  onClick={() => navigate("/privacy")}
                >
                  隐私与数据
                </button>
                <FontSizeToggle />
              </div>
            </div>
          </header>
          <SyncConflictBanner />
          <WriterLockBanner />
          <main id="jyj-main" tabIndex={-1} className="mx-auto max-w-4xl px-4 py-6 pb-16">
            <Suspense fallback={<RouteFallback />}>
              <Routes />
            </Suspense>
          </main>
          <footer className="no-print border-t py-4 text-center text-xs text-muted-foreground">
            {BOUNDARY_NOTICES.footer}
            {/* 内网测试入口（http + 内网 IP）不是安全上下文：离线壳注册不了、剪贴板不可用，而且和线上长得一模一样。
                2026-09-28 就因为"说不清对方打开的是哪一份"误诊过一次，所以这种来源下把入口文件名直接说出来；线上是 https，这一格不出现。 */}
            {!window.isSecureContext && <BuildStamp />}
          </footer>
        </div>
      </SyncProvider>
    </StoreProvider>
  );
}

/** 只在非安全上下文（内网 http 测试入口）出现的构建标记：从页面真正加载的那个 script 上读，不靠构建期注入常量 */
function BuildStamp() {
  const src = document.querySelector('script[src*="/assets/"]')?.getAttribute("src") ?? "";
  const file = src.split("/").pop() || "未知";
  return (
    <p className="mt-1 break-all" data-build-stamp={file}>
      测试入口（非 https：离线壳与剪贴板受限）· 构建 {file}
    </p>
  );
}
