// 「一份资料的文本层能留多少、留下的是它的几成」——唯一一处（R76）。
//
// 为什么必须有这个模块（先记一条**我自己测错**的事，免得下一个照抄这段的人以为量过了）：
// 第一版测量报的是"那份 PDF 文本层 485,999 字节，只存下 214,320 字节 = 44%，而屏幕上没有一个字说被剪了"。
// 那个 44% 不成立——责任在我方：造测试件的 `dev/make-fat-pdf.mjs` 把行距按 10pt 排到 150 行，
// 页面只有 842pt 高，**多数行落在了页面之外**。这一点现在量死了（`node dev/probe-pdfjs-offpage.mjs`：
// 同一套构造参数请求 3,000 行 / 594,000 字节 ⇒ pdf.js 只提取到 1,620 条 / 288,360 字节，负 y 的一条都不报），
// 所以我拿"我以为的文本层大小"去比产品留下的数，得出"产品剪掉了 56%"——那是我的夹具越界，不是产品的行为
// （同类错误：R71 那张"体积桩"big.jpg）。改成页内排版后同一条链路量到 `seenBytes == keptBytes`（没剪）。
// 判据本身也跟着改了：现在测试件自己检查"每一行的 y 都在页内"，量不出重量就不许往下走。
//
// 那这一处还留着做什么？三件事，两件是量到的、一件是算出来的：
// ① `MAX_PAGES_PARSED = 20` 是真会撞的：超过 20 页的 PDF 就是"整页没留下文字"，而资料行以前只写
//    「共 20 页」——把"本机只读了 20 页"说成"这份东西就 20 页"。
// ② 单份 500KB 的预算原来按 `JSON.stringify(...).length` 比，那是 UTF-16 单位数：中文一份顶三倍 ⇒
//    护栏晚三段才生效。现在按字节，且剪了多少**留在数据里**（`documents[].textSeenBytes` / `pagesTotal`），
//    刷新、换设备、被服务端采纳之后都还在；那句说辞只有一处出口（行上与上传当场共用）。
// ③ 算出来的那条：单份合规不等于整份合规。实测一条任务攒到 6 份资料时载荷 = **1,283,848 字节**，
//    服务端 `readJson(request, 1_000_000)` 回 413，界面上只有「云端保存失败」——所以有了
//    `MAX_TEXT_BYTES_PER_TASK`：新资料在登记**之前**就裁进这条任务剩下的空间（原件不动），
//    而整份的账由 `src/fieldLimits.ts` 那一处管着（同一处还管识别回来的那三栏字节帽）。
//
// 这不是崩溃，是**证据回看比人以为的少**——与 R71（存的是压缩副本必须说出来）、R72（入口不许兑不了诺）同一类，
// 而医生看到的正是这种回看。
//
// 与 R74 的关系（这条解释了②为什么必须同时进服务端形状）：本机多带一个键而 `sanitizeTaskPayload`
// 把它丢掉 ⇒ 下次 load 时本机这份与服务器那份"内容不同"，而两边时间戳都没动 ⇒ 被判成"无从判断"而暂停同步。
// 所以新字段**必须同时**进 `functions/validate.mjs` 的 `sanitizeDoc`，A 组拿那份真函数双向对死。

// 整份载荷那道 1MB 门的数字住在 `fieldLimits`（它与服务端 readJson 的对照由 A 组钉），这里只引用、不再抄一份。
import { MAX_TASK_PAYLOAD_BYTES } from "./fieldLimits";

/** 单份资料的文本层预算（UTF-8 字节）。原来那个数叫"500_000 字符"，那是同一处口径错的另一半。 */
export const MAX_TEXT_BYTES_PER_DOC = 500_000;
/** 每页最多留多少个文字块（行）。 */
export const MAX_BLOCKS_PER_PAGE = 120;
/** 单块最多多少个字符（显示级颗粒度，按字符数算是有意的）。 */
export const MAX_BLOCK_CHARS = 600;
/** 一份 PDF 最多解析多少页（超出的页只算"未解析"，原件本身完整保存）。 */
export const MAX_PAGES_PARSED = 20;

const encoder = new TextEncoder();

export const utf8Length = (s: string): number => encoder.encode(s).length;

/** 已保留的文本层合计字节——从留下来的块现算，不另存一份"我以为的数" */
export function keptTextBytes(pages: { blocks?: { text?: string }[] }[]): number {
  let bytes = 0;
  for (const p of pages) for (const b of p.blocks ?? []) bytes += utf8Length(b.text ?? "");
  return bytes;
}

const kb = (bytes: number) => `${Math.round(bytes / 1024)}KB`;

/** 一份资料在界面上要如实交代的事实：解析了多少页、留下多少文本、它本来有多少 */
export interface DocTextFacts {
  /** 登记时记下的"这份 PDF 的文本层一共多少字节"；没有这个数就当没截过 */
  textSeenBytes?: number;
  /** PDF 自己报的总页数；没有就当本机看到的就是全部 */
  pagesTotal?: number;
  pages: { blocks?: { text?: string }[] }[];
  /** 界面上那份资料的显示名——只有"点名最重的那一份"才用（没名字就当未命名资料，不印一个空书名号） */
  name?: string;
}

export interface TextCoverage {
  seenBytes: number;
  keptBytes: number;
  /** 整页没解析的页数（原件仍在，只是文本层没读） */
  pagesNotParsed: number;
  pagesParsed: number;
}

export function textCoverageOf(doc: DocTextFacts): TextCoverage {
  const pagesParsed = doc.pages.length;
  const pagesTotal = typeof doc.pagesTotal === "number" ? doc.pagesTotal : pagesParsed;
  return {
    seenBytes: typeof doc.textSeenBytes === "number" ? doc.textSeenBytes : 0,
    keptBytes: keptTextBytes(doc.pages),
    pagesNotParsed: Math.max(0, pagesTotal - pagesParsed),
    pagesParsed,
  };
}

/** 有没有"少给了"这件事要披露（文本层剪过，或整页没解析） */
export function textIsPartial(c: TextCoverage): boolean {
  return (c.seenBytes > 0 && c.keptBytes < c.seenBytes) || c.pagesNotParsed > 0;
}

/**
 * 那一句：说清留了多少、共多少、以及**怎么看剩下的**。资料行上、上传当场的提示都用它——
 * 两处各写一份，早晚会有一句说漏。两个真实数字都要在（R72 的纪律：只说"部分保留"等于没说）；
 * `seenBytes` 缺失时**不许拿 0 冒充事实**，那一半句子就不拼。
 */
export function textCoverageNotice(c: TextCoverage, originalKept: boolean): string {
  const parts: string[] = [];
  if (c.seenBytes > 0 && c.keptBytes < c.seenBytes) {
    // 一位小数都不给，但 0 就说是 0：`Math.max(1, …)` 是为了不让"留了 3 行"被四舍五入成 0%，
    // 而真的一个字没留下时报"约 1%"就是说假话。
    const pct = c.keptBytes === 0 ? 0 : Math.max(1, Math.round((c.keptBytes / c.seenBytes) * 100));
    parts.push(`这份资料的文本层共 ${c.seenBytes} 字节，本机只留下 ${c.keptBytes} 字节（约 ${pct}%）——其余的行没有解析，不在「已解析的页面文字」里`);
  }
  if (c.pagesNotParsed > 0) {
    parts.push(`另有 ${c.pagesNotParsed} 页没有留下文字（本机只留下 ${c.pagesParsed} 页的文字；护栏有两道：单份最多 ${MAX_PAGES_PARSED} 页 / ${kb(MAX_TEXT_BYTES_PER_DOC)}，以及一条任务里所有资料的文字层要一起挤进服务器一次能收的 ${MAX_TASK_PAYLOAD_BYTES} 字节）`);
  }
  if (!parts.length) return "";
  parts.push(originalKept
    ? "原件本身完整保存在站点存储里，要看全文就展开原件那一栏，或直接把原件带去就诊"
    : "本机模式下没有存原件，未解析的部分只能人工录入");
  return `${parts.join("；")}。`;
}

/** 资料行那句「共 N 页」：整页没解析时不许只报解析过的页数，也不许报成好像全都读到了 */
export function pageCountText(doc: DocTextFacts): string {
  const parsed = doc.pages.length;
  const total = typeof doc.pagesTotal === "number" ? doc.pagesTotal : parsed;
  if (total <= parsed) return `共 ${parsed || "—"} 页`;
  // 一页文字都没留下时说"只留下前 0 页"是把 0 当成一个进度，直说没有
  if (parsed === 0) return `共 ${total} 页（本机没有留下任何页面文字）`;
  return `共 ${total} 页（本机只留下前 ${parsed} 页的文字）`;
}

/**
 * 一条任务里所有资料已经留下的文本层合计（字节）。界面上不单独显示它，
 * 但 A 组用它对账"裁进这条任务剩下的空间"那句判据是不是真的按字节在算。
 */
export function taskTextBytes(docs: DocTextFacts[]): number {
  return docs.reduce((n, d) => n + keptTextBytes(d.pages), 0);
}

/**
 * 文字层被占尽、新来的那一份裁到一页文字都不剩时，那句"接下来能做什么"。
 *
 * 为什么行上那句不够：它说的是事实（「本机只留下 0 字节（约 0%）」），但没说去哪儿腾空间，
 * 而此刻人手里唯一能动的就是这一页上那两颗按钮——那一行的「替换」（重传时本机会把它裁进剩下的
 * 空间）与「删除」（删掉一份资料，它占的字节就腾出来，确认框会说清删掉会失去什么）。
 * R72 的纪律：出路必须是界面上真存在的；R76 的纪律：不许承诺"换了一定腾得出来"。
 *
 * 点名的必须是**本机留下文字最多**的那一份，且按 `keptTextBytes` 现算（不读登记时记下的数——
 * 那个数是"本来有多少"，不是"此刻占着多少"）。一份带文字层的资料都没有时**不许点一份不存在的资料**，
 * 那一格改成实话。这一句不提"原件还在不在"：那半句由模式决定，由 `textCoverageNotice` 与删除确认框说。
 */
export function textBudgetSaturatedNotice(docs: DocTextFacts[]): string {
  // 首句不说"文字层已经占满"而说"剩下的空间装不下这一份的文字层"：占这份空间的可能是别的内容
  // （审计记录、各栏文字），那句会把归因说反——R71/R75 同一条纪律：新加的每句话都要问它在哪一半状态下不成立。
  const head = "这条任务剩下的空间已经装不下这一份的文字层，所以它没有留下任何页面文字";
  let best: { name: string; bytes: number } | undefined;
  for (const d of docs) {
    const bytes = keptTextBytes(d.pages);
    if (bytes <= 0) continue;
    if (!best || bytes > best.bytes) {
      best = { name: typeof d.name === "string" && d.name.trim() ? d.name.trim() : "（未命名资料）", bytes };
    }
  }
  if (!best) {
    return `${head}；这条任务里没有留下文字层的资料可以点名，要腾出空间只能删掉某一份资料（那一行的「删除」有确认框），或者删短其它栏里已有的文字`;
  }
  return `${head}；本机留下文字最多的是「${best.name}」（${best.bytes} 字节）——出路有两条，都在这一页：用它那一行的「替换」重传，本机会把它的文字层裁进剩下的空间；或者直接删掉一份不再需要的资料（那一行的「删除」有确认框），它占的字节就腾出来了`;
}

/**
 * 把这份新资料的文本层裁进"这条任务剩下的空间"。**只裁文字层，不动原件**——
 * 原件在站点存储里是独立对象，裁掉文字层不会让任何人丢掉那张纸。
 * 裁了多少靠 `textSeenBytes` 留在数据里，由资料行长期说出口（不是一闪而过的提示）。
 *
 * `roomBytes` 必须由调用方从**真载荷的字节数**算出来（`payloadRoomBytes`，见 `src/fieldLimits.ts`），
 * 这里也不许估"平均每块多少字节"：本轮第一版把每块开销写成 `+8`，实测（真产物真浏览器，三份 20 页 × 110 行的 PDF）
 * 裁完文字层 885,654 字节、整份载荷却 = **1,032,527 字节** ⇒ 仍然越了服务端那 1MB 的门。
 * 现在按 `JSON.stringify(block)` 的**真实字节**计费，量的是将要被存出去的那段文本本身。
 */
export function fitPagesToTaskBudget<T extends { pageNo: number; blocks: { id: string; text: string }[] }>(
  pages: T[],
  roomBytes: number,
): { pages: T[]; droppedPages: number } {
  if (roomBytes >= MAX_TEXT_BYTES_PER_DOC) return { pages, droppedPages: 0 };
  const out: T[] = [];
  let used = 0;
  let droppedPages = 0;
  for (const p of pages) {
    const blocks: { id: string; text: string }[] = [];
    for (const b of p.blocks) {
      const cost = utf8Length(JSON.stringify(b));
      if (used + cost > roomBytes) continue;
      used += cost;
      blocks.push(b);
    }
    if (blocks.length) out.push({ ...p, blocks });
    // 本来就没有文字的页（扫描页/空白页）不算"被裁掉"——没有东西被拿走就不许记账；
    // 剪掉几行的那一页也不记账，那一半由"留了多少字节 / 一共多少字节"那句说。
    else if (p.blocks.length) droppedPages += 1;
  }
  return { pages: out, droppedPages };
}

/** 护栏常量的机器可读快照：A 组用它对账"预算是不是按字节生效" */
export const TEXT_BUDGET = {
  MAX_TEXT_BYTES_PER_DOC,
  MAX_BLOCKS_PER_PAGE,
  MAX_BLOCK_CHARS,
  MAX_PAGES_PARSED,
} as const;
