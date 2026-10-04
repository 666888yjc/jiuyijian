import { fileURLToPath, URL } from "node:url";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 默认仍指 8000；但 8000/4180 这类端口在本机常被别的进程占着 —— 占了就静默代理到**别人的服务**，
// 界面照样能点，看到的却不是被测代码。JYJ_FIXTURE_URL 让本地复验能显式换一个自己起的夹具端口。
const FIXTURE = process.env.JYJ_FIXTURE_URL || "http://127.0.0.1:8000";
const proxy = { "/functions/v1/app": FIXTURE, "/_fixture": FIXTURE };

/**
 * 构建期给离线壳打**产物指纹**。
 * 要解决的问题：`public/sw-v2.js` 是原样拷进产物的，若某次发布只改了业务代码而没手动升 `CACHE`，
 * 浏览器认为 SW 字节没变 ⇒ 不重装、不重新预缓存，**新访客拿到新版、装过旧版的人离线时却启动旧壳**
 * （R41–R45 那几轮我在预览里反复看到"改了却没生效"，就是这个机制在起作用，当时只能靠手动 +1 压掉）。
 * 手动升版本号必被遗忘，所以让构建自己写：指纹取自 index.html 引用的入口 chunk 名（入口变＝一切变）。
 * 取不到指纹时宁可不写（保持源文件原样），也不把一个来路不明的缓存名印进产物。
 */
function stampServiceWorker(rootDir: string) {
  let outDir = "";
  return {
    name: "jyj-stamp-service-worker",
    apply: "build" as const,
    configResolved(cfg: { build: { outDir: string } }) {
      outDir = path.resolve(rootDir, cfg.build.outDir);
    },
    closeBundle() {
      // 留一个逃生口：JYJ_SW_NO_STAMP=1 构出"不指纹"的产物，用来在真浏览器里对比两种缓存名到底谁失效
      if (process.env.JYJ_SW_NO_STAMP) return;
      const swPath = path.join(outDir, "sw-v2.js");
      const htmlPath = path.join(outDir, "index.html");
      const assetsDir = path.join(outDir, "assets");
      if (!existsSync(swPath) || !existsSync(htmlPath) || !existsSync(assetsDir)) return;
      const html = readFileSync(htmlPath, "utf8");
      // 指纹必须覆盖**全部** chunk 名 + 壳 HTML 本身。R46 实测：只取入口 chunk 是不够的——
      // 改懒加载页（DocsPage/storageNotice 那类）时入口名一动不动，指纹也就不动，
      // 等于给一次真实发布打了"没变"的标记，老访客照样离线启动旧壳。
      const chunks = readdirSync(assetsDir).sort().join("\n");
      const tag = createHash("sha256").update(html + "\n" + chunks).digest("hex").slice(0, 8);
      const sw = readFileSync(swPath, "utf8");
      const m = sw.match(/const CACHE = "jiuyijian-shell-v(\d+)";/);
      if (!m) return; // 源码里缓存名的形状变了 ⇒ 不猜，交给闸门报红
      writeFileSync(swPath, sw.replace(m[0], `const CACHE = "jiuyijian-shell-v${m[1]}-${tag}";`));
    },
  };
}

export default defineConfig({
  plugins: [react(), stampServiceWorker(process.cwd())],
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  server: { host: "127.0.0.1", proxy },
  preview: { host: "127.0.0.1", proxy },
  build: { outDir: "dist" },
});
