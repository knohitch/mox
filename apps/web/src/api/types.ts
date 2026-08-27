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
 * The hosted product uses the HTTP/SSE client against the Mox control plane;
 * there is no browser-side business logic fallback.
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

export interface AdminOverview {
  metrics: {
    customers: number;
    activeSubscriptions: number;
    paymentFailures: number;
    activeServers: number;
    serverProvisioningFailures: number;
    runtimeAgentHealth: { total: number; degraded: number };
    providerIncidents: number;
    notifications: number;
    abuse: number;
    costMargin: { currency: string; revenueMinor: string; costMinor: string };
  };
  incidents: Array<Record<string, unknown>>;
  notifications: Array<Record<string, unknown>>;
  abuse: Array<Record<string, unknown>>;
}

export interface AdminCustomer {
  orgId: string;
  slug: string;
  displayName: string;
  workspaceName?: string | null;
  createdAt: string;
  users: Array<Record<string, unknown>>;
  memberships: Array<Record<string, unknown>>;
  subscriptions: Array<Record<string, unknown>>;
  servers: Array<Record<string, unknown>>;
  agents: Array<Record<string, unknown>>;
  supportNotes: Array<{ id: string; actorId?: string | null; note: string; at: string }>;
}

export interface AdminPlans {
  products: Array<Record<string, unknown>>;
  planVersions: Array<Record<string, unknown>>;
  entitlementDefinitions: Array<Record<string, unknown>>;
  entitlementValues: Array<Record<string, unknown>>;
  currencies: Array<Record<string, unknown>>;
  pricingRegions: Array<Record<string, unknown>>;
  priceBooks: Array<Record<string, unknown>>;
  priceVersions: Array<Record<string, unknown>>;
  addons: Array<Record<string, unknown>>;
}

export interface AdminPaymentProvider {
  providerName: string;
  environment: "test" | "live" | string;
  enabled: boolean;
  displayName: string;
  publicConfig: Record<string, unknown>;
  supportedCurrencies: string[];
  supportedRegions: string[];
  priority: number;
  maintenanceMode: boolean;
  hasSecretRef: boolean;
  hasWebhookSecretRef: boolean;
  webhookStatus: string;
  reconciliationStatus: string;
  health: string;
  updatedAt?: string | null;
}

export interface AdminCompute {
  providers: string[];
  accounts: Array<Record<string, unknown>>;
  classes: Array<Record<string, unknown>>;
  orders: Array<Record<string, unknown>>;
  operations: Array<Record<string, unknown>>;
  nodes: Array<Record<string, unknown>>;
}

export interface AdminIntelligence {
  providers: Array<{
    slug: string;
    displayName: string;
    kind: string;
    configured: boolean;
    credentialFingerprint?: string;
    baseUrlConfigured: boolean;
    settings: Record<string, unknown> | unknown[];
    models: Array<Record<string, unknown>>;
  }>;
}

export interface AdminRuntimeAgent {
  agentId: string;
  orgId: string;
  slug: string;
  displayName: string;
  status: string;
  deploymentState: string;
  runtimeVersion?: string;
  serverPlacement?: string;
  failures: string[];
  lastHeartbeatAt?: string;
}

export interface AdminOperations {
  jobs: Array<Record<string, unknown>>;
  queues: Array<Record<string, unknown>>;
  incidents: Array<Record<string, unknown>>;
  backups: Array<Record<string, unknown>>;
  abuse: Array<Record<string, unknown>>;
  audit: Array<Record<string, unknown>>;
  featureFlags: Array<Record<string, unknown>>;
  costLedger: Array<Record<string, unknown>>;
}

export interface AdminNotificationJobs {
  jobs: Array<Record<string, unknown>>;
  stats: { scheduled: number; completed: number; failed: number };
}

// ---- Prompt 03: Staff & Access + Support console ---------------------------

export interface StaffMember {
  userId: string;
  email: string;
  displayName: string;
  role: string;
  surface: "admin" | "support";
  enabled: boolean;
  grantedByUserId: string | null;
  createdAt: string;
  revokedAt: string | null;
}

export interface AdminStaffInvite {
  invitationId: string;
  surface: "admin" | "support" | "both";
  role: string;
  email: string;
  createdAt: string;
  expiresAt: string;
  consumedAt?: string | null;
  revokedAt?: string | null;
}

export interface AdminStaff {
  members: StaffMember[];
  invites: AdminStaffInvite[];
}

export interface CreateStaffInviteInput {
  email: string;
  role: string;
  surface: "admin" | "support" | "both";
}

export interface CreatedStaffInvite {
  invitationId: string;
  role: string;
  email: string;
  surface: "admin" | "support" | "both";
  token: string;
  expiresAt: string;
}

export interface SupportCustomer {
  orgId: string;
  slug: string;
  displayName: string;
  workspaceName: string | null;
  createdAt: string;
  memberCount: number;
  users: Array<Record<string, unknown>>;
  subscriptions: Array<Record<string, unknown>>;
  servers: Array<Record<string, unknown>>;
  agents: Array<Record<string, unknown>>;
  supportNoteCount: number;
}

export interface SupportCustomerDetail {
  orgId: string;
  slug: string;
  displayName: string;
  workspaceName: string | null;
  createdAt: string;
  users: Array<Record<string, unknown>>;
  subscriptions: Array<Record<string, unknown>>;
  servers: Array<Record<string, unknown>>;
  agents: Array<Record<string, unknown>>;
  supportNotes: Array<{ id: string; actorId: string | null; note: string; at: string }>;
  recentActivity: Array<Record<string, unknown>>;
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

  // Protected Mox Admin
  adminOverview(): Promise<AdminOverview>;
  adminCustomers(): Promise<AdminCustomer[]>;
  adminCustomerAction(orgId: string, action: "suspend" | "reactivate", reason?: string): Promise<void>;
  adminAddSupportNote(orgId: string, note: string): Promise<void>;
  adminPlans(): Promise<AdminPlans>;
  adminUpsertCurrency(input: { code: string; displayName: string; exponent: number }): Promise<void>;
  adminUpsertPriceBook(input: Record<string, unknown>): Promise<void>;
  adminPaymentProviders(): Promise<AdminPaymentProvider[]>;
  adminSavePaymentProvider(providerName: string, input: Record<string, unknown>): Promise<void>;
  adminCompute(): Promise<AdminCompute>;
  adminSaveComputeAccount(providerName: string, accountLabel: string, input: Record<string, unknown>): Promise<void>;
  adminSaveComputeClass(code: string, input: Record<string, unknown>): Promise<void>;
  adminComputeOrderAction(orderId: string, action: "restart" | "redeploy" | "resize" | "cancel"): Promise<void>;
  adminIntelligence(): Promise<AdminIntelligence>;
  adminSaveIntelligenceProvider(slug: string, input: Record<string, unknown>): Promise<void>;
  adminRuntime(): Promise<AdminRuntimeAgent[]>;
  adminRuntimeAction(agentId: string, action: "restart" | "redeploy"): Promise<void>;
  adminOperations(): Promise<AdminOperations>;
  adminNotificationJobs(): Promise<AdminNotificationJobs>;
  adminPreviewNotification(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  adminSendNotification(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  adminScheduleNotification(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  adminCancelNotificationJob(jobId: string): Promise<void>;

  // Prompt 03: Staff & Access (admin.staff.write — superadmin only)
  adminStaff(): Promise<AdminStaff>;
  adminCreateStaffInvite(input: CreateStaffInviteInput): Promise<CreatedStaffInvite>;
  adminRevokeStaffInvite(invitationId: string): Promise<void>;
  adminStaffAction(userId: string, role: string, action: "disable" | "enable" | "revoke", reason?: string): Promise<void>;

  // Prompt 03: Support console (support.customer.lookup / support.ticket.write)
  supportCustomers(query?: string): Promise<SupportCustomer[]>;
  supportCustomer(orgId: string): Promise<SupportCustomerDetail>;
  supportAddNote(orgId: string, note: string): Promise<void>;

  // Computer (through the Mox Computer Gateway contractually)
  computerSnapshot(agentId: string): Promise<ComputerSnapshot | undefined>;
  computerTakeover(agentId: string, take: boolean, takenBy: string): Promise<ComputerSnapshot>;
  computerRestart(agentId: string): Promise<ComputerSnapshot>;

  // Files + logs (workspace-scoped)
  listFiles(agentId: string): Promise<Array<{ path: string; sizeBytes: number; updatedAt: string }>>;
  filePreview(agentId: string, path: string): Promise<string>;
  runTerminalCommand(agentId: string, command: string): Promise<{ output: string }>;
  getLogs(agentId: string): Promise<Array<{ at: string; level: "info" | "warn" | "error"; line: string }>>;
}
