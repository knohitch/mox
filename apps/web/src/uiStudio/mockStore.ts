import type { MoxStore } from "../api/store.js";
import type { ChatMessage, MoxApi } from "../api/types.js";
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

export type UiStudioSurface = "customer" | "admin" | "support";
export type UiStudioState = "populated" | "empty" | "loading" | "error" | "gated";

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
    listServers: async () => customerServers,
    serverAction: async () => ({ ok: true }),
    listDeployments: async () => customerDeployments,
    deployAgent: async () => ({ ok: true, state: "running" }),
    redeployDeployment: async () => ({ ok: true, state: "running" }),
    deploymentRollback: async () => ({ ok: true, state: "running" }),
    listModels: async () => (isEmpty ? [] : customerModels.models),
    testProviderConnection: async () => ({ ok: true }),
    listCliEngines: async () => [],
    listModelConnections: async () => (isEmpty ? [] : customerModels.connections),
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
    signIn: noopPromise,
    signUp: noopPromise,
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
