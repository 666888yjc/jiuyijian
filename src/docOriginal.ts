// 「这条资料到底能回看到什么」——资料级判据的唯一出处（R72）。
//
// 为什么又是一处、而不是复用 R67 那张字段级的表：
// R67 的 `sheet.evidenceAffordance` 回答的是"**这个字段**能不能指认到原文的哪一行/哪一页"；
// 这里回答的是"**这份资料**的原件此刻到底在不在能拿到的地方"。层级不同，纪律同一条：
// **判据、措辞、入口必须由同一处导出**——否则就会出现"给了入口却兑不了诺"。
//
// 触发这一轮的实测（2026-09-27 真浏览器，产物 `index-D85LuhWS.js`，停源态）：
// 本机模式上传一张 12.4MB 照片，列表写着「image/png · 12660 KB · 共 1 页」，下面挂着「查看原件内容」，
// 真点开 `<details>` 里**只有标题那一行**（32 个字符，没有图、也没有文字）。
// 原因在本机模式的留存规则：只有 ≤1.5MB 的图片才会把字节内联进浏览器（`MAX_INLINE_IMAGE`），
// 其余只登记名称／类型／大小。于是那个入口承诺的是一件它做不到的事——
// 与 R67 抓到的"手工补录字段的「原文证据」死链"同一类，这是第二处，且 R71 放开超限照片后更容易被点到。
//
// 三条刻意的取舍：
// ① **有 `objectPath` 就算 object，即使此刻云端不可达**。不能因为连不上就改口说"本机没留原件"——
//    它在服务器上，这是事实；展不开时由 `PageView` 自己说「原件暂时无法载入」（那句已经是对的）。
//    把"按下取不到"说成"从来没有"，是 R68 那一类错误（拿不可确认当否定）的另一面。
// ② 只有解析出的文字时，入口**不许叫"原件内容"**：原件图像并不在这台设备上，能看的是文字。
// ③ 「怎么办」那句跟着云端可达性走（R68 的纪律）：链路不可达时不指挥用户此刻去登录。
import type { SourceDocument } from "./types";

export type DocOriginalLevel = "inline" | "object" | "objectNoPages" | "text" | "markers" | "none";

export interface DocOriginalAffordance {
  level: DocOriginalLevel;
  /** 给不给"展开看"这个入口 */
  offer: boolean;
  /** 入口的措辞（别处引用这个入口时也必须用同一个名字） */
  label: string;
  /** 展开后你实际会看到什么 */
  noun: string;
  /** 只在 `offer===false` 的那一档（`none`）有：这台设备上到底留下了什么、以及为什么 */
  why?: string;
  /** 只在 `objectNoPages` 有：入口给的是**整份原件**（从站点存储取原件本身逐页渲染），不是本机记下的那些页 */
  wholeFile?: boolean;
  /** 只在 `wholeFile===true` 的那一档有：展开后**必须先说清**这里看的是原件本身、页数以原件为准 */
  note?: string;
}

export interface DocOriginalInput {
  /** 云端链路此刻能不能真的把原件写进站点存储（= serverMode && signedIn && 任务可同步） */
  serverUpload: boolean;
  /** 这条任务**本身**参不参与同步（内置示例任务永远不参与）——出路那句必须按它分支，见 missingOriginalNotice */
  taskSyncable: boolean;
  /** 云端链路此刻的状态：只有真的不可达时，才允许说「等云端链路可用」 */
  backend: "checking" | "up" | "down";
  /** 本机内联图片的体积上限：超过它，图片字节就不会留在浏览器里 */
  inlineLimitBytes: number;
}

const AFFORDANCE: Record<DocOriginalLevel, Pick<DocOriginalAffordance, "offer" | "label" | "noun" | "wholeFile">> = {
  inline: { offer: true, label: "查看原件内容", noun: "这台设备上留着的那张图（内联副本）" },
  object: { offer: true, label: "查看原件内容", noun: "站点存储里的原件" },
  // R103 把这一档关成"没有入口"，理由是展开走的是「按本机记下的每一页逐个取回」——一页都没记下就是 0 个子节点
  // （真浏览器实测）。R109 改的是**取页的依据**而不是关掉事实：原件就在站点存储里，页数以原件本身为准，
  // 于是这一档拿到的是另一种入口（整份原件查看器），措辞与"按本机页码展开"那档必须分开，不许混用同一个名字。
  objectNoPages: {
    offer: true,
    wholeFile: true,
    label: "查看整份原件",
    noun: "从站点存储取回的原件本身（整份逐页渲染，页数以原件为准，不看本机记没记下）",
  },
  text: { offer: true, label: "查看已解析的页面文字", noun: "从原件解析出来的文字（原件图像没有留在这台设备上）" },
  markers: { offer: true, label: "查看逐页说明", noun: "每一页有没有内容的标记（这一份没解析到文字）" },
  none: { offer: false, label: "", noun: "没有留在这台设备上、也无法从存储取回的原件内容" },
};

/** 这份资料的原件此刻能以什么形式被回看 */
export function docOriginalAffordance(doc: SourceDocument, i: DocOriginalInput): DocOriginalAffordance {
  const hasBlocks = doc.pages.some((p) => p.blocks.length > 0);
  const hasMarkers = doc.pages.some((p) => p.empty);
  const noPages = doc.pages.length === 0;
  const level: DocOriginalLevel =
    // 顺序是刻意的：能从本机立刻拿到的排在前面，别拿一个更远的说法盖过近在手边的答案
    doc.pages.some((p) => p.imageDataUrl) ? "inline"
      : noPages && doc.objectPath ? "objectNoPages"
        : doc.objectPath ? "object"
          : hasBlocks ? "text"
            : hasMarkers ? "markers"
              : "none";
  if (level === "objectNoPages") {
    // R72 取舍①在这一档仍然是第一位的：原件确实在服务器上，不许因为它一度展不出就改口说"本机没留原件"。
    // R103 的缺陷本体是"入口按本机记下的页取，一页都没记下却还给这个入口"⇒ 点开是空白。
    // R109 的修法是把这一档换成**另一件东西**：整份原件（页数由原件本身给出），并把差别写在展开里说清；
    // 而不是继续关掉事实、也不是把「查看原件内容」这个名字复用到这里（那两个名字指的是两种取法）。
    return {
      level,
      ...AFFORDANCE[level],
      note:
        "本机没有记下这份资料的任何一页（这一份没能解析出页面，或它的文字层被任务预算整份裁走了），" +
        "所以下面不是按本机页码展开的——这里是从站点存储里取回的那份原件本身，页数与内容都以原件为准。",
    };
  }
  if (level !== "none") return { level, ...AFFORDANCE[level] };
  // 一句都不许含糊：到底留下了什么、为什么没留下。体积缺失时不许拿 0KB 冒充事实
  const bytes = typeof doc.fileSize === "number" && doc.fileSize > 0 ? doc.fileSize : null;
  const why = bytes === null
    ? "本机模式只登记这份资料的名称、类型和大小，原件本体没有留在这台设备上（只有不超过 "
      + Math.round(i.inlineLimitBytes / 1024) + "KB 的图片才会内联存进浏览器）。"
    : bytes > i.inlineLimitBytes && doc.mime && /image\//.test(doc.mime)
      ? `本机模式只把不超过 ${Math.round(i.inlineLimitBytes / 1024)}KB 的图片内联留在浏览器里，这张 ${Math.round(bytes / 1024)}KB 的图超过了那道门槛，所以本体没有留下，登记的只有名称、类型和大小。`
      : `本机模式没有留下这份资料的本体（只有不超过 ${Math.round(i.inlineLimitBytes / 1024)}KB 的图片会内联存进浏览器），这里记录的是 ${Math.round(bytes / 1024)}KB 这个大小本身。`;
  // 这一档同样从表里出：入口关不关、叫什么，不许在函数里另写一份（否则表就成了摆设）
  return { level, ...AFFORDANCE.none, why };
}

/**
 * 没有展开入口时给家属看的那一句。
 *
 * R102 之前只按「这份资料有没有存到服务器」两分支，于是内置示例任务（**这条任务本身永远不参与同步**）
 * 在云端链路明明可用的时候，也被说成「得等云端链路可用时…」——那是把**任务的属性**说成**链路的状态**，
 * 与 R68/R84 那条纪律相反（不许把做不到的原因说成别的原因）。现在按三个事实分支：
 * 这份资料有没有上云 → 这条任务参不参与同步 → 云端链路此刻通不通。
 */
export function missingOriginalWayOut(i: DocOriginalInput): string {
  if (i.serverUpload) return "需要能回看原件的话，就在这个走云端存储的任务里重新上传一次。";
  if (!i.taskSyncable) {
    return i.backend === "up"
      ? "这条任务（内置示例）只存在这台设备上、不会存到服务器，所以这里永远没有原件可展开；要能回看原件，请新建一条任务再上传，那条会走云端存储。"
      : "这条任务（内置示例）只存在这台设备上、不会存到服务器；等云端链路可用时新建一条任务再上传，才能回看原件。";
  }
  return i.backend === "up"
    ? "这条任务此刻没有走云端存储（未登录或未开启云端存储），所以本机没留下原件；开启云端存储并登录后，重新上传一次就能回看。"
    : "这条任务此刻没有走云端存储，而云端链路目前也不可达；等链路可用、开启云端存储并登录后，重新上传一次才能回看。";
}

/**
 * 没有展开入口时给家属看的那一句（`offer===false` 那一档）。
 *
 * 这一句的前件写在函数自己身上：入口存在时**不许**说「没有可以展开的原件内容」——那是假话，
 * 而假话在这里的代价是家属以为原件没了（R72 取舍①指的就是这一类）。R103 ⑦ 钉的是页面控制流，
 * 这一条钉的是句子本身：谁把有入口的那一档递进来，拿到的就是这一档自己的说明，不是"没有"。
 */
export function missingOriginalNotice(doc: SourceDocument, i: DocOriginalInput): string {
  const a = docOriginalAffordance(doc, i);
  if (a.offer) return a.note ?? a.noun;
  return `没有可以展开的原件内容：${a.why ?? AFFORDANCE.none.noun}${missingOriginalWayOut(i)}`;
}

/* ---------------------------------------------------------------------------
 * 整份原件查看器（R109）——`objectNoPages` 那一档的入口背后到底是什么。
 *
 * 这里放的是**这个查看器能给到哪一步、给不到时怎么说**的唯一出处，与上面那张表同一纪律：
 * 措辞由这一处导出，页面只负责按状态挑句子。三条不可让的：
 *  ① 取地址只有一个出口（`src/fileUrlCache.ts`，R78）——查看器不许自己再发一发 `file-url`；
 *  ② 签名地址是**会过期的凭据**，只进 DOM 属性，不落任何本机存储、不进日志（R78 那条边界的另一侧）；
 *  ③ 取不到、渲染不出、给了多少页，是三件不同的事，各说各的（R41：把网络问题说成文件问题会让人重拍一份没坏的东西）。
 * ------------------------------------------------------------------------ */

/** 一次最多渲染多少页：pdf.js 是逐页画到 canvas 的，页数不设上限就等于在浏览器里放一个无界的内存坑 */
export const WHOLE_FILE_PAGE_CAP = 20;

/** 「在新标签打开原件」那一行的措辞：这里不许承诺"一定能显示"——打开还是下载由这台设备的浏览器决定 */
export const WHOLE_FILE_LINK_LABEL = "在新标签打开原件";
export const WHOLE_FILE_LINK_HINT =
  "（这一行是把这个原件的地址交给浏览器自己处理：可能直接显示，也可能转为下载，取决于这台设备。" +
  "签名地址有有效期，过期后重新展开这一行会再取一枚新的。）";

/**
 * 页数披露：给了多少、没给多少。被上限切断时必须点名"还有几页没显示"并给一条真存在的出路
 * （R76 那条口径：剪了多少要说得出数，不许安静地少给）。
 */
export function wholeFilePagesNotice(total: number, shown: number): string {
  if (shown >= total) return `这份原件共 ${total} 页，这里全部画出了。`;
  return `这份原件共 ${total} 页，这里画出了前 ${shown} 页，另外 ${total - shown} 页没有显示`
    + `（一次最多渲染 ${WHOLE_FILE_PAGE_CAP} 页）。要看整份，请用下面那一行「${WHOLE_FILE_LINK_LABEL}」。`;
}

/** 连地址／字节都没取回来。这一句永远不许说成"本机没留原件"（R72 取舍①），也不许指挥用户此刻去做链路不通时做不到的动作（R68） */
export function wholeFileUnavailableNotice(i: DocOriginalInput): string {
  return i.backend === "down"
    ? "这一次没有从站点存储取回原件：云端链路目前不可达。原件本身仍加密保存在站点存储里，这里没有说它不在了；等链路可用后重新展开这一行可以再取一次。"
    : "这一次没有从站点存储取回原件（地址没换到或字节没下载完）。原件本身仍加密保存在站点存储里，这里没有说它不在了；稍后重新展开这一行可以再取一次，急用可先人工录入。";
}

/**
 * 字节明明取回来了、这一页却画不出来——与上面那句是两件事，措辞必须能听出"东西在手上了"。
 * 三种原因分开：渲染组件本身没加载（与文件好坏无关）、这份 PDF 打不开、图片格式这台设备显示不了。
 */
export type WholeFileRenderCause = "asset" | "pdf-unopenable" | "image-undisplayable";

export function wholeFileRenderFailureNotice(cause: WholeFileRenderCause): string {
  switch (cause) {
    case "asset":
      return "原件已经取回来了，但渲染组件（工作线程）这次没有加载出来，这与文件本身无关。恢复网络后重新展开这一行可以再试一次。";
    case "pdf-unopenable":
      return "原件已经取回来了，但这份 PDF 打不开（可能为加密或损坏）：本机当初没能从它解析出页面，现在浏览器里也画不出它。"
        + `可以用下面那一行「${WHOLE_FILE_LINK_LABEL}」交给浏览器自己试一次，或用这一行的「替换」重传一份能打开的文件；未确认的字段请先人工录入。`;
    case "image-undisplayable":
      return "原件已经取回来了，但这台设备上的浏览器显示不了这种图片格式（不是原件没了）。"
        + `可以用下面那一行「${WHOLE_FILE_LINK_LABEL}」交给浏览器自己试一次，或用这一行的「替换」重传一份 JPG/PNG。`;
  }
}
