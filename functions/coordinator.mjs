// Durable coordinator over app.ai_resources (fence compare-and-set).
// Single-writer per lock key; a stale lease holder cannot overwrite its successor.

export function makeCoordinator(db) {
  return {
    async withLock(key, callback) {
      for (let attempt = 0; attempt < 6; attempt++) {
        const current = await db.resGet(key);
        const fence = crypto.randomUUID();
        const record = { fence, data: current && typeof current === "object" && "data" in current ? current.data : null };
        const taken = current === null
          ? await db.resInsert(key, record)
          : await db.resCas(key, current.fence, record);
        if (!taken) continue;
        let held = true;
        const lease = {
          async read() {
            const r = await db.resGet(key);
            return r && r.data !== undefined ? r.data : null;
          },
          async write(data) {
            if (!held) throw new Error("lease_lost");
            const r = await db.resGet(key);
            if (!r || r.fence !== fence) {
              held = false;
              throw new Error("lease_lost");
            }
            const ok = await db.resCas(key, fence, { fence, data });
            if (!ok) {
              held = false;
              throw new Error("lease_lost");
            }
            return true;
          },
          async assertHeld() {
            const r = await db.resGet(key);
            if (!r || r.fence !== fence) {
              held = false;
              throw new Error("lease_lost");
            }
          },
        };
        return await callback(lease);
      }
      throw new Error("lock_busy");
    },
  };
}
