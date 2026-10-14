import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { LEASE_KEY, canWrite, leaseStringOf, mustStepDown, parseLease, type Lease } from "./writerLease";
import type { AuditEvent, VisitTask } from "./types";
import type { Action, AppState } from "./state";
import { reducer } from "./state";
import { buildSeedTask } from "./seed";
import { capAuditText } from "./fieldLimits";
import { now, uid } from "./sheet";

const STORAGE_KEY = "jiuyijian-m1-state-v1";

function initialState(): AppState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<AppState>;
      // 老版本状态无 tombstones / events 键 → 降级为空数组
      return { tasks: saved.tasks ?? [], tombstones: saved.tombstones ?? [], events: saved.events ?? [] };
    }
  } catch {
    /* 损坏则重置 */
  }
  return { tasks: [buildSeedTask()], tombstones: [], events: [] };
}

const StoreCtx = createContext<{
  state: AppState;
  dispatch: (a: Action) => void;
  /** 显示层的"只读"＝**另有一个活着的持有者**（提示与控件只读都跟着这个走）；对面关页后这句就不该再挂在屏幕上 */
  readOnly: boolean;
  /** 通路层的"写者"＝这一页被允许写本机存储、允许推服务器。按下抢到租约之前一直false，即使屏幕上已经不显示只读提示 */
  writer: boolean;
  /** 这一页被租约拦下过几次（>0 就在提示后补那半句）——只给界面用，不进数据、不进审计 */
  blockedEdits: number;
} | null>(null);

/**
 * 这一页的身份。放 sessionStorage：**刷新不换身份**（否则每次刷新都要等一次陈旧才能改，
 * 等于把"刷新看看"变成一次锁死）；关掉标签页即作废，另一页靠 `pagehide` 的释放事件立刻接管。
 */
function selfTabId(): string {
  const k = "jiuyijian-writer-tab-v1";
  try {
    const had = sessionStorage.getItem(k);
    if (had) return had;
    const fresh = uid("w-");
    sessionStorage.setItem(k, fresh);
    return fresh;
  } catch {
    return uid("w-"); // 拿不到 sessionStorage：这一页刷新后要等一次陈旧，不影响别人
  }
}

const SELF_TAB = selfTabId();

function readLease(): Lease | null {
  try {
    return parseLease(localStorage.getItem(LEASE_KEY));
  } catch {
    return null; // 读不到租约＝"没人持有"，行为退回装这条之前
  }
}

function claimLease(): void {
  try {
    localStorage.setItem(LEASE_KEY, leaseStringOf(SELF_TAB, Date.now()));
  } catch {
    /* 存储不可用：这一页只能待在内存态，拦不拦都一样 */
  }
}

function releaseLease(): void {
  try {
    if (parseLease(localStorage.getItem(LEASE_KEY))?.tab === SELF_TAB) localStorage.removeItem(LEASE_KEY);
  } catch {
    /* 同上 */
  }
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, rawDispatch] = useReducer(reducer, undefined, initialState);
  // 第一次渲染就定身份，早于任何一次写存储：两个页面同时开时，先 claim 的那个写，另一个从一开始就只读
  const [amWriter, setAmWriter] = useState<boolean>(() => {
    const writer = canWrite(readLease(), SELF_TAB, Date.now());
    if (writer) claimLease();
    return writer;
  });
  const [blockedEdits, setBlockedEdits] = useState(0);
  // 屏幕上那句只读提示的依据：**别人手上有一条还没陈旧的租约**。
  // 不能拿 `!amWriter` 当这句——对面关页之后这一页仍然不是写者（要等它自己按下才接管），
  // 但那时"正在另一个页面里核对"已经是假话了（本轮真浏览器量到的那一形：刷新写者那一页会把写者悄悄换到对面去）。
  const [heldByOther, setHeldByOther] = useState(() => mustStepDown(readLease(), SELF_TAB, Date.now()));
  const amWriterRef = useRef(amWriter);
  amWriterRef.current = amWriter;

  // 全程事件驱动，没有任何"定时续命"（那条会把谁能写交给浏览器的节流脾气，见 `src/writerLease.ts` 头注）：
  // 别人 claim 了一条新鲜的租约 ⇒ 这一台下台；台下之后**不在事件里抢回来**——抢回来发生在用户按下那一刻。
  // 为什么必须在事件里不自动 claim（本轮两个真标签页量到的）：写者那一页按一次 F5 也会走 `pagehide` 释放，
  // 对面那页若在事件里立刻抢，刷新完就成了"用户正在看的这一页变只读、一个藏在后面的标签页成了写者"，
  // 而提示还让人"回到那一个页面"去改——那一页用户根本没在看。
  useEffect(() => {
    const onLease = (e: StorageEvent) => {
      if (e.key !== LEASE_KEY) return;
      const lease = parseLease(e.newValue);
      if (mustStepDown(lease, SELF_TAB, Date.now())) {
        setAmWriter(false);
        setHeldByOther(true);
      } else if (!amWriterRef.current) {
        // 没人持有／那条已经陈旧 ⇒ 把提示收起来（对面确实不在了），但**不动 amWriter**：下一次按下时才接管
        setHeldByOther(false);
      }
    };
    const onHide = () => {
      if (amWriterRef.current) releaseLease();
    };
    window.addEventListener("storage", onLease);
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("storage", onLease);
      window.removeEventListener("pagehide", onHide);
      if (amWriterRef.current) releaseLease();
    };
  }, []);

  const dispatch = useCallback((a: Action) => {
    if (amWriterRef.current) {
      rawDispatch(a);
      return;
    }
    // 只读页按下时才判一次接管——那一刻页面必然在前台，谈不上后台节流。抢得到就**把这一次照常放行**，
    // 不许让用户多点一次；只有仍然抢不到才拦下，并记一笔让界面说清"刚才那一次没生效"（R72／R105／R106 那一族）。
    if (canWrite(readLease(), SELF_TAB, Date.now())) {
      claimLease();
      setAmWriter(true);
      setBlockedEdits(0);
      // 同一条接管纪律：先把共享存储那一份接回内存，**再**把用户这一次按下放上去（顺序反了就等于拿旧快照盖掉上一位没推出去的改动）
      rawDispatch({ type: "load", state: initialState() });
      rawDispatch(a);
      return;
    }
    setBlockedEdits((n) => n + 1);
  }, []);

  useEffect(() => {
    // 只读的上下文一个字都不写存储：否则"我这一份比较旧"会由我的挂载回写悄悄盖到对面去
    if (!amWriter) return;
    try {
      // 图片 dataURL 可能过大，超限则剥离后再存
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch {
        const slim: AppState = {
          tasks: state.tasks.map((t) => ({
            ...t,
            documents: t.documents.map((d) => ({
              ...d,
              pages: d.pages.map((p) => (p.imageDataUrl ? { ...p, imageDataUrl: undefined } : p)),
            })),
          })),
          tombstones: state.tombstones,
          events: state.events,
        };
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(slim));
        } catch {
          /* 仍失败则仅内存态 */
        }
      }
    } catch {
      /* localStorage 不可用 */
    }
  }, [state, amWriter]);
  const value = useMemo(
    () => ({ state, dispatch, readOnly: !amWriter && heldByOther, writer: amWriter, blockedEdits }),
    [state, dispatch, amWriter, heldByOther, blockedEdits],
  );
  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>;
}

export function useStore() {
  const ctx = useContext(StoreCtx);
  if (!ctx) throw new Error("useStore must be used within StoreProvider");
  return ctx;
}

export function useTask(taskId: string | undefined): VisitTask | undefined {
  const { state } = useStore();
  return state.tasks.find((t) => t.id === taskId);
}

export function makeAudit(action: string, detail: string): AuditEvent {
  // 审计这两栏是我们自己生成的句子，服务端按字节拒收（action 60 / detail 500 字节）；
  // 留着超长句子＝整条任务锁死在存不上，而家属没法去编辑一行审计——所以这里截，且只截我们自己写的话（R75）。
  return { id: uid("a-"), at: now(), action: capAuditText("auditAction", action), detail: capAuditText("auditDetail", detail) };
}
