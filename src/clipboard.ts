// 复制文字到剪贴板：**一处实现，两页共用**（交接单与复诊摘要原来各写一份，而其中一份在失败时什么都不说）。
// 为什么必须收在一处并返回成败：`navigator.clipboard` 也是**安全上下文专属**——内网 http 地址（手机测试入口）下它是
// `undefined`，`await navigator.clipboard.writeText(...)` 直接抛 TypeError；复诊摘要那一页原先 `catch {}` 静默吞掉，
// 于是用户按下「复制纯文本」后既没复制、也没任何解释（与 R68／R84 立的"做不到必须说清为什么"同一条纪律）。
export const CLIPBOARD_UNAVAILABLE_NOTICE =
  "这台设备上的浏览器不允许这个页面写入剪贴板（走内网 http 地址时常见）。下面框里就是本该复制的文字，请长按选中后复制。";

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 往下走兜底：能选中就选不中也要给一句实话
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
