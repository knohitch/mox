import type { MoxStore } from "../api/store.js";
import type { ChatMessage, MoxApi, OnboardingState, ServerOrderView } from "../api/types.js";
import {
  createCustomerAgentsFixture,
  createCustomerBackupsFixture,
  createCustomerBillingFixture,
  createCustomerChannelsFixture,
  createCustomerDeploymentsFixture,
  createCustomerIntegrationsFixture,
  createCustomerModelsFixture,
  createCustomerNotificationsFixture,
  createCustomerRoomsFixture,
  createCustomerServersFixture,
  createCustomerTeamFixture,
  createCustomerUsageFixture,
  createCustomerUserFixture,
} from "../fixtures/customerFixtures.js";
import {
  createAdminComputeFixture,
  createAdminCustomersFixture,
  createAdminEnterpriseContractsFixture,
  createAdminIntelligenceFixture,
  createAdminNotificationsFixture,
  createAdminOperationsFixture,
  createAdminOverviewFixture,
  createAdminPaymentsFixture,
  createAdminPlansFixture,
  createAdminRuntimeFixture,
  createAdminStaffFixture,
} from "../fixtures/adminFixtures.js";
import {
  createSupportCustomerDetailFixture,
  createSupportCustomersFixture,
} from "../fixtures/supportFixtures.js";
import {
  ADMIN_PREVIEW_ROLES,
  SUPPORT_PREVIEW_ROLES,
} from "../concepts/staffNav.js";
import type { StudioOnboardingState } from "./previewNavigation.js";

export type UiStudioSurface = "customer" | "admin" | "support";
export type UiStudioState = "populated" | "empty" | "loading" | "error" | "gated";

/**
 * Deterministic onboarding preview fixtures (VISUAL ONLY — fixture data, never
 * the real onboarding authority). `provider-unavailable` models a deployment
 * where Mox-managed models are absent and no BYOK provider is connected;
 * `error` models the onboarding state failing to load.
 */
function createOnboardingPreviewFixture(preview: StudioOnboardingState | undefined): OnboardingState {
  const base: OnboardingState = {
    orgId: "org_acme_prod",
    status: "in_progress",
    currentStep: 1,
    completedSteps: [],
    persona: null,
    goals: [],
    displayName: "Ada Operator",
    workspaceName: "Acme Robotics",
    modelSetupChoice: null,
    modelProviderId: null,
    agentSetupChoice: null,
    agentId: null,
    infrastructureSetupChoice: null,
    serverOrderId: null,
    connectionsSetupChoice: null,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: null,
    updatedByUserId: "usr_owner",
    missingRequiredSteps: [1, 2, 3, 4, 5, 6],
  };
  const at = (step: number) => {
    base.currentStep = step;
    base.completedSteps = [1, 2, 3, 4, 5, 6].slice(0, step - 1);
    base.missingRequiredSteps = [1, 2, 3, 4, 5, 6].slice(step - 1);
    return base;
  };
  switch (preview) {
    case "step1":
      return at(1);
    case "step2":
      at(2);
      base.persona = "founder";
      return { ...base };
    case "step3":
      at(3);
      base.persona = "founder";
      base.goals = ["build-ai-agents", "deploy-autonomous-agents"];
      return { ...base };
    case "step4":
      at(4);
      base.persona = "founder";
      base.goals = ["build-ai-agents", "deploy-autonomous-agents"];
      base.modelSetupChoice = "mox_managed";
      base.modelProviderId = "mox";
      return { ...base };
    case "provider-unavailable":
      // Modeled at the model-setup step: Mox-managed models are absent on the
      // deployment and no BYOK provider is connected (honest unavailability).
      at(3);
      base.persona = "founder";
      base.goals = ["use-own-ai-provider"];
      return { ...base };
    case "step5":
      at(5);
      base.persona = "founder";
      base.goals = ["build-ai-agents", "dedicated-infrastructure"];
      base.modelSetupChoice = "own_provider";
      base.modelProviderId = "anthropic";
      base.agentSetupChoice = "created";
      base.agentId = "agent_orchestrator";
      return { ...base };
    case "step6":
      at(6);
      base.persona = "founder";
      base.goals = ["build-ai-agents", "connect-messaging-channels"];
      base.modelSetupChoice = "own_provider";
      base.modelProviderId = "anthropic";
      base.agentSetupChoice = "created";
      base.agentId = "agent_orchestrator";
      base.infrastructureSetupChoice = "provisioned";
      base.serverOrderId = "ord_fixture_1";
      return { ...base };
    case "mobile":
      at(1);
      return { ...base };
    default:
      return base;
  }
}

function previewCapabilities(
  surface: UiStudioSurface,
  state: UiStudioState,
  role: string | undefined,
): { role: string; capabilities: string[] } {
  if (surface === "admin") {
    const resolved = role && role in ADMIN_PREVIEW_ROLES ? role : "superadmin";
    const profile = ADMIN_PREVIEW_ROLES[resolved as keyof typeof ADMIN_PREVIEW_ROLES];
    return { role: resolved, capabilities: state === "gated" ? [] : [...profile.capabilities] };
  }
  if (surface === "support") {
    const resolved = role && role in SUPPORT_PREVIEW_ROLES ? role : "support_manager";
    const profile = SUPPORT_PREVIEW_ROLES[resolved as keyof typeof SUPPORT_PREVIEW_ROLES];
    return { role: resolved, capabilities: state === "gated" ? [] : [...profile.capabilities] };
  }
  return { role: "superadmin", capabilities: [] };
}

export function createMockMoxStore(
  surface: UiStudioSurface,
  state: UiStudioState,
  role?: string,
  onboardingPreview?: StudioOnboardingState,
): MoxStore {
  const isLoading = state === "loading";
  const isError = state === "error";
  const isEmpty = state === "empty";
  const isGated = state === "gated";

  const customerUser = createCustomerUserFixture();
  const customerAgents = isEmpty ? [] : createCustomerAgentsFixture();
  const customerRooms = isEmpty ? [] : createCustomerRoomsFixture();
  const customerServers = isEmpty ? [] : createCustomerServersFixture();
  const customerDeployments = isEmpty ? [] : createCustomerDeploymentsFixture();
  const customerModels = createCustomerModelsFixture();
  const customerIntegrations = isEmpty ? [] : createCustomerIntegrationsFixture();
  const customerChannels = isEmpty ? [] : createCustomerChannelsFixture();
  const customerUsage = createCustomerUsageFixture();
  const customerBilling = createCustomerBillingFixture();
  const customerBackups = createCustomerBackupsFixture();
  const customerTeam = createCustomerTeamFixture();
  const customerNotifications = createCustomerNotificationsFixture();

  const adminOverview = createAdminOverviewFixture();
  const adminCustomers = isEmpty ? [] : createAdminCustomersFixture();
  const adminPlans = createAdminPlansFixture();
  const adminPayments = isEmpty ? [] : createAdminPaymentsFixture();
  const adminCompute = createAdminComputeFixture();
  const adminIntelligence = createAdminIntelligenceFixture();
  const adminRuntime = isEmpty ? [] : createAdminRuntimeFixture();
  const adminOperations = createAdminOperationsFixture();
  const adminNotifications = createAdminNotificationsFixture();
  const adminContracts = isEmpty ? [] : createAdminEnterpriseContractsFixture();
  const adminStaff = createAdminStaffFixture();

  const supportCustomers = isEmpty ? [] : createSupportCustomersFixture();
  const supportCustomerDetail = createSupportCustomerDetailFixture();
  const draftDefinition = createCustomerAgentsFixture()[0]!.definition;
  const modelConnectionTemplate = createCustomerModelsFixture().connections[0]!;
  const { role: previewRole, capabilities: previewCaps } = previewCapabilities(surface, state, role);

  // Onboarding preview (visual fixture only): mutable local copy so PATCHes in
  // the preview behave realistically without touching any real authority.
  const onboardingUnavailable = onboardingPreview === "provider-unavailable";
  let onboardingFixture = createOnboardingPreviewFixture(onboardingPreview === "error" ? undefined : onboardingPreview);
  const onboardingModels = onboardingUnavailable
    ? []
    : customerModels.models.map((m) => (m.providerId === "deepseek" ? { ...m, providerId: "mox", modelId: "mox-agent", byok: false, displayName: "Mox Agent (managed)" } : m));
  const onboardingConnections = onboardingUnavailable
    ? customerModels.connections.map((c) => ({ ...c, connected: false, credentialConfigured: false, status: "unconfigured" }))
    : customerModels.connections;

  const noopPromise = async () => {};

  // Preview-only message cache (fixture data, never privileged APIs/PostgreSQL).
  const previewThreadMessages = new Map<string, ChatMessage[]>();

  const mockApi: MoxApi = {
    listAgents: async () => (isEmpty ? [] : customerAgents),
    getAgent: async (id) => customerAgents.find((a) => a.agentId === id),
    updateModel: noopPromise,
    createAgentDraft: async () => ({ agentId: "draft_1", slug: "draft", status: "draft", currentVersion: 1, definition: customerAgents[0]?.definition ?? draftDefinition }),
    updateAgentDraft: async () => ({ agentId: "draft_1", slug: "draft", status: "draft", currentVersion: 1, definition: customerAgents[0]?.definition ?? draftDefinition }),
    publishAgent: async () => ({ agentId: "draft_1", revision: 2, status: "published" }),
    listAgentVersions: async () => [],
    diffAgentVersions: async () => ({ from: 1, to: 2, changes: ["Updated prompt"] }),
    rollbackAgent: async () => ({ agentId: "draft_1", revision: 1 }),
    listThreads: async () =>
      isEmpty
        ? []
        : [
            { threadId: "th_main", title: "General Discussion", status: "active" },
            { threadId: "th_q3", title: "Q3 Pipeline Review", status: "active" },
          ],
    createThread: async (input) => {
      if (isError) throw new Error("Simulated thread creation failure — Studio preview of createThread errors.");
      return { threadId: "th_new", title: input?.title ?? "New conversation" };
    },
    archiveThread: async () => ({ threadId: "th_main", status: "archived" }),
    getMessages: async (threadId) => {
      if (isEmpty) return [];
      if (threadId === "th_main") {
        return [
          {
            messageId: "msg_fixture_1",
            threadId,
            authorId: "u_you",
            role: "user",
            text: "Summarize the current pipeline for me.",
            at: new Date().toISOString(),
          },
          {
            messageId: "msg_fixture_2",
            threadId,
            authorId: "agent_orchestrator",
            role: "agent",
            text: "Here is the current pipeline summary based on your workspace data.",
            at: new Date().toISOString(),
          },
          // Streaming bubble + active run: previews the "running" state.
          {
            messageId: "msg_fixture_3",
            threadId,
            authorId: "agent_orchestrator",
            role: "agent",
            text: "Breaking down the Q3 numbers: ",
            at: new Date().toISOString(),
            streaming: true,
          },
        ];
      }
      if (threadId === "th_q3") {
        return [
          {
            messageId: "msg_fixture_4",
            threadId,
            authorId: "u_you",
            role: "user",
            text: "Compare the top three competitors for us.",
            at: new Date().toISOString(),
          },
          {
            messageId: "msg_fixture_5",
            threadId,
            authorId: "agent_orchestrator",
            role: "agent",
            text: "Here is the competitor comparison you asked for.",
            at: new Date().toISOString(),
          },
        ];
      }
      return [];
    },
    send: async () => ({ runId: "run_mock", done: Promise.resolve(), cancel: () => {} }),
    openApprovals: async () => [],
    resolveApproval: noopPromise,
    getEvents: async () => [],
    listRooms: async () => customerRooms,
    createRoom: async (input) => ({
      roomId: `room_${Date.now()}` as any,
      orgId: "org_acme_prod" as any,
      title: input.title,
      memberAgentIds: input.memberAgentIds as any,
      memberUserIds: [],
      createdAt: new Date().toISOString(),
    }),
    getRoomMessages: async () => [],
    sendRoomMessage: async (_roomId, text) => ({
      message: { messageId: `rm_${Date.now()}`, roomId: _roomId, authorKind: "user" as const, authorId: "u_you", authorName: "You", text, at: new Date().toISOString() },
      turns: [],
    }),
    listServers: async () => customerServers,
    serverAction: async () => ({ ok: true }),
    orderServer: async (input) => {
      if (isGated) throw new Error("server quota exceeded for current plan");
      const order: ServerOrderView = {
        orderId: `ord_${Date.now()}`,
        state: "provisioning",
        computeClassCode: input.computeClassCode,
        hostname: input.hostname,
        regionCode: null,
        lastError: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      return order;
    },
    getProvisionOptions: async () => ({
      classes: [
        { code: "standard-2vcpu", displayName: "Mox Standard — 2 vCPU / 4 GB", minVcpu: 2, minRamGb: 4, included: true },
        { code: "standard-4vcpu", displayName: "Mox Standard — 4 vCPU / 8 GB", minVcpu: 4, minRamGb: 8, included: true },
      ],
      serverQuota: { entitled: true, included: 3, activeServers: 0, reason: null },
      sshKeys: [],
    }),
    addSshKey: async (input) => ({
      id: `key_${Date.now()}`,
      label: input.label,
      fingerprint: "SHA256:fixture",
      publicKey: input.publicKey,
      createdAt: new Date().toISOString(),
    }),
    deleteSshKey: async () => ({ ok: true }),
    getOnboarding: async () => {
      if (onboardingPreview === "error") throw new Error("Simulated onboarding state failure — Studio preview of error handling.");
      return onboardingFixture;
    },
    updateOnboarding: async (input) => {
      if (onboardingPreview === "error") throw new Error("Simulated onboarding state failure — Studio preview of error handling.");
      onboardingFixture = {
        ...onboardingFixture,
        ...("persona" in input && input.persona ? { persona: input.persona } : {}),
        goals: "goals" in input && input.goals ? input.goals : onboardingFixture.goals,
        displayName: input.displayName ?? onboardingFixture.displayName,
        workspaceName: input.workspaceName ?? onboardingFixture.workspaceName,
        modelSetupChoice: input.modelSetupChoice ?? onboardingFixture.modelSetupChoice,
        modelProviderId: input.modelProviderId ?? onboardingFixture.modelProviderId,
        agentSetupChoice: input.agentSetupChoice ?? onboardingFixture.agentSetupChoice,
        agentId: input.agentId ?? onboardingFixture.agentId,
        infrastructureSetupChoice: input.infrastructureSetupChoice ?? onboardingFixture.infrastructureSetupChoice,
        serverOrderId: input.serverOrderId ?? onboardingFixture.serverOrderId,
        connectionsSetupChoice: input.connectionsSetupChoice ?? onboardingFixture.connectionsSetupChoice,
        currentStep: input.advanceTo ?? onboardingFixture.currentStep,
        completedSteps: input.step && !onboardingFixture.completedSteps.includes(input.step)
          ? [...onboardingFixture.completedSteps, input.step].sort((a, b) => a - b)
          : onboardingFixture.completedSteps,
        updatedAt: new Date().toISOString(),
      };
      onboardingFixture.missingRequiredSteps = [1, 2, 3, 4, 5, 6].filter((n) => !onboardingFixture.completedSteps.includes(n));
      return onboardingFixture;
    },
    completeOnboarding: async () => {
      onboardingFixture = {
        ...onboardingFixture,
        status: "completed",
        currentStep: 6,
        completedSteps: [1, 2, 3, 4, 5, 6],
        missingRequiredSteps: [],
        completedAt: new Date().toISOString(),
      };
      return onboardingFixture;
    },
    listDeployments: async () => customerDeployments,
    deployAgent: async () => ({ ok: true, state: "running" }),
    redeployDeployment: async () => ({ ok: true, state: "running" }),
    deploymentRollback: async () => ({ ok: true, state: "running" }),
    listModels: async () => (isEmpty ? [] : onboardingPreview ? onboardingModels : customerModels.models),
    testProviderConnection: async () => ({ ok: true }),
    listCliEngines: async () => [],
    listModelConnections: async () => (isEmpty ? [] : onboardingPreview ? onboardingConnections : customerModels.connections),
    connectModelConnection: async () => customerModels.connections[0] ?? modelConnectionTemplate,
    rotateModelConnection: async () => customerModels.connections[0] ?? modelConnectionTemplate,
    disconnectModelConnection: async () => ({ ok: true, providerId: "anthropic" }),
    listIntegrations: async () => customerIntegrations,
    connectIntegration: async () => ({ ok: true, integrationId: "github", connected: true }),
    disconnectIntegration: async () => ({ ok: true, integrationId: "github", connected: false }),
    listIntegrationGrants: async () => [],
    grantIntegrationTool: async () => ({ ok: true, grantId: "grant_1" }),
    revokeIntegrationGrant: async () => ({ ok: true, grantId: "grant_1" }),
    listChannels: async () => customerChannels,
    connectChannel: async () => ({ ok: true, channelId: "slack", agentId: "agent_orchestrator", connected: true }),
    reconnectChannel: async () => ({ ok: true, connectionId: "conn_1", connected: true, boundAgentId: "agent_orchestrator" }),
    disconnectChannel: async () => ({ ok: true, connectionId: "conn_1", connected: false }),
    testChannel: async () => ({ ok: true }),
    getUsage: async () => (isEmpty ? [] : customerUsage.rows),
    getUsageDetails: async () => customerUsage.details,
    listInvoices: async () => (isEmpty ? [] : customerBilling.invoices),
    getEntitlements: async () => ({
      commerciallyEntitled: !isGated,
      values: isGated
        ? {}
        : {
            agent_rooms: 10,
            model_connections: 5,
            integrations: 10,
            channel_connections: 5,
            backup_retention_days: 30,
            team_members: 10,
            storage_gb: 100,
            included_server_count: onboardingUnavailable ? 0 : 2,
            included_compute_class: "COMPUTE_SMALL",
          },
    }),
    listPlans: async () => customerBilling.plans,
    getSubscription: async () => (isEmpty ? null : customerBilling.subscription),
    listBillingProviders: async () => [
      {
        providerName: "stripe",
        displayName: "Stripe",
        environment: "live",
        enabled: true,
        supportedCurrencies: ["USD", "EUR"],
        available: true,
      },
    ],
    startCheckout: async () => ({ sessionId: "cs_mock", providerRef: "pi_mock", redirectUrl: "#", state: "open" }),
    cancelSubscription: async () => ({ ok: true, subscriptionId: "sub_scale_active" }),
    reconcileCheckout: async () => ({ status: "active" }),
    getNotificationPreferences: async () => customerNotifications,
    updateNotificationPreferences: async (prefs) => ({
      availableRoutes: customerNotifications.availableRoutes,
      items: customerNotifications.items.map((i) => ({ ...i, muted: prefs.mutedEventTypes.includes(i.eventType) })),
    }),
    getBackupsOverview: async () => (isEmpty ? { availability: false, retentionDays: 0, failedCount: 0, backups: [] } : customerBackups),
    triggerManualBackup: async () => ({ ok: true, backupId: "bak_manual", state: "pending" }),
    testBackupRestore: async () => ({ ok: true, message: "Backup validated successfully" }),
    getTeamOverview: async () => (isEmpty ? { members: customerTeam.members.slice(0, 1), invitations: [], totalUsed: 1, limit: 5 } : customerTeam),
    inviteTeamMember: async (email, role) => ({ invitationId: "inv_1", email, role, inviteToken: "tok_1", inviteUrl: "#", expiresAt: new Date().toISOString() }),
    revokeTeamInvitation: noopPromise,
    updateTeamMemberRole: noopPromise,
    removeTeamMember: noopPromise,
    listKnowledgeSources: async () => [],
    createKnowledgeSource: async (input) => ({ id: "ks_1", name: input.name, kind: input.kind, createdAt: new Date().toISOString() }),
    deleteKnowledgeSource: noopPromise,
    listVoices: async () => [],
    previewVoice: async () => ({ ok: true }),
    createApiToken: async () => ({ token: "mox_tok_mock", tokenId: "tok_1", scopes: ["read"], expiresAt: new Date().toISOString() }),
    listApiTokens: async () => [],
    revokeApiToken: noopPromise,
    adminOverview: async () => adminOverview,
    adminCustomers: async () => adminCustomers,
    adminCustomerAction: noopPromise,
    adminAddSupportNote: noopPromise,
    adminPlans: async () => adminPlans,
    adminUpsertCurrency: noopPromise,
    adminUpsertPriceBook: noopPromise,
    adminPaymentProviders: async () => adminPayments,
    adminSavePaymentProvider: noopPromise,
    adminCompute: async () => adminCompute,
    adminSaveComputeAccount: noopPromise,
    adminSaveComputeClass: noopPromise,
    adminComputeOrderAction: noopPromise,
    adminIntelligence: async () => adminIntelligence,
    adminSaveIntelligenceProvider: noopPromise,
    adminRuntime: async () => adminRuntime,
    adminRuntimeAction: noopPromise,
    adminOperations: async () => adminOperations,
    adminNotificationJobs: async () => adminNotifications,
    adminPreviewNotification: async () => ({}),
    adminSendNotification: async () => ({}),
    adminScheduleNotification: async () => ({}),
    adminCancelNotificationJob: noopPromise,
    adminGetNotificationJob: async (jobId) => ({
      id: jobId,
      audienceType: "all",
      title: "Security Update",
      body: "Platform maintenance advisory.",
      severity: "info",
      category: "security",
      status: "completed",
      fanoutDone: 142,
      fanoutTotal: 142,
      createdAt: new Date().toISOString(),
      logs: [],
    }),
    adminListEnterpriseContracts: async () => adminContracts,
    adminSaveEnterpriseContract: async () => ({ ok: true }),
    adminDeactivateEnterpriseContract: async () => ({ ok: true }),
    adminSaveFeatureFlag: async () => ({ ok: true }),
    adminDeleteFeatureFlag: async () => ({ ok: true }),
    adminRunBackup: async () => ({ ok: true }),
    adminRestoreTest: async () => ({ ok: true }),
    adminSavePlanEntitlement: async () => ({ ok: true }),
    adminSaveAddon: async () => ({ ok: true }),
    adminStaff: async () => adminStaff,
    adminCreateStaffInvite: async () => ({
      invitationId: "sinv_1",
      email: "staff@mox.internal",
      role: "operator",
      inviteToken: "stok_1",
      token: "stok_1",
      surface: "admin",
      expiresAt: new Date().toISOString(),
    }),
    adminRevokeStaffInvite: noopPromise,
    adminStaffAction: noopPromise,
    supportCustomers: async () => supportCustomers,
    supportCustomer: async (orgId) => {
      const found = supportCustomers.find((c) => c.orgId === orgId);
      return found ? createSupportCustomerDetailFixture(found.orgId) : supportCustomerDetail;
    },
    supportAddNote: noopPromise,
    computerSnapshot: async () =>
      isEmpty
        ? undefined
        : {
            sessionId: "cs_1",
            state: "active",
            humanControl: false,
            url: "https://preview.invalid",
            frameLabel: "frame_0",
            capturedAt: new Date().toISOString(),
          },
    computerTakeover: async () => ({ sessionId: "cs_1", state: "active", humanControl: true, url: "https://preview.invalid", frameLabel: "frame_0", capturedAt: new Date().toISOString() }),
    computerRestart: async () => ({ sessionId: "cs_1", state: "active", humanControl: true, url: "https://preview.invalid", frameLabel: "frame_0", capturedAt: new Date().toISOString() }),
    listFiles: async () => (isEmpty ? [] : [{ path: "workspace/README.md", sizeBytes: 1024, updatedAt: new Date().toISOString() }]),
    filePreview: async () => (isEmpty ? "" : "# Fixture workspace\nNo production secrets."),
    runTerminalCommand: async () => ({ output: "Command completed." }),
    getLogs: async () => (isEmpty ? [] : [{ at: new Date().toISOString(), level: "info" as const, line: "Agent started." }]),
  };

  return {
    api: mockApi,
    ready: !isLoading && !isError,
    error: isError ? "Simulated Network Error: Failed to reach Mox Control Plane cluster." : null,
    needsAuth: false,
    me: isEmpty ? { ...customerUser, orgDisplayName: "Empty Sandbox Org" } : customerUser,
    switchOrg: noopPromise,
    signIn: async () => onboardingFixture,
    signUp: async () => onboardingFixture,
    signOut: noopPromise,
    staffSession: {
      staffUserId: surface === "admin" ? "usr_mock_admin" : "usr_mock_support",
      email: surface === "admin" ? "admin@mox.internal" : "support@mox.internal",
      displayName: surface === "admin" ? "Admin Preview Operator" : "Support Preview Agent",
      role: previewRole,
      roles: surface === "support" ? [previewRole] : undefined,
      staffRoles: surface === "admin" ? [previewRole] : undefined,
      surface: surface === "customer" ? "admin" : surface,
      capabilities: previewCaps,
    },
    staffSurface: surface === "customer" ? null : surface,
    staffReady: !isLoading && !isError,
    staffError: isError ? "Simulated Staff Error: Authentication gateway timed out." : null,
    verifyStaffSession: async () => null,
    adminLogin: async () => undefined,
    supportLogin: async () => undefined,
    adminSignup: noopPromise,
    supportSignup: noopPromise,
    staffSignOut: noopPromise,
    forgotPassword: async () => ({ ok: true, message: "Reset sent" }),
    resetPassword: noopPromise,
    agents: customerAgents,
    refreshAgents: noopPromise,
    refreshEntitlements: noopPromise,
    refreshOnboarding: noopPromise,
    onboarding: onboardingPreview === "error" ? null : onboardingFixture,
    entitlements: {
      commerciallyEntitled: !isGated,
      values: isGated
        ? {}
        : {
            agent_rooms: 10,
            model_connections: 5,
            integrations: 10,
            channel_connections: 5,
            backup_retention_days: 30,
            team_members: 10,
            storage_gb: 100,
          },
    },
    approvals: isEmpty
      ? []
      : [
          {
            approvalId: "apr_fixture_1" as any,
            orgId: "org_acme_prod" as any,
            agentId: customerAgents[0]?.agentId ?? "agent_orchestrator",
            threadId: "th_main",
            kind: "tool-run",
            summary: "Agent wants to run a browser search (Studio preview).",
            payload: {},
            state: "open",
            requestedAt: new Date().toISOString(),
          },
        ],
    messages: (threadId) => previewThreadMessages.get(threadId) ?? [],
    loadThread: async (_agentId, threadId) => {
      const msgs = await mockApi.getMessages(threadId);
      previewThreadMessages.set(threadId, msgs);
    },
    send: async () => {
      if (isError) throw new Error("Simulated send failure — Studio preview of send errors.");
    },
    cancel: () => {},
    activeRun: (threadId) => (!isEmpty && threadId === "th_main" ? "run_mock" : null),
    resolveApproval: noopPromise,
    eventsVersion: 0,
    invalidateEvents: () => {},
  };
}
