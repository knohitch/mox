/**
 * Real authenticated HTTP client behind the MoxApi seam (Prompt 00 §A /
 * 00B §B/§D).
 *
 * Browser authentication rides the HttpOnly session cookie set by
 * /api/auth/login|signup; the session token never enters JS storage or any
 * URL. Mutating requests carry the `x-mox-csrf` custom header (the
 * control-plane's cookie-channel CSRF defense). A programmatic bearer
 * token may still be injected for non-browser clients (CLI/tooling).
 *
 * There is no local simulation: when the backend is unavailable the error
 * propagates honestly to the store, which surfaces it to the UI.
 */

import type { AgentDeployment, AgentEvent, AgentRoom, ApprovalRequest } from "@mox/contracts";
import type {
  ApiTokenMetadata,
  BrowserAuthResponse,
  CreateApiTokenResponse,
  ForgotPasswordResponse,
  LoginRequest,
  MeResponse,
  ProgrammaticLoginResponse,
  ResetPasswordRequest,
  SignupRequest,
  StaffLoginResponse,
  StaffSessionResponse,
  StaffSignupRequest,
} from "@mox/control-plane-contracts";
import type { NotificationItem } from "./notification-types.js";
import { SseRealtimeTransport, type RealtimeTransport } from "./realtime.js";
import type {
  AgentSummary,
  AdminCompute,
  AdminCustomer,
  AdminIntelligence,
  AdminNotificationJobs,
  AdminOperations,
  AdminOverview,
  AdminPaymentProvider,
  AdminPlans,
  AdminRuntimeAgent,
  AdminStaff,
  AgentDraftResult,
  AgentVersionRow,
  ChatMessage,
  CliEngineRow,
  ComputerSnapshot,
  CreatedStaffInvite,
  CreateAgentDraftInput,
  CreateStaffInviteInput,
  Entitlements,
  InvoiceRow,
  ModelOption,
  MoxApi,
  SendRunHandle,
  ServerSummary,
  SupportCustomer,
  SupportCustomerDetail,
  UsageRow,
} from "./types.js";

export interface HttpMoxApiOptions {
  baseUrl: string;
  /**
   * Optional bearer-token source for non-browser clients (personal API
   * access tokens, 00C §B). Browsers omit it and authenticate via the
   * HttpOnly session cookie exclusively (00C §A).
   */
  tokenProvider?: () => Promise<string>;
  fetchImpl?: typeof fetch;
  realtime?: RealtimeTransport;
  /** Injected in tests; defaults to the browser location when present. */
  currentOrigin?: string;
}

interface ApiErrorBody {
  error?: string;
  code?: string;
  unavailable?: boolean;
}

export class ApiUnavailableError extends Error {}

/** Header required on cookie-authenticated mutations (CSRF defense). */
export const CSRF_HEADER = "x-mox-csrf";

/**
 * Prompt 00C §C: cross-origin is determined by comparing REAL origins —
 * never by host-name heuristics like "is localhost".
 */
function detectCrossOrigin(baseUrl: string, injectedOrigin?: string): boolean {
  const target = new URL(baseUrl).origin;
  if (injectedOrigin !== undefined) return new URL(injectedOrigin).origin !== target;
  if (typeof location !== "undefined" && location.origin) return location.origin !== target;
  return false; // non-browser default: same-host tooling
}

export class HttpMoxApi implements MoxApi {
  readonly realtime: RealtimeTransport;
  private readonly baseUrl: string;
  private readonly tokenProvider?: () => Promise<string>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpMoxApiOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.tokenProvider = options.tokenProvider;
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
    this.realtime =
      options.realtime ?? new SseRealtimeTransport(this.baseUrl, detectCrossOrigin(this.baseUrl, options.currentOrigin));
  }

  get isBrowserCookieAuth(): boolean {
    return this.tokenProvider === undefined;
  }

  /** True when the API lives on a different origin than the web app. */
  get crossOrigin(): boolean {
    return detectCrossOrigin(this.baseUrl, typeof location !== "undefined" ? location.origin : undefined);
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const mutating = ["POST", "PATCH", "PUT", "DELETE"].includes((init.method ?? "GET").toUpperCase());
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...(mutating ? { [CSRF_HEADER]: "1" } : {}),
    };
    if (this.tokenProvider) {
      // Non-browser channel only; browsers rely on the HttpOnly cookie.
      try {
        headers["authorization"] = `Bearer ${await this.tokenProvider()}`;
      } catch {
        throw new ApiUnavailableError("not signed in");
      }
    }
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        credentials: "include",
        headers: { ...headers, ...init.headers },
      });
    } catch (cause) {
      throw new ApiUnavailableError(
        `cannot reach the Mox control plane at ${this.baseUrl}: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as ApiErrorBody;
      const detail = body.error ?? `HTTP ${res.status}`;
      if (res.status >= 500 || body.unavailable || body.code === "engine_not_configured") {
        throw new ApiUnavailableError(`Mox control plane request failed (${res.status}): ${detail}`);
      }
      const error = new Error(detail) as Error & { status?: number };
      error.status = res.status;
      throw error;
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  // ---- Account auth (browser contract: cookie-only, Prompt 00C §A) ---------------

  me(): Promise<MeResponse> {
    return this.call<MeResponse>("/api/me");
  }

  login(input: LoginRequest): Promise<BrowserAuthResponse> {
    return this.call<BrowserAuthResponse>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: input.email, password: input.password }),
    });
  }

  signup(input: SignupRequest): Promise<BrowserAuthResponse> {
    return this.call<BrowserAuthResponse>("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({
        email: input.email,
        password: input.password,
        displayName: input.displayName,
        orgName: input.orgName,
      }),
    });
  }

  logout(): Promise<void> {
    return this.call<{ ok: boolean }>("/api/auth/logout", { method: "POST", body: "{}" }).then(() => undefined);
  }

  selectOrg(orgId: string): Promise<BrowserAuthResponse> {
    return this.call<BrowserAuthResponse>("/api/auth/orgs/select", {
      method: "POST",
      body: JSON.stringify({ orgId }),
    });
  }

  // ---- Staff surface auth (Prompt 01: admin/support isolation) ------------

  /** Admin surface login: password → server-verified admin cookie. */
  adminLogin(input: LoginRequest): Promise<StaffLoginResponse> {
    return this.call<StaffLoginResponse>("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ email: input.email, password: input.password, returnTo: input.returnTo }),
    });
  }

  /** Support surface login: password → server-verified support cookie. */
  supportLogin(input: LoginRequest): Promise<StaffLoginResponse> {
    return this.call<StaffLoginResponse>("/api/support/login", {
      method: "POST",
      body: JSON.stringify({ email: input.email, password: input.password, returnTo: input.returnTo }),
    });
  }

  /** Admin surface session probe (identity + capabilities; no credential). */
  adminSession(): Promise<StaffSessionResponse> {
    return this.call<StaffSessionResponse>("/api/admin/session");
  }

  /** Support surface session probe (identity + capabilities; no credential). */
  supportSession(): Promise<StaffSessionResponse> {
    return this.call<StaffSessionResponse>("/api/support/session");
  }

  /** Invite-first staff signup on the Admin surface. */
  adminSignup(input: StaffSignupRequest): Promise<StaffLoginResponse> {
    return this.call<StaffLoginResponse>("/api/admin/signup", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  /** Invite-first staff signup on the Support surface. */
  supportSignup(input: StaffSignupRequest): Promise<StaffLoginResponse> {
    return this.call<StaffLoginResponse>("/api/support/signup", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  // ---- Password recovery (Prompt 01: anti-enumeration, token delivery) ------

  forgotPassword(email: string): Promise<ForgotPasswordResponse> {
    return this.call<ForgotPasswordResponse>("/api/auth/forgot-password", {
      method: "POST",
      body: JSON.stringify({ email }),
    });
  }

  resetPassword(input: ResetPasswordRequest): Promise<{ ok: boolean }> {
    return this.call<{ ok: boolean }>("/api/auth/reset-password", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  // ---- Notifications (Prompt 02) ----------------------------------------------------

  listNotifications(
    filters: { unread?: boolean; category?: string; limit?: number; offset?: number } = {},
  ): Promise<NotificationItem[]> {
    const params = new URLSearchParams();
    if (filters.unread) params.set("unread", "1");
    if (filters.category) params.set("category", filters.category);
    if (filters.limit !== undefined) params.set("limit", String(filters.limit));
    if (filters.offset !== undefined) params.set("offset", String(filters.offset));
    const qs = params.toString();
    return this.call<NotificationItem[]>(`/api/notifications${qs ? `?${qs}` : ""}`);
  }

  unreadCount(): Promise<{ count: number }> {
    return this.call<{ count: number }>("/api/notifications/unread-count");
  }

  markNotificationRead(id: string): Promise<void> {
    return this.call<{ ok: boolean }>(`/api/notifications/${encodeURIComponent(id)}/read`, {
      method: "POST",
      body: "{}",
    }).then(() => undefined);
  }

  markNotificationUnread(id: string): Promise<void> {
    return this.call<{ ok: boolean }>(`/api/notifications/${encodeURIComponent(id)}/unread`, {
      method: "POST",
      body: "{}",
    }).then(() => undefined);
  }

  archiveNotification(id: string): Promise<void> {
    return this.call<{ ok: boolean }>(`/api/notifications/${encodeURIComponent(id)}/archive`, {
      method: "POST",
      body: "{}",
    }).then(() => undefined);
  }

  markAllNotificationsRead(): Promise<{ changed: number }> {
    return this.call<{ changed: number }>("/api/notifications/read-all", { method: "POST", body: "{}" });
  }

  // ---- Personal access tokens (programmatic contract, 00C §B / 00D §B) ------------
  // Management is SESSION-only server-side; browsers call these with the
  // cookie. The plaintext token appears exactly once at creation.

  createApiToken(input: { name: string; scopes?: string[] }): Promise<CreateApiTokenResponse> {
    return this.call<CreateApiTokenResponse>("/api/auth/tokens", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  listApiTokens(): Promise<ApiTokenMetadata[]> {
    return this.call<ApiTokenMetadata[]>("/api/auth/tokens");
  }

  revokeApiToken(tokenId: string): Promise<void> {
    return this.call<{ ok: boolean }>(`/api/auth/tokens/${encodeURIComponent(tokenId)}`, {
      method: "DELETE",
    }).then(() => undefined);
  }

  /** Programmatic login: the ONLY password→bearer exchange (00C §B). */
  tokenLogin(input: { email: string; password: string; name?: string; scopes?: string[] }): Promise<ProgrammaticLoginResponse> {
    return this.call<ProgrammaticLoginResponse>("/api/auth/token-login", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  // ---- Roster / definitions ---------------------------------------------------

  async listAgents(): Promise<AgentSummary[]> {
    const rows = await this.call<Array<{ agentId: string; slug: string; status: string; definition: AgentSummary["definition"] }>>("/api/agents");
    return rows.map((row) => ({
      // The server row id is the ONLY id the mutating routes accept (threads,
      // drafts, deployments, servers). The definition's own agentId is the
      // engine-facing identifier and must not be used to address rows.
      agentId: row.agentId,
      status: row.status,
      definition: row.definition,
    }));
  }

  async getAgent(agentId: string): Promise<AgentSummary | undefined> {
    try {
      const row = await this.call<{ agentId: string; status: string; definition: AgentSummary["definition"] }>(
        `/api/agents/${encodeURIComponent(agentId)}`,
      );
      return { agentId: row.agentId, status: row.status, definition: row.definition };
    } catch (error) {
      if (error instanceof ApiUnavailableError) throw error;
      return undefined; // honest 404 → unknown agent
    }
  }

  async updateModel(agentId: string, modelId: string): Promise<void> {
    await this.call(`/api/agents/${encodeURIComponent(agentId)}/model`, {
      method: "PATCH",
      body: JSON.stringify({ providerId: modelId.split("/")[0] ?? modelId, modelId }),
    });
  }

  // ---- Authoring & versioning (Phase 02 §B / §C) -----------------------------

  async createAgentDraft(input: CreateAgentDraftInput): Promise<AgentDraftResult> {
    return this.call("/api/agents/drafts", { method: "POST", body: JSON.stringify(input) });
  }

  async updateAgentDraft(agentId: string, input: CreateAgentDraftInput): Promise<AgentDraftResult> {
    return this.call(`/api/agents/${encodeURIComponent(agentId)}/draft`, { method: "PATCH", body: JSON.stringify(input) });
  }

  async publishAgent(agentId: string, changelog?: string): Promise<{ agentId: string; revision: number; status: string }> {
    return this.call(`/api/agents/${encodeURIComponent(agentId)}/publish`, {
      method: "POST",
      body: JSON.stringify({ changelog }),
    });
  }

  async listAgentVersions(agentId: string): Promise<AgentVersionRow[]> {
    return this.call(`/api/agents/${encodeURIComponent(agentId)}/versions`);
  }

  async diffAgentVersions(agentId: string, from: number, to: number): Promise<{ from: number; to: number; changes: string[] }> {
    return this.call(`/api/agents/${encodeURIComponent(agentId)}/versions/diff?from=${from}&to=${to}`);
  }

  async rollbackAgent(agentId: string, toRevision: number): Promise<{ agentId: string; revision: number }> {
    return this.call(`/api/agents/${encodeURIComponent(agentId)}/rollback`, {
      method: "POST",
      body: JSON.stringify({ toRevision }),
    });
  }

  // ---- Threads & chat ------------------------------------------------------------

  async listThreads(agentId: string): Promise<Array<{ threadId: string; title?: string }>> {
    return this.call(`/api/agents/${encodeURIComponent(agentId)}/threads`);
  }

  async createThread(input: { agentId: string; title?: string }): Promise<{ threadId: string; title?: string }> {
    return this.call("/api/threads", {
      method: "POST",
      body: JSON.stringify({ agentId: input.agentId, title: input.title }),
    });
  }

  async getMessages(threadId: string): Promise<ChatMessage[]> {
    return this.call(`/api/threads/${encodeURIComponent(threadId)}/messages`);
  }

  async archiveThread(threadId: string): Promise<{ threadId: string; status: string }> {
    return this.call(`/api/threads/${encodeURIComponent(threadId)}/archive`, { method: "POST" });
  }

  /**
   * Submits the turn durably. The current foundation deployment reports
   * engine availability honestly via a turn.failed event instead of
   * fabricating an assistant reply.
   */
  async send(
    agentId: string,
    threadId: string,
    text: string,
    onEvent: (event: AgentEvent) => void,
    _opts?: { roomId?: string },
  ): Promise<SendRunHandle> {
    void agentId;
    void _opts;
    let cancelled = false;
    let finish = () => {};
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });

    void (async () => {
      try {
        // Success means the turn was durably accepted (and launched server-side
        // when a runtime is composed). Turn progress arrives via the events
        // stream, so we do NOT invent a turn.failed here.
        await this.call(`/api/threads/${encodeURIComponent(threadId)}/messages`, {
          method: "POST",
          body: JSON.stringify({ text }),
        });
        if (cancelled) {
          finish();
          return;
        }
      } catch (error) {
        if (cancelled) {
          finish();
          return;
        }
        onEvent({
          type: "turn.failed",
          error: error instanceof Error ? error.message : String(error),
          threadId,
        } as unknown as AgentEvent);
      } finally {
        finish();
      }
    })();

    return {
      runId: `run_${Date.now()}`,
      done,
      cancel: () => {
        cancelled = true;
        finish();
      },
    };
  }

  // ---- Approvals ----------------------------------------------------------------

  async openApprovals(): Promise<ApprovalRequest[]> {
    return this.call("/api/approvals/open");
  }

  async resolveApproval(approvalId: string, outcome: "approved" | "denied"): Promise<void> {
    await this.call(`/api/approvals/${encodeURIComponent(approvalId)}/resolve`, {
      method: "POST",
      body: JSON.stringify({ outcome }),
    });
  }

  // ---- Events --------------------------------------------------------------------

  async getEvents(subjectId: string): Promise<AgentEvent[]> {
    const frames = await this.call<Array<{ seq: number; event: AgentEvent }>>(
      `/api/events?sinceSeq=0&subject=${encodeURIComponent(subjectId)}`,
    );
    return frames.map((frame) => frame.event);
  }

  // ---- Rooms ----------------------------------------------------------------------

  async listRooms(): Promise<AgentRoom[]> {
    return this.call("/api/rooms");
  }

  async createRoom(input: { title: string; memberAgentIds: string[] }): Promise<AgentRoom> {
    return this.call("/api/rooms", { method: "POST", body: JSON.stringify(input) });
  }

  // ---- Infrastructure surfaces ------------------------------------------------------

  async listServers(): Promise<ServerSummary[]> {
    return this.call("/api/servers");
  }

  async listDeployments(): Promise<AgentDeployment[]> {
    return this.call("/api/deployments");
  }

  async serverAction(
    orderId: string,
    action: "restart" | "redeploy" | "resize" | "cancel" | "stop" | "start",
    computeClassCode?: string,
  ): Promise<{ ok: boolean }> {
    return this.call(`/api/servers/${encodeURIComponent(orderId)}/${action}`, {
      method: "POST",
      body: JSON.stringify({ computeClassCode }),
    });
  }

  async deployAgent(input: { agentId: string; revision: number; target?: { kind?: string; vpsId?: string } }): Promise<{ ok: boolean; state: string }> {
    return this.call("/api/deployments", { method: "POST", body: JSON.stringify(input) });
  }

  async redeployDeployment(deploymentId: string): Promise<{ ok: boolean; state: string }> {
    return this.call(`/api/deployments/${encodeURIComponent(deploymentId)}/redeploy`, { method: "POST" });
  }

  async deploymentRollback(deploymentId: string, toRevision: number): Promise<{ ok: boolean; state: string }> {
    return this.call(`/api/deployments/${encodeURIComponent(deploymentId)}/rollback`, { method: "POST", body: JSON.stringify({ toRevision }) });
  }

  // ---- Models page -----------------------------------------------------------------

  async listModels(): Promise<ModelOption[]> {
    return this.call("/api/models");
  }

  async testProviderConnection(providerId: string): Promise<{ ok: boolean; reason?: string }> {
    try {
      await this.call(`/api/model-connections/${encodeURIComponent(providerId)}/test`, { method: "POST" });
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async listCliEngines(): Promise<CliEngineRow[]> {
    return this.call("/api/cli-engines");
  }

  // ---- Integrations/Apps + Channels --------------------------------------------------

  async listIntegrations(): Promise<Array<{ integrationId: string; displayName: string; connected: boolean }>> {
    return this.call("/api/integrations");
  }

  async toggleIntegration(integrationId: string, connected: boolean): Promise<void> {
    await this.call(`/api/integrations/${encodeURIComponent(integrationId)}`, {
      method: "PATCH",
      body: JSON.stringify({ connected }),
    });
  }

  async listChannels(): Promise<Array<{ channelId: string; displayName: string; kind: string; connected: boolean }>> {
    return this.call("/api/channels");
  }

  // ---- Usage/billing/settings ----------------------------------------------------------

  async getUsage(): Promise<UsageRow[]> {
    return this.call("/api/usage");
  }

  async listInvoices(): Promise<InvoiceRow[]> {
    return this.call("/api/billing/invoices");
  }

  async getEntitlements(): Promise<Entitlements> {
    // Security Repair 05A §J: the endpoint reports commercial-access truth
    // (commerciallyEntitled + denial reason); effective VALUE exists only while
    // currently entitled. The UI keeps the canonical key/value map — no legacy
    // boolean buckets.
    const response = await this.call<{
      planVersionId?: string;
      commerciallyEntitled: boolean;
      values: Record<string, boolean | number | string>;
    }>("/api/billing/entitlements");
    return {
      commerciallyEntitled: response.commerciallyEntitled === true,
      values: response.values ?? {},
    };
  }

  // ---- Protected Mox Admin ----------------------------------------------------------

  adminOverview(): Promise<AdminOverview> {
    return this.call("/api/admin/overview");
  }

  adminCustomers(): Promise<AdminCustomer[]> {
    return this.call("/api/admin/customers");
  }

  adminCustomerAction(orgId: string, action: "suspend" | "reactivate", reason?: string): Promise<void> {
    return this.call<{ ok: boolean }>(`/api/admin/customers/${encodeURIComponent(orgId)}/${action}`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }).then(() => undefined);
  }

  adminAddSupportNote(orgId: string, note: string): Promise<void> {
    return this.call<{ ok: boolean }>(`/api/admin/customers/${encodeURIComponent(orgId)}/support-notes`, {
      method: "POST",
      body: JSON.stringify({ note }),
    }).then(() => undefined);
  }

  adminPlans(): Promise<AdminPlans> {
    return this.call("/api/admin/plans");
  }

  adminUpsertCurrency(input: { code: string; displayName: string; exponent: number }): Promise<void> {
    return this.call<{ ok: boolean }>(`/api/admin/plans/currencies/${encodeURIComponent(input.code)}`, {
      method: "PUT",
      body: JSON.stringify({ displayName: input.displayName, exponent: input.exponent }),
    }).then(() => undefined);
  }

  adminUpsertPriceBook(input: Record<string, unknown>): Promise<void> {
    return this.call<{ ok: boolean }>("/api/admin/plans/price-books", {
      method: "PUT",
      body: JSON.stringify(input),
    }).then(() => undefined);
  }

  adminPaymentProviders(): Promise<AdminPaymentProvider[]> {
    return this.call("/api/admin/billing-providers");
  }

  adminSavePaymentProvider(providerName: string, input: Record<string, unknown>): Promise<void> {
    return this.call<{ ok: boolean }>(`/api/admin/billing-providers/${encodeURIComponent(providerName)}`, {
      method: "PUT",
      body: JSON.stringify(input),
    }).then(() => undefined);
  }

  adminCompute(): Promise<AdminCompute> {
    return this.call("/api/admin/compute");
  }

  adminSaveComputeAccount(providerName: string, accountLabel: string, input: Record<string, unknown>): Promise<void> {
    return this.call<{ ok: boolean }>(
      `/api/admin/compute/accounts/${encodeURIComponent(providerName)}/${encodeURIComponent(accountLabel)}`,
      { method: "PUT", body: JSON.stringify(input) },
    ).then(() => undefined);
  }

  adminSaveComputeClass(code: string, input: Record<string, unknown>): Promise<void> {
    return this.call<{ ok: boolean }>(`/api/admin/compute/classes/${encodeURIComponent(code)}`, {
      method: "PUT",
      body: JSON.stringify(input),
    }).then(() => undefined);
  }

  adminComputeOrderAction(orderId: string, action: "restart" | "redeploy" | "resize" | "cancel"): Promise<void> {
    return this.call<{ ok: boolean }>(`/api/admin/compute/orders/${encodeURIComponent(orderId)}/${action}`, {
      method: "POST",
      body: "{}",
    }).then(() => undefined);
  }

  adminIntelligence(): Promise<AdminIntelligence> {
    return this.call("/api/admin/intelligence");
  }

  adminSaveIntelligenceProvider(slug: string, input: Record<string, unknown>): Promise<void> {
    return this.call<{ ok: boolean }>(`/api/admin/intelligence/providers/${encodeURIComponent(slug)}`, {
      method: "PUT",
      body: JSON.stringify(input),
    }).then(() => undefined);
  }

  adminRuntime(): Promise<AdminRuntimeAgent[]> {
    return this.call("/api/admin/runtime");
  }

  adminRuntimeAction(agentId: string, action: "restart" | "redeploy"): Promise<void> {
    return this.call<{ ok: boolean }>(`/api/admin/runtime/agents/${encodeURIComponent(agentId)}/${action}`, {
      method: "POST",
      body: "{}",
    }).then(() => undefined);
  }

  adminOperations(): Promise<AdminOperations> {
    return this.call("/api/admin/operations");
  }

  adminNotificationJobs(): Promise<AdminNotificationJobs> {
    return this.call("/api/admin/notifications/jobs");
  }

  adminPreviewNotification(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.call("/api/admin/notifications/preview", { method: "POST", body: JSON.stringify(input) });
  }

  adminSendNotification(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.call("/api/admin/notifications/send", { method: "POST", body: JSON.stringify(input) });
  }

  adminScheduleNotification(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.call("/api/admin/notifications/schedule", { method: "POST", body: JSON.stringify(input) });
  }

  adminCancelNotificationJob(jobId: string): Promise<void> {
    return this.call<{ ok: boolean }>(`/api/admin/notifications/jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: "POST",
      body: "{}",
    }).then(() => undefined);
  }

  // ---- Prompt 03: Staff & Access + Support console ------------------------------

  adminStaff(): Promise<AdminStaff> {
    return this.call("/api/admin/staff");
  }

  adminCreateStaffInvite(input: CreateStaffInviteInput): Promise<CreatedStaffInvite> {
    return this.call<CreatedStaffInvite>("/api/admin/staff/invites", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  adminRevokeStaffInvite(invitationId: string): Promise<void> {
    return this.call<{ ok: boolean }>(`/api/admin/staff/invites/${encodeURIComponent(invitationId)}`, {
      method: "DELETE",
    }).then(() => undefined);
  }

  adminStaffAction(userId: string, role: string, action: "disable" | "enable" | "revoke", reason?: string): Promise<void> {
    return this.call<{ ok: boolean }>(`/api/admin/staff/${encodeURIComponent(userId)}/${action}`, {
      method: "POST",
      body: JSON.stringify({ role, reason }),
    }).then(() => undefined);
  }

  supportCustomers(query?: string): Promise<SupportCustomer[]> {
    const qs = query?.trim() ? `?q=${encodeURIComponent(query.trim())}` : "";
    return this.call<{ customers: SupportCustomer[] }>(`/api/support/customers${qs}`).then((r) => r.customers);
  }

  supportCustomer(orgId: string): Promise<SupportCustomerDetail> {
    return this.call(`/api/support/customers/${encodeURIComponent(orgId)}`);
  }

  supportAddNote(orgId: string, note: string): Promise<void> {
    return this.call<{ ok: boolean }>(`/api/support/customers/${encodeURIComponent(orgId)}/notes`, {
      method: "POST",
      body: JSON.stringify({ note }),
    }).then(() => undefined);
  }

  // ---- Computer + files/logs -----------------------------------------------------------

  async computerSnapshot(_agentId: string): Promise<ComputerSnapshot | undefined> {
    throw new ApiUnavailableError("computer gateway is not configured on this deployment");
  }

  async computerTakeover(agentId: string, take: boolean, takenBy: string): Promise<ComputerSnapshot> {
    void agentId;
    void take;
    void takenBy;
    throw new ApiUnavailableError("computer gateway is not configured on this deployment");
  }

  async computerRestart(agentId: string): Promise<ComputerSnapshot> {
    void agentId;
    throw new ApiUnavailableError("computer gateway is not configured on this deployment");
  }

  async listFiles(_agentId: string): Promise<Array<{ path: string; sizeBytes: number; updatedAt: string }>> {
    throw new ApiUnavailableError("workspace file access is not configured on this deployment");
  }

  async filePreview(_agentId: string, _path: string): Promise<string> {
    throw new ApiUnavailableError("workspace file access is not configured on this deployment");
  }

  async runTerminalCommand(agentId: string, command: string): Promise<{ output: string }> {
    return this.call(`/api/agents/${encodeURIComponent(agentId)}/terminal`, {
      method: "POST",
      body: JSON.stringify({ command }),
    });
  }

  async getLogs(_agentId: string): Promise<Array<{ at: string; level: "info" | "warn" | "error"; line: string }>> {
    throw new ApiUnavailableError("log streaming is not configured on this deployment");
  }
}
