// PDF 本地解析失败的可读文案（回归层 A 直接 import 这张表取证）。
//
// 为什么单独成模块：
//  ① 判据与文案要能被 Node 侧真调用（写在 DocsPage 里就只能拿正则扫源码，测不到行为）；
//     也不能放进 ../pdf —— 那会把 330KB 的 pdfjs 静态拉进主包， DocsPage 的动态 import 分割就白做了。
//  ② 两条纪律沿用 extractErrors.ts：**错误原话不外露**（家属看到的是"工作线程"这种术语没意义），
//     以及"此刻还没有的东西绝不承诺已保存"——解析发生在上传之前，所以离线分支不许说"原件已保存"。
//  ③ 文案按 serverUpload 分叉：本机模式下 PDF 原件确实不会留下（只有图片会），不能冒充云端行为。

/**
 * 区分"解析组件没取到"与"这份 PDF 读不了"。
 * 判据取 pdf.js 的原话（R41 真断网实测）：
 * `Setting up fake worker failed: "Failed to fetch dynamically imported module: …/assets/pdf.worker.min-….mjs"`
 * —— 那是离线壳没预缓存到 worker，与文件本身好坏无关。
 */
export function isPdfAssetUnreachable(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error ?? "");
  return /fake worker|workerSrc|dynamically imported module|Failed to fetch|ERR_/i.test(msg);
}

export function pdfFailureNotice(error: unknown, serverUpload: boolean): string {
  if (isPdfAssetUnreachable(error)) {
    return serverUpload
      ? "离线或网络中断：PDF 解析组件（工作线程）没能加载，这与文件本身无关。此刻原件也还没上传成功，恢复网络后请重新上传一次；急用可先人工录入。"
      : "离线或网络中断：PDF 解析组件（工作线程）没能加载，这与文件本身无关。本机模式下 PDF 原件不会留在本机，请恢复网络后重新上传，或改用截图/人工录入。";
  }
  return serverUpload
    ? "PDF 内容解析失败（可能为加密或损坏）。原件仍会照常上传保存，但这一份在本机没有记下任何一页——"
      + "资料行下面给的是「查看整份原件」：它从站点存储取回的是原件本身、页数以原件为准，这一份如果确实打不开，那里会当面说明并给出路。"
      + "未能解析出的字段请人工录入，或用这一行的「替换」重传一份能打开的文件。"
    : "PDF 内容解析失败（可能为加密或损坏）。本机模式下这份 PDF 的原件不会留在本机，只留下这条记录——请重新上传或改用截图，未解析字段人工录入。";
}

/** 解析成功但**一个字都没抽出来**：全是空白页，还是有图像没文字层（扫描件），是两件不同的事 */
export function pdfPagesHaveNoText(pages: { blocks: unknown[]; empty: boolean }[]): "none" | "blank" | "no-text-layer" {
  if (pages.length === 0 || pages.some((p) => p.blocks.length > 0)) return "none";
  return pages.every((p) => p.empty) ? "blank" : "no-text-layer";
}

/**
 * "解析成功但没有内容"也要说话。R43 的动机：扫描件外形完全正常（页面有墨、页数对得上），
 * 家属看到的却是一条安静的"共 1 页"——没有字段、没有原因，只能猜是系统漏了还是自己上传错了。
 *
 * 两条写法纪律（第一条是本轮真机量出来的，不是我推想的）：
 *  ① **不许拿登录状态当出路**。R43 实测：页头徽章是「已同步 · 夹具用户A」，而这条资料仍走本机模式
 *    ——因为"要不要上云"由任务决定（示例任务刻意不可上云）。所以"登录后可…"这种话会与徽章当面打脸；
 *    只说**产品能力事实**：云端识别目前只支持图片，不支持 PDF。
 *  ② 本机模式不做任何自动识别，不能把"换成图片"写成本机用户当下能走完的路。
 */
export function pdfNoTextNotice(kind: "blank" | "no-text-layer", serverUpload: boolean): string {
  if (kind === "blank") {
    return "这份 PDF 每一页都是空白页（常见于扫描时没送进纸、或导出只出了页框）。它不会生成任何待确认字段——请重扫后重新上传，或先人工录入。";
  }
  return serverUpload
    ? "这份 PDF 是图片型（扫描件）：页面读得出来，但没有可提取的文字层，所以不会自动生成待确认字段。要自动识别请把每一页另存为 JPG/PNG 再上传（云端识别目前只支持图片）；也可以直接人工录入。"
    : "这份 PDF 是图片型（扫描件）：页面读得出来，但没有可提取的文字层，所以不会自动生成任何待确认字段。本机模式不做任何自动识别，这条资料只会留下页数——请人工录入，或把每一页另存为图片后重新上传（云端识别目前只支持图片，不支持 PDF）。";
}

/** 动态 import 解析组件本身失败（离线壳没预缓存到 pdf chunk）——与"组件在、worker 不在"分开说 */
export function pdfModuleLoadNotice(serverUpload: boolean): string {
  return serverUpload
    ? "离线或网络中断：PDF 解析组件没能加载，这份文件还没有上传成功。恢复网络后请重新上传一次；急用可先人工录入。"
    : "离线或网络中断：PDF 解析组件没能加载。本机模式下 PDF 原件不会留在本机（只有图片会），恢复网络后请重新上传，或改用截图/人工录入。";
}
