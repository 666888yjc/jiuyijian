// 「这一项服务器到底存得下多少」——唯一一处（R75）。
//
// 为什么必须有这个模块（2026-09-27 真浏览器实测，产物 `index-D238wniw.js`）：
// 服务端 `functions/validate.mjs` 的每一道长度门数的都是 **UTF-8 字节**（`str(v, max)` 里是
// `new TextEncoder().encode(v).length > max` ⇒ 超了就 `invalid_payload` 400，**不是截断**），
// 而界面上一个字节的限制都没有——整个产品只有一处 `maxLength={2000}`（复诊摘要），另有两处按**字符**切的
// （`ActionsPage` 把行动内容切到 300 字符、`state.ts` 把摘要切到 2000 字符）。汉字一个 3 字节 ⇒
// 300 字符的行动内容是 900 字节，上限却只有 300 字节。
// 实测后果：在行动清单里输入 120 个汉字（界面允许、也让加）⇒ 条目加进去了、页头从此挂着
// 「云端保存失败」，而**这句话里没有一项是说"哪一栏、超了多少"**；更要紧的是这条任务之后**每一次**改动
// 都推不出去（同一份载荷里那个超长项还在），家属继续往里填、屏幕上没有任何一处提示这份已经存不上了。
// 拿真的 `sanitizeTaskPayload` 探一遍（本机现跑，9 个用例）：101 个汉字的行动内容、120 个汉字的完成备注、
// 210 个汉字的「为谁准备」、70 个汉字的称呼、700 个汉字的问题、1400 个汉字的人工修改值——**7 项全被拒**，
// 而这些都是输入框允许的输入。
//
// 三条刻意的选择：
// ① **不许拿"截断"当解决办法**（对用户写的那些栏）。这些长度是人的判断内容，切掉就是悄悄丢东西——
//    与"家属点下的每一次核对不许被吃掉"同一条纪律。所以这里只做三件事：标出来、不推、说清是哪一栏超了多少。
//    （例外见 ③。）
// ② 数字的**唯一真源是这张表**，而这张表与真 sanitizer 的对应关系由回归层 A 逐字段探两边
//    （恰好 N 字节收得下、N+3 字节必须拒），漂一个字节就报红——写完表不等于表是对的。
// ③ 审计那两栏（`auditAction`/`auditDetail`）**是我们自己生成的句子**，源头都已经先切过用户文本，
//    真超长时只有截断这一条路：留着超长句子等于把整条任务锁死在存不上的状态，而用户没法去编辑一行审计。
//    所以这里截，且截的是我们自己写的话，不是家属写的话。

export type FieldKey =
  | "purpose" | "patientLabel" | "dept" | "summaryNote" | "questionText"
  | "actionContent" | "actionDoneNote" | "fieldLabel" | "fieldValue" | "docName"
  | "auditAction" | "auditDetail"
  // R76：载荷里**嵌套**的那三栏。它们不是家属打的字，是识别回来的结果——而识别那一边
  // （`functions/extraction.mjs`）原来按**字符**切（4000/2000 字符），存储这一边按**字节**拒
  // （8000/4000 字节），汉字 3 字节 ⇒ 一份 1400 个汉字的识别段落就足以把整条任务锁死。
  // 源头已经改成按字节切了，这里仍然要扫：漂移网（与 R75 同一道理——本机自查不许拿服务端那句
  // 不带栏名的 400 去猜是哪一栏）。
  | "blockText" | "fieldOcrRaw" | "fieldAiValue";

export interface FieldLimit {
  /** 服务端 `str(v, N)` 的那个 N：UTF-8 字节数，不是字符数 */
  bytes: number;
  /** 界面上说人话时用的栏名 */
  label: string;
}

export const FIELD_LIMITS: Record<FieldKey, FieldLimit> = {
  purpose: { bytes: 600, label: "为谁准备" },
  patientLabel: { bytes: 200, label: "称呼" },
  dept: { bytes: 120, label: "科室" },
  summaryNote: { bytes: 6000, label: "复诊摘要" },
  questionText: { bytes: 2000, label: "要问医生的问题" },
  actionContent: { bytes: 300, label: "行动内容" },
  actionDoneNote: { bytes: 300, label: "完成备注" },
  fieldLabel: { bytes: 200, label: "信息项名称" },
  fieldValue: { bytes: 4000, label: "你修改后的值" },
  docName: { bytes: 300, label: "资料名称" },
  auditAction: { bytes: 60, label: "操作类型" },
  auditDetail: { bytes: 500, label: "操作记录" },
  blockText: { bytes: 8000, label: "识别出的一段页面文字" },
  fieldOcrRaw: { bytes: 12000, label: "信息项的原文转写" },
  fieldAiValue: { bytes: 4000, label: "信息项的识别值" },
};

/** 一个字符占几字节由内容决定（汉字 3、emoji 4、ASCII 1），所以只能真算 */
export function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

export function fieldBytes(key: FieldKey, value: string): number {
  return utf8Bytes(value ?? "");
}

/** 超出多少字节（没超 ⇒ 0） */
export function overByBytes(key: FieldKey, value: string): number {
  return Math.max(0, fieldBytes(key, value) - FIELD_LIMITS[key].bytes);
}

export function fitsField(key: FieldKey, value: string): boolean {
  return overByBytes(key, value) === 0;
}

/**
 * 输入框旁边那一句，只在超限时才渲染（没超限时不占地方）。
 * **按字节**说，并给两个真实数字（上限、现在多少）——只说"太长了"等于没说话：
 * 家属不知道要删到哪里才算删够。
 */
export function overLimitHint(key: FieldKey, value: string): string {
  const limit = FIELD_LIMITS[key].bytes;
  const bytes = fieldBytes(key, value);
  if (bytes <= limit) return "";
  return `「${FIELD_LIMITS[key].label}」超出服务器上限：现在 ${bytes} 字节，最多 ${limit} 字节（一个汉字占 3 字节）——这条任务先存不上`;
}

export interface OverLimitField {
  key: FieldKey;
  label: string;
  bytes: number;
  limit: number;
  /** 在载荷里的位置，例如 actions[2].content —— 让人找得到是哪一栏 */
  at: string;
}

/**
 * 本机自查：这份载荷里哪几栏服务器收不下。
 * 保存失败时那句诊断、以及"先别推"的判断，都从这里出——**不许**拿服务端回的 400 猜是哪一栏
 * （`sanitizeTaskPayload` 对所有越界都回同一个 `invalid_payload`，它自己不点名）。
 */
export function overLimitFields(payload: unknown): OverLimitField[] {
  const out: OverLimitField[] = [];
  if (!payload || typeof payload !== "object") return out;
  const p = payload as Record<string, unknown>;
  const push = (key: FieldKey, at: string, value: unknown, label?: string) => {
    if (typeof value !== "string") return;
    const bytes = fieldBytes(key, value);
    const limit = FIELD_LIMITS[key].bytes;
    if (bytes > limit) out.push({ key, label: label ?? FIELD_LIMITS[key].label, bytes, limit, at });
  };
  push("purpose", "purpose", p.purpose);
  push("patientLabel", "patientLabel", p.patientLabel);
  push("dept", "dept", p.dept);
  push("summaryNote", "summaryNote", p.summaryNote);
  (Array.isArray(p.questions) ? p.questions : []).forEach((q, i) => push("questionText", `questions[${i}].text`, (q as Record<string, unknown>)?.text));
  (Array.isArray(p.actions) ? p.actions : []).forEach((a, i) => {
    push("actionContent", `actions[${i}].content`, (a as Record<string, unknown>)?.content);
    push("actionDoneNote", `actions[${i}].doneNote`, (a as Record<string, unknown>)?.doneNote);
  });
  (Array.isArray(p.fields) ? p.fields : []).forEach((f, i) => {
    const rec = f as Record<string, unknown>;
    const name = typeof rec?.label === "string" && rec.label ? rec.label : `第 ${i + 1} 个信息项`;
    push("fieldLabel", `fields[${i}].label`, rec?.label);
    push("fieldValue", `fields[${i}].userValue`, rec?.userValue);
    push("fieldAiValue", `fields[${i}].aiValue`, rec?.aiValue, `「${name}」的识别值`);
    push("fieldOcrRaw", `fields[${i}].ocrRaw`, rec?.ocrRaw, `「${name}」的原文转写`);
  });
  (Array.isArray(p.documents) ? p.documents : []).forEach((d, i) => {
    const doc = d as Record<string, unknown>;
    push("docName", `documents[${i}].name`, doc?.name);
    // 点名要点到"哪一份、哪一页"——那些段落是识别回来的页面文字，界面上只能按资料与页找到
    const docName = typeof doc?.name === "string" && doc.name ? doc.name : `第 ${i + 1} 份资料`;
    (Array.isArray(doc?.pages) ? doc.pages : []).forEach((pg, j) => {
      const page = pg as Record<string, unknown>;
      const at = typeof page?.pageNo === "number" ? `第 ${page.pageNo} 页` : `第 ${j + 1} 页`;
      (Array.isArray(page?.blocks) ? page.blocks : []).forEach((b, k) =>
        push("blockText", `documents[${i}].pages[${j}].blocks[${k}].text`, (b as Record<string, unknown>)?.text,
          `「${docName}」${at}识别出的一段页面文字`));
    });
  });
  (Array.isArray(p.audit) ? p.audit : []).forEach((a, i) => {
    push("auditAction", `audit[${i}].action`, (a as Record<string, unknown>)?.action);
    push("auditDetail", `audit[${i}].detail`, (a as Record<string, unknown>)?.detail);
  });
  return out;
}

/** 页头／错误位那一句：点名是哪几栏、各超多少；一条都点不出来时不许编原因 */
export function overLimitNotice(over: OverLimitField[]): string {
  if (!over.length) return "";
  const parts = over.slice(0, 3).map((o) => `「${o.label}」现在 ${o.bytes} 字节，最多 ${o.limit} 字节`);
  const more = over.length > 3 ? `等 ${over.length} 处` : "";
  return `这些内容超出服务器可存的长度，这份还没存上：${parts.join("；")}${more}。长度按 UTF-8 字节算（一个汉字 3 字节），把标出来的那一栏删短后即可自动重存。`;
}

/**
 * 按字节把字符串截到上限内，**绝不把代理对切成一半**（切一半会留下非法 UTF-16，再编码就多出 U+FFFD）。
 * 只给"不是人写的判断内容"的那几栏用：审计句子走 `capAuditText`，资料名称（文件名）走这个。
 * 用户写的那些栏一律不截——见文件头第 ① 条。
 */
export function capToFieldBytes(value: string, key: FieldKey): string {
  const limit = FIELD_LIMITS[key].bytes;
  if (utf8Bytes(value) <= limit) return value;
  let out = "";
  let bytes = 0;
  for (const ch of value) {
    const next = utf8Bytes(ch);
    if (bytes + next > limit) break;
    out += ch;
    bytes += next;
  }
  return out;
}

/**
 * 只给用户自己写的那几栏用：**不截断**（截断＝悄悄丢掉家属写的话）。
 * 审计那两栏走 `capAuditText`，因为那是我们自己生成的句子，锁死整条任务的代价比截自己的话大。
 */
export function capAuditText(key: "auditAction" | "auditDetail", text: string): string {
  const limit = FIELD_LIMITS[key].bytes;
  if (utf8Bytes(text) <= limit) return text;
  // 按码点退，绝不把一个 emoji 的代理对切成一半（那会留下非法 UTF-16，再编码就变 U+FFFD）
  let out = "";
  let bytes = 0;
  const marker = utf8Bytes("…（已截断）");
  for (const ch of text) {
    const next = utf8Bytes(ch);
    if (bytes + next + marker > limit) break;
    out += ch;
    bytes += next;
  }
  return `${out}…（已截断）`;
}

/** 超长那一栏在哪一页改得到——位置前缀 → 页面，一处映射；界面上"去哪一栏删"那句与它同源 */
export function overLimitWhere(at: string): string {
  if (at.startsWith("actions[")) return "「4 行动清单」这一页";
  if (at.startsWith("questions[")) return "「2 信息核对」里的要问医生的问题";
  // R76：识别回来的那三栏（段落文字／原文转写／识别值）界面上**没有**逐段删掉的入口，
  // 而且删资料也带不走字段（`doc.delete` 只把字段解绑）。这一句要照实说，
  // 不许指一条"去把它改短"的、根本不存在的路（R72：入口与出路都不许兑不了诺）。
  if (at.includes(".blocks[")) return "「1 资料上传」这一页（识别出的段落文字没有逐段删掉的入口，删掉这份资料或这条任务才能腾出来）";
  if (at.includes(".aiValue") || at.includes(".ocrRaw")) return "「2 信息核对」这一页（识别值与原文转写没有编辑入口，只能删掉那条资料或这条任务）";
  if (at.startsWith("fields[")) return "「2 信息核对」这一页";
  if (at.startsWith("documents[")) return "「1 资料上传」这一页";
  if (at === "summaryNote") return "「5 复诊摘要」这一页";
  if (at.startsWith("audit[")) return "「隐私与数据」里的处理与操作记录";
  return "任务信息（← 返回任务列表后点「编辑任务」）";
}

/**
 * 整条任务一次推送的载荷上限（字节）。等号右边那个数不是我们定的：
 * `functions/handler.mjs` 里 task-save 走的是 `readJson(request, 1_000_000)`，超了回 413
 * `payload_too_large`，**整条任务一个字都存不进去**。
 * 实测（2026-09-27 22:4x，产物 `index-DTEyyYGf.js`）：一条任务攒到 6 份资料时载荷
 * = **1,283,848 字节** ⇒ 413，而界面上只有「云端保存失败」＋「请删减后重试」，
 * 既没说删哪一份、也没说删了原件还在不在。这条与上面 12 栏是同一类（服务器收不下），
 * 所以放在同一处，由 A 组钉住"两边的数字不许各说各话"。
 */
export const MAX_TASK_PAYLOAD_BYTES = 1_000_000;

/** 这份载荷真有多久（就是服务端会看到的体积，同一份 JSON 形状） */
export function payloadBytes(value: unknown): number {
  return utf8Bytes(JSON.stringify(value) ?? "");
}

/** 载荷里文本层最重的那一份资料（"要删就说说删哪一份最有用"） */
export function biggestTextDoc(payload: unknown): { name: string; bytes: number } | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const docs = (payload as { documents?: unknown }).documents;
  if (!Array.isArray(docs)) return undefined;
  let best: { name: string; bytes: number } | undefined;
  for (const d of docs) {
    const doc = d as { name?: unknown; pages?: unknown };
    if (!Array.isArray(doc.pages)) continue;
    let bytes = 0;
    for (const p of doc.pages) {
      const blocks = (p as { blocks?: unknown }).blocks;
      if (!Array.isArray(blocks)) continue;
      for (const b of blocks) bytes += utf8Bytes((b as { text?: string }).text ?? "");
    }
    if (!best || bytes > best.bytes) best = { name: typeof doc.name === "string" ? doc.name : "（未命名资料）", bytes };
  }
  return best;
}

/** 这份载荷现在还剩多少字节可塞（服务端那 1MB 减去已用掉、再留一点给这一次新增本身） */
export function payloadRoomBytes(payload: unknown): number {
  return Math.max(0, MAX_TASK_PAYLOAD_BYTES - payloadBytes(payload) - UPLOAD_HEADROOM_BYTES);
}

/**
 * 给"这一次新增"预留的字节。文字层之外，一份新资料还会带来：每页那层壳
 * （`{"id":…,"pageNo":…,"kind":…,"empty":…,"blocks":[…]}`，最多 20 页）、资料记录本身
 * （名称按 `docName` 上限 300 字节）、以及一条 `doc.upload` 审计（`auditDetail` 上限 500 字节）。
 * 20_000 是这些的几十倍余量——为什么要这么松：连点两次「选择文件」时两个解析循环看到的
 * 是同一份"已经用了多少"，各裁各的会双双超量（真浏览器实测到：三份资料裁完 885,654 字节文字层、
 * 整份载荷 1,032,527 字节）。留头寸吸收这一格，剩下的仍越界时由 `payloadBlockReason` 点名、不推。
 */
export const UPLOAD_HEADROOM_BYTES = 20_000;

/**
 * 整份载荷过大那一句。给的必须是**事实与要求**，不是一句保证：
 * 「替换最重的那一份一定能存上去」这种话我们兑现不了（要腾出的差额可能比那一份还大），
 * 所以这句话只说三件事——现在多少、上限多少、要腾出多少，以及界面上真有的那两条路
 * （那一行的「替换」会裁进预算；「删除」会拿走整份资料）。R72 的纪律：出路必须真存在。
 */
export function payloadSizeNotice(bytes: number, biggest?: { name: string; bytes: number }): string {
  const need = bytes - MAX_TASK_PAYLOAD_BYTES;
  const head = `这条任务的内容合计 ${bytes} 字节，服务器一次最多收 ${MAX_TASK_PAYLOAD_BYTES} 字节，所以要腾出至少 ${need} 字节才存得上，而现在一个字都还没存上去`;
  if (!biggest || biggest.bytes <= 0) {
    return `${head}；这条任务里没有带文字层的资料，要腾的地方在各栏文字与操作记录本身（本机那份照旧可以看、可以打印、可以带去就诊）`;
  }
  return `${head}；文本层最重的是「${biggest.name}」（${biggest.bytes} 字节）——可以用它那一行的「替换」重传一次，本机会把它的文字层裁进这条任务剩下的空间（原件仍完整保存在站点存储，不会因此丢页），或者直接删掉不再需要的资料。已经存上去的其它资料不受影响`;
}

/**
 * 一条任务最多带多少条操作记录（服务端 `functions/validate.mjs` 里 `audit.length > 2000` 是**整体 400 拒收**，
 * 也就是这条任务之后每次改动都存不上）。R82 现测：这道门**不会被上面那道 1MB 门提前遮住**——
 * 2000 条最小形状的记录整份载荷只有 181,641 字节，占 1MB 的 18%，而在此之前界面上只有
 * 「云端保存失败」＋一个白按的「重试」。所以它得和单栏字节、整份字节并列为第三道门（R83）。
 * 这个数字由 A 组拿真 `sanitizeTaskPayload` 在边界上对死（2000 收、2001 拒），改一头就红。
 */
export const MAX_AUDIT_ENTRIES = 2000;

/**
 * 操作记录条数这道门的那一句。**界面上没有逐条删掉记录的地方**，所以出路只有"删掉整条任务"那一条，
 * 而它住在「隐私与数据」页的「删除就诊任务」那一张里、**无法恢复**——不许指一条不存在的路（R72），
 * 也不许把不可逆说轻。同理不许顺手承诺"我们替你删最早的几条"：那些行记着"哪天谁改过什么"，
 * 删它是替患者做决定，得人来（与 R75「绝不截断家属写的话」同一条纪律，只是这里的对象是我们自己的记录）。
 */
export function auditCountNotice(payload: unknown): string {
  const audit = (payload as { audit?: unknown } | null)?.audit;
  if (!Array.isArray(audit) || audit.length <= MAX_AUDIT_ENTRIES) return "";
  return `这条任务的操作记录已有 ${audit.length} 条，服务器一条任务最多收 ${MAX_AUDIT_ENTRIES} 条，所以现在一个字都存不上；本机这份照旧能看、能打印、能带去就诊。界面上没有逐条删掉记录的地方，要腾出来只能删掉整条任务——它在「隐私与数据」页的「删除就诊任务」那一张里，确认框会先说清会失去什么，而且删掉无法恢复。最早的记录我们不会替你删：那些行记着哪天谁改过什么，删它得由你来定`;
}

/**
 * "不是某一栏太长，而是这条任务**整体**存不上"那一句。两道门都在这一处排序：
 * 先合计字节（能靠删资料/替换腾出来，出路多），再操作记录条数（只能删整条任务）。
 * 页头顶端那段与页头那颗芯片都走这里 ⇒ 两处不会有一天说的话不一样。
 */
export function payloadOversizeNotice(payload: unknown): string {
  const bytes = payloadBytes(payload);
  if (bytes > MAX_TASK_PAYLOAD_BYTES) return payloadSizeNotice(bytes, biggestTextDoc(payload));
  return auditCountNotice(payload);
}

/**
 * 页顶那句后面跟着的补充说明。**只有"合计字节"那道门才谈得上"那个合计是多少"**——
 * 条数那道门上再说"合计"就是让人去找一个屏幕上根本不存在的数字（R83 真浏览器量到：
 * 2001 条记录时那句挂着"那个合计就是…"，而那一刻界面上没有任何合计）。没在报警时返回空串。
 */
export function payloadOversizeTail(payload: unknown): string {
  if (!payloadOversizeNotice(payload)) return "";
  if (payloadBytes(payload) > MAX_TASK_PAYLOAD_BYTES) {
    return "那个合计就是服务器要收下的那份 JSON 的大小；本机上这条任务照旧可以看、可以改、可以打印。";
  }
  return "本机上这条任务照旧可以看、可以改、可以打印；在记录条数降回上限之前，这条任务会一直挂在这里。";
}

/**
 * 这份载荷现在**能不能推**。返回空串＝可以推；否则返回那句该说给家属看的话。
 * 三条理由按"先能改的后说不能改的"排：单栏超长（删短那一栏）→ 整份字节超上限（删资料或替换）
 * → 操作记录条数超上限（只能删整条任务，R83 新钉的那道门）。
 *
 * 句首要带任务名：页头那颗芯片是**全局**的（哪一条存不上都说这一颗），而人可能正看着另一条任务——
 * 只说"这条任务"就会被读成"眼前这条存不上"。真浏览器实测到这一格：新任务已经同步好了，
 * 页头仍因另一条旧任务挂着「存不上」。
 */
export function payloadBlockReason(payload: unknown): string {
  const over = overLimitFields(payload);
  const reason = over.length ? overLimitNotice(over) : payloadOversizeNotice(payload);
  if (!reason) return "";
  const purpose = (payload as { purpose?: unknown } | null)?.purpose;
  const who = typeof purpose === "string" && purpose ? `「${purpose.slice(0, 12)}」` : "";
  return `${who}${reason}`;
}

export const FIELD_KEYS = Object.keys(FIELD_LIMITS) as FieldKey[];
