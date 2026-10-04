/* 就医笺 PWA：应用壳离线可打开；业务数据与 Function 一律不缓存 */
/* 壳缓存白名单制：只有带应用标记（id="root"）的 HTML 才允许进缓存。
   2026-09-24 修复前，install 的 addAll 与 navigate 策略把任意 200 响应当成壳写入——
   CloudBase 测试域名对新访客下发的拦截页因此被缓存成 /index.html，
   离线打开看到的是拦截页而不是应用（round14/A3，回归测试 v25 守住这条边界）。 */
const CACHE = "jiuyijian-shell-v11";
const SHELL = ["/", "/index.html", "/manifest.webmanifest", "/icons/icon-512.png"];
// 入缓存走**白名单**而不是"除黑名单外都缓存"：只有静态资源目录与壳文件可以被缓存。
// 老写法是黑名单，里面点名列了开发期路由前缀 ⇒ 两桩问题：新增任何后端路由都会被静默缓存，
// 而且把内部开发路径印进了线上产物（R34 的产物审计扫出来的就是这条，故此处刻意不写出那些字面量）。
const CACHEABLE_PREFIXES = ["/assets/", "/icons/"];
const SHELL_MARKER = 'id="root"'; // 应用壳 index.html 的根节点标识

function isCacheable(pathname) {
  return SHELL.includes(pathname) || CACHEABLE_PREFIXES.some((p) => pathname.startsWith(p));
}

function isAppShellHtml(text) {
  return text.includes(SHELL_MARKER);
}

/**
 * 静态资源的响应必须**真是资源**。R41 实测：请求一个不存在的 `/assets/pdf.worker.mjs`
 * （pdf.js 内置的默认 worker 名，产物里其实叫 `pdf.worker.min-<hash>.mjs`），
 * 开发/线上主机的 SPA 回退会给 **200 + text/html**，body 就是 index.html。
 * 只看 `res.ok` 就会把一张 HTML 存成 JS 键；下次离线以 module 身份取到 HTML ⇒ SyntaxError 白屏
 * —— 正是 R38 那条"缓存里有 ≠ 取的时候能用"的另一半。HTML 只能以 HTML 的身份入壳（走上面的应用标记过门）。
 */
function isAssetLikeResponse(pathname, res) {
  if (pathname === "/" || /\.html?$/i.test(pathname)) return true; // 壳 HTML 由 isAppShellHtml 单独把关，这里不误伤
  return !/text\/html/i.test(res.headers.get("content-type") || "");
}

/** 预缓存的单个资源：非 200、或被 SPA 回退伪装成资源的 HTML，一律不入壳 */
async function putAsset(c, url, res) {
  if (!res.ok || !isAssetLikeResponse(new URL(url, self.location).pathname, res)) return false;
  await c.put(url, res.clone());
  return true;
}

/**
 * 从壳缓存里取一份响应：先按标准匹配，**再按路径名兜一次**。
 * 需要兜底是 R38 实测出来的：install 时用字符串键 put 的资源，页面以 module/stylesheet 身份来取时，
 * 标准 `caches.match(req)` 在 Chrome 下会 miss（同一份缓存用 `new Request(url,{mode:'cors'})` 手工匹配却 HIT），
 * 于是回落到 fetch → 离线时 ERR_FAILED → 首屏白页。路径名比对不依赖这些匹配细节。
 */
async function fromCache(url) {
  try {
    const c = await caches.open(CACHE);
    const direct = await c.match(url);
    if (direct) return direct;
    const p = new URL(url, self.location).pathname;
    for (const key of await c.keys()) {
      try { if (new URL(key.url).pathname === p) return await c.match(key); } catch { /* 单键异常跳过 */ }
    }
  } catch { /* 缓存不可用当作未命中，交给网络 */ }
  return null;
}

/**
 * 离线壳必须**自己把整包静态资源抓下来**，不能等请求路过再缓存：用户第一次打开时 SW 还没接管这个页面，
 * 首屏那批请求根本不经过 SW ⇒ "壳"其实是个空壳。R38 实测（杀掉源端口再刷新）分两步暴露：
 *   ① 只缓存 HTML 时页面 1181 字节、React 从未启动；
 *   ② 连入口 chunk 一起缓存后**仍然全白**——入口里 Vite 把所有 chunk 名字写成字符串数组
 *     （懒加载路由、共享组件都在里面），React 一 import 就撞上不可达的源。
 * 所以这里做 BFS：HTML 直挂 → 每个 JS 里出现的 assets/*.js 与 ./xxx.js → 全部入壳。
 * 只碰白名单（/assets/、/icons/、壳清单），单个失败不阻断安装。
 * 两道总量闸：**条数** 200 与 **字节** MAX_SHELL_BYTES。字节这道是给手机用的——
 * 采集器每变宽一次，壳就会多吃一截（R41 认出反引号里的 worker 后，1.34MB 的 worker 脚本就进来了），
 * 只按条数设闸等于"最多 200 个 404 也认了"，挡不住产物长大。
 * 队列是插入序（HTML 直挂的先走）⇒ 超预算时**先牺牲边缘 chunk，留住首屏必需的那批**，
 * 部分壳仍比空壳有用（运行时那条路会把剩下的按需补上）。
 */
const MAX_SHELL_BYTES = 12 * 1024 * 1024;

async function precacheBundle(c) {
  let html = "";
  try {
    html = await (await c.match("/index.html") || await fetch("/index.html")).text();
  } catch { return 0; }
  if (!isAppShellHtml(html)) return 0; // 拿到的不是应用壳（拦截页等）⇒ 一个都不预缓存
  const queue = new Set();
  const push = (p) => { if (p.startsWith("/assets/") || p.startsWith("/icons/")) queue.add(p); };
  for (const m of html.matchAll(/(?:src|href)="(\/(?:assets|icons)\/[^"]+)"/g)) push(m[1]);
  const collectFromJs = (text) => {
    // 三种写法都要吃到（R41 实测两桩：只写 `assets/…js` 会漏掉绝对路径的 .mjs；
    // 而 pdf.js 的 worker 在产物里是 **反引号**模板串 `$r.workerSrc=\`/assets/pdf.worker.min-….mjs\``，
    // 只认引号的话 worker 永远不入壳 ⇒ 离线上传 PDF 必失败）：
    //   "assets/x.js"（Vite mapDeps）、"./x.js"（同目录 chunk）、`/assets/x.mjs`（?url 注入的资源）
    for (const m of text.matchAll(/[`"']((?:\.?\/)?assets\/[^`"']+\.(?:js|mjs)|\.\/[^`"']+\.m?js)[`"']/g)) {
      const p = m[1];
      if (p.includes("..")) continue; // 带 ../ 的字面量归一后会逃到 /assets 外面，fetch 到的其实是根路径资源，绝不入壳
      push(p.startsWith("/assets/") ? p : p.startsWith("assets/") ? `/${p}` : p.startsWith("./") ? `/assets/${p.slice(2)}` : p);
    }
  };
  const seen = new Set();
  let cached = 0;
  let bytes = 0;
  while (queue.size && seen.size < 200 && bytes < MAX_SHELL_BYTES) {
    const url = queue.values().next().value;
    queue.delete(url);
    if (seen.has(url)) continue;
    seen.add(url);
    try {
      const res = await fetch(url);
      const len = Number(res.headers.get("content-length"));
      const size = Number.isFinite(len) && len > 0 ? len : 0; // 拿不到长度（chunked）时按 0 记，仍受条数闸约束
      if (bytes + size > MAX_SHELL_BYTES) continue; // 这个塞不下：跳过它，让更小的边缘资源还有机会（不是整体停）
      // 只看 res.ok 不够：产物里不存在的 /assets/*.mjs（pdf.js 的默认 worker 名就是这种）会被
      // SPA 回退成 **200 + text/html**，于是离线壳里存着一堆"以 JS 为名的 HTML"（实测 5251：/assets/pdf.worker.mjs → 200 text/html 1530B）。
      // 离线时模块脚本拿到 HTML 就是 SyntaxError ⇒ 白屏回到 R38 那一类，所以资源位只收真资源。
      if (!await putAsset(c, url, res)) continue;
      const body = url.endsWith(".js") ? await res.text() : null;
      cached += 1;
      bytes += size || (body ? body.length : 0);
      if (body) collectFromJs(body);
    } catch { /* 单个失败不阻断：壳可以不完整，不能是错误的 */ }
  }
  return cached;
}

self.addEventListener("install", (event) => {
  // 逐个校验后再入壳：拦截页（200 且 text/html 但无应用标记）不得污染壳缓存；
  // 单个资源失败不阻断安装（壳可以是不完整的，不能是错误的）。
  event.waitUntil((async () => {
    const c = await caches.open(CACHE);
    for (const url of SHELL) {
      try {
        const res = await fetch(url);
        if (!res.ok) continue;
        if (!isAssetLikeResponse(url, res)) continue; // 清单/图标位也不许收 SPA 回退出来的 HTML
        const ct = res.headers.get("content-type") || "";
        if (ct.includes("text/html")) {
          const copy = res.clone();
          if (!isAppShellHtml(await copy.text())) continue;
        }
        await c.put(url, res);
      } catch { /* 单个资源失败不阻断安装 */ }
    }
    await precacheBundle(c);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then(async (res) => {
          // 网络优先，但只把应用壳写进缓存：拦截页等非应用 HTML 一律过门不入
          const ct = res.headers.get("content-type") || "";
          if (res.ok && ct.includes("text/html")) {
            const copy = res.clone();
            const text = await copy.text();
            if (isAppShellHtml(text)) {
              caches.open(CACHE)
                .then((c) => c.put("/index.html", new Response(text, { headers: res.headers })))
                .catch(() => {});
            }
          }
          return res;
        })
        .catch(() => fromCache("/index.html").then((hit) => hit || fromCache("/").then((h) => h || Response.error()))),
    );
    return;
  }
  // 静态资源：只有白名单目录/文件才走"缓存优先"，其余（Function、签名 URL 之外的任何新路由）一律直连，
  // 不会被写进壳缓存——业务数据与开发期路径都不该出现在离线壳里。
  if (!isCacheable(url.pathname)) return;
  event.respondWith(
    fromCache(req.url).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok && isAssetLikeResponse(url.pathname, res)) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        }),
    ),
  );
});
