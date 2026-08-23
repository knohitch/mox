import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { AgentEvent, ApprovalRequest } from "@mox/contracts";
import {
  ApiUnavailableError,
  HttpMoxApi,
  exchangeBootstrapSession,
} from "./http-api.js";
import type { RealtimeSubscription } from "./realtime.js";
import { resolveWebConfig, WebConfigError } from "../config.js";
import type {
  AgentSummary,
  ChatMessage,
  Entitlements,
  MoxApi,
} from "./types.js";

/**
 * App-wide state over the MoxApi seam. Views never touch the API directly —
 * they consume hooks. Prompt 00 §A: production composes the authenticated
 * HTTP client against the control plane; the demo implementation is an
 * explicit dev-only escape hatch with no production fallback path.
 */

interface MoxStore {
  api: MoxApi;
  ready: boolean;
  /** Honest failure surface: configuration or backend unavailability. */
  error: string | null;
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

const SESSION_STORAGE_KEY = "mox.session.v1";

interface CachedSession {
  sessionToken: string;
  expiresAt: string;
}

function loadCachedSession(): CachedSession | undefined {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as CachedSession;
    if (!parsed.sessionToken || Date.parse(parsed.expiresAt) <= Date.now()) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function storeCachedSession(session: CachedSession): void {
  try {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Private-mode storage failures degrade to per-load sessions.
  }
}

/** Explicit composition of the API seam (Prompt 00 §A). */
function createMoxApi(): { api: MoxApi; error: string | null } {
  try {
    const config = resolveWebConfig(import.meta.env);
    if (config.mode === "demo") {
      // Dev-only explicit escape hatch; unreachable from production builds
      // because resolveWebConfig throws on VITE_DEMO_MODE in PROD.
      void config;
      throw new WebConfigError(
        "demo mode requires wiring DemoMoxApi explicitly in a development build; it is never a production path",
      );
    }
    const bootstrapToken = config.bootstrapToken;
    const tokenProvider = async (): Promise<string> => {
      const cached = loadCachedSession();
      if (cached) return cached.sessionToken;
      if (!bootstrapToken) return "";
      const session = await exchangeBootstrapSession(config.apiBaseUrl, bootstrapToken);
      storeCachedSession(session);
      return session.sessionToken;
    };
    return { api: new HttpMoxApi({ baseUrl: config.apiBaseUrl, tokenProvider }), error: null };
  } catch (error) {
    return {
      api: failingApi(error instanceof Error ? error.message : String(error)),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** An API whose every call fails honestly — used only for config errors. */
function failingApi(message: string): MoxApi {
  const fail = () => Promise.reject(new Error(message));
  return {
    listAgents: fail,
    getAgent: fail,
    updateModel: fail,
    listThreads: fail,
    getMessages: fail,
    send: () => Promise.reject(new Error(message)),
    openApprovals: fail,
    resolveApproval: fail,
    getEvents: fail,
    listRooms: fail,
    createRoom: fail,
    listServers: fail,
    listDeployments: fail,
    listModels: fail,
    testProviderConnection: () => Promise.resolve({ ok: false, reason: message }),
    listCliEngines: () => Promise.resolve([]),
    listIntegrations: fail,
    toggleIntegration: fail,
    listChannels: fail,
    getUsage: fail,
    listInvoices: fail,
    getEntitlements: fail,
    computerSnapshot: fail,
    computerTakeover: fail,
    computerRestart: fail,
    listFiles: fail,
    filePreview: fail,
    getLogs: fail,
  };
}

interface RunState {
  handle: { runId: string; cancel(): void };
  threadId: string;
}

export function MoxProvider({ children }: { children: ReactNode }) {
  const composed = useMemo(() => createMoxApi(), []);
  const api = composed.api;
  const [ready, setReady] = useState(false);
  const [backendError, setBackendError] = useState<string | null>(composed.error);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [entitlements, setEntitlements] = useState<Entitlements>();
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [messagesByThread, setMessagesByThread] = useState<Map<string, ChatMessage[]>>(new Map());
  const [eventsVersion, setEventsVersion] = useState(0);
  const runsRef = useRef(new Map<string, RunState>()); // threadId → run
  const [, force] = useState(0);
  const rerender = useCallback(() => force((n) => n + 1), []);

  const refreshApprovals = useCallback(async () => {
    setApprovals(await api.openApprovals());
  }, [api]);

  useEffect(() => {
    if (composed.error) return;
    let alive = true;
    (async () => {
      try {
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
        setBackendError(null);
      } catch (error) {
        if (!alive) return;
        // Honest error surface — the app never pretends demo data is real.
        setBackendError(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      alive = false;
    };
  }, [api, composed.error]);

  useEffect(() => {
    if (composed.error || backendError?.includes("control plane")) return;
    let subscription: RealtimeSubscription | undefined;
    if ("realtime" in api) {
      subscription = (api as { realtime?: { subscribe: RealtimeTransportLike } }).realtime?.subscribe(
        "org-events",
        0,
        () => setEventsVersion((v) => v + 1),
        () => setBackendError("realtime stream disconnected"),
      );
    }
    return () => subscription?.close();
  }, [api, composed.error, backendError]);

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

      let handle;
      try {
        handle = await api.send(agentId, threadId, text, onEvent);
      } catch (error) {
        if (error instanceof ApiUnavailableError) setBackendError(error.message);
        const message = error instanceof Error ? error.message : String(error);
        setMessagesByThread((prev) => {
          const next = new Map(prev);
          const list = [...(prev.get(threadId) ?? [])];
          for (let i = list.length - 1; i >= 0; i -= 1) {
            const m = list[i] as ChatMessage;
            if (m.role === "agent" && m.streaming) {
              list[i] = { ...m, streaming: false, error: message };
              break;
            }
          }
          next.set(threadId, list);
          return next;
        });
        return;
      }
      runsRef.current.set(threadId, { handle, threadId });
      rerender();
      await handle.done;
      runsRef.current.delete(threadId);
      rerender();
      await refreshApprovals().catch(() => undefined);
      await reloadAgents().catch(() => undefined);
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
    error: backendError,
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

type RealtimeTransportLike = (
  channel: "org-events",
  sinceSeq: number,
  onEvent: (frame: { seq: number; event: unknown }) => void,
  onError: (error: Error) => void,
) => RealtimeSubscription;

export function useMox(): MoxStore {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useMox outside <MoxProvider>");
  return ctx;
}

/** Entitlement gate HOOK backed by durable server values (§D4). */
export function useEntitlement(cap: keyof Entitlements): boolean {
  const { entitlements } = useMox();
  return entitlements?.[cap] === true;
}
