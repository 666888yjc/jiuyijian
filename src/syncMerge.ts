// 「服务端那份和本机这份，谁的算」——唯一一处实现（R70）。
//
// 为什么必须有这个模块（R69 复验留下的那条未定位缺陷）：
// 原先 `src/sync.tsx` 首次 load 里就一行 `byId.set(row.id, {...row.payload, id: row.id})`——
// **无条件**用服务端行覆盖本机同名任务，紧跟着一行 `savedRef.set(row.id, JSON.stringify(row.payload))`
// 又把"这份服务端内容"记成已经写穿的基线。于是本机上那些**改了还没推出去**的动作（900ms 防抖窗口里的
// 勾选、修正、备注，以及识别结果落库后还没写穿的那一笔）会被静默吃掉，而且因为基线已被改写成旧内容，
// 写穿队列之后也不会再推——**不是闪一下，是永久丢**。对一款靠家属逐项核对的产品，丢的是人的判断，
// 而界面当时说的是「已同步」。
//
// 这里的裁决规则只有一条，且是刻意的：**本机有还没写穿的改动 ⇒ 保住本机，让队列把它推上去**。
// 反过来（服务端行更新）确实会盖掉本机那份，但那种情况下本机没有未推的改动，盖掉的是已经存在服务器上的内容。
// 两端都可能丢的时候，选丢"可再生的东西"而不是"人的核对"：
// 服务端的识别结果永远落在「待确认」，重跑一次就有；家属点下的那次确认，重跑拿不回来（红线①）。
//
// 第二条规则（R73 补上）：**本机删过的任务不许因为"服务端还留着行"而回来**。
// 离线删除只在本地删（云端模式关闭时 `deleteTaskOnServer` 根本不调 API），服务器上那条行连同加密原件都还在，
// 重新连通就会被当一条新任务显示回来（真浏览器实测：建任务→停源删除→起回预览→reload→列表里又出现了它）。
// 判据来自只装 UUID 的本机账 `src/deletedLedger.ts`——删除留痕 `tombstoneFor` 按设计不带任务 id（留痕不许含资料内容），
// 所以复用不了。看到这种行就把 id 交给调用方去**补删**：恢复连通的那一刻是唯一能把服务器那份也删干净的时机，
// 而服务端 `task-delete` 会连带删掉原件对象，所以补删是彻底删，不是打个标记。
//
// 序列化必须是**规范形**（键排序）：合并判据比的是"本机这份和上次写穿的那份是否相同"，
// 而两边分别来自 `JSON.stringify(payloadOf(task))` 与 `JSON.stringify(row.payload)`——
// 键序不同就会把每条任务都误判成"本机有未推改动"，同步进来的方向从此永久失效，
// 而这个错只有在"另一台设备改了东西"时才看得出来。判据用 `canonicalPayload` 一处出，两边共用。
//
// 第三条规则（R74 补上）：**"本机有未推改动"这件事必须有依据，不许拿"不记得"当依据**。
// R70 的基线放在内存（`savedRef`），每次刷新清零，而清零后的判据恒为真 ⇒ 每台设备一打开页面就把
// 自己那份推回服务器，把另一台设备刚写上去的更新**覆盖掉**（2026-09-27 真浏览器实测见 `src/syncAnchor.ts` 头部：
// 本机零改动、只按一次 F5，夹具侧 `task-save` 4→5；再模拟"另一台设备"写一条更晚的行，刷新后服务器那条新值
// 被本机旧内容盖掉，界面显示的还是旧标题）。现在"谁动过"问那份跨刷新的账：
// 只有本机动了 ⇒ 保本机再推；只有服务器动了 ⇒ 采纳服务器那份（这才是同步本身）；
// 两边都动了 ⇒ **谁也不许盖谁**，停下并由页头说出来——"两份怎么合"是要人做的判断，产品不替人拍板。
import type { VisitTask } from "./types";
import type { SyncAnchor } from "./syncAnchor";

export interface ServerRow {
  id: string;
  payload: unknown;
  /** 服务端行的 `updated_at`：`functions/handler.mjs` 用服务器时钟写入，`task-save` 也把它回给客户端 */
  updatedAt?: string;
}

export interface MergeInput {
  /** 本机当前任务，可能含有还没写穿出去的改动 */
  local: VisitTask[];
  /** 服务端返回的行（`api.listTasks()`） */
  rows: ServerRow[];
  /** 本次会话的写穿基线：key＝任务 id，value＝上一次服务端确认收下并已折算的那份载荷（规范形） */
  saved: Map<string, string>;
  isSyncable: (task: VisitTask) => boolean;
  /** 本机已经删过、但还没在服务器上删干净的任务 id（`src/deletedLedger.ts`，R73） */
  deletedIds?: string[];
  /** 本机这份与服务端那份"上次一致"时的两条时间戳（`src/syncAnchor.ts`，R74） */
  anchors?: Map<string, SyncAnchor>;
}

export interface MergeResult {
  tasks: VisitTask[];
  /** 合并后的写穿基线：没被服务端确认过的那些任务，基线一律留空 ⇒ 队列会把它推上去 */
  saved: Map<string, string>;
  /** 本机删过、服务端却还留着行的任务 id ⇒ 调用方应在恢复连通后补删（服务端会连带删掉原件对象） */
  pendingServerDeleteIds: string[];
  /** 合并后的同步锚点账，调用方负责落盘；服务器上还没有对应的任务已从这里去掉 */
  anchors: Map<string, SyncAnchor>;
  /** 这次从服务端采纳下来的任务 id（本机这份不比它新） */
  adoptedFromServerIds: string[];
  /** 本机与服务器各有一份、两边都有新动作 ⇒ 既不推也不盖，调用方必须说出来 */
  conflicts: string[];
  /**
   * R97：冲突那一条**服务器上那份的原样**（按 id 索引），交给界面并排展示、由用户挑一份。
   * 合并器自己不替用户决定，所以这里**只带出来、不写进 tasks**——写进去就是"悄悄盖掉本机这一份"，
   * 而那是 R74 立"谁也不许盖谁"这一档要防的事。
   * `serverAt` 是服务器写在那一行上的时间（`updated_at`，服务器时钟），与任务数据里的 `updatedAt` 分开设，
   * 界面上要各自标清楚是谁的时间，否则患者会以为是同一条记录。
   */
  conflictServerRows: Map<string, { task: VisitTask; serverAt: string }>;
}

/** 去掉 id 就是任务载荷——id 在 URL 与数据库行里，不进载荷（与 `task-save` 的入参同形） */
export function payloadOf(task: VisitTask): Omit<VisitTask, "id"> {
  const { id, ...payload } = task;
  void id;
  return payload;
}

/**
 * 把两边折成**同一个形状**再比——规则就是「`sanitizeTaskPayload` 会怎么存」。
 *
 * 不折算就会判错。真浏览器实测（产物 `index-XKoIuelR.js`，任务 `5caae5fc-…`，本机那份 vs 服务器上那一行，
 * 逐路径比出来 4 处差异，一处都不是内容差异）：
 *   · `documents[i].pages[j].empty` —— 服务端 `bool(v.empty) ?? false` 一律给出 `false`，本机的页面对象不带这个键；
 *   · `summaryNote` —— 服务端给 `""`，从没填过摘要的本机任务不带这个键；
 *   · `summaryVersions` —— 服务端给 `[]`，同上；
 *   · （以及可选键上 `null` 与"没有这个键"的差别：`sanitizeField` 对 `docId`/`pageId`/`blockIds`/
 *     `modelVersion` 是"非 null 才写进存储"，所以存储里根本没有 null 这一种。）
 * 于是"本机从没填过摘要"与"服务器那份摘要是空的"本是同一件事，直接比字符串却成了两份不同内容
 * ⇒ 每条任务永久被判成"本机有未推改动"，R74 那次多余写穿就是这么来的。
 * 这套折算与那份真 sanitizer 的对应关系由回归层 A 双向对过（`payloadFingerprint(sanitize(p))` 必须
 * 等于 `payloadFingerprint(p)`，漂了就红），不是照着想象写的。
 */
export function projectPayload(value: unknown): Record<string, unknown> {
  const src: Record<string, unknown> =
    value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
  delete src.id;
  if (typeof src.summaryNote !== "string") src.summaryNote = "";
  if (!Array.isArray(src.summaryVersions)) src.summaryVersions = [];
  if (Array.isArray(src.documents)) {
    src.documents = (src.documents as unknown[]).map((doc) => {
      if (!doc || typeof doc !== "object" || !Array.isArray((doc as { pages?: unknown }).pages)) return doc;
      const d = doc as Record<string, unknown>;
      return {
        ...d,
        pages: (d.pages as unknown[]).map((page) =>
          page && typeof page === "object" && (page as { empty?: unknown }).empty === undefined
            ? { ...(page as Record<string, unknown>), empty: false }
            : page,
        ),
      };
    });
  }
  return src;
}

/**
 * 递归按键排序的 JSON：让"内容相同"这个判断不受键序影响。
 * 对象属性里的 `null` / `undefined` 一律不进比对——服务端对可选键的口径是"非 null 才写进存储"，
 * 留着它们会把"没填"和"没这个键"当成两种不同内容（实测见 `projectPayload` 上面那段）。
 */
export function canonicalPayload(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        const item = (v as Record<string, unknown>)[k];
        if (item === undefined || item === null) continue;
        out[k] = norm(item);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(norm(value));
}

/** 载荷的比对指纹＝折算 + 规范形。写穿基线、合并判据、页头那句「已同步」必须共用这一个口径 */
export function payloadFingerprint(value: unknown): string {
  return canonicalPayload(projectPayload(value));
}

/**
 * 这个任务本机这份，是否还没被服务器确认收下。
 * 会话内有基线就问基线（最精确）；刷新过、基线空了，就问锚点；两份都没有才算"未知 ⇒ 当作待推"。
 */
export function hasUnpushedEdit(
  task: VisitTask,
  saved: Map<string, string>,
  anchors?: Map<string, SyncAnchor>,
): boolean {
  const fp = payloadFingerprint(payloadOf(task));
  const baseline = saved.get(task.id);
  if (baseline !== undefined) return baseline !== fp;
  const anchor = anchors?.get(task.id);
  if (anchor) return anchor.localAt !== task.updatedAt;
  return true;
}

/** 行的服务端时间戳：`tasks` 把 `updated_at` 平铺在行上；旧版函数没有这个字段时退回载荷里那份 */
function serverStampOf(row: ServerRow): string {
  if (typeof row.updatedAt === "string" && row.updatedAt) return row.updatedAt;
  const inPayload = (row.payload as { updatedAt?: unknown } | undefined)?.updatedAt;
  return typeof inPayload === "string" ? inPayload : "";
}

function toTask(row: ServerRow): VisitTask {
  return { ...(row.payload as Omit<VisitTask, "id">), id: row.id };
}

/** 记"此刻两边是同一份"：两条时间戳缺一条就记不成对，宁可不记（下次落到"无从判断"那一支，不会覆盖别人） */
function rememberConsistent(anchors: Map<string, SyncAnchor>, row: ServerRow): void {
  const serverAt = serverStampOf(row);
  const localAt = (row.payload as { updatedAt?: unknown } | undefined)?.updatedAt;
  if (!serverAt || typeof localAt !== "string" || !localAt) {
    anchors.delete(row.id);
    return;
  }
  anchors.set(row.id, { serverAt, localAt });
}

export function mergeServerRows(input: MergeInput): MergeResult {
  const byId = new Map<string, VisitTask>(input.local.map((t) => [t.id, t] as const));
  const saved = new Map(input.saved);
  const anchors = new Map(input.anchors ?? []);
  const pendingServerDeleteIds: string[] = [];
  const adoptedFromServerIds: string[] = [];
  const conflicts: string[] = [];
  const conflictServerRows = new Map<string, { task: VisitTask; serverAt: string }>();
  const deleted = new Set(input.deletedIds ?? []);
  const onServer = new Set<string>();

  for (const row of input.rows) {
    if (deleted.has(row.id)) {
      // 本机删过的：不许因为它还在服务器上就把它显示回来（用户按下的是删除键，不是"稍后再问我一次"）；
      // 同时把 id 交给调用方去补删——恢复连通的那一刻正是唯一能把服务器那份也删干净的时候。
      byId.delete(row.id);
      saved.delete(row.id);
      anchors.delete(row.id);
      pendingServerDeleteIds.push(row.id);
      continue;
    }
    onServer.add(row.id);
    const rowFp = payloadFingerprint(row.payload);
    const localTask = byId.get(row.id);
    if (!localTask) {
      // 本机没有这条（多半是另一台设备建的）：直接采纳，并记下"此刻两边是同一份"
      byId.set(row.id, toTask(row));
      saved.set(row.id, rowFp);
      rememberConsistent(anchors, row);
      continue;
    }
    const localFp = payloadFingerprint(payloadOf(localTask));
    if (localFp === rowFp) {
      // 内容相同 ⇒ 既不推也不盖。R74 少掉的那一次多余写穿就落在这里：
      // 判"相同"必须先折算形状，否则从没填过摘要的任务永远走不到这一支。
      saved.set(row.id, rowFp);
      anchors.set(row.id, { serverAt: serverStampOf(row), localAt: localTask.updatedAt });
      continue;
    }
    // 两份不一样。先各自问一句"你动过吗"——问的是**证据**，不是"记不记得"：
    //   · 会话内有基线（上一次服务器确认收下、或刚采纳下来的那份）⇒ 动没动拿基线比，最直接；
    //   · 没有基线（刷新过了）⇒ 问跨刷新的锚点账：本机问本机自己写的时间戳，服务器问服务器写的那条；
    //   · 两样都没有 ⇒ 无从判断，只能当作"两边都动过"，走谁也不许盖那一只。
    const baseline = input.saved.get(row.id);
    const anchor = input.anchors?.get(row.id);
    const localMoved = baseline !== undefined ? baseline !== localFp : anchor ? anchor.localAt !== localTask.updatedAt : true;
    const serverMoved = baseline !== undefined ? baseline !== rowFp : anchor ? anchor.serverAt !== serverStampOf(row) : true;
    if (!localMoved) {
      // 本机这份就是上次确认过的那份，动的是服务器 ⇒ 采纳，这就是同步本身（R70 那条正样本，防"一律保本机"的假严格）
      byId.set(row.id, toTask(row));
      saved.set(row.id, rowFp);
      rememberConsistent(anchors, row);
      adoptedFromServerIds.push(row.id);
      continue;
    }
    if (!serverMoved) {
      // 只有本机动了：防抖窗口里刚点的勾选、识别结果刚落库、或离线期间改的那一笔 ⇒ 保住本机。
      // 基线与锚点都原样留着：基线与本机这份不同，脏位就成立，队列会把它推上去。
      continue;
    }
    // 两边都动了 ⇒ 谁也不许盖谁：推上去就是把另一台设备上那个人的核对抹掉，盖下来就是把眼前这个人的抹掉。
    // 清掉基线是为了让"不推"这件事成为可断言的行为——调用方拿到 id 名单后既跳过队列，也要在页头说出来。
    // R97：同时把**服务器那一份原样带出来**给界面并排展示——合并器不替用户拍板，但必须让他看得见另一份是什么，
    // 否则"挑一份"就成了一句没有依据的按钮。
    saved.delete(row.id);
    conflicts.push(row.id);
    conflictServerRows.set(row.id, { task: toTask(row), serverAt: serverStampOf(row) });
  }

  for (const task of input.local) {
    if (onServer.has(task.id)) continue;
    if (input.isSyncable(task)) {
      saved.delete(task.id); // 服务端没有这条 ⇒ 待写穿
      anchors.delete(task.id); // 服务器上还没有这份，谈不上"上次一致"
    }
    // 本地专属任务（内置示例任务、以及 id 不是 UUID 的那些）本来就不该有基线，原样留着
  }

  return { tasks: [...byId.values()], saved, pendingServerDeleteIds, anchors, adoptedFromServerIds, conflicts, conflictServerRows };
}
