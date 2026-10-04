import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { installErrorLogging } from "./errorLog";
import "./globals.css";

installErrorLogging();

createRoot(document.getElementById("root")!).render(
  <StrictMode><App /></StrictMode>,
);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    // 退役旧路径注册（/sw.js）：2026-09-24 发现发布通道边缘对 SW 注册请求钉住旧文件
    // （页面请求全是新版、SW 注册请求却拿到 20:05 旧版，4/4 全新 context 实测），
    // 改名 sw-v2.js 做缓存击穿——新 URL 在任何边缘节点都是 miss，只能回源取当前版本。
    // 老访客浏览器里的旧注册在此卸载，新注册接管同一 scope；退役失败不阻塞新注册。
    try {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(
        regs.map((r) =>
          r.active && r.active.scriptURL.endsWith("/sw-v2.js")
            ? Promise.resolve()
            : r.unregister(),
        ),
      );
    } catch {
      /* 退役失败不阻塞新注册 */
    }
    navigator.serviceWorker.register("/sw-v2.js").catch(() => {});
  });
}
