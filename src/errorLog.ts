// 就医笺 · 客户端异常自录（R6）
// 只存本机的独立键，永不进 AppState / task.audit / task-save 载荷；只记四个字段，不记栈、不记文件名与 URL。

export const ERROR_LOG_KEY = "jiuyijian-error-log-v1";
export const ERROR_LOG_LIMIT = 50;
export const MESSAGE_MAX_CHARS = 160;

export interface ErrorLogEntry {
  /** ISO 时间 */
  at: string;
  /** 白名单错误类型（形如 XxxError / XxxException），无法判定时为「未分类」 */
  type: string;
  /** 固定页面名表中的条目，不含任务 id 与 URL */
  page: string;
  /** 限长并清洗过的 message */
  message: string;
}

export interface KvStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const HIDDEN = "（信息含医疗内容或无法安全展示，已隐藏）";
const UNKNOWN = "（无附加信息）";

// 命中即整条信息隐藏：这些词意味着 message 里带着病历正文
const MEDICAL_MARKERS = [
  "患者", "病历", "主诉", "现病史", "既往史", "家族史", "诊断", "处方", "医嘱", "出院小结",
  "口服", "静滴", "静注", "肌注", "皮下注射", "顿服", "每日三次", "每日两次", "每日一次", "饭前", "饭后",
  "血糖", "血压", "肌酐", "尿素氮", "转氨酶", "白细胞", "血红蛋白", "血小板", "尿酸", "尿蛋白",
  "剂量", "用药", "药品", "频次", "过敏", "复查", "血药浓度",
  "造影", "病理", "心电", "影像", "禁忌",
  "阿司匹林", "氯吡格雷", "美托洛尔", "比索洛尔", "阿托伐他汀", "瑞舒伐他汀", "二甲双胍", "格列美脲",
  "胰岛素", "华法林", "肝素", "硝苯地平", "氨氯地平", "缬沙坦", "厄贝沙坦", "培哚普利", "呋塞米",
  "螺内酯", "泼尼松", "地塞米松", "布洛芬", "对乙酰氨基酚", "阿莫西林", "头孢", "左氧氟沙星",
  "阿奇霉素", "奥美拉唑", "硝酸甘油", "达格列净", "司美格鲁肽",
];

const UNIT =
  "mg/dl|mg/l|mg/m2|μg/l|ug/l|mcg|μg|ug|mmol/l|mmol|mol/l|umol/l|μmol/l|nmol|iu/l|iu|u/l|ml/min|ml|kg|℃|%|mmhg|g/l|copies/ml|次/日|次/天|片/次|片|粒|袋|支|滴|单位";
const RE_STACK_LINE = /^[ \t]*at[ \t]+\S.*$/gim;
const RE_URL = /(?:https?|ftp|file|blob|data):\/\/[^\s'"，。；)）]+/gi;
const RE_QUERY = /\?[^\s，。；]+/g;
const RE_FILE = /[A-Za-z0-9_@./\\-]*\.(?:tsx|jsx|ts|js|mjs|cjs|json|css|map|html|pdf|png|jpe?g|gif|webp|svg|txt|woff2?)(?::\d{1,6}(?::\d{1,6})?)?/gi;
const RE_QUOTED = /[「『][^」』]{0,300}[」』]|“[^”]{0,300}”|"[^"]{0,300}"|《[^》]{0,300}》|《[^》]*$/g;
const RE_MEASURE = new RegExp(`(?:^|[^0-9A-Za-z])(\\d+(?:[.,]\\d+)?)[ \\t]*(?:${UNIT})(?![A-Za-z])`, "gi");
const RE_NUM_NEAR_KEYWORD =
  /(剂量|浓度|数值|结果|指标|参考区间|水平|含量|阳性|阴性)[^0-9\n]{0,6}\d+(?:[.,]\d+)?/g;
const RE_DATE = /\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?/g;
const RE_WS = /\s+/g;

/** 只取 message，永不读 stack */
function messageOf(input: unknown): string {
  if (typeof input === "string") return input;
  if (input && typeof input === "object") {
    const m = (input as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return "";
}

/** 错误类型只接受「XxxError / XxxException」形状，避免把 name 当自由文本写入 */
export function errorTypeFor(input: unknown): string {
  const name =
    input && typeof input === "object" ? (input as { name?: unknown }).name : undefined;
  if (typeof name === "string" && /^[A-Za-z][A-Za-z0-9]{1,28}(?:Error|Exception)$/.test(name)) {
    return name;
  }
  return "未分类";
}

/** message 清洗：结构剥离 → 数值掩码 → 高危词整条隐藏 → 限长 */
export function sanitizeErrorMessage(raw: unknown): string {
  let text = messageOf(raw);
  if (!text.trim()) return UNKNOWN;
  text = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ");
  text = text.replace(RE_STACK_LINE, " ");
  text = text.replace(RE_URL, " [链接] ");
  text = text.replace(RE_QUERY, " [参数] ");
  text = text.replace(RE_FILE, " [文件] ");
  text = text.replace(RE_QUOTED, " [已隐藏] ");
  text = text.replace(RE_MEASURE, " [数值] ");
  text = text.replace(RE_NUM_NEAR_KEYWORD, "$1 [数值] ");
  text = text.replace(RE_DATE, " [时间] ");
  if (MEDICAL_MARKERS.some((w) => text.includes(w))) return HIDDEN;
  text = text.replace(RE_WS, " ").trim();
  if (text.length > MESSAGE_MAX_CHARS) text = text.slice(0, MESSAGE_MAX_CHARS) + "…";
  return text || UNKNOWN;
}

const PAGES: { seg: string; name: string }[] = [
  { seg: "privacy", name: "隐私与数据" },
  { seg: "new", name: "新建任务" },
  { seg: "evidence", name: "证据定位" },
  { seg: "docs", name: "资料上传" },
  { seg: "review", name: "信息核对" },
  { seg: "sheet", name: "交接单编辑" },
  { seg: "print", name: "交接单打印" },
  { seg: "actions", name: "行动清单" },
  { seg: "summary", name: "复诊摘要" },
  { seg: "edit", name: "任务设置" },
];

/** 路由 → 固定中文页面名；不返回路径本身，任务 id 因此不会入库 */
export function pageNameFor(path: string | undefined): string {
  if (!path || path === "/") return "任务列表";
  const segs = path.split("/").filter(Boolean);
  if (segs[0] === "t") return PAGES.find((p) => p.seg === segs[2])?.name ?? "任务内页";
  return PAGES.find((p) => p.seg === segs[0])?.name ?? "未知页面";
}

function currentPath(): string {
  try {
    const hash = (globalThis as { location?: { hash?: string } }).location?.hash ?? "";
    return hash.startsWith("#") ? hash.slice(1) : hash;
  } catch {
    return "";
  }
}

function defaultStore(): KvStore | null {
  try {
    const ls = (globalThis as { localStorage?: KvStore }).localStorage;
    return ls ?? null;
  } catch {
    return null;
  }
}

function saneEntry(e: unknown): ErrorLogEntry | null {
  if (!e || typeof e !== "object") return null;
  const row = e as Record<string, unknown>;
  if (typeof row.at !== "string" || typeof row.message !== "string") return null;
  return {
    at: row.at,
    type: typeof row.type === "string" ? row.type.slice(0, 40) : "未分类",
    page: typeof row.page === "string" ? row.page.slice(0, 20) : "未知页面",
    message: row.message.slice(0, MESSAGE_MAX_CHARS + 1),
  };
}

/** 读不到、坏了、不是数组 → 一律当空，绝不抛 */
export function readErrorLog(store: KvStore | null = defaultStore()): ErrorLogEntry[] {
  if (!store) return [];
  try {
    const raw = store.getItem(ERROR_LOG_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(saneEntry).filter((e): e is ErrorLogEntry => e !== null).slice(-ERROR_LOG_LIMIT);
  } catch {
    return [];
  }
}

/** 环形写入（≤50），写失败只返回原状，不抛、不阻塞主流程 */
export function appendErrorLog(
  entry: ErrorLogEntry,
  store: KvStore | null = defaultStore(),
): ErrorLogEntry[] {
  if (!store) return [];
  const next = [...readErrorLog(store), entry].slice(-ERROR_LOG_LIMIT);
  try {
    store.setItem(ERROR_LOG_KEY, JSON.stringify(next));
    return next;
  } catch {
    return readErrorLog(store);
  }
}

export function recordError(
  input: unknown,
  at?: string,
  store: KvStore | null = defaultStore(),
): ErrorLogEntry | null {
  const entry: ErrorLogEntry = {
    at: typeof at === "string" && at ? at : new Date().toISOString(),
    type: errorTypeFor(input),
    page: pageNameFor(currentPath()),
    message: sanitizeErrorMessage(input),
  };
  const log = appendErrorLog(entry, store);
  return log[log.length - 1]?.at === entry.at ? entry : null;
}

export function clearErrorLog(store: KvStore | null = defaultStore()): boolean {
  if (!store) return false;
  try {
    store.removeItem(ERROR_LOG_KEY);
    return true;
  } catch {
    return false;
  }
}

let installed = false;
let reentering = false;

type LogListener = (event: unknown) => void;
interface ErrorEventTarget {
  addEventListener?: (type: string, listener: LogListener) => void;
}

/** 安装 window 级钩子：任何一步失败都静默返回，不改用户当前页面 */
export function installErrorLogging(): void {
  const w = globalThis as unknown as ErrorEventTarget;
  if (installed || typeof w.addEventListener !== "function") return;
  installed = true;
  const capture = (input: unknown) => {
    if (reentering) return;
    reentering = true;
    try {
      recordError(input);
    } catch {
      /* 异常自录本身失败时不影响页面 */
    } finally {
      reentering = false;
    }
  };
  try {
    w.addEventListener("error", (event) => {
      const e = (event ?? {}) as { error?: unknown; message?: unknown };
      capture(e.error ?? (typeof e.message === "string" ? e.message : ""));
    });
    w.addEventListener("unhandledrejection", (event) => {
      capture((event as { reason?: unknown } | null)?.reason);
    });
  } catch {
    installed = false;
  }
}
