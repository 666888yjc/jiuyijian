// 就医笺 · 状态归约（纯逻辑：无 React、无浏览器依赖，可被 node 直接导入断言）
import type {
  ActionItem,
  AuditEvent,
  ExtractedField,
  QuestionItem,
  SourceDocument,
  SummaryVersion,
  VisitTask,
} from "./types";
import { now, uid } from "./sheet";
import { brokenRefAuditDetail, referencingTasks } from "./reference";

export const TOMBSTONE_LIMIT = 200;

export interface AppState {
  tasks: VisitTask[];
  /** 已删除任务的留痕：只含科室、拟就诊日期、资料数、字段数与时间，不含任何资料内容 */
  tombstones: AuditEvent[];
  /** 非任务归属的全局操作记录（如「导出我的数据」data.export）；同样只含操作与数量，不含资料内容 */
  events: AuditEvent[];
}

/** 任务本体已被删除，其审计条目随之消失；这里留一条不可争辩的最小化记录。
 *  标识只取科室与拟就诊日期：purpose 常含症状描述、patientLabel 常含亲属关系，
 *  二者都属于资料内容，一旦进入留痕就与「不含资料内容」的承诺矛盾（HE-08）。 */
function tombstoneFor(task: VisitTask): AuditEvent {
  const dept = task.dept.trim() || "科室未填";
  const visitDate = task.visitDate.trim() || "日期未填";
  return {
    id: uid("a-"),
    at: now(),
    action: "task.delete",
    detail: `已删除任务（${dept} · 拟就诊 ${visitDate}）及其 ${task.documents.length} 份资料、${task.fields.length} 项信息（本条为删除留痕，不含资料内容）`,
  };
}

export type Action =
  | { type: "load"; state: AppState }
  | { type: "task.create"; task: VisitTask }
  | { type: "task.updateMeta"; taskId: string; patch: Partial<Pick<VisitTask, "patientLabel" | "purpose" | "dept" | "visitDate">> }
  /**
   * R97「并排挑一份」挑了服务器那一版时用：**整条换成服务器那一份**。
   * 故意不走 `mapTask`——那条会给 `updatedAt` 盖上新时刻，于是"刚采纳完服务器那份"立刻又被判成
   * "本机动了"，反过来把服务器那份盖掉；挑一次必须一次收敛，不许来回荡。
   */
  | { type: "task.replace"; task: VisitTask }
  | { type: "task.delete"; taskId: string }
  | { type: "doc.add"; taskId: string; doc: SourceDocument }
  | { type: "doc.update"; taskId: string; docId: string; patch: Partial<SourceDocument> }
  | { type: "doc.delete"; taskId: string; docId: string }
  | { type: "doc.stripObjectPaths"; taskId: string }
  | { type: "field.add"; taskId: string; field: ExtractedField }
  | { type: "field.addMany"; taskId: string; fields: ExtractedField[] }
  | { type: "field.move"; taskId: string; fieldId: string; dir: -1 | 1 }
  | { type: "field.dropSourceGone"; taskId: string; dropIds: string[] }
  | { type: "field.confirm"; taskId: string; fieldId: string; status: ExtractedField["confirmStatus"]; userValue?: string; audit: AuditEvent }
  /**
   * R112「算同一项」/「拆开」：一次点下来改的是**这一项下的几条记录**（`fieldIds`），不是整条任务。
   * `itemGroup === null` 就是拆开（把这个键去掉）；确认态、值、证据引用一律不动——并项只是换个看法，不是核对结论。
   */
  | { type: "field.setItemGroup"; taskId: string; fieldIds: string[]; itemGroup: string | null; audit: AuditEvent }
  | { type: "question.add"; taskId: string; question: QuestionItem }
  | { type: "question.delete"; taskId: string; questionId: string }
  | { type: "action.add"; taskId: string; item: ActionItem }
  | { type: "action.toggle"; taskId: string; actionId: string; done: boolean; doneNote?: string }
  | { type: "action.delete"; taskId: string; actionId: string }
  | { type: "action.update"; taskId: string; actionId: string; content: string }
  | { type: "summary.setNote"; taskId: string; note: string }
  | { type: "summary.saveVersion"; taskId: string; version: SummaryVersion }
  | { type: "summary.deleteVersion"; taskId: string; versionId: string }
  | { type: "sheet.toggleHidden"; taskId: string; fieldId: string }
  | { type: "audit.push"; taskId: string; audit: AuditEvent }
  | { type: "event.push"; audit: AuditEvent };

function touch(task: VisitTask): VisitTask {
  return { ...task, updatedAt: now() };
}

/** 认得出"来源资料已删除"的历史形状：AI 字段、没有 docId、id 前缀是某份资料的头 8 位，而那份资料已经不在任务里 */
export function markLegacySourceGone(t: VisitTask): VisitTask {
  const docPrefixes = new Set(t.documents.map((d) => d.id.slice(0, 8)));
  let touched = false;
  const fields = t.fields.map((f) => {
    if (f.docGone || f.docId || f.source === "user") return f;
    const m = /^([0-9a-f]{8})-/.exec(f.id);
    if (!m || docPrefixes.has(m[1])) return f;
    touched = true;
    return { ...f, docGone: true };
  });
  return touched ? { ...t, fields } : t;
}

function mapTask(state: AppState, taskId: string, fn: (t: VisitTask) => VisitTask): AppState {
  return { ...state, tasks: state.tasks.map((t) => (t.id === taskId ? touch(fn(t)) : t)) };
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "load":
      return {
        // R101：`docGone` 这个标记位是本轮才加的，而**在它存在之前**被删过资料的任务已经留下了"AI 字段没有 docId、id 却带着那份资料前缀"的形状。
        // 不补这一步，那些字段会一直既不出现在"来源已删除"的提示里、又能被确认进单——修了将来、留了历史，等于没修。只在 load 时补，且**不动 updatedAt**（动了每次刷新都被判成"本机有未推改动"，撞上 R74 那一族）。
        tasks: action.state.tasks.map(markLegacySourceGone),
        tombstones: action.state.tombstones ?? state.tombstones,
        events: action.state.events ?? state.events ?? [],
      };
    case "task.create":
      return { ...state, tasks: [action.task, ...state.tasks] };
    case "task.updateMeta":
      return mapTask(state, action.taskId, (t) => ({ ...t, ...action.patch }));
    case "task.replace":
      // 见类型注释：不碰 updatedAt，挑一次就收敛一次
      return { ...state, tasks: state.tasks.map((t) => (t.id === action.task.id ? action.task : t)) };
    case "task.delete": {
      const doomed = state.tasks.find((t) => t.id === action.taskId);
      if (!doomed) return state;
      // U11 删除边界（I4/I5，选项 b）：允许删除被引用任务，引用方字段值不动，
      // 仅把链接标记断裂并写一条审计——删除权不被数据依赖绑架（与 HE-18 同构：
      // 门槛只防"操作被阻塞"，不加在数据依赖上）。断裂是展示层降级，不是数据损坏。
      const refs = referencingTasks(state.tasks, action.taskId);
      const tasks = state.tasks
        .filter((t) => t.id !== action.taskId)
        .map((t) => {
          const ref = refs.find((r) => r.task.id === t.id);
          if (!ref) return t;
          return touch({
            ...t,
            audit: [
              ...t.audit,
              { id: uid("a-"), at: now(), action: "reference.broken", detail: brokenRefAuditDetail(doomed, ref.count) },
            ],
          });
        });
      return {
        ...state,
        tasks,
        tombstones: [...state.tombstones, tombstoneFor(doomed)].slice(-TOMBSTONE_LIMIT),
      };
    }
    case "doc.add":
      return mapTask(state, action.taskId, (t) => ({ ...t, documents: [...t.documents, action.doc] }));
    case "doc.update":
      return mapTask(state, action.taskId, (t) => ({
        ...t,
        documents: t.documents.map((d) => (d.id === action.docId ? { ...d, ...action.patch } : d)),
      }));
    case "doc.delete":
      return mapTask(state, action.taskId, (t) => {
        const documents = t.documents.filter((d) => d.id !== action.docId);
        // 删除资料后，引用该资料的字段同步失效：回到待确认并保留人工修改值
        const fields = t.fields.map((f) =>
          f.docId === action.docId
            ? { ...f, confirmStatus: "pending" as const, docId: undefined, pageId: undefined, blockIds: undefined, docGone: true, updatedAt: now() }
            : f,
        );
        return { ...t, documents, fields };
      });
    case "doc.stripObjectPaths":
      return mapTask(state, action.taskId, (t) => ({
        ...t,
        documents: t.documents.map(({ objectPath, ...d }) => ({ ...d, objectPath: undefined })),
      }));
    case "field.add":
      return mapTask(state, action.taskId, (t) => ({ ...t, fields: [...t.fields, action.field] }));
    case "field.addMany":
      return mapTask(state, action.taskId, (t) => ({ ...t, fields: [...t.fields, ...action.fields] }));
    case "field.dropSourceGone":
      // 只清"来源资料已删除"的那批，且**要删哪些由调用方点名**（reducer 自己不去猜哪些该留）；一次动作写一条审计，由界面 push。
      return mapTask(state, action.taskId, (t) => ({ ...t, fields: t.fields.filter((f) => !action.dropIds.includes(f.id)) }));
    case "field.move":
      return mapTask(state, action.taskId, (t) => {
        const fields = [...t.fields];
        const from = fields.findIndex((f) => f.id === action.fieldId);
        if (from < 0) return { ...t, fields };
        let to = from;
        do {
          to += action.dir;
        } while (to >= 0 && to < fields.length && fields[to].group !== fields[from].group);
        if (to < 0 || to >= fields.length) return { ...t, fields };
        [fields[from], fields[to]] = [fields[to], fields[from]];
        return { ...t, fields };
      });
    case "field.confirm":
      return mapTask(state, action.taskId, (t) => ({
        ...t,
        fields: t.fields.map((f) =>
          f.id === action.fieldId
            ? {
                ...f,
                confirmStatus: action.status,
                userValue: action.userValue !== undefined ? action.userValue : f.userValue,
                updatedAt: now(),
              }
            : f,
        ),
        audit: [...t.audit, action.audit],
      }));
    case "field.setItemGroup": {
      const ids = new Set(action.fieldIds);
      return mapTask(state, action.taskId, (t) => ({
        ...t,
        fields: t.fields.map((f) => {
          if (!ids.has(f.id)) return f;
          if (action.itemGroup === null) {
            const next = { ...f };
            // 整个键去掉，不留 `itemGroup: undefined`——服务器那一行没有这个键，留着就成了永久的"本机有未推改动"（R74 那一族）
            delete next.itemGroup;
            return next;
          }
          return { ...f, itemGroup: action.itemGroup };
        }),
        audit: [...t.audit, action.audit],
      }));
    }
    case "question.add":
      return mapTask(state, action.taskId, (t) => ({ ...t, questions: [...t.questions, action.question] }));
    case "question.delete":
      return mapTask(state, action.taskId, (t) => ({ ...t, questions: t.questions.filter((q) => q.id !== action.questionId) }));
    case "action.add":
      return mapTask(state, action.taskId, (t) => ({ ...t, actions: [...(t.actions ?? []), action.item] }));
    case "action.toggle":
      return mapTask(state, action.taskId, (t) => ({
        ...t,
        actions: (t.actions ?? []).map((a) =>
          a.id === action.actionId
            ? {
                ...a,
                done: action.done,
                doneAt: action.done ? new Date().toISOString() : undefined,
                doneNote: action.done ? action.doneNote : undefined,
              }
            : a,
        ),
      }));
    case "action.delete":
      return mapTask(state, action.taskId, (t) => ({ ...t, actions: (t.actions ?? []).filter((a) => a.id !== action.actionId) }));
    // R77：改内容。此前只有 add/toggle/delete ⇒ 一条打错字、或长度顶到服务器那道 300 字节门的行动，
    // 唯一的出路是**整条删掉重填**（把家属自己写的话删掉，还要重填日期与挂的字段）。
    // 只换 content：完成状态、完成记录、日期、挂接字段一律不动（那条决定不是这次要改的）。
    case "action.update":
      return mapTask(state, action.taskId, (t) => ({
        ...t,
        actions: (t.actions ?? []).map((a) => (a.id === action.actionId ? { ...a, content: action.content } : a)),
      }));
    case "summary.setNote":
      return mapTask(state, action.taskId, (t) => ({ ...t, summaryNote: action.note.slice(0, 2000) }));
    case "summary.saveVersion":
      return mapTask(state, action.taskId, (t) => ({
        ...t,
        summaryVersions: [action.version, ...(t.summaryVersions ?? [])].slice(0, 20),
      }));
    case "summary.deleteVersion":
      return mapTask(state, action.taskId, (t) => ({
        ...t,
        summaryVersions: (t.summaryVersions ?? []).filter((v) => v.id !== action.versionId),
      }));
    case "sheet.toggleHidden":
      return mapTask(state, action.taskId, (t) => ({
        ...t,
        sheetHidden: t.sheetHidden.includes(action.fieldId)
          ? t.sheetHidden.filter((id) => id !== action.fieldId)
          : [...t.sheetHidden, action.fieldId],
      }));
    case "audit.push":
      return mapTask(state, action.taskId, (t) => ({ ...t, audit: [...t.audit, action.audit] }));
    case "event.push":
      return { ...state, events: [...(state.events ?? []), action.audit].slice(-TOMBSTONE_LIMIT) };
  }
}
