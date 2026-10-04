import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, ApiError, type ServerUser } from "./api";
import { useStore, makeAudit } from "./store";
import { forgetTask } from "./extractInflight";
import { fetchFileUrl } from "./fileUrlCache";
import { deletedTaskIds, forgetDeleted, rememberDeleted } from "./deletedLedger";
import { forgetSyncAnchor, readSyncAnchors, setSyncAnchor, writeSyncAnchors } from "./syncAnchor";
import { hasUnpushedEdit, mergeServerRows, payloadFingerprint, payloadOf } from "./syncMerge";
import { payloadBlockReason } from "./fieldLimits";
import { adoptedTask, conflictAudit, type ConflictChoice } from "./conflictChoice";
import type { AppState } from "./state";
import type { VisitTask } from "./types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 只有任务 id 与全部资料 id 都是 UUID 的任务才能进入服务端存储（夹具/M1 示例任务是本地专属） */
export function isSyncable(task: VisitTask): boolean {
  if (!UUID_RE.test(task.id)) return false;
  return task.documents.every((d) => UUID_RE.test(d.id));
}

export type SyncState = "idle" | "saving" | "saved" | "error" | "offline" | "conflict" | "rejected";

/**
 * 后端**摸没摸着**——与"登录了吗""能不能同步"是三件不同的事（R68）。
 *
 * 为什么必须单列：此前只有 `serverMode` 一个布尔，而它是 `false` 的两种成因根本不同——
 * ① `api.me()` 通了但访客匿名（`!me`）；② `api.me()` 直接抛（离线／Function 没部署）。
 * 两种成因被喂进同一句文案，于是**离线时当着家属的面让他去做一件此刻做不到的事**
 * （「登录后可加密上传并云端识别」——登录页都打不开），也让"这个任务的资料在哪儿"被答成
 * 「仅在本机」，而它可能上一次连通时早就上传过了。R40 修的是页头那一条入口，
 * 这一处是同一类缺陷的第二形态。
 */
export type BackendStatus = "checking" | "up" | "down";

interface SyncContextValue {
  user: ServerUser | "checking";
  signedIn: boolean;
  serverMode: boolean;
  backend: BackendStatus;
  syncState: SyncState;
  lastError: string;
  /** 本机与服务器各有一份、且两边都有新动作的任务（R74：既不推也不盖，必须说出来） */
  conflictTaskIds: string[];
  /**
   * R97：上面那些任务里**服务器那一份的原样**（合并器带出来，不写进本机 tasks）。
   * 有了它，界面才谈得上"并排看两份再挑一份"；没有它，那颗按钮就是让人在看不见对手的情况下签字。
   */
  conflictServerCopies: Record<string, { task: VisitTask; serverAt: string }>;
  /** 挑一份：`local` ⇒ 用本机这份盖服务器；`server` ⇒ 用服务器那版盖本机。两边都会**替换掉另一份且取不回来**（实测无版本可查） */
  resolveConflict: (taskId: string, keep: ConflictChoice) => void;
  /**
   * 刚刚在本页挑完一份的那条任务（挑完之后组件还要挂载一会儿，好把结果话说出来；下一次连通就清掉）。
   * R97b：这里**记下挑的是哪一份**——组件据此只复述那句结果话，不再拿还留着的副本重新给一次选择：
   * 那份副本是本轮读到的那一版，服务器一行会被后写的盖掉，第二次挑可能挑的已经不是屏幕上说的那一版了。
   */
  justResolved: { id: string; keep: ConflictChoice } | null;
  retry: () => void;
  reload: () => void;
  deleteTaskOnServer: (taskId: string) => Promise<void>;
  localOnlyTaskIds: string[];
}

const Ctx = createContext<SyncContextValue | null>(null);

export function SyncProvider({ children }: { children: ReactNode }) {
  const { state, dispatch } = useStore();
  const [user, setUser] = useState<ServerUser | "checking">("checking");
  const [serverMode, setServerMode] = useState(false);
  const [backend, setBackend] = useState<BackendStatus>("checking");
  const [syncState, setSyncState] = useState<SyncState>("idle");
  const [lastError, setLastError] = useState("");
  const [conflictTaskIds, setConflictTaskIds] = useState<string[]>([]);
  // R97：服务器那一份的原样（由合并器带出来）。放 state 是为了让界面在挑之前**看得见**它。
  const [conflictServerCopies, setConflictServerCopies] = useState<Record<string, { task: VisitTask; serverAt: string }>>({});
  const [justResolved, setJustResolved] = useState<{ id: string; keep: ConflictChoice } | null>(null);
  const conflictCopiesRef = useRef<Map<string, { task: VisitTask; serverAt: string }>>(new Map());
  const [nonce, setNonce] = useState(0);
  const savedRef = useRef<Map<string, string>>(new Map());
  const conflictRef = useRef<Set<string>>(new Set());
  const blockedRef = useRef<Map<string, string>>(new Map());
  const timerRef = useRef<number | undefined>(undefined);
  /**
   * R107：刚刚在并排挑单里**当着人的面**挑完的那一次，用哪条服务器时间戳去做条件写。
   *
   * 为什么要单独记一笔而不是复用锚点里的 `serverAt`：锚点记的是"本机上次与服务器一致"的那一版，
   * 而冲突成立的前提就是它已经过期——拿它当 expected 的话，挑完这一次照样 409，那句"已选本机这份"
   * 就永远落不了地。这里放的是**屏幕上那份副本自己的时间戳**（`conflictServerRows` 带出来的 `serverAt`），
   * 也就是用户签字时看见的那一版。
   * 一次请求后就作废（见 `queueSave`）：挑单只授权"覆盖我看见的那一版"，不授权"覆盖服务器此刻碰巧的那一版"。
   */
  const chosenOverwriteRef = useRef<Map<string, string>>(new Map());
  const stateRef = useRef(state);
  stateRef.current = state;
  const serverModeRef = useRef(serverMode);
  serverModeRef.current = serverMode;

  // 登录态与服务器任务加载
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setBackend("checking");
      try {
        const me = await api.me();
        if (cancelled) return;
        setUser(me);
        if (!me) {
          setBackend("up");
          setServerMode(false);
          return;
        }
        const rows = await api.listTasks();
        if (cancelled) return;
        setBackend("up");
        setServerMode(true);
        // 合并规则只在 src/syncMerge.ts 一处：本机有还没写穿的改动 ⇒ 保住本机，别拿服务端行盖掉它
        const merged = mergeServerRows({
          local: stateRef.current.tasks,
          rows: rows as { id: string; payload: unknown; updatedAt?: string }[],
          saved: savedRef.current,
          isSyncable,
          deletedIds: deletedTaskIds(),
          anchors: readSyncAnchors(),
        });
        savedRef.current = merged.saved;
        writeSyncAnchors(merged.anchors);
        conflictRef.current = new Set(merged.conflicts);
        setConflictTaskIds(merged.conflicts);
        // R97：把服务器那些"和本机各有一份"的任务原样留下给界面看。只留本轮读到的那些（合并每次重算，不留陈副本）
        conflictCopiesRef.current = merged.conflictServerRows;
        setConflictServerCopies(Object.fromEntries(merged.conflictServerRows));
        setJustResolved(null);
        dispatch({
          type: "load",
          state: { tasks: merged.tasks, tombstones: stateRef.current.tombstones, events: stateRef.current.events ?? [] } satisfies AppState,
        });
        if (merged.pendingServerDeleteIds.length) {
          // 刚恢复连通就把服务器上那些"本机已经删掉"的行补删掉（服务端会连带删原件对象）。
          // 失败不清账：留着下次连通再试，并且把这句如实说给家属——不许一边说「已同步」一边留着没删干净的病历。
          const failed: string[] = [];
          for (const id of merged.pendingServerDeleteIds) {
            try {
              await api.deleteTask(id);
              forgetDeleted(id);
            } catch {
              failed.push(id);
            }
          }
          if (failed.length) {
            setLastError(`有 ${failed.length} 个你已删除的任务在服务器上还没删干净，下次连通时会再试一次`);
            setSyncState("error");
          }
        }
      } catch {
        if (cancelled) return;
        // 未部署 Function 或离线：保持纯本地模式（M1 行为）
        setUser(null);
        setBackend("down");
        setServerMode(false);
        setSyncState("offline");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dispatch, nonce]);

  // 写穿：任务内容变化后防抖保存
  const queueSave = useCallback(() => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      void (async () => {
        const tasks = stateRef.current.tasks.filter(isSyncable);
        const anchors = readSyncAnchors();
        let anySaved = false;
        let failure = "";
        let sawWriteConflict = false;
        for (const task of tasks) {
          // 两边各有一份且都动过的那条**不推**：推上去就是把另一台设备上那个人的核对抹掉（R74）。
          // 这件事由页头的「本机与服务器各有一份」说出来，不靠这里默默跳过。
          if (conflictRef.current.has(task.id)) continue;
          const payload = payloadOf(task);
          const serialized = payloadFingerprint(payload);
          if (!hasUnpushedEdit(task, savedRef.current, anchors)) continue;
          // 这条任务此刻**推不出去**的理由（R75 的单栏超长 + R76 的整份超 1MB）。
          // 服务端对所有单栏越界只回同一个不带栏名的 400，对整份过大回 413 `payload_too_large`，
          // 两种失败推上去的代价是一样的：整条任务从此每次都失败，而屏幕上只有一句「云端保存失败」。
          // 所以不推，并把理由（哪一栏、超了多少 / 合计多少、动哪一份资料）说清楚——本机那份一个字都不动。
          const reason = payloadBlockReason(payload);
          if (reason) {
            blockedRef.current.set(task.id, reason);
            continue;
          }
          blockedRef.current.delete(task.id);
          setSyncState("saving");
          // R107（R97c 的修法）：这次写带上"本机最后一次从服务器读到的那一行的时间戳"。
          // 服务器那行在这之间被别人改过时，条件写让它落空并回 409，而不是把另一台设备上的核对抹掉——
          // R104 实测：不带它的今天实现两种交错（锚点已过期／读后写前插队）都被盖穿。
          // 刚从并排挑单里授权过的那一次用**屏幕上那份副本自己的时间戳**（见 `chosenOverwriteRef`），且授权只用一次。
          const expected = chosenOverwriteRef.current.get(task.id) ?? anchors.get(task.id)?.serverAt ?? "";
          chosenOverwriteRef.current.delete(task.id);
          try {
            const saved = (await api.saveTask(task.id, payload, expected || undefined)) as { updatedAt?: unknown };
            savedRef.current.set(task.id, serialized);
            // 服务器把它盖上的那个 `updated_at` 记进锚点：下次刷新才答得出"服务器这份有没有再动过"
            if (typeof saved.updatedAt === "string" && saved.updatedAt) {
              setSyncAnchor(task.id, { serverAt: saved.updatedAt, localAt: task.updatedAt });
              anchors.set(task.id, { serverAt: saved.updatedAt, localAt: task.updatedAt });
            }
            anySaved = true;
          } catch (error) {
            // 单个任务失败不阻塞其余任务的保存队列
            if (error instanceof ApiError && error.code === "login_required") {
              setLastError(error.message);
              setSyncState("offline");
              return;
            }
            if (error instanceof ApiError && error.code === "doc_reference_invalid") {
              // 存储引用已失效（如后端重置）：降级为本地资料并随队列自动重存
              dispatch({ type: "doc.stripObjectPaths", taskId: task.id });
              failure = `「${task.purpose.slice(0, 12)}」的原件引用已失效，已转为本地资料并自动重试`;
              continue;
            }
            if (error instanceof ApiError && error.code === "write_conflict") {
              // 服务器那一行在本机上次读到之后又被别人改了 ⇒ 这一次没写下去，本机那份一个字都没动。
              // 立刻把它记进冲突名单（跳过后续队列，页头当场从「已同步」改口），并重新走一遍加载：
              // 合并器拿到服务器那一版后判成"两边都动"，R97 那张「并排挑一份」就是这条的处置界面——
              // **不自己挑、不悄悄重试**，因为"两份怎么合"是要人做的判断（R74 立的规矩）。
              conflictRef.current.add(task.id);
              sawWriteConflict = true;
              continue;
            }
            failure = `「${task.purpose.slice(0, 12)}」${error instanceof ApiError ? error.message : "保存失败"}`;
          }
        }
        if (blockedRef.current.size) {
          // 「存不上」这句必须点名为什么存不上——只说失败等于让人再试一百次
          setLastError([...blockedRef.current.values()].join(" "));
          setSyncState("rejected");
        } else if (failure) {
          setLastError(failure);
          setSyncState("error");
        } else if (conflictRef.current.size) {
          setSyncState("conflict");
        } else if (anySaved) {
          setLastError("");
          setSyncState("saved");
        }
        // 撞过 409 就必须把服务器那一版读回来：合并器拿到它才判得出"两边都动"，
        // 而"并排挑一份"的界面要求人**看得见**另一份长什么样（R97）——看不见对手的签字不算签字。
        // 重试不在这里做：这一条的处置是"由人来挑"，自动重试就是把同一个覆盖请求再发一次。
        if (sawWriteConflict) setNonce((n) => n + 1);
      })();
    }, 900);
  }, []);

  useEffect(() => {
    if (!serverMode || user == null || user === "checking") return;
    // 「已同步」这句只能由"真的没有待推的改动"推出来（R70）：
    // 以前 load 一结束就无条件 setSyncState("saved")，而那笔刚改完、还在防抖窗口里的动作根本没出去。
    // R74：判"有没有待推"不许拿"内存里不记得"当依据——基线空了就问锚点；
    // 而两边各有一份、都动过的那些**既没推也没盖**，这一件事必须压在「已同步」上面说出来。
    const anchors = readSyncAnchors();
    const dirty = state.tasks.some(
      (t) => isSyncable(t) && !conflictRef.current.has(t.id) && hasUnpushedEdit(t, savedRef.current, anchors),
    );
    setSyncState(blockedRef.current.size ? "rejected" : conflictRef.current.size ? "conflict" : dirty ? "saving" : "saved");
    if (dirty) queueSave();
  }, [serverMode, user, state, queueSave]);

  const retry = useCallback(() => {
    setSyncState("idle");
    queueSave();
  }, [queueSave]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  const deleteTaskOnServer = useCallback(async (taskId: string) => {
    const task = stateRef.current.tasks.find((t) => t.id === taskId);
    // 仅云端模式（已登录且服务端可用）才调服务端删除，与写穿队列同一门槛；
    // 纯本地模式下 UUID 任务同样只在本地删除，不再因调用不可达的 Function 而失败。
    // 云端模式下删除失败保持抛出：本地若照删，下次登录合并服务端列表时已删任务会"复活"。
    if (task && serverModeRef.current && isSyncable(task)) {
      try {
        await api.deleteTask(taskId);
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== "not_found") throw error;
      }
    } else if (task && isSyncable(task)) {
      // 云端此刻不可达 ⇒ 这次只在本地删。记进删除账，下次连通时补删，别让它"复活"（R73）
      rememberDeleted(taskId);
    }
    forgetTask(taskId);
    savedRef.current.delete(taskId);
    conflictRef.current.delete(taskId);
    setConflictTaskIds((prev) => prev.filter((id) => id !== taskId));
    forgetSyncAnchor(taskId); // 任务都没了，"上次两边一致"这条记忆也不该留着（R74）
    dispatch({ type: "task.delete", taskId });
  }, [dispatch]);

  /**
   * R97「并排挑一份」。两条路都只换**这一条任务**，且都留下一次操作记录；挑完照常把选定那份推上去，两边从此一致。
   *
   * 为什么允许"覆盖"这种不可逆动作：主理人 2026-09-28 批准，而不可逆性是**量过的**——
   * 服务器一条任务只存一行，后写的 `task-save` 原地覆盖；`action=task-versions`／`task-history` 实测都回 404，
   * 所以界面上这句话必须在按下去**之前**说清，并指一条此刻真存在的出路（「隐私与数据」页的「导出我的数据（JSON）」）。
   * 拿不到另一份（本轮没读到、或已不在冲突名单里）时**什么都不做**——不许"大概挑过了"，也不许把本机这份当成服务器那份。
   */
  const resolveConflict = useCallback(
    (taskId: string, keep: ConflictChoice) => {
      const local = stateRef.current.tasks.find((t) => t.id === taskId);
      const copy = conflictCopiesRef.current.get(taskId);
      if (!local || !copy) return;
      // R107：这次签字是**对着屏幕上那一版**签的，所以接下来的那一次写穿用这一版的时间戳做条件写。
      // 服务器在这之间又被改过的话，条件写再次落空、重新给出挑单——而不是把没人看见过的第三版盖掉。
      // 副本没带服务器时间（旧版函数不回 `updatedAt`）时不记：那条路上本来就没有可比的时间戳，退回无条件写。
      if (copy.serverAt) chosenOverwriteRef.current.set(taskId, copy.serverAt);
      const line = conflictAudit(keep);
      const audit = makeAudit(line.action, line.detail);
      // 先结束"既不推也不盖"这一档：这条任务重新进入正常同步；服务器那份的副本也一并撤下（挑过了就不该再并排显示）
      conflictRef.current.delete(taskId);
      setConflictTaskIds((prev) => prev.filter((id) => id !== taskId));
      // 副本先留着：下一次连通的合并会整体换掉这份映射；但界面上**不再拿它重新给一次选择**（R97b），只复述这句结果话
      setJustResolved({ id: taskId, keep });
      if (keep === "server") {
        // 整条换成服务器那一版（不走 mapTask：不许给刚采纳的东西盖上新时刻，否则又判成"本机动过"来回荡）
        dispatch({ type: "task.replace", task: adoptedTask(copy.task, audit) });
      } else {
        dispatch({ type: "audit.push", taskId, audit });
      }
      // 无论挑哪一份，选定那份都要成为两边共同的那一份：走正常防抖写穿，之后页头自己回到「已同步」
      queueSave();
    },
    [dispatch, queueSave],
  );

  const localOnlyTaskIds = useMemo(
    () => state.tasks.filter((t) => !isSyncable(t)).map((t) => t.id),
    [state.tasks],
  );

  const value = useMemo<SyncContextValue>(() => ({
    user,
    signedIn: user !== "checking" && user !== null,
    serverMode,
    backend,
    syncState,
    lastError,
    conflictTaskIds,
    conflictServerCopies,
    resolveConflict,
    justResolved,
    retry,
    reload,
    deleteTaskOnServer,
    localOnlyTaskIds,
  }), [user, serverMode, backend, syncState, lastError, conflictTaskIds, conflictServerCopies, resolveConflict, justResolved, retry, reload, deleteTaskOnServer, localOnlyTaskIds]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSync(): SyncContextValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useSync must be used within SyncProvider");
  return ctx;
}

/**
 * 资料原件的短期签名地址。
 * R78：不在这里各取各的——收进 `fileUrlCache` 一处（同一份资料的并发挂载共用一发请求，
 * 短时间内复用，失败不缓存）。以前每次挂载重新申请 ⇒ 展开一份 20 页 PDF 就是 20 发。
 */
export function useSignedFileUrl(docId: string | undefined, enabled: boolean) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!enabled || !docId) return;
    let cancelled = false;
    void fetchFileUrl(docId).then((r) => {
      if (!cancelled) setUrl(r.url);
    }).catch(() => {
      // 地址没换到 ≠ 资料没了：这一句只说"这一次没拿到"，不许被写成"原件不存在"（R72 那条纪律）
      if (!cancelled) setFailed(true);
    });
    return () => { cancelled = true; };
  }, [docId, enabled]);
  return { url, failed };
}

export { UUID_RE };
