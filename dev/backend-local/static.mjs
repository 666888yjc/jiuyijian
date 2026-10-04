// 静态产物托管：`dev/serve-app.mjs`（交付包前门）与 `dev/local-app/server.mjs`（本机识别链路）共用这一份。
//
// 为什么搬出来（R123）：本机服务器要发的就是同一份 `dist/`，而这里的两处细节都是**用真事故换来的**——
// 路径穿越要 403、以及"先读成功再写响应头"（R103 实测：请求一个"是目录却没有 index.html"的路径时，
// 旧写法先 writeHead 再 readFile 抛错、catch 里又写一次头 ⇒ ERR_HTTP_HEADERS_SENT 未捕获 ⇒ 整个前门进程死掉）。
// 再抄一份就等于把这些教训复制一遍而不是共享一遍。
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
  ".ico": "image/x-icon", ".woff2": "font/woff2", ".pdf": "application/pdf",
};

/** 两种布局的产物位置不同（包内 `app/dist` ／ 仓库 `dist`）：按"哪份里有 index.html 用哪份"解析 */
export function resolveDistRoot(candidates = ["app/dist", "dist", "../dist"], fromDir = resolve(fileURLToPath(new URL("./", import.meta.url)), "..", "..")) {
  const list = candidates.map((p) => (resolve(p) === p ? p : resolve(fromDir, p)));
  return list.find((p) => existsSync(join(p, "index.html"))) ?? null;
}

export function distCandidatesReport(candidates = ["app/dist", "dist", "../dist"], fromDir) {
  return candidates.map((p) => (resolve(p) === p ? p : resolve(fromDir ?? process.cwd(), p)));
}

/**
 * 发一个静态文件；找不到就回 SPA 的 `index.html`（前端是 hash 路由，深链接落到哪个路径都要能开）。
 * @param {{ res: import("node:http").ServerResponse, root: string, rawUrl: string }} args
 */
export async function serveStatic({ res, root, rawUrl }) {  const raw = decodeURIComponent(String(rawUrl || "/").split("?")[0].split("#")[0]);
  const p = resolve(root, raw.startsWith("/") ? raw.slice(1) : raw);
  if (p !== root && !p.startsWith(root + sep)) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("forbidden");
    return;
  }
  try {
    let f = p;
    if ((await stat(f)).isDirectory()) f = join(f, "index.html");
    // 先读文件、读成功才写响应头（见文件顶 R103 那段）
    const bytes = await readFile(f);
    res.writeHead(200, { "content-type": MIME[extname(f).toLowerCase()] || "application/octet-stream", "cache-control": "no-store" });
    res.end(bytes);
  } catch {
    try {
      const spa = await readFile(join(root, "index.html"));
      if (!res.headersSent) res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-store" });
      res.end(spa);
    } catch {
      if (!res.headersSent) res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
    }
  }
}
