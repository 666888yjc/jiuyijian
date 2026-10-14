// Single application Function. Browser calls same-origin /functions/v1/app?action=...
// deps: { storage (platform injected SDK or fixture), extract: factory ({supabase, coordinator}) -> adapter }
import { requireUser, getUser, UserContextError } from "./auth.mjs";
import { DbError } from "./db.mjs";
import { CloudAgentsError } from "./cloud-agents.mjs";
import { verifyUploadedObject } from "./storage-validation.mjs";
import { causeTail, DETAIL_MAX, detailTag } from "./error-detail.mjs";
import { makeDb } from "./db.mjs";
import { makeCoordinator } from "./coordinator.mjs";
import { makeQuotaGuard, QUOTA_DEFAULTS } from "./quota.mjs";
import {
  readJson, sanitizeTaskPayload, uuid,
  UPLOAD_MIMES, EXTRACT_MIMES, MAX_UPLOAD_BYTES, MAX_EXTRACT_IMAGE_BYTES,
} from "./validate.mjs";

const json = (value, status = 200) =>
  Response.json(value, { status, headers: { "cache-control": "private, no-store" } });
const ok = (extra = {}) => json({ ok: true, ...extra });
const fail = (code, status = 400) => json({ ok: false, error: code }, status);

const hexDigest = async (text) => {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
};

/** 把 32 位十六进制键摆成 UUID 形状（版本/变体位固定，保证过 validate.uuid 的格式校验） */
const deterministicJobId = (hex) =>
  `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;

const decodeBase64 = (value) => {
  if (typeof value !== "string" || value.length > 1_400_000 || !/^[A-Za-z0-9+/=\r\n]+$/.test(value)) return null;
  try {
    const binary = atob(value.replace(/\s/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
};

// 默认上限（为 QCA 异步轮询设计）。同步通路会用自己的 `adapter.jobTimeoutMs` 覆盖它。
const JOB_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * `modelKind` 是**必填注入**（R96）："这次吐出来的识别值是真模型还是测试假模型"只有装配那层知道
 * （生产打的是运维配置的端点，本地夹具打的是 `dev/fake-llm`／`dev/fake-ocr` 那两台剧本服务），
 * 而界面要据此对患者说真话。缺这一格 ⇒ 直接抛错，不许退化成"猜一个"或干脆不说：
 * R35 那次"装配少传一个 onUsage"让成本账本在 300+ 条链路断言下从没被写过而无人察觉，同一形状不再犯。
 */
export function createHandler({ storage, extract, quotaLimits = null, modelKind }) {
  if (modelKind !== "real" && modelKind !== "test") {
    throw new Error(`createHandler 缺 modelKind 注入（只接受 "real" 或 "test"，收到 ${JSON.stringify(modelKind)}）`);
  }
  return async ({ request, supabase }) => {
    const db = makeDb(supabase);
    const adapter = extract({ supabase, db, coordinator: makeCoordinator(db) });
    const quota = makeQuotaGuard({ db, limits: quotaLimits ?? QUOTA_DEFAULTS });
    const url = new URL(request.url);
    const action = url.searchParams.get("action") ?? "";
    const method = request.method;

    try {
      if (action === "me" && method === "GET") {
        const user = getUser(request);
        return ok({ user: user ? { id: user.user_id, name: user.name, picture: user.picture } : null });
      }

      const user = requireUser(request);
      const ownerId = user.user_id;

      if (action === "tasks" && method === "GET") {
        const rows = await db.listTasks(ownerId);
        return ok({
          tasks: rows.map((r) => ({ id: r.id, payload: r.payload, updatedAt: r.updated_at })),
          server: true,
        });
      }

      if (action === "task-save" && method === "POST") {
        const body = await readJson(request, 1_000_000);
        if (!uuid(body?.id)) return fail("invalid_payload");
        const payload = sanitizeTaskPayload(body.payload);
        for (const doc of payload.documents) {
          if (doc.objectPath === undefined) continue;
          const row = await db.getDoc(doc.id, ownerId);
          if (!row || row.task_id !== body.id || row.object_path !== doc.objectPath) return fail("doc_reference_invalid", 422);
        }
        const updatedAt = new Date().toISOString();
        const existing = await db.getTask(body.id, ownerId);
        // R107（known-issues ⑪ / R97c）：客户端带上"我上次从服务器读到的那个 `updated_at`"时，这次写就是**条件写**——
        // 服务器上那一行若已被别的设备改过，那一行不再匹配 ⇒ 0 行 ⇒ 409，本机这份不会被悄悄盖上去，
        // 也不会有人的核对被静默抹掉。不带这个键的旧客户端照旧是无条件写（实测：先上服务端不打断已装旧版，
        // 但旧版因此不受这层保护——这一取舍写在 `docs/r97c-measurement.md` §4）。
        const expected = typeof body?.expectedUpdatedAt === "string" && body.expectedUpdatedAt ? body.expectedUpdatedAt : null;
        if (existing) {
          try {
            await db.updateTask(body.id, ownerId, { payload, updated_at: updatedAt }, expected ?? undefined);
          } catch (error) {
            if (expected && error instanceof DbError && error.code === "not_found") return fail("write_conflict", 409);
            throw error;
          }
        } else {
          try {
            await db.insertTask({ id: body.id, owner_id: ownerId, payload, updated_at: updatedAt });
          } catch (error) {
            if (error instanceof DbError && error.code === "write_rejected") {
              const raced = await db.getTask(body.id, ownerId);
              if (raced) return fail("write_conflict", 409);
            }
            throw error;
          }
        }
        return ok({ updatedAt });
      }

      if (action === "task-delete" && method === "POST") {
        const body = await readJson(request, 4096);
        if (!uuid(body?.id)) return fail("invalid_payload");
        const docs = await db.listDocsByTask(body.id, ownerId);
        const deleted = await db.deleteTask(body.id, ownerId);
        if (!deleted) return fail("not_found", 404);
        for (let i = 0; i < docs.length; i += 100) {
          await storage.remove(docs.slice(i, i + 100).map((d) => d.object_path)).catch(() => {});
        }
        await db.deleteDocsByTask(body.id, ownerId);
        return ok({ removedDocs: docs.length });
      }

      if (action === "upload-intent" && method === "POST") {
        const body = await readJson(request, 16384);
        const docId = uuid(body?.docId) ?? crypto.randomUUID();
        const ext = UPLOAD_MIMES.get(body?.mime);
        const name = typeof body?.name === "string" ? body.name.slice(0, 300) : null;
        if (!ext || !name || !Number.isSafeInteger(body?.size) || body.size < 1 || body.size > MAX_UPLOAD_BYTES) return fail("invalid_payload");
        if (!uuid(body?.taskId) || !(await db.getTask(body.taskId, ownerId))) return fail("not_found", 404);
        const objectPath = `docs/${(await hexDigest(ownerId)).slice(0, 16)}/${docId}.${ext}`;
        await db.insertDoc({ id: docId, owner_id: ownerId, task_id: body.taskId, object_path: objectPath, name, mime: body.mime, size: body.size, state: "pending", created_at: new Date().toISOString() });
        const { signedUrl } = await storage.createSignedUploadUrl(objectPath, { upsert: false });
        return ok({ docId, signedUrl, objectPath });
      }

      if (action === "upload-complete" && method === "POST") {
        const body = await readJson(request, 4096);
        if (!uuid(body?.docId)) return fail("invalid_payload");
        const row = await db.getDoc(body.docId, ownerId);
        if (!row) return fail("not_found", 404);
        if (row.state === "stored") return ok({ size: Number(row.size) });
        try {
          const actual = await verifyUploadedObject(await storage.download(row.object_path), {
            maxBytes: MAX_UPLOAD_BYTES,
            expectedBytes: Number(row.size),
            allowedContentTypes: [row.mime],
          });
          await db.markDocStored(row.id, ownerId, actual.size);
          return ok({ size: actual.size });
        } catch {
          await storage.remove([row.object_path]).catch(() => {});
          await db.deleteDoc(row.id, ownerId).catch(() => {});
          return fail("upload_validation_failed", 422);
        }
      }

      if (action === "file-url" && method === "GET") {
        if (!uuid(url.searchParams.get("docId"))) return fail("invalid_payload");
        const row = await db.getDoc(url.searchParams.get("docId"), ownerId);
        if (!row || row.state !== "stored") return fail("not_found", 404);
        const { signedUrl } = await storage.createSignedUrl(row.object_path, 300);
        return ok({ url: signedUrl, mime: row.mime });
      }

      if (action === "doc-delete" && method === "POST") {
        const body = await readJson(request, 4096);
        if (!uuid(body?.docId)) return fail("invalid_payload");
        const row = await db.getDoc(body.docId, ownerId);
        if (!row) return ok({ alreadyGone: true });
        await storage.remove([row.object_path]);
        await db.deleteDoc(row.id, ownerId);
        // 级联：从任务载荷中移除该资料并把引用字段退回待确认，避免悬空引用阻塞后续保存。
        // R107：这一段和 task-save 是同一条缺陷（R97c）——它也是"读整行 → 改一份 → 写回整行"，
        // 另一台设备在读完之后落的那一笔会被这次级联整份盖掉。所以改成**条件写 + 重读再试**：
        // 每一轮只摘掉**这一份资料自己的**引用（不搬动别的内容），落空就重读那一行再来一次。
        // 三次都没落地才留给 task-save 的 `doc_reference_invalid` 那一档兜底（客户端会转成本地资料再重推）。
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const taskRow = await db.getTask(row.task_id, ownerId);
          const p = taskRow?.payload;
          if (!p || !Array.isArray(p.documents) || !p.documents.some((d) => d.id === row.id)) break;
          const next = {
            ...p,
            documents: p.documents.filter((d) => d.id !== row.id),
            fields: Array.isArray(p.fields)
              ? p.fields.map((f) =>
                  f?.docId === row.id
                    ? { ...f, confirmStatus: "pending", docId: undefined, pageId: undefined, blockIds: undefined, updatedAt: new Date().toISOString() }
                    : f,
                )
              : p.fields,
          };
          try {
            await db.updateTask(row.task_id, ownerId, { payload: next, updated_at: new Date().toISOString() }, taskRow.updated_at);
            break;
          } catch (error) {
            if (!(error instanceof DbError) || error.code !== "not_found") throw error;
          }
        }
        return ok({});
      }

      if (action === "ai-ping" && method === "GET") {
        return ok(await adapter.ping());
      }

      if (action === "ai-repair" && method === "POST") {
        const rows = await db.resList();
        let cleared = 0;
        for (const row of rows) {
          const state = row.record?.data?.state;
          if (state === "creating" || state === "unknown" || state === "rejected") {
            await db.resDelete(row.scope_key);
            cleared += 1;
          }
        }
        return ok({ cleared });
      }

      if (action === "extract-start" && method === "POST") {
        const body = await readJson(request, 1_600_000);
        if (!uuid(body?.docId) || !EXTRACT_MIMES.has(body?.mediaType)) return fail("invalid_payload");
        const row = await db.getDoc(body.docId, ownerId);
        if (!row || row.state !== "stored") return fail("not_found", 404);
        if (!EXTRACT_MIMES.has(row.mime)) return fail("extract_unsupported_type", 422);
        const bytes = decodeBase64(body?.imageBase64);
        if (!bytes || bytes.length < 64 || bytes.length > MAX_EXTRACT_IMAGE_BYTES) return fail("extract_image_invalid", 422);
        // ── 幂等：同一份资料 + 同一张图 + 同一版提示词 + 同一个模型 ⇒ 同一个 jobId ──────────
        // 防的是真实场景：用户连点两次「识别此资料」、或前端超时后自己再发一次——每次都是几毛钱积分
        // 与 8–12 秒等待，而且第二次的结果会盖掉第一次，家属看到字段跳动。
        // 不加列、不做迁移：jobId 由键算出来，靠主键唯一性天然去重；失败的键换一次 attempt 号重来。
        const versionTag = String(adapter.modelVersion?.(adapter.model ?? null) ?? "unknown");
        const idKey = await hexDigest(`${row.id}|${body.mediaType}|${versionTag}|${await hexDigest(body.imageBase64)}`);
        let jobId = null;
        let reused = null;
        let lastFailedCause = "";
        for (let attempt = 0; attempt < 3 && !jobId; attempt += 1) {
          const candidate = deterministicJobId(await hexDigest(`${idKey}#${attempt}`));
          const existing = await db.getJob(candidate, ownerId);
          if (!existing) { jobId = candidate; continue; }
          // 已完成 ⇒ 直接复用结果；在途 ⇒ 绝不第二次烧积分；失败 ⇒ 换下一个 attempt 重开
          if (existing.state === "failed") { lastFailedCause = String(existing.error_code ?? "") || "unknown"; continue; }
          jobId = candidate;
          reused = existing;
        }
        if (!jobId) {
          // 三个幂等位全被"已失败"的作业占满 ⇒ 在这里就停：往下走会拿 `id=null` 去插一行——真服务器回一个
          // 看着像数据库故障的码（实测 `write_rejected`），而夹具那份查询引擎收得下 null ⇒ 幽灵行 + 第四次
          // 模型请求照发（"同一张图最多烧三次"这道护栏在那种语义下根本没兜住）。真实成因本来就写在那几行的
          // error_code 里，把它如实带回界面，别让它塌成一句「服务暂不可用，请稍后重试」。
          // detail 的头**必须是码本身**（与产品既有形状一致：`码@阶段`）——资料页那句是
          // `error.detail || error.code` 喂进查表函数的，头上放一个表里没有的串就退到兜底句
          // 「识别未完成，可重试或改用人工录入。」，而那正是这句要避免的假指引（同一张图再试不会有新作业）。
          return json({
            ok: false, error: "extract_retry_exhausted",
            // 头是码、尾是那几行里记着的阶段；预算按 `码@` 之后剩多少算，拼完整条永远 ≤64（超了界面是整条丢，不是截断）
            detail: detailTag(`extract_retry_exhausted@${causeTail(lastFailedCause, DETAIL_MAX - "extract_retry_exhausted@".length)}`),
          }, 409);
        }
        const nowIso = new Date().toISOString();
        if (!reused) {
          // 配额只挡"要发模型请求"的新作业；已完成的复用（上面 reused 分支）不受影响，
          // 所以配额耗尽后用户仍能看到已有结果、仍能上传与人工录入。
          const gate = await quota.check(ownerId);
          if (!gate.allowed) return fail("ai_quota_exceeded", 429);
          try {
            await db.insertJob({ id: jobId, owner_id: ownerId, task_id: row.task_id, doc_id: row.id, session_id: null, state: "pending", error_code: null, result: null, model_id: null, created_at: nowIso, updated_at: nowIso });
          } catch (error) {
            // 主键冲突 = 同一份图的并发请求已经建了行；如实复用它，而不是回一个 500 让用户再点一次
            const raced = error instanceof DbError ? await db.getJob(jobId, ownerId) : null;
            if (!raced) throw error;
            reused = raced;
          }
        }
        if (reused) {
          // 不重发模型请求；状态由 extract-status 照旧给出（completed 会带上已存的结果）
          return ok({ jobId, idempotent: reused.state ?? "pending" });
        }
        try {
          const { sessionId, modelId } = await adapter.startJob({ jobId, imageBytes: bytes, mediaType: body.mediaType });
          await db.updateJob(jobId, ownerId, { session_id: sessionId, model_id: modelId, state: "dispatched" });
          return ok({ jobId });
        } catch (error) {
          const code = (error instanceof CloudAgentsError ? error.code : "ai_service_unavailable") + (error?.phase ? `@${error.phase}` : "");
          const unknown = error instanceof CloudAgentsError && error.outcome === "unknown";
          await db.updateJob(jobId, ownerId, {
            state: unknown ? "pending" : "failed",
            error_code: unknown ? `dispatch_unknown:${code}` : code,
          });
          return json({ ok: false, error: unknown ? "ai_dispatch_pending" : "ai_service_unavailable", detail: code }, 503);
        }
      }

      if (action === "extract-status" && method === "GET") {
        if (!uuid(url.searchParams.get("jobId"))) return fail("invalid_payload");
        const job = await db.getJob(url.searchParams.get("jobId"), ownerId);
        if (!job) return fail("not_found", 404);
        if (job.state === "completed") {
          return ok({ state: "completed", result: job.result, modelVersion: adapter.modelVersion(job.model_id), modelKind });
        }
        if (job.state === "failed") return ok({ state: "failed", code: job.error_code ?? "ai_service_unavailable" });
        // 卡死上限由 adapter 自己报（同步通路 90 秒级，QCA 沿用 10 分钟）：
        // 让病人在"识别中"上空等的时长必须匹配该通道的真实耗时分布，而不是共用一个为异步设计写的老值。
        if (Date.parse(job.created_at) < Date.now() - (adapter.jobTimeoutMs ?? JOB_TIMEOUT_MS)) {
          await db.updateJob(job.id, ownerId, { state: "failed", error_code: "ai_timeout" });
          return ok({ state: "failed", code: "ai_timeout" });
        }
        if (job.session_id) {
          const polled = await adapter.pollJob({ sessionId: job.session_id });
          if (polled.status === "completed") {
            await db.updateJob(job.id, ownerId, { state: "completed", result: polled.result, model_id: job.model_id ?? null });
            return ok({ state: "completed", result: polled.result, modelVersion: adapter.modelVersion(job.model_id), modelKind });
          }
          if (polled.status === "failed") {
            await db.updateJob(job.id, ownerId, { state: "failed", error_code: polled.code });
            return ok({ state: "failed", code: polled.code });
          }
        }
        return ok({ state: "pending" });
      }

      return fail("not_found", 404);
    } catch (error) {
      if (error instanceof UserContextError) return fail(error.code, error.status);
      if (error instanceof DbError) return fail(error.code, error.status);
      if (error instanceof CloudAgentsError) return fail(error.code, error.status);
      return fail("service_unavailable", 503);
    }
  };
}
