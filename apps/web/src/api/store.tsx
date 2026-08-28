import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { AgentEvent, ApprovalRequest } from "@mox/contracts";
import type {
  ForgotPasswordResponse,
  MeResponse,
  ResetPasswordRequest,
  StaffSessionResponse,
} from "@mox/control-plane-contracts";
import { ApiUnavailableError, HttpMoxApi } from "./http-api.js";
import type { RealtimeSubscription } from "./realtime.js";
import { resolveWebConfig } from "../config.js";
import type {
  AgentSummary,
  ChatMessage,
  Entitlements,
  MoxApi,
} from "./types.js";
import { hasAgentRooms, hasBackups, hasBrowser, hasChannels, hasDeveloperMode, hasIntegrations, hasMoxAiCredits, hasModelConnections, hasStorage, hasTeamMembers, hasTerminal, hasVoice } from "./entitlement.js";
import type { CanonicalEntitlementKey } from "./entitlement.js";

/**
 * App-wide state over the MoxApi seam. Views never touch the API directly —
 * they consume hooks. Prompt 00 §A + 00B §B: production composes the
 * authenticated HTTP client against the control plane using HttpOnly cookie
 * sessions (no bootstrap secrets, no browser-persisted credentials); the demo
 * implementation is an explicit dev-only escape hatch with no production
 * fallback path.
 */

interface MoxStore {
  api: MoxApi;
  ready: boolean;
  /** Honest failure surface: configuration or backend unavailability. */
  error: string | null;
  /** True when the server rejected the session (login required). */
  needsAuth: boolean;
  /** Authenticated identity + org memberships (authoritative, from /api/me). */
  me: MeResponse | null;
  switchOrg(orgId: string): Promise<void>;
  signIn(input: { email: string; password: string }): Promise<void>;
  signUp(input: { email: string; password: string; orgName?: string }): Promise<void>;
  signOut(): Promise<void>;
  /** Staff surface (Prompt 01): admin/support session + auth. */
  staffSession: StaffSessionResponse | null;
  staffSurface: "admin" | "support" | null;
  staffReady: boolean;
  staffError: string | null;
  verifyStaffSession(surface: "admin" | "support"): Promise<StaffSessionResponse | null>;
  adminLogin(input: { email: string; password: string; returnTo?: string }): Promise<string | undefined>;
  supportLogin(input: { email: string; password: string; returnTo?: string }): Promise<string | undefined>;
  adminSignup(input: { email: string; password: string; inviteToken: string }): Promise<void>;
  supportSignup(input: { email: string; password: string; inviteToken: string }): Promise<void>;
  staffSignOut(): Promise<void>;
  forgotPassword(email: string): Promise<ForgotPasswordResponse>;
  resetPassword(input: ResetPasswordRequest): Promise<void>;
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

/** Explicit composition of the API seam (Prompt 00 §A). */
function createMoxApi(): { api: MoxApi; error: string | null; httpApi?: HttpMoxApi } {
  try {
    const config = resolveWebConfig(import.meta.env);
    if (config.mode === "demo") {
      throw new Error(
        "demo mode requires explicit dev-only wiring in a development build; it is never a production path",
      );
    }
    const httpApi = new HttpMoxApi({ baseUrl: config.apiBaseUrl });
    return { api: httpApi, error: null, httpApi };
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
    createThread: fail,
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
    listCliEngines: fail,
    listIntegrations: fail,
    toggleIntegration: fail,
    listChannels: fail,
    getUsage: fail,
    listInvoices: fail,
    getEntitlements: fail,
    adminOverview: fail,
    adminCustomers: fail,
    adminCustomerAction: fail,
    adminAddSupportNote: fail,
    adminPlans: fail,
    adminUpsertCurrency: fail,
    adminUpsertPriceBook: fail,
    adminPaymentProviders: fail,
    adminSavePaymentProvider: fail,
    adminCompute: fail,
    adminSaveComputeAccount: fail,
    adminSaveComputeClass: fail,
    adminComputeOrderAction: fail,
    adminIntelligence: fail,
    adminSaveIntelligenceProvider: fail,
    adminRuntime: fail,
    adminRuntimeAction: fail,
    adminOperations: fail,
    adminNotificationJobs: fail,
    adminPreviewNotification: fail,
    adminSendNotification: fail,
    adminScheduleNotification: fail,
    adminCancelNotificationJob: fail,
    adminStaff: fail,
    adminCreateStaffInvite: fail,
    adminRevokeStaffInvite: fail,
    adminStaffAction: fail,
    supportCustomers: fail,
    supportCustomer: fail,
    supportAddNote: fail,
    computerSnapshot: fail,
    computerTakeover: fail,
    computerRestart: fail,
    listFiles: fail,
    filePreview: fail,
    runTerminalCommand: fail,
    getLogs: fail,
  };
}

function isUnauthorized(error: unknown): boolean {
  return (error as { status?: number })?.status === 401;
}

interface RunState {
  handle: { runId: string; cancel(): void };
  threadId: string;
}

export function MoxProvider({ children }: { children: ReactNode }) {
  const composed = useMemo(() => createMoxApi(), []);
  const api = composed.api;
  const httpApi = composed.httpApi;
  const [ready, setReady] = useState(false);
  const [needsAuth, setNeedsAuth] = useState(false);
  const [backendError, setBackendError] = useState<string | null>(composed.error);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [staffSession, setStaffSession] = useState<StaffSessionResponse | null>(null);
  const [staffSurface, setStaffSurface] = useState<"admin" | "support" | null>(null);
  const [staffReady, setStaffReady] = useState(false);
  const [staffError, setStaffError] = useState<string | null>(null);
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
        const [identity, list, ents, open] = await Promise.all([
          httpApi?.me() ?? Promise.resolve(null),
          api.listAgents(),
          api.getEntitlements(),
          api.openApprovals(),
        ]);
        if (!alive) return;
        setMe(identity);
        setAgents(list);
        setEntitlements(ents);
        setApprovals(open);
        setReady(true);
        setNeedsAuth(false);
        setBackendError(null);
      } catch (error) {
        if (!alive) return;
        // Honest error surface — the app never pretends demo data is real.
        setNeedsAuth(isUnauthorized(error));
        setBackendError(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      alive = false;
    };
  }, [api, composed.error]);

  useEffect(() => {
    if (composed.error || !ready || !httpApi) return;
    let subscription: RealtimeSubscription | undefined;
    subscription = httpApi.realtime.subscribe(
      "org-events",
      0,
      () => setEventsVersion((v) => v + 1),
      () => undefined, // transient stream errors surface on next fetch
    );
    return () => subscription?.close();
  }, [httpApi, ready, composed.error]);

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

  const authenticateAndLoad = useCallback(async (action: () => Promise<unknown>) => {
    if (!httpApi) return;
    await action();
    const [identity, list, ents, open] = await Promise.all([
      httpApi.me(),
      httpApi.listAgents(),
      httpApi.getEntitlements(),
      httpApi.openApprovals(),
    ]);
    setMe(identity);
    setAgents(list);
    setEntitlements(ents);
    setApprovals(open);
    setReady(true);
    setNeedsAuth(false);
    setBackendError(null);
  }, [httpApi]);

  const signIn = useCallback(
    async (input: { email: string; password: string }) => {
      await authenticateAndLoad(() => httpApi!.login(input));
    },
    [authenticateAndLoad, httpApi],
  );

  const signUp = useCallback(
    async (input: { email: string; password: string; orgName?: string }) => {
      await authenticateAndLoad(() => httpApi!.signup(input));
    },
    [authenticateAndLoad, httpApi],
  );

  const signOut = useCallback(async () => {
    if (!httpApi) return;
    await httpApi.logout().catch(() => undefined);
    setReady(false);
    setNeedsAuth(true);
    setMe(null);
    setAgents([]);
    setApprovals([]);
    setMessagesByThread(new Map());
  }, [httpApi]);

  const switchOrg = useCallback(
    async (orgId: string) => {
      if (!httpApi) return;
      await authenticateAndLoad(() => httpApi.selectOrg(orgId));
    },
    [authenticateAndLoad, httpApi],
  );

  // ---- Staff surface (Prompt 01) -------------------------------------------

  const verifyStaffSession = useCallback(
    async (surface: "admin" | "support") => {
      if (!httpApi) return null;
      try {
        const session = surface === "admin" ? await httpApi.adminSession() : await httpApi.supportSession();
        setStaffSession(session);
        setStaffSurface(surface);
        setStaffReady(true);
        setStaffError(null);
        return session;
      } catch (error) {
        if (!isUnauthorized(error)) setStaffError(error instanceof Error ? error.message : String(error));
        setStaffSession(null);
        setStaffSurface(null);
        setStaffReady(false);
        return null;
      }
    },
    [httpApi],
  );

  const finalizeStaffLogin = useCallback((result: StaffSessionResponse) => {
    setStaffSession(result);
    setStaffReady(true);
    setStaffError(null);
  }, []);

  const adminLogin = useCallback(
    async (input: { email: string; password: string; returnTo?: string }) => {
      if (!httpApi) throw new ApiUnavailableError("control plane unavailable");
      const result = await httpApi.adminLogin(input);
      setStaffSurface("admin");
      finalizeStaffLogin(result);
      return result.returnTo;
    },
    [httpApi, finalizeStaffLogin],
  );

  const supportLogin = useCallback(
    async (input: { email: string; password: string; returnTo?: string }) => {
      if (!httpApi) throw new ApiUnavailableError("control plane unavailable");
      const result = await httpApi.supportLogin(input);
      setStaffSurface("support");
      finalizeStaffLogin(result);
      return result.returnTo;
    },
    [httpApi, finalizeStaffLogin],
  );

  const adminSignup = useCallback(
    async (input: { email: string; password: string; inviteToken: string }) => {
      if (!httpApi) throw new ApiUnavailableError("control plane unavailable");
      const result = await httpApi.adminSignup(input);
      setStaffSurface("admin");
      finalizeStaffLogin(result);
    },
    [httpApi, finalizeStaffLogin],
  );

  const supportSignup = useCallback(
    async (input: { email: string; password: string; inviteToken: string }) => {
      if (!httpApi) throw new ApiUnavailableError("control plane unavailable");
      const result = await httpApi.supportSignup(input);
      setStaffSurface("support");
      finalizeStaffLogin(result);
    },
    [httpApi, finalizeStaffLogin],
  );

  const staffSignOut = useCallback(async () => {
    if (httpApi) await httpApi.logout().catch(() => undefined);
    setStaffSession(null);
    setStaffSurface(null);
    setStaffReady(false);
    setStaffError(null);
  }, [httpApi]);

  const forgotPassword = useCallback(
    async (email: string) => {
      if (!httpApi) throw new ApiUnavailableError("control plane unavailable");
      return httpApi.forgotPassword(email);
    },
    [httpApi],
  );

  const resetPassword = useCallback(
    async (input: ResetPasswordRequest) => {
      if (!httpApi) throw new ApiUnavailableError("control plane unavailable");
      await httpApi.resetPassword(input);
    },
    [httpApi],
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
    needsAuth,
    me,
    switchOrg,
    signIn,
    signUp,
    signOut,
    staffSession,
    staffSurface,
    staffReady,
    staffError,
    verifyStaffSession,
    adminLogin,
    supportLogin,
    adminSignup,
    supportSignup,
    staffSignOut,
    forgotPassword,
    resetPassword,
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

/**
 * Entitlement hooks backed by durable server values (§D4 / Phase 01 §B).
 *
 * These are the ONLY sanctioned capability gate series for the customer
 * surface. Each hook maps a UX capability to its canonical entitlement key via
 * the selector helpers in `entitlement.ts` — call sites never inspect raw
 * `entitlements.values` directly.
 */

export function useEntitlements(): Entitlements | undefined {
  const { entitlements } = useMox();
  return entitlements;
}

export const useBrowser = () => hasBrowser(useEntitlements());
export const useTerminal = () => hasTerminal(useEntitlements());
export const useAgentRooms = () => hasAgentRooms(useEntitlements());
export const useModelConnections = () => hasModelConnections(useEntitlements());
export const useVoice = () => hasVoice(useEntitlements());
export const useIntegrations = () => hasIntegrations(useEntitlements());
export const useChannels = () => hasChannels(useEntitlements());
export const useDeveloperMode = () => hasDeveloperMode(useEntitlements());
export const useBackups = () => hasBackups(useEntitlements());
export const useTeamMembers = () => hasTeamMembers(useEntitlements());
export const useStorage = () => hasStorage(useEntitlements());
export const useMoxAiCredits = () => hasMoxAiCredits(useEntitlements());

/** Raw canonical value (0 / "" / false when unavailable). */
export function useCanonicalValue(
  key: CanonicalEntitlementKey,
): boolean | number | string | undefined {
  const { entitlements } = useMox();
  return entitlements?.values[key];
}
