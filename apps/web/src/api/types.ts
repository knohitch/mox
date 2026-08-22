import type {
  AgentDeployment,
  AgentDefinition,
  AgentEvent,
  AgentRoom,
  ApprovalRequest,
} from "@mox/contracts";

/**
 * The web app's ONLY access to Mox backend capabilities (Prompt 05
 * acceptance: "UI consumes Mox contracts/APIs, not direct legacy internals").
 * Today a demo implementation backs this seam in-memory; the hosted product
 * swaps in the HTTP/SSE client against the Mox control plane without touching
 * views.
 */

export interface ChatMessage {
  messageId: string;
  threadId: string;
  /** "user" | agent id | "system" */
  authorId: string;
  role: "user" | "agent" | "system";
  text: string;
  at: string;
  streaming?: boolean;
  error?: string;
}

export interface AgentSummary {
  definition: AgentDefinition;
  deploymentState?: AgentDeployment["state"];
  runtimeStatus?: string;
  hasUnread?: boolean;
  modelBadge?: string;
}

export interface ServerSummary {
  serverId: string;
  displayName: string;
  kind: "mox-cloud" | "customer-vps";
  region: string;
  state: "provisioning" | "running" | "degraded" | "suspended";
  agentsRunning: number;
  cpuPct: number;
  memPct: number;
}

export interface ModelOption {
  modelId: string;
  providerId: string;
  displayName: string;
  byok: boolean;
  available: boolean;
}

export interface UsageRow {
  metric: string;
  quantity: number;
  unit: string;
}

export interface InvoiceRow {
  invoiceId: string;
  periodStart: string;
  periodEnd: string;
  amountCents: number;
  currency: string;
  state: "open" | "paid" | "void";
}

export interface CliEngineRow {
  engineId: string;
  displayName: string;
  supportTier: string;
  state: string;
  reason?: string;
}

export interface Entitlements {
  computer: boolean;
  terminal: boolean;
  voice: boolean;
  rooms: boolean;
  customModels: boolean;
}

export interface ComputerSnapshot {
  sessionId: string;
  state: "pending" | "active" | "paused" | "closed";
  humanControl: boolean;
  url: string;
  /** Reference frame label until a live screencast transport is wired. */
  frameLabel: string;
  capturedAt: string;
}

export interface SendRunHandle {
  runId: string;
  /** Resolves when the simulated/real run settles. */
  done: Promise<void>;
  cancel(): void;
}

export interface MoxApi {
  // Roster / definitions
  listAgents(): Promise<AgentSummary[]>;
  getAgent(agentId: string): Promise<AgentSummary | undefined>;
  updateModel(agentId: string, modelId: string): Promise<void>;

  // Threads & chat
  listThreads(agentId: string): Promise<Array<{ threadId: string; title?: string }>>;
  getMessages(threadId: string): Promise<ChatMessage[]>;
  send(
    agentId: string,
    threadId: string,
    text: string,
    onEvent: (event: AgentEvent) => void,
    opts?: { roomId?: string },
  ): Promise<SendRunHandle>;

  // Approvals
  openApprovals(): Promise<ApprovalRequest[]>;
  resolveApproval(approvalId: string, outcome: "approved" | "denied"): Promise<void>;

  // Events (canonical, authoritative)
  getEvents(subjectId: string): Promise<AgentEvent[]>;

  // Rooms
  listRooms(): Promise<AgentRoom[]>;
  createRoom(input: { title: string; memberAgentIds: string[] }): Promise<AgentRoom>;

  // Infrastructure surfaces
  listServers(): Promise<ServerSummary[]>;
  listDeployments(): Promise<AgentDeployment[]>;

  // Models page
  listModels(): Promise<ModelOption[]>;
  testProviderConnection(providerId: string): Promise<{ ok: boolean; reason?: string }>;
  listCliEngines(): Promise<CliEngineRow[]>;

  // Integrations/Apps + Channels
  listIntegrations(): Promise<Array<{ integrationId: string; displayName: string; connected: boolean }>>;
  toggleIntegration(integrationId: string, connected: boolean): Promise<void>;
  listChannels(): Promise<Array<{ channelId: string; displayName: string; kind: string; connected: boolean }>>;

  // Usage/billing/settings
  getUsage(): Promise<UsageRow[]>;
  listInvoices(): Promise<InvoiceRow[]>;
  getEntitlements(): Promise<Entitlements>;

  // Computer (through the Mox Computer Gateway contractually)
  computerSnapshot(agentId: string): Promise<ComputerSnapshot | undefined>;
  computerTakeover(agentId: string, take: boolean, takenBy: string): Promise<ComputerSnapshot>;
  computerRestart(agentId: string): Promise<ComputerSnapshot>;

  // Files + logs (workspace-scoped)
  listFiles(agentId: string): Promise<Array<{ path: string; sizeBytes: number; updatedAt: string }>>;
  filePreview(agentId: string, path: string): Promise<string>;
  getLogs(agentId: string): Promise<Array<{ at: string; level: "info" | "warn" | "error"; line: string }>>;
}
