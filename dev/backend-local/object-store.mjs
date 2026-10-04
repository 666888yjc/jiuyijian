// 本机对象存储：与云端 `storage` 客户端同形状的一份实现（upload / download / remove /
// createSignedUploadUrl / createSignedUrl / list），缺省纯内存，传 `dir` 就顺带落盘。
//
// 为什么搬出来（R123）：这份逻辑原来只在 `dev/api-fixture/server.mjs` 里，且**故意不落地**
// ——测试要的是每次 `/_fixture/reset` 之后干净。本机识别链路要的是反过来：手机今天拍的化验单，
// 明天关掉进程再开还得在。两边共用同一份代码、由 `dir` 决定持不持久，就不会出现
// "夹具验过的上传链路，本机服务器上其实另一套"。
//
// 两条不放宽的地方：① **单文件上限照抄产品那份常量**（`MAX_UPLOAD_BYTES`）——超限必须当场拒，
// 否则"前端已把超限照片压进上限"（R71）这条主张在这套件上永远不可能失败，等于没测；
// ② 落盘路径必须解析后仍在 `dir` 内（对象路径来自请求可影响的字段，路径穿越就是别人的病历）。
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

/** 对象路径 → 磁盘绝对路径；越界即抛（调用方按 4xx 处理，绝不去读目录外的文件） */
export function safeObjectFile(dir, objectPath) {
  const raw = String(objectPath ?? "");
  if (!raw || raw.startsWith("/") || raw.includes("\\") || raw.includes("//")) throw new Error("object_path_invalid");
  const parts = raw.split("/");
  if (parts.some((p) => p === ".." || p === "." || !SAFE_SEGMENT.test(p))) throw new Error("object_path_invalid");
  const root = resolve(dir);
  const file = resolve(root, ...parts);
  if (file !== root && !file.startsWith(root + sep)) throw new Error("object_path_escape");
  return file;
}

/**
 * @param {{ dir?: string|null, maxSizeBytes: number, urlPrefix?: string }} options
 */
export function makeObjectStore({ dir = null, maxSizeBytes, urlPrefix = "/_fixture/upload" } = {}) {
  /** path -> { bytes: Uint8Array|null, contentType, size }；bytes===null 表示只在磁盘上，按需读回 */
  const objects = new Map();
  const objectsDir = dir ? join(dir, "objects") : null;
  const indexFile = dir ? join(dir, "index.json") : null;

  if (dir) {
    mkdirSync(objectsDir, { recursive: true });
    try {
      const index = JSON.parse(readFileSync(indexFile, "utf8"));
      for (const [path, meta] of Object.entries(index?.objects ?? {})) {
        objects.set(path, { bytes: null, contentType: meta?.contentType ?? "application/octet-stream", size: Number(meta?.bytes) || 0 });
      }
    } catch {
      // 没有 index.json ＝ 第一次起服务。有但读不动＝如实说，不装作是空的（静默清空会吃掉家属已经上传的原件）。
      try {
        if (readFileSync) {
          const stat = readFileSync(indexFile);
          if (stat && stat.length) throw new Error(`object_index_unreadable:${indexFile}`);
        }
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }

  const oversize = (n) => n > maxSizeBytes;

  const flush = () => {
    if (!dir) return;
    const out = {};
    for (const [path, item] of objects) out[path] = { contentType: item.contentType, bytes: item.size };
    const tmp = `${indexFile}.tmp`;
    writeFileSync(tmp, JSON.stringify({ objects: out }, null, 0));
    renameSync(tmp, indexFile);
  };

  const loadBytes = (path) => {
    const item = objects.get(path);
    if (!item) return null;
    if (item.bytes) return item;
    if (!dir) return null;
    try {
      item.bytes = new Uint8Array(readFileSync(safeObjectFile(objectsDir, path)));
      item.size = item.bytes.byteLength;
      return item;
    } catch {
      return null;
    }
  };

  const put = (path, bytes, contentType = "application/octet-stream") => {
    const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (oversize(buf.byteLength)) throw new Error(`local_storage_object_too_large:${buf.byteLength}`);
    objects.set(path, { bytes: buf, contentType, size: buf.byteLength });
    if (dir) {
      const file = safeObjectFile(objectsDir, path);
      mkdirSync(file.slice(0, file.lastIndexOf(sep)), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, buf);
      renameSync(tmp, file);
      flush();
    }
    return { Path: path };
  };

  const get = (path) => loadBytes(path);

  const del = (path) => {
    objects.delete(path);
    if (dir) {
      try {
        rmSync(safeObjectFile(objectsDir, path), { force: true });
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      flush();
    }
  };

  const signedUrlFor = (path) => `${urlPrefix}/${encodeURIComponent(path)}`;

  const storage = {
    async upload(path, source, { contentType } = {}) {
      const buf = new Uint8Array(await new Response(source).arrayBuffer());
      return put(path, buf, contentType);
    },
    async download(path) {
      const item = loadBytes(path);
      if (!item) return new Response(null, { status: 404 });
      return new Response(item.bytes, { headers: { "content-type": item.contentType } });
    },
    async remove(paths) {
      for (const p of paths) del(p);
      return [];
    },
    async createSignedUploadUrl(path) {
      return { signedUrl: signedUrlFor(path) };
    },
    async createSignedUrl(path) {
      return { signedUrl: signedUrlFor(path) };
    },
    async list() {
      return { keys: [...objects.keys()].map((name) => ({ name })) };
    },
  };

  return {
    objects,
    oversize,
    put,
    get,
    del,
    flush,
    has: (path) => objects.has(path),
    reset: () => {
      objects.clear();
      if (dir) {
        rmSync(objectsDir, { recursive: true, force: true });
        mkdirSync(objectsDir, { recursive: true });
        flush();
      }
    },
    storage,
  };
}
