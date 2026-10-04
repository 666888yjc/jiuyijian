import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type ReactNode,
} from "react";
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

const StoreCtx = createContext<{ state: AppState; dispatch: (a: Action) => void } | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  useEffect(() => {
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
  }, [state]);
  const value = useMemo(() => ({ state, dispatch }), [state]);
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
