// CloudBase 存储版的 storage 适配器：接口与 handler 用的那四个方法对齐
// （createSignedUploadUrl／createSignedUrl／download／remove，见 handler.mjs:139/150/168/124）。
//
// 与本地文件版（dev/backend-local/object-store.mjs）的一处关键差异：**「签名 URL」指回函数
// 自己的对象路由**（`/_tcb/object/<路径>`），字节的进出都经过函数。原因有两层：
//   ① CloudBase 存储没有 S3 那种预签名 PUT，浏览器没法直传；
//   ② 更重要的：把存储桶的永久公开链接当「签名 URL」发给前端＝患者原件裸奔，
//      而 handler 的契约是「会过期的凭据，只进 src/href，不落存储」（R78 那一族）。
// 于是对象路由的两道校验就是安全边界本身：路径段形状＋**归属**。
//
// 归属校验的根据：对象路径的第二段就是 owner 的 SHA-256 前 16 位（生成规则在
// handler.mjs:137，那边是唯一真源）。路由侧镜像同一算法比对——改生成规则必须同步这里，
// 两边不一致时表现是「取不回自己的原件」（fail-closed，不是把别人的送出去）。
import { UPLOAD_MIMES } from "../../functions/validate.mjs";

// ext→mime 反推表：从 validate.mjs 的 UPLOAD_MIMES（唯一真源）现算，不手抄第二份。
// 拿不到对应 mime 的路径，download 直接抛——upload-complete 的校验会因此 fail-closed 成 422，
// 而不是猜一个 content-type 把字节放过去。
const EXT_TO_MIME = new Map([...UPLOAD_MIMES].map(([mime, ext]) => [ext, mime]));
export { EXT_TO_MIME };

// 与 dev/backend-local/object-store.mjs:15 同规。那一侧还有两道文件系统逃逸锁（resolve 后比前缀），
// 这一侧不需要：存储桶的键不是文件系统路径，「..」在这里只是一个古怪键名，逃不出桶。
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

const ownerPrefix = async (ownerId) => {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ownerId));
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
};

/** 路径形状校验：docs/<owner哈希16位>/<uuid>.<ext>，三段、只许安全字符。返段落数组或 null。 */
export function objectPathParts(raw) {
  const p = String(raw ?? "");
  if (!p || p.startsWith("/") || p.includes("\\") || p.includes("//")) return null;
  const parts = p.split("/");
  if (parts.length !== 3 || parts[0] !== "docs") return null;
  if (parts.some((seg) => seg === ".." || seg === "." || !SAFE_SEGMENT.test(seg))) return null;
  return parts;
}

/** 归属校验：路径第二段必须等于调用者 owner 的哈希前缀。形状不对也返回 false。 */
export async function objectPathBelongsTo(objectPath, ownerId) {
  const parts = objectPathParts(objectPath);
  if (!parts) return false;
  return parts[1] === (await ownerPrefix(ownerId));
}

export function makeStorageTcb({ app, urlPrefix = "/_tcb/object" }) {
  if (!app || typeof app.uploadFile !== "function") throw new Error("tcb_app_missing_storage");
  const encode = (objectPath) => `${urlPrefix}/${encodeURIComponent(objectPath)}`;
  return {
    // 两个「签名」URL 都指回本函数的对象路由——路由侧做归属校验，所以它比真签名 URL 更紧：
    // 不只是「持有链接的人」，还得是「这个 owner 的设备」。
    async createSignedUploadUrl(objectPath) { return { signedUrl: encode(objectPath) }; },
    async createSignedUrl(objectPath) { return { signedUrl: encode(objectPath) }; },

    // upload-complete 的字节核验（storage-validation.mjs）要一个带 content-type 的 web Response。
    // TCB 的 downloadFile 只给字节不给类型 ⇒ 从路径扩展名反推（反推表现算自真源）。
    // 反推不出 ⇒ 抛 ⇒ 调用方 catch 成 422——「类型对不上就不许入库」，不猜。
    async download(objectPath) {
      const ext = String(objectPath).split(".").pop();
      const mime = EXT_TO_MIME.get(ext);
      if (!mime) throw new Error(`object_mime_unknown:${ext}`);
      const r = await app.downloadFile({ fileID: objectPath });
      if (!r || r.fileContent === undefined || r.fileContent === null) throw new Error("object_unavailable");
      const buf = Buffer.isBuffer(r.fileContent) ? r.fileContent : Buffer.from(r.fileContent);
      return new Response(buf, { headers: { "content-type": mime } });
    },

    async remove(paths) {
      const list = (paths ?? []).filter(Boolean);
      if (!list.length) return;
      await app.deleteFile({ fileList: list });
    },
  };
}
