// 「一份资料的签名地址取几次」——唯一一处（R78）。
//
// 为什么要这一处：`useSignedFileUrl` 以前每次挂载都重新申请一次签名地址，而**展开一份 PDF 资料就是每页一个缩略图**
// ⇒ 一份 20 页的资料点开一次，夹具/服务端侧 `file-url` 计数 **+20**（真产物实测：传 1 份 ⇒ +20、3 份 ⇒ 累计 +153、4 份 ⇒ +229）。
// 这不是崩溃，是每多看一页就多打一发鉴权请求——同一份原件的地址被问了 20 遍。
// 收成一处之后同时拿到三件事：① **同一次展开只取一发**（in-flight 合并，20 个挂载等同一个 promise）；
// ② **取到之后短时间内复用**（TTL 见下面那个数，必须明显短于服务端签发的时长）；
// ③ 失败**不进缓存**（一次网络抖动不许把这份资料的原件永久锁成"看不到"）。
//
// 与 R71/R72 那条纪律的关系：这里缓存的是**签名地址**（会过期的凭据），不是资料内容；
// 缓存的边界写在数字上（TTL＋条数上限），不许有人把它改成"永久缓存"——那等于在浏览器里存一枚不再有效的凭据还当能用。
import { api } from "./api";

/** 服务端签的是 300 秒（`functions/handler.mjs`：`createSignedUrl(objectPath, 300)`），这条由 A 组与那边对账 */
export const SERVER_SIGNED_TTL_SEC = 300;
/** 本机复用时长：留足一分钟余量，避免"本机以为还有效、服务端已拒"的那种半路失效 */
export const FILE_URL_TTL_MS = 240_000;
/** 最多记多少份资料的地址（与同步锚点账同一条纪律：有上限、丢最旧） */
export const FILE_URL_CACHE_CAP = 60;

export interface FileUrlEntry {
  url: string;
  mime: string;
  /** 本机认为这枚地址还有效的截止时刻（Date.now() 口径） */
  until: number;
}

const cache = new Map<string, FileUrlEntry>();
const inflight = new Map<string, Promise<FileUrlEntry>>();

/** 只在本机侧丢账：换过原件（替换／删除）之后，旧地址不能再被复用 */
export function forgetFileUrl(docId: string) {
  cache.delete(docId);
}

/**
 * 要**下载整份原件**的那条路（识别入参）用的入口：先丢账再取，拿到的必是一枚新签的地址。
 * 仍然只有"取地址"这一个出口——不许那条路自己再去开一发 `api.fileUrl`。
 */
export function fetchFreshFileUrl(docId: string): Promise<FileUrlEntry> {
  cache.delete(docId);
  return fetchFileUrl(docId);
}

/**
 * 取一份资料的签名地址。同一个 docId 的并发调用**共用一发请求**；
 * 成功才记账（并保证不超上限），失败不记账、错误原样交给调用方去显示那一句「取不到原件」。
 */
export function fetchFileUrl(docId: string): Promise<FileUrlEntry> {
  const hit = cache.get(docId);
  if (hit && hit.until > Date.now()) {
    // 命中的那一条挪到末尾：被反复看的资料不该被最旧淘汰策略先丢掉
    cache.delete(docId);
    cache.set(docId, hit);
    return Promise.resolve(hit);
  }
  const fly = inflight.get(docId);
  if (fly) return fly;
  // 整个 src/ 里"发一发签名地址"只许出现在这一行（A 组按这条数出口数量，故不许拆行、不许有第二处）
  const p = api.fileUrl(docId).then((r) => {
      const entry: FileUrlEntry = { url: r.url, mime: r.mime, until: Date.now() + FILE_URL_TTL_MS };
      cache.set(docId, entry);
      while (cache.size > FILE_URL_CACHE_CAP) cache.delete(cache.keys().next().value as string);
      return entry;
    })
    .finally(() => {
      inflight.delete(docId);
    });
  inflight.set(docId, p);
  return p;
}

/** 护栏常量的机器可读快照：A 组用它对账"两头的时长不许各说各话" */
export const FILE_URL_BUDGET = { SERVER_SIGNED_TTL_SEC, FILE_URL_TTL_MS, FILE_URL_CACHE_CAP } as const;
