import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { AgentEvent, ApprovalRequest } from "@mox/contracts";
import { DemoMoxApi } from "./demo-api.js";
import type {
  AgentSummary,
  ChatMessage,
  ComputerSnapshot,
  Entitlements,
  MoxApi,
} from "./types.js";

/**
 * App-wide state over the MoxApi seam. Views never touch the API directly —
 * they consume hooks, keeping the future HTTP/SSE swap invisible to UI code.
 */

interface MoxStore {
  api: MoxApi;
  ready: boolean;
  agents: AgentSummary[];
  entitlements: Entitlements | undefined;
  approvals: ApprovalRequest[];
  messages(threadId: string): ChatMessage[];
  loadThread(agentId: string, threadId: string): Promise<void>;
  send(agentId: string, threadId: string, text: string): Promise<void>;
  cancel(runId: string): void;
  activeRun(threadId: string): string | null;
  resolveApproval(approvalId: string, outcome: "approved" | "denied"): Promise<void>;
  eventsVersion: number;
  invalidateEvents(): void;
}

const Ctx = createContext<MoxStore | null>(null);

interface RunState {
  handle: { runId: string; cancel(): void };
  threadId: string;
}

export function MoxProvider({ children }: { children: ReactNode }) {
  const api = useMemo<MoxApi>(() => new DemoMoxApi(), []);
  const [ready, setReady] = useState(false);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [entitlements, setEntitlements] = useState<Entitlements>();
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [messagesByThread, setMessagesByThread] = useState<Map<string, ChatMessage[]>>(new Map());
  const [eventsVersion, setEventsVersion] = useState(0);
  const runsRef = useRef(new Map<string, RunState>()); // threadId → run
  const [, force] = useState(0);
  const rerender = useCallback(() => force((n) => n + 1), []);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [list, ents, open] = await Promise.all([
        api.listAgents(),
        api.getEntitlements(),
        api.openApprovals(),
      ]);
      if (!alive) return;
      setAgents(list);
      setEntitlements(ents);
      setApprovals(open);
      setReady(true);
    })();
    return () => {
      alive = false;
    };
  }, [api]);

  const refreshApprovals = useCallback(async () => {
    setApprovals(await api.openApprovals());
  }, [api]);

  const loadThread = useCallback(
    async (_agentId: string, threadId: string) => {
      if (messagesByThread.has(threadId)) return;
      const msgs = await api.getMessages(threadId);
      setMessagesByThread((prev) => {
        const next = new Map(prev);
        next.set(threadId, msgs);
        return next;
      });
    },
    [api, messagesByThread],
  );

  const send = useCallback(
    async (agentId: string, threadId: string, text: string) => {
      // Optimistic user bubble + streaming placeholder.
      setMessagesByThread((prev) => {
        const next = new Map(prev);
        const list = [...(prev.get(threadId) ?? [])];
        list.push({ messageId: `u_${Date.now()}`, threadId, authorId: "u_you", role: "user", text, at: new Date().toISOString() });
        list.push({
          messageId: `a_${Date.now()}`,
          threadId,
          authorId: agentId,
          role: "agent",
          text: "",
          at: new Date().toISOString(),
          streaming: true,
        });
        next.set(threadId, list);
        return next;
      });

      const onEvent = (e: AgentEvent) => {
        if (e.type === "message.delta") {
          setMessagesByThread((prev) => {
            const next = new Map(prev);
            const list = [...(prev.get(threadId) ?? [])];
            for (let i = list.length - 1; i >= 0; i -= 1) {
              const m = list[i] as ChatMessage;
              if (m.role === "agent" && m.streaming) {
                list[i] = { ...m, text: m.text + e.delta };
                break;
              }
            }
            next.set(threadId, list);
            return next;
          });
        } else if (e.type === "message.completed") {
          setMessagesByThread((prev) => {
            const next = new Map(prev);
            const list = [...(prev.get(threadId) ?? [])];
            for (let i = list.length - 1; i >= 0; i -= 1) {
              const m = list[i] as ChatMessage;
              if (m.role === "agent" && m.streaming) {
                list[i] = { ...m, text: e.text, streaming: false };
                break;
              }
            }
            next.set(threadId, list);
            return next;
          });
        } else if (e.type === "turn.failed") {
          setMessagesByThread((prev) => {
            const next = new Map(prev);
            const list = [...(prev.get(threadId) ?? [])];
            for (let i = list.length - 1; i >= 0; i -= 1) {
              const m = list[i] as ChatMessage;
              if (m.role === "agent" && m.streaming) {
                list[i] = { ...m, streaming: false, error: e.error };
                break;
              }
            }
            next.set(threadId, list);
            return next;
          });
        } else if (e.type === "approval.opened") {
          void refreshApprovals();
        }
        setEventsVersion((v) => v + 1);
      };

      const handle = await api.send(agentId, threadId, text, onEvent);
      runsRef.current.set(threadId, { handle, threadId });
      rerender();
      await handle.done;
      runsRef.current.delete(threadId);
      rerender();
      await refreshApprovals();
      await reloadAgents();
    },
    [api, refreshApprovals],
  );

  const reloadAgents = useCallback(async () => {
    setAgents(await api.listAgents());
  }, [api]);

  const cancel = useCallback((runId: string) => {
    for (const run of runsRef.current.values()) {
      if (run.handle.runId === runId) run.handle.cancel();
    }
  }, []);

  const resolveApproval = useCallback(
    async (approvalId: string, outcome: "approved" | "denied") => {
      await api.resolveApproval(approvalId, outcome);
      await refreshApprovals();
      setEventsVersion((v) => v + 1);
    },
    [api, refreshApprovals],
  );

  const activeRun = useCallback((threadId: string) => runsRef.current.get(threadId)?.handle.runId ?? null, []);

  const value: MoxStore = {
    api,
    ready,
    agents,
    entitlements,
    approvals,
    messages: (threadId) => messagesByThread.get(threadId) ?? [],
    loadThread,
    send,
    cancel,
    activeRun,
    resolveApproval,
    eventsVersion,
    invalidateEvents: () => setEventsVersion((v) => v + 1),
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useMox(): MoxStore {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useMox outside <MoxProvider>");
  return ctx;
}

/** Entitlement gate HOOK (acceptance: gates are hooks, not hardcoded plans). */
export function useEntitlement(cap: keyof Entitlements): boolean {
  const { entitlements } = useMox();
  return entitlements?.[cap] === true;
}
