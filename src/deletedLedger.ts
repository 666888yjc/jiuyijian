// 本机记下的"我已经删过这个任务"——只存 UUID，不存任何资料内容（R73）。
//
// 为什么需要它（2026-09-27 真浏览器实测，产物 `index-DsHBFJiN.js`）：
// 云端不可达时删除任务只在本地删（`deleteTaskOnServer` 在云端模式关闭时根本不调 API），
// 服务器上那条行——连同它加密存的原件——**还在**。重新连通后 `listTasks()` 会把它当一条新任务带回来：
// 实测序列是「建云端任务→停源（夹具仍在，行仍在）→隐私页删除→本机只剩种子、留痕一条→
// 起回预览→reload」，最后一步本机任务列表里**又出现了那条已删任务**，页头还写着「已同步」。
// 用户按下的是一次删除。它回来了，这件事比"慢一拍"严重：家属会以为自己的删除没生效，
// 或者更糟——以为那份被删掉的病历又被人放回来了。
//
// 为什么不能复用现成的删除留痕（`state.tombstones`）：留痕按设计**不带任务 id**
// （`tombstoneFor` 只记科室与拟就诊日期，因为 purpose 常含症状描述、patientLabel 常含亲属关系，
// 都属于资料内容——HE-08 的口径）。所以这里单独放一份只装 UUID 的账：UUID 是随机数，
// 不承载任何病历信息，写进本机存储不会与"留痕不含资料内容"的承诺冲突。
//
// 三条刻意的取舍：
// ① **不设 TTL**。过期即遗忘＝允许复活，而这条账存在的唯一理由就是不遗忘；
//    条目在补删成功之后才销账，所以它只会因为"删干净了"而变短。
// ② 有上限（FIFO 淘汰最旧的一条）。上限是防本机存储被撑爆，不是防内容——
//    超出意味着有人离线删了 1000 个任务，那是另一种故障；这里选择"记满就丢最旧的一条"，
//    并且把它做成可断言的行为，而不是默默无限增长。
// ③ 只认 UUID 形状。示例任务（`seed-task-1` 这类）从来没有服务端行，记它没有意义，
//    还会让补删去请求一个不存在的对象。
const KEY = "jiuyijian-deleted-tasks-v1";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CAP = 1000;

export interface DeletedEntry {
  id: string;
  at: number;
}

const readRaw = (): DeletedEntry[] => {
  try {
    const parsed = JSON.parse(globalThis.localStorage.getItem(KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    // 坏数据（上一代留下的、手改过的、别的版本写的）整表降级为空，不抛——它不该拖住删除这条路
    return parsed.filter((e): e is DeletedEntry => !!e && typeof e.id === "string" && UUID_RE.test(e.id) && Number.isFinite(e.at));
  } catch {
    return [];
  }
};

const writeRaw = (entries: DeletedEntry[]) => {
  try {
    globalThis.localStorage.setItem(KEY, JSON.stringify(entries));
  } catch {
    // 写不进去（隐私模式 / 配额）时这条账就只能少记一次；删除本身仍要成功，不因为记账失败而卡住用户
  }
};

/** 记一笔"这个任务我删过"，返回记账后的整表（同 id 不重复累积） */
export function rememberDeleted(taskId: string, at: number = Date.now()): DeletedEntry[] {
  const entries = readRaw();
  if (!UUID_RE.test(taskId) || entries.some((e) => e.id === taskId)) return entries;
  // 超上限时丢最旧的一条：新的一次删除更要紧（它对应刚刚按下删除键的那个人）
  const next = [...entries, { id: taskId, at }];
  const trimmed = next.length > CAP ? next.slice(next.length - CAP) : next;
  writeRaw(trimmed);
  return trimmed;
}

export function forgetDeleted(taskId: string): DeletedEntry[] {
  const trimmed = readRaw().filter((e) => e.id !== taskId);
  writeRaw(trimmed);
  return trimmed;
}

/** 当前这份账里的任务 id（合并服务端列表时用） */
export function deletedTaskIds(): string[] {
  return readRaw().map((e) => e.id);
}

/** 给测试与诊断用：整表快照 */
export function deletedLedger(): DeletedEntry[] {
  return readRaw();
}

export const DELETED_LEDGER_KEY = KEY;
export const DELETED_LEDGER_CAP = CAP;
