// 同源 Function 调用客户端。浏览器永远不直接接触模型服务或数据库。
import { ERROR_COPY } from "./errorCopy";

export class ApiError extends Error {
  constructor(message: string, readonly code: string, readonly status: number = 0, readonly detail: string = "") {
    super(message);
    this.name = "ApiError";
  }
}

// R63：错误文案不在这里写第二份——统一取 `errorCopy.ts`（服务端可达码必须在那里有键，回归层 A 比对）
const MESSAGES = ERROR_COPY;

export async function requestJson(url: string, init: RequestInit = {}): Promise<unknown> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  let response: Response;
  try {
    response = await fetch(url, { ...init, headers, credentials: "same-origin" });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new ApiError(MESSAGES.network_error, "network_error");
  }
  if (response.status === 401 || response.status === 403) {
    throw new ApiError(MESSAGES.access_denied, "access_denied", response.status);
  }
  if (response.redirected || !response.headers.get("content-type")?.includes("application/json")) {
    throw new ApiError(MESSAGES.invalid_response, "invalid_response", response.status);
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new ApiError(MESSAGES.invalid_response, "invalid_response", response.status);
  }
  const body = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
  const code = typeof body?.error === "string" ? body.error
    : (!response.ok || body?.ok === false) && typeof body?.code === "string" ? body.code
    : response.ok ? null : "request_failed";
  if (!response.ok || body?.ok === false || code) {
    const resolved = code ?? "request_failed";
    const detail = typeof body?.detail === "string" && /^[a-z0-9_:@-]{1,64}$/.test(body.detail) ? body.detail : "";
    // detail 单独留一个字段：识别失败的**具体码**（如 ai_truncated@length）要在界面上原样可见，
    // 而不是只混在中文句子里——排查与对外举证都靠它。
    throw new ApiError(
      (MESSAGES[resolved] ?? MESSAGES.service_unavailable) + (detail ? `（${detail}）` : ""),
      resolved,
      response.status,
      detail,
    );
  }
  return data;
}

/** 写请求结果未知（网络断开/响应丢失）时禁止盲目重放，需要先读取对账 */
export function isWriteOutcomeUnknown(error: unknown): boolean {
  return error instanceof ApiError && ["network_error", "invalid_response", "db_unavailable", "service_unavailable"].includes(error.code);
}

const ENDPOINT = "/functions/v1/app";
const q = (action: string, extra = "") => `${ENDPOINT}?action=${action}${extra}`;

export type ServerUser = { id: string; name: string; picture: string } | null;

export const api = {
  me: async (): Promise<ServerUser> => {
    const r = (await requestJson(q("me"))) as { user: ServerUser };
    return r.user;
  },
  listTasks: async () => {
    const r = (await requestJson(q("tasks"))) as { tasks: { id: string; payload: unknown; updatedAt: string }[] };
    return r.tasks;
  },
  /**
   * `expectedUpdatedAt` ＝ 本机**上次从服务器读到的**那一行的时间戳（来自同步锚点）。
   * 带上它这次写就是条件写：服务器那行被别人改过时回 409 `write_conflict`，而不是把别人抹掉（R107／R97c）。
   */
  saveTask: (id: string, payload: unknown, expectedUpdatedAt?: string) =>
    requestJson(q("task-save"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(expectedUpdatedAt ? { id, payload, expectedUpdatedAt } : { id, payload }),
    }),
  deleteTask: (id: string) =>
    requestJson(q("task-delete"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    }),
  uploadIntent: (taskId: string, file: File) =>
    requestJson(q("upload-intent"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId, name: file.name, mime: file.type, size: file.size }),
    }) as Promise<{ docId: string; signedUrl: string; objectPath: string }>,
  /** signedUrl 是本站相对地址；PUT 时携带已批准的 MIME */
  putSigned: async (signedUrl: string, file: Blob, contentType: string) => {
    const response = await fetch(signedUrl, {
      method: "PUT",
      credentials: "same-origin",
      headers: { "Content-Type": contentType },
      body: file,
    });
    if (!response.ok) throw new ApiError(MESSAGES.upload_validation_failed, "upload_failed", response.status);
  },
  uploadComplete: (docId: string) =>
    requestJson(q("upload-complete"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ docId }),
    }),
  fileUrl: (docId: string) =>
    requestJson(q("file-url", `&docId=${encodeURIComponent(docId)}`)) as Promise<{ url: string; mime: string }>,
  docDelete: (docId: string) =>
    requestJson(q("doc-delete"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ docId }),
    }),
  extractStart: (docId: string, mediaType: string, imageBase64: string) =>
    requestJson(q("extract-start"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ docId, mediaType, imageBase64 }),
    }) as Promise<{ jobId: string }>,
  // PDF 文字层通路：数字版 PDF 解析出的文字整份送识别（比图片 OCR 准且便宜）；
  // 扫描版没有文字层，前端解析后走 pdf_no_text_layer 告知，不会到这里。
  extractStartText: (docId: string, text: string) =>
    requestJson(q("extract-start"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ docId, mediaType: "application/pdf", text }),
    }) as Promise<{ jobId: string }>,
  aiRepair: () =>
    requestJson(q("ai-repair"), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
  extractStatus: (jobId: string) =>
    requestJson(q("extract-status", `&jobId=${encodeURIComponent(jobId)}`)) as Promise<ExtractStatus>,
};

export type ExtractFieldResult = {
  id: string;
  group: "meta" | "timeline" | "history" | "medication" | "exam" | "allergy";
  label: string;
  ocrRaw: string;
  aiValue: string;
  confidence: "high" | "medium" | "low";
  highRisk: boolean;
  pageNo: number | null;
  blockIds: string[];
};

export type ExtractResult = {
  docType: "outpatient" | "prescription" | "report" | "inpatient" | "unknown";
  pages: { pageNo: number; blocks: { id: string; text: string }[] }[];
  fields: ExtractFieldResult[];
};

export type ExtractStatus =
  | { state: "pending" }
  | { state: "completed"; result: ExtractResult; modelVersion: string; modelKind?: "real" | "test" | "unknown" }
  | { state: "failed"; code: string };
