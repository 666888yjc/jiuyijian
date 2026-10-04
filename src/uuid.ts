// 任务／资料的 id：必须是合法 UUID v4 形状。
// 为什么不用 `crypto.randomUUID()`：那是**安全上下文专属**的 API。手机走内网 http 地址
// （例如 `http://192.168.0.104:4236/`）打开时 `window.isSecureContext === false`，`crypto.randomUUID`
// 压根不存在 ⇒ 「保存并去上传资料」点下去只抛一个 TypeError，界面上没有任何反应（2026-09-28 主理人在手机上实测到，
// 而我第一次把根因猜成了输入法那次事件，因为桌面端 `127.0.0.1` 是安全上下文、照不出来）。
// `crypto.getRandomValues` 不受这条限制，所以这里用它自己拼 v4；形状必须过得了删除账本那道"只认 UUID"的判据。
const HEX = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export function newUuid(randomValues?: (arr: Uint8Array) => Uint8Array): string {
  const fill =
    randomValues ??
    ((arr: Uint8Array) => {
      globalThis.crypto.getRandomValues(arr);
      return arr;
    });
  const b = fill(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10xx
  const h = HEX(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
