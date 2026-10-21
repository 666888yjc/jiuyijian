import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import type { ExtractedField, SourceDocument, SourcePage, VisitTask } from "./types";
import { navigate } from "./router";
import { isSyncable, useSignedFileUrl, useSync } from "./sync";
import { evidenceAffordance } from "./sheet";
import { overLimitHint, type FieldKey } from "./fieldLimits";
import {
  WHOLE_FILE_LINK_HINT,
  WHOLE_FILE_LINK_LABEL,
  WHOLE_FILE_PAGE_CAP,
  wholeFilePagesNotice,
  wholeFileRenderFailureNotice,
  wholeFileUnavailableNotice,
  type DocOriginalAffordance,
  type DocOriginalInput,
  type WholeFileRenderCause,
} from "./docOriginal";
import { isPdfAssetUnreachable } from "./pdfErrors";
import type { PdfDocumentHandle } from "./pdf";

/** 服务端 PDF 原件的按需渲染（签名URL→pdf.js→canvas） */
function PdfPageThumb({ doc, pageNo }: { doc: SourceDocument; pageNo: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "failed">("idle");
  const { url, failed } = useSignedFileUrl(doc.id, doc.mime === "application/pdf");
  useEffect(() => {
    if (!url || failed || state !== "idle") return;
    setState("loading");
    void (async () => {
      try {
        const { loadPdfBytes, renderPdfPageToCanvas } = await import("./pdf");
        const buf = await loadPdfBytes(doc.id, url);
        if (canvasRef.current) {
          await renderPdfPageToCanvas(canvasRef.current, buf, pageNo);
          setState("ready");
        } else setState("failed");
      } catch {
        setState("failed");
      }
    })();
  }, [url, failed, state, doc.id, pageNo]);
  return (
    <div className="mb-3">
      <canvas
        ref={canvasRef}
        className={`w-full rounded border bg-muted ${state === "ready" ? "" : "hidden"}`}
        aria-label={`${doc.name} 第${pageNo}页原件`}
      />
      {state === "loading" && <p className="text-sm text-muted-foreground">正在载入原件第 {pageNo} 页…</p>}
      {state === "failed" && <p className="text-sm text-muted-foreground">原件页渲染失败，可稍后重试或下载查看。</p>}
    </div>
  );
}

export const DOC_TYPE_LABELS: Record<SourceDocument["docType"], string> = {
  outpatient: "门诊记录",
  prescription: "处方",
  report: "检查/检验报告",
  inpatient: "住院资料",
  unknown: "待分类",
};

export const CONF_LABELS: Record<ExtractedField["confirmStatus"], string> = {
  pending: "待确认",
  confirmed: "已确认",
  corrected: "已修改",
  uncertain: "不确定",
};

export function ConfirmBadge({ status }: { status: ExtractedField["confirmStatus"] }) {
  const variant =
    status === "confirmed" || status === "corrected"
      ? "default"
      : status === "uncertain"
        ? "secondary"
        : "outline";
  return (
    <Badge variant={variant} className="shrink-0">
      {CONF_LABELS[status]}
    </Badge>
  );
}

export function ConfidenceBadge({ level }: { level: ExtractedField["confidence"] }) {
  const text = { high: "识别度高", medium: "识别度中", low: "识别度低", failed: "未能识别" }[level];
  return (
    <Badge variant={level === "low" || level === "failed" ? "destructive" : "outline"} className="shrink-0">
      {text}
    </Badge>
  );
}

export function OriginBadge({ field }: { field: ExtractedField }) {
  if (field.source === "user")
    return <Badge variant="outline" className="shrink-0 border-green-700 text-green-800">用户补充</Badge>;
  return <Badge variant="outline" className="shrink-0">原文提取</Badge>;
}

export function HighRiskBadge() {
  return (
    <Badge variant="destructive" className="shrink-0">
      高风险·须确认
    </Badge>
  );
}

/** M1：以「转写文本」模拟扫描页；服务端模式下按需申请原件签名地址 */
export function PageView({
  doc,
  page,
  highlight,
}: {
  doc: SourceDocument;
  page: SourcePage;
  highlight?: string[];
}) {
  const serverImage = Boolean(doc.objectPath) && page.kind === "image";
  const { url, failed } = useSignedFileUrl(doc.id, serverImage);
  const src = page.imageDataUrl ?? (serverImage && !failed ? url : null);
  return (
    <div className="rounded-md border bg-white p-4">
      <div className="mb-2 text-xs text-muted-foreground">
        {doc.name} · 第 {page.pageNo} 页
      </div>
      {src ? (
        <img
          src={src}
          alt={`${doc.name} 第${page.pageNo}页原件`}
          className="mb-3 max-h-72 w-full rounded border object-contain bg-muted"
        />
      ) : null}
      {!src && doc.objectPath && page.kind === "pdf" && <PdfPageThumb doc={doc} pageNo={page.pageNo} />}
      {serverImage && failed && (
        <p className="mb-2 text-sm text-muted-foreground">原件暂时无法载入，可稍后从资料页重新打开。</p>
      )}
      {page.empty ? (
        <p className="text-sm text-muted-foreground">此页为空白页（未检测到内容，未静默丢弃）。</p>
      ) : page.blocks.length === 0 && !page.empty ? null : (
        <ul className="space-y-1.5 font-mono text-sm leading-relaxed">
          {page.blocks.map((b) => (
            <li
              key={b.id}
              className={highlight?.includes(b.id) ? "evidence-hit px-1" : "px-1"}
            >
              {b.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * 整份原件查看器（R109）：`objectNoPages` 那一档的入口背后。
 *
 * 这一档的原件在站点存储里、本机却一页都没记下 ⇒ 展开不能按本机页码去取（R103 实测那样是 0 个子节点），
 * 而是**取回原件本身、页数由原件给出**。三条写死的纪律：
 *  ① 地址只在**按下展开之后**取一枚，且只走 `src/fileUrlCache.ts` 那一个出口（R78）；
 *  ② 这枚地址是会过期的凭据：只进 `src`/`href` 这两个 DOM 属性，不落任何本机存储、不进日志；
 *  ③ 取不回、画不出、画了多少页是三件事，各说各的句子（措辞全在 `src/docOriginal.ts`，这里只挑）。
 */
export function WholeOriginalViewer({ doc, orig, input }: { doc: SourceDocument; orig: DocOriginalAffordance; input: DocOriginalInput }) {
  const [open, setOpen] = useState(false);
  const { url, failed } = useSignedFileUrl(doc.id, open);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "unavailable" | "render-failed">("idle");
  const [cause, setCause] = useState<WholeFileRenderCause>("pdf-unopenable");
  const [pages, setPages] = useState<{ total: number; shown: number } | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  // 画过了就不再重画：合上再展开不该重新问一次地址、重新下载、重新画二十页（真浏览器实测到旧写法会）
  const drawnRef = useRef(false);
  const isImage = /image\//.test(doc.mime || "");

  useEffect(() => {
    if (isImage || !open || !url || failed || drawnRef.current) return;
    const box = bodyRef.current;
    if (!box) return;
    let cancelled = false;
    box.replaceChildren();
    setPages(null);
    setState("loading");
    void (async () => {
      let handle: PdfDocumentHandle | null = null;
      try {
        const mod = await import("./pdf");
        let bytes: ArrayBuffer;
        try {
          bytes = await mod.loadPdfBytes(doc.id, url);
        } catch {
          // 地址拿到了、字节取不回：这仍属于"这一次没取回原件"，不是"这份资料没有原件"
          if (!cancelled) setState("unavailable");
          return;
        }
        try {
          // `loadPdfBytes` 交出来的已经是副本（pdf.js 会把传进去的 buffer 移交工作线程，那份缓存不能被他抽走）
          handle = await mod.openPdf(bytes);
        } catch (error) {
          if (!cancelled) {
            setCause(isPdfAssetUnreachable(error) ? "asset" : "pdf-unopenable");
            setState("render-failed");
          }
          return;
        }
        const shown = Math.min(handle.numPages, WHOLE_FILE_PAGE_CAP);
        if (!cancelled) setPages({ total: handle.numPages, shown });
        for (let pageNo = 1; pageNo <= shown; pageNo++) {
          if (cancelled) break;
          const canvas = document.createElement("canvas");
          canvas.className = "w-full rounded border bg-muted";
          canvas.setAttribute("aria-label", `${doc.name} 整份原件第 ${pageNo} 页`);
          box.appendChild(canvas);
          await handle.renderPageTo(canvas, pageNo);
        }
        if (!cancelled) {
          drawnRef.current = true;
          setState("ready");
        }
      } catch (error) {
        if (!cancelled) {
          setCause(isPdfAssetUnreachable(error) ? "asset" : "pdf-unopenable");
          setState("render-failed");
        }
      } finally {
        await handle?.destroy();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isImage, open, url, failed, doc.id]);

  return (
    <details className="mt-3" onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary className="cursor-pointer text-sm text-primary">{orig.label}</summary>
      <div className="mt-2 space-y-2">
        <p className="text-xs text-muted-foreground">{orig.note}</p>
        {(failed || state === "unavailable") && (
          <p role="status" className="text-sm text-muted-foreground">{wholeFileUnavailableNotice(input)}</p>
        )}
        {!failed && !url && <p role="status" className="text-sm text-muted-foreground">正在取回原件…</p>}
        {url && isImage && (
          <img
            src={url}
            alt={`${doc.name} 整份原件`}
            className="max-h-[70vh] w-full rounded border bg-muted object-contain"
            onError={() => { setCause("image-undisplayable"); setState("render-failed"); }}
          />
        )}
        {url && !isImage && state === "loading" && (
          <p role="status" className="text-sm text-muted-foreground">正在取回原件并逐页渲染…首次打开需要加载渲染组件，请稍候。</p>
        )}
        {/* canvas 由上面那段渲染循环按原件自己的页数挂进来：React 侧不需要先知道有几页 */}
        <div ref={bodyRef} className="space-y-2" />
        {pages && state !== "render-failed" && (
          <p role="status" className="text-xs text-muted-foreground">{wholeFilePagesNotice(pages.total, pages.shown)}</p>
        )}
        {state === "render-failed" && <p role="status" className="text-sm text-muted-foreground">{wholeFileRenderFailureNotice(cause)}</p>}
        {url && !failed && (
          <p className="text-xs text-muted-foreground">
            <a href={url} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2">
              {WHOLE_FILE_LINK_LABEL}
            </a>
            {WHOLE_FILE_LINK_HINT}
          </p>
        )}
      </div>
    </details>
  );
}

/**
 * 资料行展开后的那一片页面（R110）：整份共用**一枚**签名地址，PDF 页面共用**一个** pdf.js 文档，而且**按下才取**。
 *
 * 为什么不是以前那样每页挂一个 `<PageView>`：`<details>` 的子节点**收起时也在 DOM 里**，
 * 于是"资料列表一渲染"就按页各取一次原件——实测一份 14 页的资料是 14 发下载＋14 次整份解析
 * （`docs/known-issues.md` ⑭）。这一支把两件事一起收口：按下展开才发请求，以及开一次文档逐页画。
 * 单页的证据页（`EvidencePage`）仍用 `PageView`——那里本来就只有一页，且是用户直接走到那一页的。
 */
export function ExpandedDocPages({ doc, pages, label }: { doc: SourceDocument; pages: SourcePage[]; label: string }) {
  const [open, setOpen] = useState(false);
  const pdfPages = useMemo(
    () => (doc.objectPath ? pages.filter((p) => p.kind === "pdf").map((p) => p.pageNo) : []),
    [doc.objectPath, pages],
  );
  const serverImageCount = useMemo(
    () => (doc.objectPath ? pages.filter((p) => p.kind === "image" && !p.imageDataUrl).length : 0),
    [doc.objectPath, pages],
  );
  const { url, failed } = useSignedFileUrl(doc.id, open && (pdfPages.length > 0 || serverImageCount > 0));
  const [state, setState] = useState<"idle" | "loading" | "done" | "failed">("idle");
  const [failedPages, setFailedPages] = useState<number[]>([]);
  const canvases = useRef<Map<number, HTMLCanvasElement>>(new Map());
  const drawnRef = useRef(false);

  useEffect(() => {
    if (!open || pdfPages.length === 0 || !url || failed || drawnRef.current) return;
    let cancelled = false;
    setState("loading");
    void (async () => {
      let handle: PdfDocumentHandle | null = null;
      try {
        const mod = await import("./pdf");
        const bytes = await mod.loadPdfBytes(doc.id, url);
        handle = await mod.openPdf(bytes);
        const bad: number[] = [];
        for (const pageNo of pdfPages) {
          if (cancelled) return;
          const canvas = canvases.current.get(pageNo);
          if (!canvas) {
            bad.push(pageNo);
            continue;
          }
          try {
            await handle.renderPageTo(canvas, pageNo);
          } catch {
            bad.push(pageNo);
          }
        }
        drawnRef.current = true;
        setFailedPages(bad);
        setState("done");
      } catch {
        if (!cancelled) {
          setFailedPages(pdfPages);
          setState("failed");
        }
      } finally {
        await handle?.destroy();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, url, failed, doc.id, pdfPages]);

  return (
    <details className="mt-3" onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary className="cursor-pointer text-sm text-primary">{label}</summary>
      <div className="mt-2 space-y-2">
        {/* 地址取不到这一句仍是"这一次没拿到"，不是"原件没了"（R72 取舍①） */}
        {failed && <p role="status" className="text-sm text-muted-foreground">原件暂时无法载入，可稍后从资料页重新打开。</p>}
        {state === "loading" && (
          <p role="status" className="text-sm text-muted-foreground">正在取回原件并逐页渲染…首次打开需要加载渲染组件，请稍候。</p>
        )}
        {pages.map((page) => {
          const src = page.imageDataUrl ?? (page.kind === "image" && !failed ? url : null);
          const pageFailed = failedPages.includes(page.pageNo);
          return (
            <div key={page.id} className="rounded-md border bg-white p-4">
              <div className="mb-2 text-xs text-muted-foreground">
                {doc.name} · 第 {page.pageNo} 页
              </div>
              {src ? (
                <img
                  src={src}
                  alt={`${doc.name} 第${page.pageNo}页原件`}
                  className="mb-3 max-h-72 w-full rounded border object-contain bg-muted"
                />
              ) : null}
              {doc.objectPath && page.kind === "pdf" && (
                <canvas
                  ref={(el) => {
                    if (el) canvases.current.set(page.pageNo, el);
                    else canvases.current.delete(page.pageNo);
                  }}
                  aria-label={`${doc.name} 第${page.pageNo}页原件`}
                  className={`mb-3 w-full rounded border bg-muted ${pageFailed || !open ? "hidden" : ""}`}
                />
              )}
              {pageFailed && (
                <p role="status" className="mb-2 text-sm text-muted-foreground">原件页渲染失败，可稍后重试或下载查看。</p>
              )}
              {page.empty ? (
                <p className="text-sm text-muted-foreground">此页为空白页（未检测到内容，未静默丢弃）。</p>
              ) : page.blocks.length === 0 && !page.empty ? null : (
                <ul className="space-y-1.5 font-mono text-sm leading-relaxed">
                  {page.blocks.map((b) => (
                    <li key={b.id} className="px-1">
                      {b.text}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </details>
  );
}

/**
 * 某一栏超出服务器可存的长度时，就地（输入框下面）说清是哪一栏、现在多少字节、上限多少（R75）。
 * 没超限就什么都不渲染——平时不给家属添噪音。
 * 这里**不截断**：长度是人的判断内容，切掉就是悄悄丢东西；改成一栏一栏点名，让人自己删。
 *
 * 但这句话只在"这条任务本该上云"时才说：本机模式下压根没往服务器写，拿云端的上限去评判一条
 * 只留在本机的事实，是 R68/R71 同一类错误（同一句话在两种留存位置下含义不同）。
 * 新建任务的表单还没有任务对象，那里按"当前是云端模式"判。
 */
export function OverLimitHint({ field, value, task, syncable }: { field: FieldKey; value: string; task?: VisitTask; syncable?: boolean }) {
  const sync = useSync();
  const text = overLimitHint(field, value);
  if (!text) return null;
  // syncable 是调用方算好的 isSyncable(task)（2026-10-21 流畅度：字段卡不再收整个 task，
  // 但这个判断只依赖 id 与资料 id，字段确认不动它 ⇒ 传布尔即可，行为与传 task 一模一样）
  const pushable = sync.serverMode && sync.signedIn && (syncable ?? (task ? isSyncable(task) : true));
  if (!pushable) return null;
  return <p role="status" className="mt-1 text-xs text-destructive">{text}</p>;
}

export function EvidenceLink({ field }: { field: ExtractedField }) {
  // R67：知道出自哪一页 ≠ 能指认到哪一行，根本没有原件更没有"已删除"可说。
  // 措辞与入口都从 evidenceAffordance 取——判据、文案、入口三件事同源，才不会再修一处漏两处。
  const ev = evidenceAffordance(field);
  if (!ev.navigable) {
    return <span className="text-sm text-destructive">{ev.noun}</span>;
  }
  return (
    <button
      type="button"
      className="text-sm font-medium text-primary underline underline-offset-4"
      onClick={() => navigate(`/evidence/${field.docId}/${field.pageId}/${field.id}`)}
    >
      {ev.linkLabel}
    </button>
  );
}

// 复制失败时给的那一格：一句实话 + 一个只读框（里面就是本该进剪贴板的文字）。
// 为什么单独收成一处：交接单与复诊摘要两页都要复制，原先各写一份、其中一份失败时静默什么都不说（内网 http 入口下必然如此）。
export function CopyFallback({ text, notice }: { text: string; notice: string }) {
  return (
    <div role="status" className="mt-2 space-y-1.5">
      <p className="text-sm text-destructive">{notice}</p>
      <textarea readOnly value={text} className="w-full rounded-md border bg-muted/30 p-2 text-xs" rows={6} />
    </div>
  );
}
