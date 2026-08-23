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
import type { AuthSessionResponse, LoginRequest, MeResponse, SignupRequest } from "@mox/control-plane-contracts";
import { SseRealtimeTransport, type RealtimeTransport } from "./realtime.js";
import type {
  AgentSummary,
  ChatMessage,
  CliEngineRow,
  ComputerSnapshot,
  Entitlements,
  InvoiceRow,
  ModelOption,
  MoxApi,
  SendRunHandle,
  ServerSummary,
  UsageRow,
} from "./types.js";

export interface HttpMoxApiOptions {
  baseUrl: string;
  /**
   * Optional bearer-token source for non-browser clients. Browsers omit it
   * and authenticate via the HttpOnly session cookie.
   */
  tokenProvider?: () => Promise<string>;
  fetchImpl?: typeof fetch;
  realtime?: RealtimeTransport;
}

interface ApiErrorBody {
  error?: string;
  code?: string;
  unavailable?: boolean;
}

export class ApiUnavailableError extends Error {}

/** Header required on cookie-authenticated mutations (CSRF defense). */
export const CSRF_HEADER = "x-mox-csrf";

export class HttpMoxApi implements MoxApi {
  readonly realtime: RealtimeTransport;
  private readonly baseUrl: string;
  private readonly tokenProvider?: () => Promise<string>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpMoxApiOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.tokenProvider = options.tokenProvider;
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
    const crossOrigin = !/^https?:\/\/[^/]*localhost(:\d+)?/i.test(this.baseUrl);
    this.realtime =
      options.realtime ?? new SseRealtimeTransport(this.baseUrl, crossOrigin);
  }

  get isBrowserCookieAuth(): boolean {
    return this.tokenProvider === undefined;
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

  // ---- Account auth ------------------------------------------------------------

  me(): Promise<MeResponse> {
    return this.call<MeResponse>("/api/me");
  }

  login(input: LoginRequest): Promise<AuthSessionResponse> {
    return this.call<AuthSessionResponse>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: input.email, password: input.password }),
    });
  }

  signup(input: SignupRequest): Promise<AuthSessionResponse> {
    return this.call<AuthSessionResponse>("/api/auth/signup", {
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

  selectOrg(orgId: string): Promise<AuthSessionResponse> {
    return this.call<AuthSessionResponse>("/api/auth/orgs/select", {
      method: "POST",
      body: JSON.stringify({ orgId }),
    });
  }

  // ---- Roster / definitions ---------------------------------------------------

  async listAgents(): Promise<AgentSummary[]> {
    const rows = await this.call<Array<{ agentId: string; definition: AgentSummary["definition"] }>>("/api/agents");
    return rows.map((row) => ({ definition: row.definition }));
  }

  async getAgent(agentId: string): Promise<AgentSummary | undefined> {
    try {
      const row = await this.call<{ definition: AgentSummary["definition"] }>(
        `/api/agents/${encodeURIComponent(agentId)}`,
      );
      return { definition: row.definition };
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

  // ---- Threads & chat ------------------------------------------------------------

  async listThreads(agentId: string): Promise<Array<{ threadId: string; title?: string }>> {
    return this.call(`/api/agents/${encodeURIComponent(agentId)}/threads`);
  }

  async getMessages(threadId: string): Promise<ChatMessage[]> {
    return this.call(`/api/threads/${encodeURIComponent(threadId)}/messages`);
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
        await this.call(`/api/threads/${encodeURIComponent(threadId)}/messages`, {
          method: "POST",
          body: JSON.stringify({ text }),
        });
        if (cancelled) {
          finish();
          return;
        }
        onEvent({
          type: "turn.failed",
          error:
            "The Mox control plane accepted your message but no turn-execution engine is configured on this deployment.",
          threadId,
        } as unknown as AgentEvent);
      } catch (error) {
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
    return [];
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
    const response = await this.call<{ planVersionId: string; values: Record<string, boolean | number | string> }>(
      "/api/billing/entitlements",
    );
    const flag = (key: keyof Entitlements): boolean =>
      response.values[key] === true || response.values[key] === "true";
    return {
      computer: flag("computer"),
      terminal: flag("terminal"),
      voice: flag("voice"),
      rooms: flag("rooms"),
      customModels: flag("customModels"),
    };
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

  async getLogs(_agentId: string): Promise<Array<{ at: string; level: "info" | "warn" | "error"; line: string }>> {
    throw new ApiUnavailableError("log streaming is not configured on this deployment");
  }
}
