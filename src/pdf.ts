import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
  keptTextBytes,
  MAX_BLOCKS_PER_PAGE,
  MAX_BLOCK_CHARS,
  MAX_PAGES_PARSED,
  MAX_TEXT_BYTES_PER_DOC,
  utf8Length,
} from "./textBudget";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export interface PdfPageInfo {
  pageNo: number;
  blocks: { id: string; text: string }[];
  empty: boolean;
}

/** 客户端解析 PDF：页数、文本层证据块、空白页检测；扫描页无文本层则 blocks 为空但 empty=false
 *
 * R76：预算按 **UTF-8 字节**算（原来是 `JSON.stringify(blocks).length`，那是 UTF-16 单位数——中文一份要乘三，
 * 护栏会晚三段才生效），并且把"文本层一共多少字节"一起带回去：剪了多少必须能被披露，
 * 不能只留一句当场闪过、刷新就没了的状态提示。阈值都在 `src/textBudget.ts`。
 */
export async function parsePdf(data: ArrayBuffer): Promise<{
  pages: PdfPageInfo[];
  numPages: number;
  truncated: boolean;
  seenTextBytes: number;
}> {
  const doc = await pdfjs.getDocument({ data }).promise;
  const pages: PdfPageInfo[] = [];
  let bytes = 0;
  let seenTextBytes = 0;
  let truncated = false;
  const count = Math.min(doc.numPages, MAX_PAGES_PARSED);
  try {
    for (let i = 1; i <= count; i++) {
      const page = await doc.getPage(i);
      const textContent = await page.getTextContent();
      interface Line { y: number; parts: { x: number; s: string }[] }
      const lines: Line[] = [];
      for (const item of textContent.items as { str?: string; transform?: number[] }[]) {
        if (typeof item.str !== "string" || !item.str.trim()) continue;
        const x = item.transform?.[4] ?? 0;
        const y = item.transform?.[5] ?? 0;
        let line = lines.find((l) => Math.abs(l.y - y) < 4);
        if (!line) lines.push((line = { y, parts: [] }));
        line.parts.push({ x, s: item.str });
      }
      lines.sort((a, b) => b.y - a.y);
      // 「一共多少文本」要在任何剪法之前数：`lines` 已经按行归并，这里逐行算字节，不看后面的上限
      seenTextBytes += lines.reduce((n, l) => n + utf8Length(l.parts.map((p) => p.s).join("")), 0);
      const blocks = lines
        .slice(0, MAX_BLOCKS_PER_PAGE)
        .map((l, idx) => ({
          id: `b${idx + 1}`,
          text: l.parts.sort((p, q) => p.x - q.x).map((p) => p.s).join("").slice(0, MAX_BLOCK_CHARS),
        }))
        .filter((b) => b.text.trim());
      let empty = blocks.length === 0;
      if (empty) {
        const viewport = page.getViewport({ scale: 0.4 });
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.floor(viewport.width));
        canvas.height = Math.max(1, Math.floor(viewport.height));
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (ctx) {
          await page.render({ canvasContext: ctx, viewport }).promise;
          const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          for (let p = 0; p < d.length; p += 4) {
            if (d[p] < 240 || d[p + 1] < 240 || d[p + 2] < 240) {
              empty = false;
              break;
            }
          }
        }
      }
      const est = keptTextBytes([{ blocks }]);
      if (bytes + est > MAX_TEXT_BYTES_PER_DOC) {
        truncated = true;
        break;
      }
      bytes += est;
      pages.push({ pageNo: i, blocks, empty });
    }
  } finally {
    await doc.destroy();
  }
  if (doc.numPages > count) truncated = true;
  return { pages, numPages: doc.numPages, truncated, seenTextBytes };
}

const pdfCache = new Map<string, ArrayBuffer>();
const pdfInflight = new Map<string, Promise<ArrayBuffer>>();

/**
 * 按需取回 PDF 字节（同一资料页复用），供证据查看器渲染原页。
 *
 * 交出去的是**副本**（R109 实测）：pdf.js 会把 `getDocument({ data })` 交进去的 buffer 移交（transfer）给工作线程，
 * 原 buffer 当场失效。以前这里直接把缓存里那一份给出去 ⇒ 展开一份 14 页的 PDF 时，第一个缩略图把缓存里那份抽走，
 * 其余 13 个拿到的是已经失效的空 buffer ⇒ 2026-09-29 真浏览器实测：每个缩略图各自**重新下载整份原件**
 * （一份 14 页的资料点了展开就是 14 发），而且全部卡在「正在载入原件第 N 页…」（14 个 canvas、墨点 0 个）。
 * 一份副本换一个能画出来的页面，这笔买卖值得。
 *
 * 合并同理：并发调用**共用一发下载**（与 `src/fileUrlCache.ts` 那条 R78 的纪律同一形状，只是这次量的是字节不是地址）。
 */
export function loadPdfBytes(docId: string, url: string): Promise<ArrayBuffer> {
  const hit = pdfCache.get(docId);
  if (hit) return Promise.resolve(hit.slice(0));
  const fly = pdfInflight.get(docId);
  if (fly) return fly.then((buf) => buf.slice(0));
  const p = fetch(url, { credentials: "same-origin" })
    .then((r) => {
      if (!r.ok) throw new Error("pdf_fetch_failed");
      return r.arrayBuffer();
    })
    .then((buf) => {
      pdfCache.set(docId, buf);
      while (pdfCache.size > 4) pdfCache.delete(pdfCache.keys().next().value as string);
      return buf.slice(0);
    })
    .finally(() => {
      pdfInflight.delete(docId);
    });
  pdfInflight.set(docId, p);
  return p;
}

export async function renderPdfPageToCanvas(canvas: HTMLCanvasElement, data: ArrayBuffer, pageNo: number, scale = 1.1): Promise<void> {
  const doc = await openPdf(data);
  try {
    await doc.renderPageTo(canvas, pageNo, scale);
  } finally {
    await doc.destroy();
  }
}

/**
 * 「开一次、按页画、画完关掉」那把钥匙（R109 整份原件查看器用）。
 * 为什么不是循环调用 `renderPdfPageToCanvas`：那样每画一页就重新解析一遍整份 PDF，
 * 20 页＝20 次全量解析——查看器的成本必须落在"开一次文档"上。
 */
export interface PdfDocumentHandle {
  numPages: number;
  renderPageTo(canvas: HTMLCanvasElement, pageNo: number, scale?: number): Promise<void>;
  destroy(): Promise<void>;
}

export async function openPdf(data: ArrayBuffer): Promise<PdfDocumentHandle> {
  const doc = await pdfjs.getDocument({ data }).promise;
  return {
    numPages: doc.numPages,
    async renderPageTo(canvas: HTMLCanvasElement, pageNo: number, scale = 1.1): Promise<void> {
      const page = await doc.getPage(Math.min(pageNo, doc.numPages));
      const viewport = page.getViewport({ scale });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("canvas_unavailable");
      await page.render({ canvasContext: ctx, viewport }).promise;
    },
    destroy: () => doc.destroy(),
  };
}
