import type {
  AgentDeployment,
  AgentDefinition,
  AgentEvent,
  AgentRoom,
  ApprovalRequest,
} from "@mox/contracts";
import type { Entitlements } from "./entitlement.js";

export type { Entitlements } from "./entitlement.js";

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

export interface RoomMessage {
  messageId: string;
  roomId: string;
  authorKind: "user" | "agent" | "system";
  authorId: string;
  authorName: string;
  text: string;
  at: string;
}

export interface AgentSummary {
  /**
   * Server-authoritative agent identity (the control-plane agent row id).
   * On the hosted path this is a real UUID returned by /api/agents — the
   * SAME id authoring/versioning/thread routes address agents by
   * (apps/web/src/api/http-api.ts). It must never be invented client-side.
   */
  agentId: string;
  definition: AgentDefinition;
  deploymentState?: AgentDeployment["state"];
  runtimeStatus?: string;
  status?: string;
  currentVersion?: number;
  hasUnread?: boolean;
  modelBadge?: string;
}

/** Simple-mode authoring inputs supported by the canonical builder (Phase 02 §B). */
export interface SimpleAgentInput {
  displayName: string;
  avatarUrl?: string;
  role?: string;
  instructions: string;
  /** Model selection as "providerSlug/modelSlug". */
  model: string;
  toolNames: string[];
  knowledgeIds?: string[];
  browserEnabled: boolean;
  channelIds?: string[];
  schedule?: { cron: string; timezone: string; prompt: string };
  target: { kind: "sandbox" } | { kind: "mox-cloud"; region?: string } | { kind: "customer-vps"; vpsId: string };
  voiceEnabled?: boolean;
  voiceId?: string;
  permissionsPreset: "safe" | "balanced" | "full";
}

export type CreateAgentDraftInput =
  | { mode: "simple"; slug: string; input: SimpleAgentInput }
  | { mode: "developer"; slug: string; raw: unknown };

export interface AgentDraftResult {
  agentId: string;
  slug: string;
  status: string;
  currentVersion: number;
  definition: AgentDefinition;
}

export interface AgentVersionRow {
  revision: number;
  changelog: string | null;
  createdBy: string;
  createdAt: string;
  definition: AgentDefinition;
}


export interface ServerSummary {
  serverId: string;
  orderId: string;
  displayName: string;
  kind: "mox-cloud" | "customer-vps";
  computeClass?: string;
  region: string;
  /** Actual lifecycle state from the compute orchestrator authority. */
  state:
    | "requested"
    | "provisioning"
    | "running"
    | "error"
    | "resizing"
    | "stopping"
    | "stopped"
    | "cancelling"
    | "canceled"
    | "retention"
    | "destroyed";
  /** Telemetry is explicitly unavailable (null) when no authority reports it. */
  agentsRunning: number | null;
  cpuPct: number | null;
  memPct: number | null;
  provider?: string | null;
  lastError?: string | null;
  createdAt: string;
  updatedAt: string;
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

// ---- Phase 03: billing self-service (§A) ------------------------------------

export interface BillingProviderOption {
  providerName: string;
  displayName: string;
  environment: string;
  enabled: boolean;
  supportedCurrencies: string[];
  available: boolean;
}

export interface PlanPricingRegion {
  pricingRegionCode: string;
  displayName: string;
  available: boolean;
  currency: string;
  amountMinor: number | null;
}

export interface PlanOption {
  planVersionId: string;
  tier: "plus" | "pro" | "max" | "enterprise";
  name: string;
  /** Effective entitlement values for the plan version (customer-safe). */
  features: Record<string, boolean | number | string | null>;
  pricingRegions: PlanPricingRegion[];
  available: boolean;
}

export interface SubscriptionView {
  id: string;
  planVersionId: string;
  state: string;
  providerName?: string;
  providerEnvironment?: string;
  currentPeriodStart?: string;
  currentPeriodEnd?: string;
  trialEndsAt?: string;
  graceEndsAt?: string;
  cancelAtPeriodEnd: boolean;
  suspensionReason?: string;
  reconciliationRequired: boolean;
  plan: { planVersionId: string; version: number; tier: string; name: string } | null;
  commercialAccess: { entitled: boolean; denialReason?: string };
  cancellation: {
    state: string;
    attempts: number;
    lastError?: string;
    nextAttemptAt?: string | null;
  } | null;
}

// ---- Phase 03: personal API tokens (§E) -------------------------------------

export interface ApiTokenRow {
  tokenId: string;
  name: string;
  scopes: string[];
  createdAt: string;
  expiresAt: string;
  revoked: boolean;
  lastUsedAt?: string;
}

export interface CreatedApiTokenView {
  token: string;
  tokenId: string;
  scopes: string[];
  expiresAt: string;
}

// ---- Phase 03: BYOK / model connections (§B/§G) -----------------------------

export interface ModelConnectionRow {
  providerId: string;
  displayName: string;
  kind: string;
  status: string;
  connected: boolean;
  credentialConfigured: boolean;
  authMethods: string[];
  baseUrlSupported: boolean;
  baseUrl: string | null;
  modelCount: number;
}

// ---- Phase 03: integrations + tool grants (§C) ------------------------------

export interface IntegrationConfigField {
  key: string;
  label: string;
  secret: boolean;
  optional: boolean;
}

export interface IntegrationCatalogRow {
  integrationId: string;
  displayName: string;
  kind: string;
  connectionId: string | null;
  status: string;
  credentialConfigured: boolean;
  connected: boolean;
  requiresRuntimeSession: boolean;
  dangerous: boolean;
  tools: string[];
  configFields: IntegrationConfigField[];
}

export interface ToolGrantRow {
  grantId: string;
  agentId: string;
  toolPattern: string;
  agentName?: string;
}

// ---- Phase 03: channels (§D) ------------------------------------------------

export interface ChannelCatalogRow {
  channelId: string;
  displayName: string;
  kind: string;
  setupInstructions: string;
  prerequisites: string | null;
  /** Expected secret field names for this channel (never values). */
  secretKeys: string[];
  connectionId: string | null;
  status: string;
  credentialConfigured: boolean;
  connected: boolean;
  boundAgentId: string | null;
  boundAgentName: string | null;
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

export interface AdminNotificationJobDetails {
  id: string;
  audienceType: string;
  audienceValue?: string;
  title: string;
  body: string;
  severity: string;
  category: string;
  status: string;
  scheduledAt?: string | null;
  fanoutDone: number;
  fanoutTotal: number;
  createdAt: string;
  lastError?: string | null;
}

export interface AdminEnterpriseContract {
  id: string;
  orgId: string;
  orgName?: string;
  contractRef: string;
  values: Record<string, unknown>;
  active: boolean;
  effectiveFrom: string;
  effectiveUntil?: string | null;
  createdAt: string;
  customPriceMinor?: string | number;
  currency?: string;
  metadata?: {
    includedNodes?: number;
    customComputeClassCodes?: string[];
    privateModelSlugs?: string[];
    dedicatedDatabase?: boolean;
    dedicatedRuntime?: boolean;
    customRetentionDays?: number;
    customDomains?: string[];
    auditExportEnabled?: boolean;
    ssoSamlReady?: boolean;
    ssoMetadataUrl?: string;
    privateNetworkingHooks?: string[];
    slaMonthlyUptimePct?: number;
    slaSupportResponseHours?: number;
    whiteLabel?: boolean;
  };
}

export interface AdminFeatureFlag {
  key: string;
  orgId: string;
  enabled: string;
  rollout?: Record<string, unknown>;
  updatedAt?: string;
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
  users: Array<{ userId: string; email: string; displayName: string; role: string; disabledAt: string | null }>;
  subscriptions: SupportSubscriptionLifecycle[];
  servers: SupportServerDiagnostic[];
  agents: SupportAgentDiagnostic[];
  supportNoteCount: number;
  diagnostics: SupportDiagnosticSummary;
}

export interface SupportCustomerDetail {
  orgId: string;
  slug: string;
  displayName: string;
  workspaceName: string | null;
  createdAt: string;
  users: Array<Record<string, unknown>>;
  subscriptions: SupportSubscriptionLifecycle[];
  servers: SupportServerDiagnostic[];
  agents: SupportAgentDiagnostic[];
  supportNotes: Array<{ id: string; actorId: string | null; note: string; at: string }>;
  recentActivity: Array<Record<string, unknown>>;
  connections: SupportConnectionDiagnostics;
  notificationFailures: SupportNotificationFailure[];
  diagnostics: SupportDiagnosticSummary;
}

export interface SupportDiagnosticSummary {
  subscriptionsRequiringAttention: number;
  serversInError: number;
  nodesStaleOrMissing: number;
  agentsDegraded: number;
  connectionsConfigured: number;
  connectionsTotal: number;
  recentNotificationFailures: number;
}

export interface SupportSubscriptionLifecycle {
  subscriptionId: string;
  state: string;
  plan: string;
  tier: string;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  trialEndsAt: string | null;
  graceEndsAt: string | null;
  retentionUntil: string | null;
  failedRenewals: number;
  cancelAtPeriodEnd: boolean;
  suspensionReason: string | null;
  reconciliationRequired: boolean;
}

export interface SupportServerDiagnostic {
  id: string;
  orgId: string;
  computeClassCode: string;
  state: string;
  providerName: string | null;
  regionCode: string | null;
  lifecycle: { state: string; attemptCount: number; errorSummary: string | null };
  nodeHealth?: { status: string; version: string | null; lastSeenAt: string | null; health: string };
  createdAt: string;
  updatedAt: string;
}

export interface SupportAgentDiagnostic {
  agentId: string;
  slug: string;
  displayName: string;
  status: string;
  currentVersion?: number;
  deploymentKind?: string;
  deploymentState?: string;
  desiredRevision?: number;
  runtimeHealth?: string;
}

export interface SupportConnectionDiagnostics {
  models: Array<{ providerId: string; displayName: string; kind: string; status: string; credentialConfigured: boolean; connected: boolean }>;
  integrations: Array<{ integrationId: string; displayName: string; kind: string; status: string; credentialConfigured: boolean; connected: boolean }>;
  channels: Array<{
    channelId: string;
    displayName: string;
    kind: string;
    status: string;
    credentialConfigured: boolean;
    connected: boolean;
    boundAgentId: string | null;
    boundAgentName: string | null;
  }>;
}

export interface SupportNotificationFailure {
  id: string;
  eventType: string;
  route: string;
  deliveryState: string;
  attempts: number;
  errorSummary: string | null;
  at: string;
}

export interface SupportEscalation {
  id: string;
  orgId: string;
  orgName?: string;
  createdByUserId: string;
  assignedUserId: string | null;
  severity: string;
  category: string;
  title: string;
  description: string;
  status: string;
  resolutionNote: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
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

// ----------------------------------------------------------------------------
// Phase 04: Customer Extended Capabilities Types
// ----------------------------------------------------------------------------

export type UsageStatus =
  | "within_included"
  | "soft_limit_warning"
  | "hard_limit_blocked"
  | "unlimited"
  | "overage";

export interface UsageMetricItem {
  kind: string;
  metric: string;
  quantity: number;
  unit: string;
  includedQuantity: number;
  remaining: number | null;
  unlimited: boolean;
  status: UsageStatus;
}

export interface UsageCredits {
  included: number;
  consumed: number;
  remaining: number;
}

export interface UsageDetails {
  period: {
    start: string;
    end: string;
  };
  metrics: UsageMetricItem[];
  credits: UsageCredits;
}

export interface NotificationRouteItem {
  eventType: string;
  title: string;
  category: "system" | "billing" | "servers" | "agents" | "security";
  mandatory: boolean;
  routes: Array<"in_app" | "email" | "web_push">;
  muted: boolean;
}

export interface NotificationPreferencesView {
  availableRoutes: Array<"in_app" | "email" | "web_push">;
  items: NotificationRouteItem[];
}

export interface StoredBackupSummary {
  backupId: string;
  serverOrderId?: string;
  kind: "provider_snapshot" | "s3_copy";
  state: "pending" | "completed" | "failed" | "expired";
  sizeBytes?: number;
  createdAt: string;
  completedAt?: string;
  error?: string;
  locationLabel: string;
}

export interface BackupsOverview {
  availability: boolean;
  retentionDays: number;
  lastSuccessfulAt?: string;
  failedCount: number;
  backups: StoredBackupSummary[];
  cancellationExportSummary?: {
    eligible: boolean;
    retentionWindowDays: number;
    description: string;
  };
}

export interface WorkspaceMemberView {
  id: string;
  userId: string;
  email: string;
  displayName: string;
  role: "owner" | "admin" | "member" | "viewer";
  joinedAt?: string;
  createdAt: string;
  isOwner: boolean;
}

export interface WorkspaceInvitationView {
  id: string;
  email: string;
  role: "admin" | "member" | "viewer";
  createdAt: string;
  expiresAt: string;
}

export interface WorkspaceTeamOverview {
  members: WorkspaceMemberView[];
  invitations: WorkspaceInvitationView[];
  totalUsed: number;
  limit: number;
}

export interface CreatedWorkspaceInvitation {
  invitationId: string;
  email: string;
  role: string;
  inviteToken: string;
  inviteUrl: string;
  expiresAt: string;
}

export interface KnowledgeSourceItem {
  id: string;
  name: string;
  kind: string;
  lastSyncedAt?: string;
  createdAt: string;
}

export interface VoiceOption {
  id: string;
  label: string;
  description?: string;
  provider: string;
}

// ---- Mandatory customer onboarding (org-scoped durable authority) -----------

export type OnboardingStatus = "not_started" | "in_progress" | "completed";

export type OnboardingPersona = "founder" | "developer" | "agency" | "operations" | "other";

/** "Configure later" style choices are explicit decisions, never fake success. */
export type OnboardingModelChoice = "mox_managed" | "own_provider" | "deferred";
export type OnboardingAgentChoice = "created" | "deferred";
export type OnboardingInfrastructureChoice = "provisioned" | "deferred";
export type OnboardingConnectionsChoice = "configured" | "deferred";

export interface OnboardingState {
  orgId: string;
  status: OnboardingStatus;
  currentStep: number;
  completedSteps: number[];
  persona: OnboardingPersona | null;
  goals: string[];
  displayName: string | null;
  workspaceName: string | null;
  modelSetupChoice: OnboardingModelChoice | null;
  modelProviderId: string | null;
  agentSetupChoice: OnboardingAgentChoice | null;
  agentId: string | null;
  infrastructureSetupChoice: OnboardingInfrastructureChoice | null;
  serverOrderId: string | null;
  connectionsSetupChoice: OnboardingConnectionsChoice | null;
  startedAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
  updatedByUserId: string | null;
  /** Server-derived: required decision steps not recorded yet. */
  missingRequiredSteps: number[];
}

/** Step-scoped progress patch; the server validates fields against the step. */
export interface OnboardingPatchInput {
  step: number;
  advanceTo?: number;
  persona?: OnboardingPersona;
  goals?: string[];
  displayName?: string;
  workspaceName?: string;
  modelSetupChoice?: OnboardingModelChoice;
  modelProviderId?: string;
  agentSetupChoice?: OnboardingAgentChoice;
  agentId?: string;
  infrastructureSetupChoice?: OnboardingInfrastructureChoice;
  serverOrderId?: string;
  connectionsSetupChoice?: OnboardingConnectionsChoice;
}

/** Customer-safe projection of a real server order (no provider internals). */
export interface ServerOrderView {
  orderId: string;
  state: ServerSummary["state"];
  computeClassCode: string;
  hostname: string;
  regionCode?: string | null;
  lastError?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Safe Mox compute-class catalog entry (PRODUCT_COMPLETION_02). */
export interface ComputeClassOption {
  code: string;
  displayName: string;
  minVcpu: number;
  minRamGb: number;
  /** Included by the org's current commercial plan (from the real authority). */
  included: boolean;
}

export interface SshKeyRow {
  id: string;
  label: string;
  fingerprint: string;
  publicKey: string;
  createdAt: string;
}

export interface ProvisionOptions {
  classes: ComputeClassOption[];
  serverQuota: {
    entitled: boolean;
    included: number | null;
    activeServers: number;
    reason: string | null;
  };
  sshKeys: SshKeyRow[];
}


export interface MoxApi {

  // Roster / definitions
  listAgents(): Promise<AgentSummary[]>;
  getAgent(agentId: string): Promise<AgentSummary | undefined>;
  updateModel(agentId: string, modelId: string): Promise<void>;

  // Authoring & versioning (Phase 02 §B / §C) — server-authoritative definitions
  createAgentDraft(input: CreateAgentDraftInput): Promise<AgentDraftResult>;
  updateAgentDraft(agentId: string, input: CreateAgentDraftInput): Promise<AgentDraftResult>;
  publishAgent(agentId: string, changelog?: string): Promise<{ agentId: string; revision: number; status: string }>;
  listAgentVersions(agentId: string): Promise<AgentVersionRow[]>;
  diffAgentVersions(agentId: string, from: number, to: number): Promise<{ from: number; to: number; changes: string[] }>;
  rollbackAgent(agentId: string, toRevision: number): Promise<{ agentId: string; revision: number }>;

  // Threads & chat
  listThreads(agentId: string): Promise<Array<{ threadId: string; title?: string; status?: string }>>;
  createThread(input: { agentId: string; title?: string }): Promise<{ threadId: string; title?: string }>;
  getMessages(threadId: string): Promise<ChatMessage[]>;
  archiveThread(threadId: string): Promise<{ threadId: string; status: string }>;
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
  getRoomMessages(roomId: string): Promise<RoomMessage[]>;
  sendRoomMessage(roomId: string, text: string, targetAgentId?: string): Promise<{ message: RoomMessage; turns: Array<{ agentId: string; turn: unknown }> }>;

  // Infrastructure surfaces
  listServers(): Promise<ServerSummary[]>;
  listDeployments(): Promise<AgentDeployment[]>;
  serverAction(orderId: string, action: "restart" | "redeploy" | "resize" | "cancel" | "stop" | "start", computeClassCode?: string): Promise<{ ok: boolean }>;

  // Customer provisioning (PRODUCT_COMPLETION_02)
  getProvisionOptions(): Promise<ProvisionOptions>;
  orderServer(input: { computeClassCode: string; hostname: string; sshKeyId?: string; idempotencyKey?: string }): Promise<ServerOrderView>;
  addSshKey(input: { label: string; publicKey: string }): Promise<SshKeyRow>;
  deleteSshKey(keyId: string): Promise<{ ok: boolean }>;
  deployAgent(input: { agentId: string; revision: number; target?: { kind?: string; vpsId?: string } }): Promise<{ ok: boolean; state: string }>;
  redeployDeployment(deploymentId: string): Promise<{ ok: boolean; state: string }>;
  deploymentRollback(deploymentId: string, toRevision: number): Promise<{ ok: boolean; state: string }>;

  // Models page
  listModels(): Promise<ModelOption[]>;
  testProviderConnection(providerId: string): Promise<{ ok: boolean; reason?: string }>;
  listCliEngines(): Promise<CliEngineRow[]>;

  // BYOK / model connections (Phase 03 §B/§G)
  listModelConnections(): Promise<ModelConnectionRow[]>;
  connectModelConnection(providerId: string, input: { apiKey?: string; baseUrl?: string; models?: string[] }): Promise<ModelConnectionRow>;
  rotateModelConnection(providerId: string, input: { apiKey: string }): Promise<ModelConnectionRow>;
  disconnectModelConnection(providerId: string): Promise<{ ok: boolean; providerId: string }>;

  // Integrations/Apps + Channels (Phase 03 §C/§D)
  listIntegrations(): Promise<IntegrationCatalogRow[]>;
  connectIntegration(integrationId: string, input: { secrets?: Record<string, string>; config?: Record<string, unknown> }): Promise<{ ok: boolean; integrationId: string; connected: boolean }>;
  disconnectIntegration(integrationId: string): Promise<{ ok: boolean; integrationId: string; connected: boolean }>;
  listIntegrationGrants(integrationId: string): Promise<ToolGrantRow[]>;
  grantIntegrationTool(integrationId: string, input: { agentId: string; toolPattern?: string }): Promise<{ ok: boolean; grantId: string }>;
  revokeIntegrationGrant(integrationId: string, grantId: string): Promise<{ ok: boolean; grantId: string }>;
  listChannels(): Promise<ChannelCatalogRow[]>;
  connectChannel(channelId: string, input: { agentId: string; secrets?: Record<string, string> }): Promise<{ ok: boolean; channelId: string; agentId: string; connected: boolean }>;
  reconnectChannel(connectionId: string, input: { secrets?: Record<string, string> }): Promise<{ ok: boolean; connectionId: string; connected: boolean; boundAgentId: string }>;
  disconnectChannel(connectionId: string): Promise<{ ok: boolean; connectionId: string; connected: boolean }>;
  testChannel(connectionId: string): Promise<{ ok: boolean; reason?: string }>;

  // Usage/billing/settings
  getUsage(): Promise<UsageRow[]>;
  getUsageDetails(): Promise<UsageDetails>;
  listInvoices(): Promise<InvoiceRow[]>;
  getEntitlements(): Promise<Entitlements>;
  listPlans(): Promise<PlanOption[]>;
  getSubscription(): Promise<SubscriptionView | null>;
  listBillingProviders(): Promise<BillingProviderOption[]>;
  startCheckout(input: {
    planVersionId: string;
    pricingRegionCode?: string;
    providerName: string;
    successUrl: string;
    cancelUrl: string;
  }): Promise<{ sessionId: string; providerRef: string; redirectUrl: string; state: string }>;
  cancelSubscription(): Promise<{ ok: boolean; subscriptionId: string }>;
  reconcileCheckout(input: { sessionId?: string }): Promise<Record<string, unknown>>;

  // Notification Preferences (Phase 04 §B)
  getNotificationPreferences(): Promise<NotificationPreferencesView>;
  updateNotificationPreferences(prefs: { routes: Record<string, string[]>; mutedEventTypes: string[] }): Promise<NotificationPreferencesView>;

  // Backups (Phase 04 §C)
  getBackupsOverview(): Promise<BackupsOverview>;
  triggerManualBackup(serverOrderId?: string): Promise<{ ok: boolean; backupId: string; state: string }>;
  testBackupRestore(backupId: string): Promise<{ ok: boolean; message: string }>;

  // Team / Workspace Members (Phase 04 §D)
  getTeamOverview(): Promise<WorkspaceTeamOverview>;
  inviteTeamMember(email: string, role: "admin" | "member" | "viewer"): Promise<CreatedWorkspaceInvitation>;
  revokeTeamInvitation(invitationId: string): Promise<void>;
  updateTeamMemberRole(userId: string, role: "admin" | "member" | "viewer"): Promise<void>;
  removeTeamMember(userId: string): Promise<void>;

  // Knowledge Sources (Phase 04 §E/§H)
  listKnowledgeSources(): Promise<KnowledgeSourceItem[]>;
  createKnowledgeSource(input: { name: string; kind: string; config?: Record<string, unknown> }): Promise<KnowledgeSourceItem>;
  deleteKnowledgeSource(id: string): Promise<void>;

  // Voice (Phase 04 §F)
  listVoices(): Promise<VoiceOption[]>;
  previewVoice(voiceId: string, text: string): Promise<{ ok: boolean; sampleUrl?: string; reason?: string }>;

  // Personal access tokens (Phase 03 §E)
  createApiToken(input: { name: string; scopes?: string[] }): Promise<{ token: string; tokenId: string; scopes: string[]; expiresAt: string }>;
  listApiTokens(): Promise<ApiTokenRow[]>;
  revokeApiToken(tokenId: string): Promise<void>;

  // Mandatory customer onboarding (durable, org-scoped authority)
  getOnboarding(): Promise<OnboardingState>;
  updateOnboarding(input: OnboardingPatchInput): Promise<OnboardingState>;
  completeOnboarding(): Promise<OnboardingState>;

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
  adminGetNotificationJob(jobId: string): Promise<AdminNotificationJobDetails>;

  // Enterprise Contracts (Phase 05 §H)
  adminListEnterpriseContracts(): Promise<AdminEnterpriseContract[]>;
  adminSaveEnterpriseContract(input: Partial<AdminEnterpriseContract>): Promise<{ ok: boolean }>;
  adminDeactivateEnterpriseContract(contractRef: string): Promise<{ ok: boolean }>;

  // Feature Flags & Operations (Phase 05 §G)
  adminSaveFeatureFlag(flag: { key: string; orgId: string; enabled: string; rollout?: Record<string, unknown> }): Promise<{ ok: boolean }>;
  adminDeleteFeatureFlag(key: string): Promise<{ ok: boolean }>;
  adminRunBackup(input: { orgId: string; serverOrderId?: string; label?: string }): Promise<Record<string, unknown>>;
  adminRestoreTest(backupId: string): Promise<Record<string, unknown>>;

  // Plan Entitlements & Addons (Phase 05 §C)
  adminSavePlanEntitlement(planVersionId: string, key: string, value: boolean | number | string): Promise<{ ok: boolean }>;
  adminSaveAddon(addon: { code: string; displayName: string; consumable: boolean; unit?: string }): Promise<{ ok: boolean }>;

  // Prompt 03: Staff & Access (admin.staff.write — superadmin only)
  adminStaff(): Promise<AdminStaff>;
  adminCreateStaffInvite(input: CreateStaffInviteInput): Promise<CreatedStaffInvite>;
  adminRevokeStaffInvite(invitationId: string): Promise<void>;
  adminStaffAction(userId: string, role: string, action: "disable" | "enable" | "revoke", reason?: string): Promise<void>;

  // Prompt 03: Support console (support.customer.lookup / support.ticket.write)
  supportCustomers(query?: string): Promise<SupportCustomer[]>;
  supportCustomer(orgId: string): Promise<SupportCustomerDetail>;
  supportAddNote(orgId: string, note: string): Promise<void>;

  // Support escalations (Phase 06)
  supportListEscalations(orgId?: string): Promise<SupportEscalation[]>;
  supportCreateEscalation(input: { orgId: string; severity: string; category: string; title: string; description: string }): Promise<SupportEscalation>;
  supportUpdateEscalation(escalationId: string, input: { status?: string; assignedUserId?: string; resolutionNote?: string }): Promise<SupportEscalation>;

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
