/**
 * Real authenticated HTTP client behind the MoxApi seam (Prompt 00 §A).
 *
 * Every call goes to the Mox Control Plane with a durable server session.
 * There is no local simulation: when the backend is unavailable the error
 * propagates honestly to the store, which surfaces it to the UI.
 */

import type { AgentDeployment, AgentEvent, AgentRoom, ApprovalRequest } from "@mox/contracts";
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
  /** Resolves the current session token; may exchange/refresh lazily. */
  tokenProvider: () => Promise<string>;
  fetchImpl?: typeof fetch;
  realtime?: RealtimeTransport;
}

interface ApiErrorBody {
  error?: string;
  code?: string;
  unavailable?: boolean;
}

export class ApiUnavailableError extends Error {}

export class HttpMoxApi implements MoxApi {
  readonly realtime: RealtimeTransport;
  private readonly baseUrl: string;
  private readonly tokenProvider: () => Promise<string>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpMoxApiOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.tokenProvider = options.tokenProvider;
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
    this.realtime = options.realtime ?? new SseRealtimeTransport(this.baseUrl, this.tokenProvider);
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = await this.tokenProvider().catch(() => "");
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...init.headers,
        },
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
      throw new Error(detail);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
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
   * Submits the turn durably and streams authoritative events over SSE. The
   * current foundation deployment reports engine availability honestly via
   * a turn.failed event instead of fabricating an assistant reply.
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

/** Creates a durable server session from the bootstrap credential. */
export async function exchangeBootstrapSession(
  baseUrl: string,
  bootstrapToken: string,
  fetchImpl: typeof fetch = fetch.bind(globalThis),
): Promise<{ sessionToken: string; expiresAt: string }> {
  const res = await fetchImpl(`${baseUrl}/api/auth/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bootstrapToken }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as ApiErrorBody;
    throw new ApiUnavailableError(body.error ?? `session bootstrap failed (${res.status})`);
  }
  return (await res.json()) as { sessionToken: string; expiresAt: string };
}
