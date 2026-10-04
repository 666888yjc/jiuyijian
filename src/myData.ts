// 就医笺 · 「导出我的数据」载荷构造（纯函数：无浏览器/React 依赖，可被 node 直接导入断言）
// 口径（U6 L2，见 deliverables/product-strategy/u6-consent-page-gap-assessment-jiuyijian-2026-09-24.md）：
//   - 包含：任务元信息、资料清单（不含页面图片）、字段（label/组/确认状态/来源/AI 值/用户值）、
//     问诊问题、行动项、复诊摘要、审计与删除留痕、全局操作记录
//   - 排除：ocrRaw（原件 OCR 原文，与 excluded 的图片同源，体积大且冗余）、
//     imageDataUrl（原件图片，实测单图最大 1.69MB；需要原件的用户走交接单打印/另存）
import type { AppState } from "./state";
import type { VisitTask } from "./types";

export interface MyDataExport {
  exportedAt: string;
  note: string;
  tasks: Array<Omit<VisitTask, "documents" | "fields"> & {
    documents: Array<Omit<VisitTask["documents"][number], "pages"> & { pageCount: number }>;
    fields: Array<Omit<VisitTask["fields"][number], "ocrRaw">>;
  }>;
  tombstones: AppState["tombstones"];
  events: AppState["events"];
}

export function buildMyDataExport(state: AppState, exportedAt: string): MyDataExport {
  return {
    exportedAt,
    note:
      "本文件为「就医笺」本机数据副本，由隐私与数据管理页导出。不含原件图片与 OCR 原文（体积原因）；" +
      "字段 aiValue 为识别值、userValue 为你的修改值，以 confirmStatus 与 source 判断生效值。",
    tasks: state.tasks.map((t) => {
      const { documents, fields, ...rest } = t;
      return {
        ...rest,
        documents: documents.map(({ pages, ...d }) => ({ ...d, pageCount: pages.length })),
        fields: fields.map(({ ocrRaw, ...f }) => f),
      };
    }),
    tombstones: state.tombstones ?? [],
    events: state.events ?? [],
  };
}
