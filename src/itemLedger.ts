// 「同一个项目被好几份资料记过」怎么排（R112）。
//
// 主理人 09-29 定的两条规则，这里逐字实现：
//  ①「一份报告是 9.26，一份是 9.29，肯定是 9.29 的结果更准确啊，当然**两份都要识别进去**，排序按最近时间排」
//     ⇒ 只做排序，不做取舍；旧值一条都不许从视野里消失。
//  ②「同一项……这两个值都放在它后面，但是**不管两个值是否相同**，都在每个值的后面括号备注时间」
//     ⇒ 并列展示 + 每个值自带日期，值相同也要各带各的日期（两条相同读数出自两份资料，本身就是"两处印证"这件事的证据）。
//
// 这一层刻意只回答"这些说的是不是同一件事、谁更近"，不回答"哪一条是对的"：
// 冲突判定仍然走 `conflictWith` 那条既有通路（核对页那句「系统不代为判断」），红线①不因排序而松动。
//
// 为什么不自动并「血肌酐」与「血肌酐 / Cr」：那是**医学别名判断**，产品没有资格替人拍板（也没有任何词典依据在仓库里）。
// 所以这里只把它们认成"疑似同一项"，由人按一次「算同一项」才并起来——写审计、可「拆开」，见 `src/state.ts` 的 field.setItemGroup。

import { localDateStr } from "./dates";
import { finalValue } from "./sheet";
import type { ExtractedField, SourceDocument, VisitTask } from "./types";

/** 值的呈现口径与交接单同一个（用户改过的以用户为准），不在这里再造第二套 */
export const LEDGER_SECTION_TITLE = "同一项目的多次记录（最近的排在前面）";
/** 取不到日期时的那句——注意它**不是**"没有日期"，是"我方没认出来" */
export const LEDGER_UNKNOWN_DATE_TEXT = "时间未确认";
export const MERGE_LABEL = "算同一项";
export const UNMERGE_LABEL = "拆开";

/** 括号里那个日期的三种来处，措辞各不相同——「按上传时间」绝不能冒充资料上印着的日期 */
export type LedgerProvenance = "onDoc" | "upload" | "unknown";

export interface LedgerDate {
  /** YYYY-MM-DD（本地时区）；`provenance === "unknown"` 时为 null */
  iso: string | null;
  provenance: LedgerProvenance;
  /** 这句话从哪一栏认出来的：报告日期／采集时间／就诊日期／上传时间 */
  noun: string;
}

/**
 * 「这份资料上是哪一栏写着日期」的优先级。
 * 排在前面的是**这一项测量自己的日期**，排在后面的是这份文书的日期——两者都算纸面日期，但措辞要分开。
 * ⚠ `EXCLUDED_LABEL` 那一档（复查／预约／下次……）永远不能当日期来处：那是"将来要去的那天"，
 *   拿它给一条已有读数排序，等于把计划排成历史。
 */
const DATE_SOURCES: { re: RegExp; noun: string }[] = [
  { re: /(报告|出具|签发|审核)(日期|时间)/, noun: "报告日期" },
  { re: /(检查|送检|采样|采集|检验|化验|接收)(日期|时间)/, noun: "采集时间" },
  { re: /就诊(日期|时间)/, noun: "就诊日期" },
];
const FUTURE_DATE_LABEL = /(复查|复诊|下次|预约|拟|预计|计划|出生|预产|有效|截止|到期)/;

/** 从一串文字里取第一个像日期的片段；认不出、或认出来是个不可能的日期就回 null——**不许猜** */
export function parseDateToken(text: string): string | null {
  const m = /(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?/.exec(String(text ?? ""));
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1900 || y > 2200 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  if (d > new Date(Date.UTC(y, mo, 0)).getUTCDate()) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function docOf(task: VisitTask, field: ExtractedField): SourceDocument | undefined {
  return field.docId ? task.documents.find((d) => d.id === field.docId) : undefined;
}

/**
 * 一条记录的日期：同一份资料上的"报告／采集／就诊"那一栏 → 那份资料的上传时间（明说）→ 时间未确认。
 * 只在这**一条记录所属的那份资料**里找日期，不跨资料借——借来的日期会把两份报告的先后排错。
 * `siblings` 是同一份资料的那批字段：由 `buildItemClusters` 一次算好交进来（R118 量测：原来每条记录都现场
 * 把整条任务的字段滤一遍，一条 934 字段的任务就是 934 遍全表扫描）。外部调用不传也照样能算。
 */
export function resolveLedgerDate(task: VisitTask, field: ExtractedField, siblings?: ExtractedField[]): LedgerDate {
  const doc = docOf(task, field);
  const sibs = siblings ?? (doc ? task.fields.filter((f) => f.docId === doc.id) : []);
  for (const src of DATE_SOURCES) {
    for (const c of [field, ...sibs]) {
      if (FUTURE_DATE_LABEL.test(c.label) || FUTURE_DATE_LABEL.test(c.ocrRaw)) continue;
      if (!src.re.test(c.label)) continue;
      const iso = parseDateToken(finalValue(c));
      if (iso) return { iso, provenance: "onDoc", noun: src.noun };
    }
  }
  if (doc) {
    const iso = localDateStr(new Date(doc.addedAt));
    if (parseDateToken(iso)) return { iso, provenance: "upload", noun: "上传时间" };
  }
  return { iso: null, provenance: "unknown", noun: LEDGER_UNKNOWN_DATE_TEXT };
}

/** 值后面括号里那一句（唯一的格式化出口：界面上所有日期标注都从这里出） */
export function dateMarkerOf(d: LedgerDate): string {
  if (d.provenance === "unknown" || !d.iso) return `（${LEDGER_UNKNOWN_DATE_TEXT}）`;
  return `（${d.iso} · 按${d.noun}）`;
}

function fold(label: string): string {
  return String(label ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 并项用的键（保守档）：**只**统一大小写/全半角、剥末尾标点、剥「结果／数值／原文／项目」这种**值栏的栏目名**
 * （写成括号时也只剥整串就是这一个栏目词的那种：`（结果）` 是栏目、`（外院化验单，图片模糊）` 是出处）。
 *
 * ⚠ R113：**「参考区间」「单位」「提示」不再当栏目后缀剥**——真模型回来的标签是 `血肌酐` / `血肌酐参考区间` / `血肌酐提示` 三个独立字段，
 * 剥掉后缀会让"这一条读数的配套说明"顶著和读数同一个键，屏幕上就成了「血肌酐 2 份记录：118.0 umol/L / 57.0 - 97.0」——
 * **把一个区间说成第二次测量**。这些栏改由 `isAttributeColumnField` 整条排除（见下面那一处）。
 * 括号里有别的内容一律保留——「血压（诊室）」与「血压（家庭）」不是同一件事，删括号就是把两件事并成一件。
 */
const NOISE_PAREN = /[（(]\s*(结果|数值|原文|项目)\s*[)）]/g;

/**
 * 同一条标签在一场渲染里会被问四遍（裸列名／抬头／配套栏／分组各一次），所以这里记住一次算过的结果。
 * 上限 4000 后整表清空：标签是家属手打的，一个只进不出的缓存等于把整台任务的文字再存一份。
 */
const KEY_MEMO_MAX = 4000;
const keyMemo = new Map<string, string>();

export function itemKeyOf(label: string): string {
  const hit = keyMemo.get(label);
  if (hit !== undefined) return hit;
  const k = computeItemKey(label);
  if (keyMemo.size >= KEY_MEMO_MAX) keyMemo.clear();
  keyMemo.set(label, k);
  return k;
}

function computeItemKey(label: string): string {
  let k = fold(label)
    .replace(NOISE_PAREN, "")
    .replace(/[。，、；;:：.]+$/g, "")
    .trim();
  for (;;) {
    const next = k
      .replace(/[\s/／、·-]+(结果|数值|原文|项目)$/g, "")
      .replace(/(结果|数值|原文|项目)$/g, "");
    if (next === k) break;
    k = next.trim();
  }
  // 整条标签本身就是栏目词（`结果`）时不许退化成空键——空键会把两个互不相干的项目并到一起
  return k || fold(label);
}

/**
 * 「这一条不是一个新的测量，而是某条读数的配套说明栏」——R113 的主判据。
 * 真实模型输出的标签形状（2026-09-29 从云端那一行现读）：`血肌酐`／`血肌酐参考区间`／`血肌酐提示`，
 * 把后两条列成"第二份、第三份记录"等于**把参考区间和上下箭头冒充成测量值**，比并错项更糟。
 * 人亲手指名并过的不在此列（那一次点击是判断）。
 */
const ATTRIBUTE_COLUMN = /(参考区间|参考值|区间|范围|单位|提示|标志|标记|箭头|状态|检测方法|仪器|设备|样本|页码)[）)\s]*$/;

/** 登记词只写一遍：组合规则**从词表常量自己派生**，不再抄第二份（同一份规则抄两处必然分叉）。 */
function vocabWords(re: RegExp): string[] {
  const out: string[] = [];
  for (const m of re.source.matchAll(/\(([^()]*)\)/g)) for (const t of m[1].split("|")) if (t) out.push(t);
  return out;
}

/**
 * 配套栏的**第二种写法**（R117 普查留下的 1、2 两条）：`参考区间（凝血酶原时间 PT）`／`参考区间（血红蛋白 HGB）`。
 * R113 的判据锚在标签末尾，所以"栏名在前、项目名在括号里"这一形漏了。这一形与末尾写法**没有任何行为差别**：
 * 它仍然是一条读数的区间，不是第二次测量。要求「除括号那段之外整串就是一个登记栏名」，
 * 所以 `检查数值（血红蛋白 HGB）`（数值是测量本身）不会被这条捞走——那条是普查里判「保留」的 7 个括号形之一。
 */
function isAttributeColumnLabel(label: string): boolean {
  const k = fold(label);
  for (const w of vocabWords(ATTRIBUTE_COLUMN)) {
    if (k.startsWith(w) && /^\s*[（(][^（）()]*[）)]\s*$/.test(k.slice(w.length))) return true;
  }
  return false;
}

/**
 * 栏名的**连写形**（R117 普查留下的 3—10 那八条）：`用法用量`／`给药剂量`／`给药频次`／`申请单号`／`就诊机构`／`就诊机构与科室`／`小计金额`。
 * 它们与 R113 的裸列名是同一件事——一行的列名，没写"是谁的"——只是登记词之间没有分隔符、或前面多了一个不指认归属的限定词。
 * 判据不是再补一批词，而是问：**整串能不能只由「这张已登记的栏名词」＋下面那几个通用限定词铺满**。
 * 只要还剩一个字不在表里（药名、项目名、出处），这一项就照常列进来——所以 `苯磺酸氨氯地平片 剂量`、
 * `剂量（阿托伐他汀钙片）`、`住院期间用药`、`检查项目`、`诊号` 这些全都留得住（这一条在普查里是被逐条验的，不是"看起来像"）。
 * 限定词表只收**有出处的写法**（给药→#rx／#similar_drug，就诊与"与"→seed 的就诊机构与科室，小计→#nonmedical 的小计金额），
 * 没见过的写法一律不加：宁可乐观地漏排一条，不可悲观地误排一条真测量值。
 */
const COLUMN_QUALIFIER = ["给药", "就诊", "小计", "与"];

/**
 * 派生结果按 `re.source` 记住一次（词表仍然只有那一个常量，这里不抄第二份，只是不再每次调用都重拆一遍）。
 * 拆一次要跑 matchAll＋split，而 `isTiledByVocab` 在一条任务里会被问几百遍（每条字段两道排除各一次）。
 */
const vocabPoolCache = new Map<string, { terms: string[]; pool: { t: string; fromVocab: boolean }[] }>();
function vocabPool(re: RegExp): { terms: string[]; pool: { t: string; fromVocab: boolean }[] } {
  const hit = vocabPoolCache.get(re.source);
  if (hit) return hit;
  const terms = vocabWords(re);
  const pool = [...terms.map((t) => ({ t, fromVocab: true })), ...COLUMN_QUALIFIER.map((t) => ({ t, fromVocab: false }))];
  const made = { terms, pool };
  vocabPoolCache.set(re.source, made);
  return made;
}

/** 整串被 `re` 里的登记词（可夹通用限定词）铺满 ⇒ 仍然是一行的列名。至少要用掉一个登记词，光靠限定词不算。 */
function isTiledByVocab(key: string, re: RegExp): boolean {
  const { terms, pool } = vocabPool(re);
  if (!terms.length) return false;
  // reach[i] 的 bit0＝这一位到得了，bit1＝到这一位至少用掉过一个登记词（原来用 number[]，形状与语义都不变）
  const reach = new Uint8Array(key.length + 1);
  reach[0] = 1;
  for (let i = 0; i < key.length; i++) {
    if (!reach[i]) continue;
    for (const { t, fromVocab } of pool) {
      if (!t || !key.startsWith(t, i)) continue;
      reach[i + t.length] |= fromVocab ? 3 : 1;
    }
  }
  return (reach[key.length] & 2) === 2;
}

/**
 * 第三个形状（同一批真模型实测里数出来的）：`剂量`、`药品名`、`频次`、`给药途径` 这些标签**是表格的列名，不是项目名**。
 * 一张单子会写两个药 ⇒ 「剂量」自然有两行；把这两行并成「剂量 2 份记录：5mg / 20mg」就把"谁是谁的剂量"丢了，
 * 而这几栏恰好都在 `HIGH_RISK_LABELS` 里（药名·剂量·频次·给药途径）——高风险那一层不许靠一个并列来猜归属。
 * 真正带归属的写法（`苯磺酸氨氯地平片 剂量`）不受影响；人亲手指名并过的也不受影响。
 */
const BARE_COLUMN_LABEL = /^(药品名|药品名称|药名|药物名称|名称|剂量|用量|频次|用法|用药频次|给药途径|途径|结果|数值|单位|参考区间|参考值|区间|范围|提示)$/;

export function isBareColumnLabel(label: string): boolean {
  const k = itemKeyOf(label);
  return BARE_COLUMN_LABEL.test(k) || isTiledByVocab(k, BARE_COLUMN_LABEL);
}

/**
 * 第四类不列进来的东西：**文书抬头的栏目**（真模型两张单子一对比，`医院名称`／`姓名`／`性别`／`年龄`／`病历号`／`科别`／`标本`／`送检者`
 * 全部成了"2 份记录"，一段二十来行的"重复记录"就把真正被测的那几项埋了——这正是主理人抱怨的"杂乱"的形状）。
 * 判据按**标签词汇**而不是按分组：分组是模型给的，它把一条测量塞进 `meta` 时不该因此从视野里消失。
 * 人亲手指名并过的不在此列。
 */
const DOC_HEADER_LABEL =
  /^(患者|姓名|名字|性别|年龄|岁|民族|国籍|婚姻|职业|身份|证件|身份证|病历号|门诊号|住院号|住院次|检查号|影像号|流水号|条码|床号|病房|科室|科别|院区|门诊|急诊|医院|机构|单位|学校|幼儿园|申请单|单号|编号|标本|样本|送检|送检单位|采样|采样者|接收|检验者|检查者|报告者|报告医师|审核者|审核医师|复核|医师|医生|签名|电话|手机|联系方式|地址|住址|费别|医保|付费|扣款|金额|费|打印时间|采集机构|送检机构|送检者|记录者|录入者)$/;

/**
 * 抬头的三种写法：整串就是一个登记栏名（`机构`）、栏名后面跟一个不指认归属的通用后缀
 * （`机构名称`／`申请单号`——R117：`号` 与既有的 `名称／号码／信息／栏` 是同一类后缀，登记词 `申请单` 加上它就是这一形）、
 * 或几栏连写（`就诊机构与科室`／`小计金额`）。
 * `诊号` 剥掉 `号` 只剩 `诊`，不在词表里 ⇒ 照常列进来——这一条判据只在"整串都归得了档"时才排除。
 */
function stripHeaderSuffix(k: string): string {
  return k.replace(/(名称|号码|信息|栏|号)$/g, "");
}

export function isDocumentHeaderField(field: ExtractedField): boolean {
  if (typeof field.itemGroup === "string" && field.itemGroup.trim()) return false;
  return isDocumentHeaderLabel(field.label);
}

function isDocumentHeaderLabel(label: string): boolean {
  const k = itemKeyOf(label);
  return DOC_HEADER_LABEL.test(k) || DOC_HEADER_LABEL.test(stripHeaderSuffix(k)) || isTiledByVocab(k, DOC_HEADER_LABEL);
}

export function isAttributeColumnField(field: ExtractedField): boolean {
  if (typeof field.itemGroup === "string" && field.itemGroup.trim()) return false;
  const k = fold(field.label);
  return ATTRIBUTE_COLUMN.test(k) || isAttributeColumnLabel(field.label) || isBareColumnLabel(field.label);
}

/**
 * 疑似档用的键：额外删掉括号内容，并把分隔符切出的词排序。
 * 这一档**不许**用来自动并项，只用来发现"看着像同一项"（见 `suspectPairs`）。
 */
export function looseKeyOf(label: string): string {
  const stripped = fold(label)
    .replace(/（[^）]*）/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/[\s/／、,，\-–—·：:|]+/g, " ")
    .trim();
  return stripped
    .split(" ")
    .filter((t) => t && !/^(结果|数值|项目|原文)$/.test(t))
    .sort()
    .join("|");
}

export interface LedgerEntry {
  field: ExtractedField;
  date: LedgerDate;
  /** 这条出自哪份资料；两份同名资料也要靠它分得开 */
  docName: string;
  /**
   * 这一条的**来源**：资料 id，手工/带入字段没有资料就统一算「本机补充」一处。
   * R113：「这个项被记了几次」问的是**跨资料**重复记录，不是同一张单子里同名几行（见 `multiRecordClusters`）。
   */
  source: string;
}

export interface ItemCluster {
  key: string;
  /** 屏幕上的项目名：人并过的那一项就用人挑的名字，没并过的取"最近那一条"的标签原文 */
  title: string;
  entries: LedgerEntry[];
  humanMerged: boolean;
}

/** 新→旧；认不出日期的永远排在后面（它没资格声称自己最新），其余保持读入顺序 */
export function byRecency(entries: LedgerEntry[]): LedgerEntry[] {
  return [...entries].sort((a, b) => {
    if (a.date.iso === null && b.date.iso === null) return 0;
    if (a.date.iso === null) return 1;
    if (b.date.iso === null) return -1;
    return a.date.iso < b.date.iso ? 1 : a.date.iso > b.date.iso ? -1 : 0;
  });
}

/**
 * 「报告日期／采集时间／就诊日期」这几栏本身**不是项目**，它们是这一份资料的日期来处。
 * 让它们也成一项，家属看到的就是一条"这个项目有两个值"的日期栏——把归纳段变成噪声。
 * 人亲手指名并过的那几栏不在此列（`itemGroup` 在的照常成项）：那一次点击是判断，不是我替他判断。
 */
export function isDateColumnField(field: ExtractedField): boolean {
  if (typeof field.itemGroup === "string" && field.itemGroup.trim()) return false;
  if (FUTURE_DATE_LABEL.test(field.label)) return false;
  return DATE_SOURCES.some((s) => s.re.test(field.label));
}

/** 分组：一个键一项，跨资料也并进来（同一项来自两份报告就是两项记录，不是两条冲突） */
export function buildItemClusters(task: VisitTask, fields: ExtractedField[]): ItemCluster[] {
  const byKey = new Map<string, ItemCluster>();
  // 同一份资料的字段一次分好桶（原来每条记录现场把整条任务滤一遍：934 字段＝934 遍全表扫描）
  const fieldsByDoc = new Map<string, ExtractedField[]>();
  for (const d of task.documents) fieldsByDoc.set(d.id, []);
  for (const f of task.fields) fieldsByDoc.get(f.docId ?? "")?.push(f);
  for (const field of fields) {
    if (isDateColumnField(field) || isAttributeColumnField(field) || isDocumentHeaderField(field)) continue;
    const human = typeof field.itemGroup === "string" && field.itemGroup.trim() ? field.itemGroup.trim() : null;
    const key = human ? `#|${human}` : itemKeyOf(field.label);
    const doc = docOf(task, field);
    const entry: LedgerEntry = {
      field,
      date: resolveLedgerDate(task, field, doc ? fieldsByDoc.get(doc.id) : []),
      docName: doc?.name ?? "",
      source: ledgerSourceOf(field),
    };
    const hit = byKey.get(key);
    if (hit) {
      hit.entries.push(entry);
      if (human) hit.title = human;
    } else {
      byKey.set(key, { key, title: human ?? field.label, entries: [entry], humanMerged: Boolean(human) });
    }
  }
  const out: ItemCluster[] = [];
  for (const c of byKey.values()) {
    c.entries = byRecency(c.entries);
    if (!c.humanMerged) c.title = c.entries[0].field.label;
    out.push(c);
  }
  // 项与项之间也按各自的"最近一条"排：家属从上往下读就是从现在往过去读。
  // 上面那一行已经把每个簇的 entries 按新→旧排好了，所以簇的最近一条就是 entries[0]——
  // 原来这里在比较器里对两份 entries 各重排一遍，是 R118 量到的平方项（48 份资料时一帧里排 1.1 万次）。
  const newestIso = (c: ItemCluster) => c.entries[0].date.iso;
  return out.sort((a, b) => {
    const x = newestIso(a);
    const y = newestIso(b);
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return x < y ? 1 : x > y ? -1 : 0;
  });
}

/**
 * 「这一项被几份资料记过」数的是**来源**，不是行数（R113 真模型实测抓出来的第二个形状）：
 * 模型对一张化验单会返回 `药品名`×2 与 `剂量`×2（同一份资料里两个药各一行），按行数并排就成了
 * 「剂量 2 份记录：5mg / 20mg」——**两个不同药的剂量被说成同一项的两次测量，谁是谁的剂量丢了**。
 * 来源＝那份资料；手工补充与带入字段没有原件，每条各算一个来源（家属手抄两次的同一个项目确实该并起来）。
 */
export function ledgerSourceOf(field: ExtractedField): string {
  return field.docId ? "doc:" + field.docId : "field:" + field.id;
}

export function clusterSources(cluster: ItemCluster): string[] {
  return [...new Set(cluster.entries.map((e) => e.source))];
}

/** 界面上"这一条出自哪份资料"的那行小字（没有原件时说的是补录本身，不含任何判断） */
export function entrySourceLabel(entry: LedgerEntry): string {
  if (entry.docName) return entry.docName;
  return entry.field.source === "user" ? "手工补充" : "本机记录（无原件）";
}

/** 界面上的"N 份记录"数的是来源（能列出来就说明 ≥2），措辞与判据同一个出处 */
export function clusterRecordCountLabel(cluster: ItemCluster): string {
  return `${clusterSources(cluster).length} 份记录`;
}

/** 界面上"这一项"什么时候值得列出来：至少两个来源各记过一次 */
export function isMultiSourceCluster(cluster: ItemCluster): boolean {
  return clusterSources(cluster).length >= 2;
}

/** 界面上要展开的那些：被**两份以上来源**记过的项目（同一份资料里的同标签几行不算） */
export function multiRecordClusters(clusters: ItemCluster[]): ItemCluster[] {
  return clusters.filter((c) => c.entries.length >= 2 && isMultiSourceCluster(c));
}

export interface SuspectPair {
  a: ItemCluster;
  b: ItemCluster;
}

function tokensOf(c: ItemCluster): string[] {
  const set = new Set<string>();
  for (const e of c.entries) for (const t of looseKeyOf(e.field.label).split("|")) if (t) set.add(t);
  return [...set].sort();
}

/**
 * 「疑似同一项」：括号备注不同（`血肌酐（外院）`／`血肌酐`）、或一边是另一边的子集（`血肌酐`／`血肌酐 / Cr`）。
 * 人已经并过的那一项不再当嫌疑，免得拆不开；认不出医学缩写别名（HGB 与 血红蛋白），那一格只能由人来点。
 */
export function suspectPairs(clusters: ItemCluster[]): SuspectPair[] {
  const pool = clusters.filter((c) => !c.humanMerged);
  // 每一簇的词只算一次：原来在内层循环里成对重算，26 簇就是 650 对 × 每对的条目数（R118 量到的第三个平方项）
  const tokens = pool.map(tokensOf);
  const out: SuspectPair[] = [];
  for (let i = 0; i < pool.length; i++) {
    const a = tokens[i];
    for (let j = i + 1; j < pool.length; j++) {
      const b = tokens[j];
      if (a.join("|") === b.join("|")) {
        out.push({ a: pool[i], b: pool[j] });
        continue;
      }
      const [short, long] = a.length <= b.length ? [a, b] : [b, a];
      if (short.length > 0 && short.every((t) => long.includes(t))) out.push({ a: pool[i], b: pool[j] });
    }
  }
  return out;
}

export function suspectPairNotice(a: ItemCluster, b: ItemCluster): string {
  return `「${a.title}」与「${b.title}」看着像同一项，但没有自动并到一起——把它们并成一项是判断，不是归一。`
    + `认为是同一项就按一次「${MERGE_LABEL}」，这一项下面的记录会一起带上你挑的那个名字；按下去会写一条审计，之后可以「${UNMERGE_LABEL}」撤回。`;
}

/**
 * 人按下「算同一项」时改哪些记录、并出来叫什么：名字取**最近那一条记录所在的那一项**（认不出日期的一边不抢这个名字）。
 * 收成纯函数（R112）：这条规则住在界面上就没法判它对不对，而它决定写进 payload 的那个值。
 */
export function mergeChoice(pair: SuspectPair): { name: string; fieldIds: string[] } {
  const newest = (c: ItemCluster) => c.entries[0]?.date.iso ?? null;
  const a = newest(pair.a);
  const b = newest(pair.b);
  const first = a === null ? pair.b : b === null ? pair.a : a >= b ? pair.a : pair.b;
  return { name: first.title, fieldIds: [...pair.a.entries, ...pair.b.entries].map((e) => e.field.id) };
}

/** 人并出来的那一项的说明：名字是他挑的，随时可以退回原样 */
export function mergedNotice(cluster: ItemCluster): string {
  return `这一项是按你点过的「${MERGE_LABEL}」并起来的（叫「${cluster.title}」）。按「${UNMERGE_LABEL}」就退回原来各写各的样子，值本身一个字都不动。`;
}

/** 图例：三种日期标注分别是什么意思，只在这里写一遍；顺带说明"哪几栏没被列进来"（R113） */
export function ledgerLegend(): string {
  return `括号里的日期是这一条记录的来处：「按报告日期／按采集时间／按就诊日期」是从这份资料上那一栏认出来的；`
    + `「按上传时间」是这份资料进入本设备的日期（资料上认不出日期时才用，并明说是上传时间）；`
    + `「${LEDGER_UNKNOWN_DATE_TEXT}」是两者都取不到——不猜日期。`
    + `排序只是排序：产品不把排在最前面的那一条说成"对的"或"准的"，几条记录都还在，各带各的出处。`
    + `这里的"记录"只指同一项目的测量值：「参考区间／单位／提示」那一类是某一条读数的配套说明、日期栏是这份资料的时间，`
    + `都不算"第二次测量"，所以不排在这里——它们仍在下面各自的卡片里，一个字没少。`
    + `像「剂量」「药品名」「频次」这种**一行的列名**也不排在这里：一张单子上有两个药就有两行剂量，把它们并排会丢掉"谁是谁的剂量"，`
    + `而写清了归属的那种（例如「某某药 剂量」）照常排。「医院名称／姓名／性别／病历号」这类**文书抬头**同样不排——`
    + `两份资料一对比它们必然是两条一样的记录，列出来只会把真正被测的那几项埋掉。`;
}

/** 跳到卡片那颗按钮的无障碍名（读屏用户也要知道点的是哪一项的哪一条） */
export function jumpLabel(cluster: ItemCluster, entry: LedgerEntry): string {
  const value = finalValue(entry.field);
  return `跳到这条记录的核对卡片：${cluster.title} ${value}${entry.docName ? `（${entry.docName}）` : ""}`;
}
