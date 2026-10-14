import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { extractFailureLabel } from "../extractErrors";
import { Progress } from "@/components/ui/progress";
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
import { api, ApiError, type ExtractResult } from "../api";
import { useSync, isSyncable, UUID_RE } from "../sync";
import { fileToExtractImage } from "../downscale";
import type { PdfPageInfo } from "../pdf";
import { pdfFailureNotice, pdfModuleLoadNotice, pdfPagesHaveNoText, pdfNoTextNotice } from "../pdfErrors";
import { storageModeNotice, deleteNotice } from "../storageNotice";
import { compressedNotice, fitFailureNotice, fitToUploadLimit, formatUnsupportedNotice, isHeic, overUploadLimit, pdfOversizeNotice, uploadHint } from "../uploadFit";
import { capToFieldBytes, payloadRoomBytes } from "../fieldLimits";
import { payloadOf } from "../syncMerge";
import { fitPagesToTaskBudget, pageCountText, textBudgetSaturatedNotice, textCoverageNotice, textCoverageOf, textIsPartial } from "../textBudget";
import { docOriginalAffordance, missingOriginalNotice } from "../docOriginal";
import { forgetExtract, rememberExtract, resumableFor, readInflight, POLL_MS, POLL_BUDGET_MS } from "../extractInflight";
import { forgetFileUrl, fetchFreshFileUrl } from "../fileUrlCache";
import { now, uid, dedupeExtractedFields } from "../sheet";
import { navigate } from "../router";
import { DOC_TYPE_LABELS, ExpandedDocPages, WholeOriginalViewer } from "../shared";
import type { DocType, ExtractedField, SourceDocument, VisitTask } from "../types";
import { TaskShell } from "./TaskShell";

const MAX_INLINE_IMAGE = 1_500_000;
// 轮询节奏与"还在路上"的预算都来自 extractInflight：这一页和登记处必须用同一把尺（R69）
const POLL_BUDGET = POLL_BUDGET_MS;

type Phase = "uploading" | "stored" | "extracting" | "done" | "failed";
interface DocJob {
  phase: Phase;
  message?: string;
}

function newDocRecord(
  docId: string,
  file: File,
  objectPath?: string,
  pdfPages?: PdfPageInfo[],
  layer?: { seenBytes: number; pagesTotal: number },
): SourceDocument {
  const isImage = /image\/(jpeg|png)/.test(file.type);
  const pages = pdfPages
    ? pdfPages.map((p) => ({ id: `${docId}-p${p.pageNo}`, pageNo: p.pageNo, kind: "pdf" as const, blocks: p.blocks, empty: p.empty }))
    : isImage
      ? [{ id: `${docId}-p1`, pageNo: 1, kind: "image" as const, blocks: [] }]
      : [];
  return {
    id: docId,
    // 「资料名称」这一栏服务端按 300 **字节**收（`str(v.name, 300)`），手机相册导出的中文名很容易就过了；
    // 过了不是名字存不下，是**整条任务**从此推不出去。文件名不是人的判断内容，所以这里截——
    // 且列表里显示的就是截完那个名字（所见即所存），不另留一份"完整名字"骗人。
    name: capToFieldBytes(file.name, "docName"),
    docType: "unknown",
    status: "processing",
    pages,
    addedAt: now(),
    fileSize: file.size,
    mime: file.type,
    objectPath,
    // R76：这两上是"这份资料我们到底给了多少"的凭据。不记下来，"只留了 44%" 这件事就只有
    // 上传那一刻的界面上短暂出现过，刷新之后资料行会理直气壮地写着「共 20 页」。
    ...(layer ? { textSeenBytes: layer.seenBytes, pagesTotal: layer.pagesTotal } : {}),
  };
}

function mergeExtractResult(task: VisitTask, doc: SourceDocument, result: ExtractResult, modelVersion: string, modelKind?: "real" | "test" | "unknown"): { patch: Partial<SourceDocument>; fields: ExtractedField[] } {
  const pages = result.pages.map((p) => ({
    id: `${doc.id}-p${p.pageNo}`,
    pageNo: p.pageNo,
    kind: "image" as const,
    blocks: p.blocks,
  }));
  const existing = task.fields;
  const fields: ExtractedField[] = result.fields.map((f) => {
    const page = pages.find((p) => p.pageNo === f.pageNo) ?? pages[0];
    const conflicts = existing.filter((o) => o.group === f.group && o.label === f.label && o.aiValue && o.aiValue !== f.aiValue).map((o) => o.id);
    return {
      id: `${doc.id.slice(0, 8)}-${f.id}`,
      group: f.group,
      label: f.label,
      ocrRaw: f.ocrRaw,
      aiValue: f.aiValue,
      userValue: null,
      highRisk: f.highRisk,
      confidence: f.confidence,
      confirmStatus: "pending",
      source: "ai",
      docId: doc.id,
      pageId: page?.id,
      blockIds: page && f.blockIds.length ? f.blockIds : [],
      conflictWith: conflicts.length ? conflicts : undefined,
      modelVersion,
      // 与服务端 `sanitizeField` 同形：**只有确实知道是 real／test 才写这个键**，"unknown" 一律不写
      // （写了就会让"本机这份"与服务器上那些没这个键的旧字段永远差一个键 ⇒ R74 那类永久"有未推改动"）
      ...(modelKind === "real" || modelKind === "test" ? { modelKind } : {}),
      updatedAt: now(),
    };
  });
  // 与已有字段冲突时双向标记
  for (const f of fields) {
    for (const cid of f.conflictWith ?? []) {
      const other = existing.find((o) => o.id === cid);
      if (other && !(other.conflictWith ?? []).includes(f.id)) {
        other.conflictWith = [...(other.conflictWith ?? []), f.id];
      }
    }
  }
  return {
    patch: {
      docType: doc.docType === "unknown" ? result.docType : doc.docType,
      status: "done",
      pages: pages.length ? pages : doc.pages,
    },
    fields: dedupeExtractedFields(existing, fields),
  };
}

export function DocsPage({ task }: { task: VisitTask }) {
  const { dispatch, readOnly } = useStore();
  const sync = useSync();
  const inputRef = useRef<HTMLInputElement>(null);
  const [jobs, setJobs] = useState<Record<string, DocJob>>({});
  const [replacingId, setReplacingId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  // 两条通道，不是一条红色 alert 什么都装：R43 的"扫描件没有文字层"是**正常结果的说明**，
  // 用 destructive + role=alert 渲染会让家属以为自己上传错了、或系统坏了（与失败必须区分开）。
  const [statusNote, setStatusNote] = useState("");
  const [parsing, setParsing] = useState<string | null>(null);
  const pollingRef = useRef<Set<string>>(new Set());
  const taskRef = useRef(task);
  taskRef.current = task;
  useEffect(() => () => {
    // 卸载只停"这一页上的循环"，不停云端作业、也不停凭据：下次进这一页会把没跑完的接回去
    pollingRef.current.clear();
  }, []);
  useEffect(() => {
    const live = new Set(task.documents.map((d) => d.id));
    const todo = resumableFor(readInflight(Date.now(), live), task);
    for (const { doc, jobId } of todo) {
      setJob(doc.id, { phase: "extracting" });
      void pollExtract(doc.id, jobId);
    }
    // 只在挂载时接一次：task/documents 每次保存都变，放依赖里会变成"边打字边重接轮询"
  }, []);

  const serverUpload = sync.serverMode && sync.signedIn && isSyncable(task);

  function setJob(docId: string, job: DocJob | null) {
    setJobs((prev) => {
      const next = { ...prev };
      if (job) next[docId] = job;
      else delete next[docId];
      return next;
    });
  }

  async function pollExtract(docId: string, jobId: string) {
    pollingRef.current.add(docId);
    const startedAt = Date.now();
    while (pollingRef.current.has(docId)) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      if (!pollingRef.current.has(docId)) return;
      try {
        const status = await api.extractStatus(jobId);
        if (status.state === "completed") {
          const doc = taskRef.current.documents.find((d) => d.id === docId);
          if (doc) {
            const merged = mergeExtractResult(taskRef.current, doc, status.result, status.modelVersion, status.modelKind);
            dispatch({ type: "doc.update", taskId: task.id, docId, patch: merged.patch });
            if (merged.fields.length) {
              dispatch({ type: "field.addMany", taskId: task.id, fields: merged.fields });
            }
            dispatch({
              type: "audit.push", taskId: task.id,
              audit: makeAudit("extract.done", `「${doc.name}」识别完成，生成 ${merged.fields.length} 项待确认字段（${status.modelVersion}）`),
            });
          }
          setJob(docId, { phase: "done" });
          forgetExtract(docId, jobId); // 只清自己这一份：迟到的旧循环不许抹掉新凭据
          pollingRef.current.delete(docId);
          return;
        }
        if (status.state === "failed") {
          setJob(docId, { phase: "failed", message: status.code });
          forgetExtract(docId, jobId);
          pollingRef.current.delete(docId);
          return;
        }
        if (Date.now() - startedAt > POLL_BUDGET) {
          // R63：这里原来直接写死一句中文 ⇒ 绕开了错误文案单点，也没带上错误码（清单 D「不静默」）。
          // 现在给码，句子由 `errorCopy` 出，渲染处 `extractFailureLabel` 会把码附在后面。
          setJob(docId, { phase: "failed", message: "ai_timeout@polling" });
          forgetExtract(docId, jobId);
          pollingRef.current.delete(docId);
          return;
        }
      } catch (error) {
        setJob(docId, { phase: "failed", message: error instanceof ApiError ? error.detail || error.code : "ai_status_query_failed" });
        forgetExtract(docId, jobId);
        pollingRef.current.delete(docId);
        return;
      }
    }
  }

  async function handleExtract(doc: SourceDocument) {
    const retrying = jobs[doc.id]?.phase === "failed";
    setJob(doc.id, { phase: "extracting" });
    try {
      if (retrying) await api.aiRepair().catch(() => {}); // 清理卡住的初始化意图后重建
      // R78：这一处要的是**这一份原件的字节**，宁可新签一枚也别拿一枚快到期的去下载一半失败——
      // 但仍然只有"取地址"这一个出口（`fetchFreshFileUrl`＝丢账再取），不许那条路自己再开一发请求。
      const { url } = await fetchFreshFileUrl(doc.id);
      const blob = await (await fetch(url, { credentials: "same-origin" })).blob();
      const { base64, mediaType } = await fileToExtractImage(new File([blob], doc.name, { type: blob.type || "image/jpeg" }));
      const { jobId } = await api.extractStart(doc.id, mediaType, base64);
      // 先落到本页之外的登记处，再开始轮询：循环会随组件卸载而死，凭据不会（R69）
      rememberExtract(task.id, doc.id, jobId);
      dispatch({ type: "audit.push", taskId: task.id, audit: makeAudit("extract.start", `「${doc.name}」发起云端识别`) });
      void pollExtract(doc.id, jobId);
    } catch (error) {
      setJob(doc.id, { phase: "failed", message: error instanceof ApiError ? error.detail || error.code : "识别发起失败" });
    }
  }

  /**
   * 一次选中的文件在「能不能存下」这一关的唯一处理（R71）。
   * 2026-09-27 用户实测「照片根本上传不了，都是大于 10MB」：10MB 不是我们的产品选择，而是平台
   * 对象存储的单文件上限（实测 `file_size_limit=10485760`，配额管理在本通道不可用），把常量调大
   * 只会把报错从我们这里挪到平台那里。所以超限照片先在本机压到限内再传，并如实说明存的是压缩副本。
   * 体积这一半**只对真要写对象存储的那条路成立**：本机模式不往服务器写任何东西，拿它去拒收用户
   * 的照片、或宣布"已压到 X MB 保存"，都是在说一件不会发生的事。
   */
  async function fitPickedFile(original: File): Promise<{ file: File; compressedCopy: boolean; notice?: string } | null> {
    const heic = isHeic(original.type);
    const isPdf = original.type === "application/pdf";
    if (!heic && !isPdf && !/image\/(jpeg|png)/.test(original.type)) {
      setNotice(formatUnsupportedNotice(original.name));
      return null;
    }
    if (serverUpload && isPdf) {
      if (overUploadLimit(original.size)) {
        setNotice(pdfOversizeNotice(original.name));
        return null;
      }
      return { file: original, compressedCopy: false };
    }
    if (!serverUpload && !heic) return { file: original, compressedCopy: false };
    // HEIC 两种模式都要转成 JPEG：服务端不收它，本机模式下不转就没有任何能预览的图像
    const fitted = await fitToUploadLimit(original, { force: heic });
    if (fitted.failed) {
      setNotice(fitFailureNotice(original.name, fitted.failed, heic));
      return null;
    }
    if (!serverUpload) return { file: fitted.file, compressedCopy: false };
    if (!fitted.compressed) return { file: fitted.file, compressedCopy: false };
    return { file: fitted.file, compressedCopy: true, notice: compressedNotice(fitted.originalBytes, fitted.storedBytes) };
  }

  async function handleFiles(files: FileList, replaceDocId?: string) {
    for (const picked of Array.from(files)) {
      const fitted = await fitPickedFile(picked);
      if (!fitted) continue;
      if (fitted.notice) setNotice(fitted.notice);
      const file = fitted.file;
      const isImage = /image\/(jpeg|png)/.test(file.type);
      const isPdf = file.type === "application/pdf";
      let pdfPages: PdfPageInfo[] | undefined;
      let pdfLayer: { seenBytes: number; pagesTotal: number } | undefined;
      if (isPdf) {
        // HE-02：动态加载解析组件可能有数秒静默期，先给即时反馈，避免"上传后毫无反应"
        setParsing(file.name);
        // 两种失败必须分开说：R41 实测离线时这里以前统一报"可能为加密或损坏"，把网络问题说成文件问题，
        // 家属会去重拍/重转一份本来没坏的 PDF。解析发生在上传之前 ⇒ 任何"原件已保存"的话此刻都不许说。
        let mod: typeof import("../pdf") | null = null;
        try {
          mod = await import("../pdf");
        } catch {
          setNotice(pdfModuleLoadNotice(serverUpload));
          setParsing(null);
          continue;
        }
        try {
          const parsed = await mod.parsePdf(await file.arrayBuffer());
          pdfLayer = { seenBytes: parsed.seenTextBytes, pagesTotal: parsed.numPages };
          // R76：单份有预算（`pdf.ts` 那 500KB），**整条任务**的载荷却只有服务端那 1MB 的空间——
          // 实测攒到 6 份资料时整份 = 1,283,848 字节 ⇒ 413，界面上只有一句「云端保存失败」。
          // 所以这份新资料的文字层只能裁进"这条任务此刻剩下的空间"（`payloadRoomBytes` 按真载荷现算，
          // 不估），原件不动（它是独立对象）。被替换的那一份先从"已经用了多少"里摘出去，
          // 否则它占的空间退不回来，「替换」就会越换越小。本机模式同样裁：离线留着齐全的文字层，
          // 一连通就正好变成上面那句「存不上」（R68 同一类）。
          const rest = payloadOf({ ...task, documents: task.documents.filter((d) => d.id !== replaceDocId) });
          pdfPages = fitPagesToTaskBudget(parsed.pages, payloadRoomBytes(rest)).pages;
          // 两件事都要说，且不能互相覆盖：`setNotice` 是替换语义，分开调用只剩最后一句。
          const noText = pdfPagesHaveNoText(parsed.pages);
          const notes: string[] = [];
          if (noText !== "none") notes.push(pdfNoTextNotice(noText, serverUpload));
          // R76：这一句只是"当场"的提醒——同一句话由资料行从登记下来的两个数**长期**再说一遍
          // （措辞与判据同源，见 `textCoverageNotice`）；这里以前只报"整页没解析"，每页被剪掉多少行从不提。
          const coverage = textCoverageNotice(textCoverageOf({ ...pdfLayer, pages: pdfPages }), serverUpload);
          if (coverage) notes.push(coverage);
          // R79：裁到**一页都不剩**（而它本来是有文字层的）时，行上那句「只留下 0 字节（约 0%）」只说了事实，
          // 没说去哪儿腾空间。这一句点出此刻占得最多那一份与它的真实字节数，并给这一页上真有的两条出路。
          // 判据与行上那句同事实（裁完的 pdfPages + 解析看到的 seenBytes），所以两句话不会互相打脸。
          if (pdfPages.length === 0 && pdfLayer.seenBytes > 0) {
            const saturated = textBudgetSaturatedNotice(task.documents.filter((d) => d.id !== replaceDocId));
            if (saturated) notes.push(saturated);
          }
          if (notes.length) setStatusNote(notes.join(" "));
        } catch (error) {
          setNotice(pdfFailureNotice(error, serverUpload));
        } finally {
          setParsing(null);
        }
      }
      if (replaceDocId) {
        await removeDoc(replaceDocId, true);
      }
      if (serverUpload) {
        const tempId = uid("up-");
        setJob(tempId, { phase: "uploading", message: file.name });
        try {
          const intent = await api.uploadIntent(task.id, file);
          setJob(tempId, null);
          setJob(intent.docId, { phase: "uploading" });
          await api.putSigned(intent.signedUrl, file, file.type);
          await api.uploadComplete(intent.docId);
          setJob(intent.docId, { phase: "stored" });
          dispatch({ type: "doc.add", taskId: task.id, doc: newDocRecord(intent.docId, file, intent.objectPath, pdfPages, pdfLayer) });
          dispatch({ type: "audit.push", taskId: task.id, audit: makeAudit("doc.upload", `上传资料「${file.name}」并存入加密存储${fitted.compressedCopy ? "（原件超过存储单文件上限，存入的是本机压缩副本）" : ""}`) });
        } catch (error) {
          setJob(tempId, null);
          setNotice(error instanceof ApiError ? error.message : "上传失败，请检查网络后重试。原件未丢失，可重新上传。");
        }
        continue;
      }
      // 游客/本地模式：M1 行为
      const id = uid("doc-");
      let dataUrl: string | undefined;
      if (isImage && file.size <= MAX_INLINE_IMAGE) {
        dataUrl = await new Promise<string | undefined>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => resolve(undefined);
          reader.readAsDataURL(file);
        });
      }
      const doc = newDocRecord(id, file, undefined, pdfPages, pdfLayer);
      if (isImage && dataUrl) doc.pages = [{ id: `${id}-p1`, pageNo: 1, kind: "image", blocks: [], imageDataUrl: dataUrl }];
      dispatch({ type: "doc.add", taskId: task.id, doc });
      setJob(id, { phase: "uploading" });
      const timer = window.setInterval(() => {
        setJobs((prev) => {
          const job = prev[id];
          if (!job || job.phase !== "uploading") {
            window.clearInterval(timer);
            return prev;
          }
          return { ...prev, [id]: job.message === "9" ? { phase: "stored" } : { phase: "uploading", message: "9" } };
        });
      }, 700);
    }
    setReplacingId(null);
  }

  async function removeDoc(docId: string, silent = false) {
    const doc = taskRef.current.documents.find((d) => d.id === docId);
    if (!doc) return;
    if (doc.objectPath && UUID_RE.test(doc.id) && isSyncable(taskRef.current)) {
      try {
        await api.docDelete(doc.id);
      } catch (error) {
        if (!silent) {
          setNotice(error instanceof ApiError ? `云端原件删除失败：${error.message}` : "云端原件删除失败");
          return;
        }
      }
    }
    forgetExtract(docId);
    // R78：换过／删过原件之后，本机那份签名地址必须一起丢账——它指向的是**上一个**对象，
    // 留着就是在接下来几分钟里把旧原件显示成这一份的内容。
    forgetFileUrl(docId);
    dispatch({ type: "doc.delete", taskId: task.id, docId });
    if (!silent) {
      dispatch({ type: "audit.push", taskId: task.id, audit: makeAudit("doc.delete", `删除资料「${doc.name}」，相关字段退回待确认`) });
    }
  }

  return (
    <TaskShell task={task} tab="docs">
      <section className="rounded-lg border bg-card p-5">
        <h2 className="font-medium">上传病历、处方和报告</h2>
        <p id="doc-upload-hint" className="mt-1 text-sm text-muted-foreground">
          {uploadHint(serverUpload)}
          {storageModeNotice({
            serverUpload,
            signedIn: sync.signedIn,
            serverMode: sync.serverMode,
            backend: sync.backend,
            demoTask: !UUID_RE.test(task.id),
          })}
        </p>
        {notice && (
          <p role="alert" className="mt-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm text-destructive">
            {notice}
            <button type="button" className="ml-2 underline" onClick={() => setNotice("")}>收起</button>
          </p>
        )}
        {statusNote && (
          <p role="status" className="mt-2 rounded-md border bg-muted/50 p-2 text-sm text-muted-foreground">
            {statusNote}
            <button type="button" className="ml-2 underline" onClick={() => setStatusNote("")}>收起</button>
          </p>
        )}
        {parsing && (
          <p className="mt-2 rounded-md border bg-muted/50 p-2 text-sm text-muted-foreground">
            正在解析「{parsing}」…首次上传 PDF 需加载解析组件，请稍候；解析结果会在此提示。
            {/* "原件会不会留下"由模式决定，写死一句"原件仍会保存"在本机模式下是假账（R41 修的是提示语，这句是进行中提示，同一条纪律） */}
            {serverUpload ? "即使解析失败，原件仍会照常上传保存。" : "本机模式下 PDF 原件不会留在本机（只有图片会）。"}
          </p>
        )}
        <input
          ref={inputRef}
          type="file"
          accept=".jpg,.jpeg,.png,.pdf,.heic,.heif"
          multiple
          className="sr-only"
          aria-label="选择要上传的资料文件（JPG / PNG / HEIC / PDF）"
          aria-describedby="doc-upload-hint"
          tabIndex={-1}
          onChange={(e) => {
            if (e.target.files?.length) handleFiles(e.target.files, replacingId ?? undefined);
            e.target.value = "";
          }}
        />
        <div className="mt-3 flex gap-2">
          <Button disabled={readOnly} onClick={() => inputRef.current?.click()}>选择文件上传</Button>
          <Button variant="outline" onClick={() => navigate(`/t/${task.id}/review`)}>去核对信息</Button>
        </div>
      </section>

      <ul className="space-y-3" aria-label="已上传资料">
        {task.documents.map((doc) => {
          const job = jobs[doc.id];
          const isImage = doc.mime ? /image\//.test(doc.mime) : true;
          const emptyPages = doc.pages.filter((p) => p.empty).length;
          // 「这条资料能回看到什么」只在 src/docOriginal.ts 一处判（R72）：入口、措辞、以及没有入口时那句解释都从它出
          const origInput = { serverUpload, inlineLimitBytes: MAX_INLINE_IMAGE, taskSyncable: isSyncable(task), backend: sync.backend };
          const orig = docOriginalAffordance(doc, origInput);
          const coverage = textCoverageOf(doc);
          return (
            <li key={doc.id} className="rounded-lg border bg-card p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium break-words">{doc.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {doc.mime || "未知类型"} · {doc.fileSize ? `${Math.round(doc.fileSize / 1024)} KB` : "大小未知"} · {pageCountText(doc)}
                    {doc.pages.length > 1 && emptyPages > 0 && orig.offer && ` · 含 ${emptyPages} 页无内容（展开「${orig.label}」可见逐页说明）`}
                    {doc.objectPath && " · 已加密存储"}
                  </p>
                  {/*
                    R76：这份资料的文本层被护栏剪过 ⇒ 长期写在行上，不是一闪而过的提示。
                    判据、数字、出路三件事都在 `textBudget` 一处，行与上传当场的提示共用。
                  */}
                  {textIsPartial(coverage) && (
                    <p role="status" className="mt-1 text-xs text-muted-foreground">{textCoverageNotice(coverage, serverUpload)}</p>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {job?.phase === "uploading" && <Badge variant="outline">上传中</Badge>}
                  {job?.phase === "extracting" && <Badge variant="outline">云端识别中…</Badge>}
                  {job?.phase === "done" && <Badge variant="secondary">识别完成，去核对</Badge>}
                  {job?.phase === "failed" && <Badge variant="destructive">识别失败：{extractFailureLabel(job.message)}</Badge>}
                  {doc.status === "failed" && <Badge variant="destructive">失败：格式不支持</Badge>}
                  <Select
                    value={doc.docType}
                    onValueChange={(v) => {
                      dispatch({ type: "doc.update", taskId: task.id, docId: doc.id, patch: { docType: v as DocType } });
                      dispatch({ type: "audit.push", taskId: task.id, audit: makeAudit("doc.classify", `「${doc.name}」分类调整为 ${DOC_TYPE_LABELS[v as DocType]}`) });
                    }}
                    disabled={doc.status === "failed"}
                  >
                    <SelectTrigger size="sm" aria-label="资料分类">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.keys(DOC_TYPE_LABELS) as DocType[]).map((t) => (
                        <SelectItem key={t} value={t}>{DOC_TYPE_LABELS[t]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {doc.objectPath && isImage && job?.phase !== "extracting" && (
                    <Button variant="outline" size="sm" onClick={() => handleExtract(doc)}>
                      {job?.phase === "failed" ? "重试识别" : "识别此资料"}
                    </Button>
                  )}
                  {doc.objectPath && !isImage && (
                    <span className="text-xs text-muted-foreground">PDF 自动识别开发中，可手工录入</span>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => { setReplacingId(doc.id); inputRef.current?.click(); }}>
                    替换
                  </Button>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button variant="ghost" size="sm" className="text-destructive">删除</Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>删除「{doc.name}」？</AlertDialogTitle>
                        <AlertDialogDescription>
                          {deleteNotice(Boolean(doc.objectPath))}
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>取消</AlertDialogCancel>
                        <AlertDialogAction onClick={() => removeDoc(doc.id)}>确认删除</AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </div>
              {job?.phase === "extracting" && <Progress value={60} className="mt-3" aria-label="识别进度" />}
              {orig.wholeFile ? (
                /* R109：这一档（原件在站点存储、本机一页都没记下）走的是**整份原件查看器**——
                   页数由取回的原件本身给出，不按 `doc.pages` 展开（按它展开就是 R103 实测的那块空白）。
                   分支只看 `orig.wholeFile` 这一个由单源导出的标记，页面不再自行按页数决定。 */
                <WholeOriginalViewer doc={doc} orig={orig} input={origInput} />
              ) : orig.offer ? (
                /* R110：展开里的那些页面不再逐页各挂一个组件——整份共用一枚签名地址、
                   PDF 页面共用一个 pdf.js 文档，且**按下展开才发请求**（`docs/known-issues.md` ⑭）。 */
                <ExpandedDocPages doc={doc} pages={doc.pages} label={orig.label} />
              ) : (
                /* R103：这里以前还挂着 `doc.pages.length > 0` 一道门——资料一页都没记下时（解析失败的 PDF、
                   被任务预算裁到零页的 PDF、超过内联上限的 HEIC）连这句解释都不渲染，页面上等于什么都不说。
                   "有没有得看、说什么、给什么出路"全部由 `src/docOriginal.ts` 一处判定，页面不再按页数自行决定闭嘴。 */
                <p className="mt-3 text-xs text-muted-foreground">{missingOriginalNotice(doc, origInput)}</p>
              )}
            </li>
          );
        })}
      </ul>

      <p className="text-sm text-muted-foreground">
        下一步：到「信息核对」逐项确认关键字段。未确认的高风险内容（药名、剂量、过敏史等）不会进入交接单。
        <button type="button" className="mx-1 text-primary underline underline-offset-2" onClick={() => navigate(`/t/${task.id}/review`)}>
          直接去手工录入
        </button>
        也可以完成交接单。
      </p>
    </TaskShell>
  );
}
