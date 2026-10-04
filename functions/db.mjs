// Supabase data-access layer. Every query is filtered by the server-derived owner.
// Errors are mapped to fixed application codes; raw provider details never escape.

export class DbError extends Error {
  constructor(code, status = 503) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

const check = (result, code = "db_unavailable") => {
  if (result.error) throw new DbError(code);
  return result.data;
};

export function makeDb(supabase) {
  return {
    async listTasks(ownerId) {
      return check(
        await supabase
          .from("tasks")
          .select("id,payload,updated_at")
          .eq("owner_id", ownerId)
          .order("updated_at", { ascending: false })
          .limit(50),
      ) ?? [];
    },
    async getTask(id, ownerId) {
      return (
        check(
          await supabase.from("tasks").select("id,payload,updated_at").eq("id", id).eq("owner_id", ownerId).maybeSingle(),
        )
      );
    },
    async insertTask(row) {
      check(await supabase.from("tasks").insert(row).select("id").maybeSingle(), "write_rejected");
    },
    /**
     * R107（R97c）：`expectedUpdatedAt` 给定时，条件写进数据库那一行 WHERE（compare-and-swap）。
     * 为什么不是"读出来比一下再写"：`docs/r97c-measurement.md` 实测那种写法拦不住"读完之后、写之前"的插队，
     * 只有把条件交给写那一刻求值的 WHERE 才封得住。0 行 ⇒ 与"行不存在"同样报 not_found，由调用方按语境改判 409。
     */
    async updateTask(id, ownerId, patch, expectedUpdatedAt) {
      let q = supabase.from("tasks").update(patch).eq("id", id).eq("owner_id", ownerId);
      if (typeof expectedUpdatedAt === "string" && expectedUpdatedAt) q = q.eq("updated_at", expectedUpdatedAt);
      const data = check(await q.select("id").maybeSingle(), "write_rejected");
      if (!data) throw new DbError("not_found", 404);
    },
    async deleteTask(id, ownerId) {
      const data = check(
        await supabase.from("tasks").delete().eq("id", id).eq("owner_id", ownerId).select("id").maybeSingle(),
      );
      return Boolean(data);
    },

    async insertDoc(row) {
      check(await supabase.from("doc_files").insert(row).select("id").maybeSingle(), "write_rejected");
    },
    async getDoc(id, ownerId) {
      return check(
        await supabase.from("doc_files").select("id,owner_id,task_id,object_path,name,mime,size,state,created_at").eq("id", id).eq("owner_id", ownerId).maybeSingle(),
      );
    },
    async listDocsByTask(taskId, ownerId) {
      return check(
        await supabase.from("doc_files").select("id,object_path").eq("task_id", taskId).eq("owner_id", ownerId).limit(200),
      ) ?? [];
    },
    async markDocStored(id, ownerId, size) {
      const data = check(
        await supabase.from("doc_files").update({ state: "stored", size }).eq("id", id).eq("owner_id", ownerId).eq("state", "pending").select("id").maybeSingle(),
      );
      if (!data) throw new DbError("not_found", 404);
    },
    async deleteDoc(id, ownerId) {
      check(await supabase.from("doc_files").delete().eq("id", id).eq("owner_id", ownerId).select("id").maybeSingle());
    },
    async deleteDocsByTask(taskId, ownerId) {
      check(await supabase.from("doc_files").delete().eq("task_id", taskId).eq("owner_id", ownerId).select("id"));
    },

    async insertJob(row) {
      check(await supabase.from("extract_jobs").insert(row).select("id").maybeSingle(), "write_rejected");
    },
    // 配额用：某 owner 自某时刻起的识别作业数。上限远小于 provider 单次返回的行数上限，
    // 真被撑到 1000 行也只会"多算不少算"，方向上是把失控账户挡在外面。
    async countJobsSince(ownerId, isoStart) {
      const rows = check(
        await supabase.from("extract_jobs").select("id,created_at").eq("owner_id", ownerId).gte("created_at", isoStart),
        "read_rejected",
      );
      return Array.isArray(rows) ? rows.length : 0;
    },
    async getJob(id, ownerId) {      return check(
        await supabase.from("extract_jobs").select("id,owner_id,task_id,doc_id,session_id,state,error_code,result,model_id,created_at,updated_at").eq("id", id).eq("owner_id", ownerId).maybeSingle(),
      );
    },
    async updateJob(id, ownerId, patch) {
      check(
        await supabase.from("extract_jobs").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id).eq("owner_id", ownerId).select("id").maybeSingle(),
      );
    },

    // ai_resources doubles as the durable coordinator store (fence CAS in coordinator.mjs).
    async resGet(key) {
      return check(
        await supabase.from("ai_resources").select("record").eq("scope_key", key).maybeSingle(),
      )?.record ?? null;
    },
    async resList() {
      return check(await supabase.from("ai_resources").select("scope_key,record").limit(200)) ?? [];
    },
    async resDelete(key) {
      check(await supabase.from("ai_resources").delete().eq("scope_key", key).select("scope_key").maybeSingle());
    },
    async resInsert(key, record) {
      const existing = await this.resGet(key);
      if (existing !== null) return false;
      const data = check(
        await supabase.from("ai_resources").insert({ scope_key: key, record, updated_at: new Date().toISOString() }).select("scope_key").maybeSingle(),
      );
      return Boolean(data);
    },
    async resCas(key, expectedFence, record) {
      const data = check(
        await supabase.from("ai_resources").update({ record, updated_at: new Date().toISOString() }).eq("scope_key", key).eq("record->>fence", expectedFence).select("scope_key").maybeSingle(),
      );
      return Boolean(data);
    },
  };
}
