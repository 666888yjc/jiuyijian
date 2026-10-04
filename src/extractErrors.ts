// 识别失败的用户可读文案（回归层 B/A 都对着这张表取证）。
//
// 为什么单独成模块：此前"识别失败"只把服务端错误码原样贴出来（`识别失败：ai_timeout@stream`），
// 家属看到的是系统内部术语；而评审方优化清单 4.3 要的正是"分类 + 可操作文案"。
// 两条纪律：① **错误码必须仍然可见**（清单 D「识别失败提示具体错误码，不静默」），所以文案后面带（错误码 …）；
// ② 文案只说"发生了什么 + 你现在能做什么"，**不解释医学、不建议用药**（红线②）。
//
// R63：句子本身搬进 `errorCopy.ts` 单点存放。这张表以前和 `api.ts` 的通用映射各写一份，
// 7 个码两边都有但句子不一样 ⇒ 同一个失败在两条界面上说法不同；现在两边取同一份。
import { ERROR_COPY, errorCopy } from "./errorCopy";

/** 服务端错误码带 `@阶段` 后缀（如 ai_truncated@length），查表按主干 */
export function extractFailureBase(code: string | null | undefined): string {
  return String(code ?? "").trim().split("@")[0];
}

export function extractFailureText(code: string | null | undefined): string {
  return errorCopy(code);
}

/** 界面用：文案 + 具体错误码（不静默、不吞掉诊断线索）。已经是人话的（老文案/自造串）原样返回。 */
export function extractFailureLabel(code: string | null | undefined): string {
  const c = String(code ?? "").trim();
  if (!/^[a-z0-9_:@-]{2,64}$/.test(c)) return c || ERROR_COPY.unknown_extract_failure;
  return `${extractFailureText(c)}（错误码 ${c}）`;
}

