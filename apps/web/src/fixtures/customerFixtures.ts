import type { AgentDefinition, AgentDeployment, AgentRoom } from "@mox/contracts";
import type { MeResponse } from "@mox/control-plane-contracts";
import type {
  AgentSummary,
  BackupsOverview,
  ChannelCatalogRow,
  IntegrationCatalogRow,
  InvoiceRow,
  ModelConnectionRow,
  ModelOption,
  NotificationPreferencesView,
  PlanOption,
  ServerSummary,
  SubscriptionView,
  UsageDetails,
  UsageRow,
  WorkspaceTeamOverview,
} from "../api/types.js";

/**
 * Deterministic fixture factories for Customer dashboard UI development.
 * Strictly local / in-memory. Never imports production server authority.
 */

export function createCustomerUserFixture(): MeResponse {
  return {
    userId: "usr_fixture_001",
    email: "alex@acme-ai.io",
    displayName: "Alex Rivera",
    orgId: "org_acme_prod",
    orgSlug: "acme-corp",
    orgDisplayName: "Acme Autonomous Corp",
    role: "owner",
    orgs: [
      { orgId: "org_acme_prod", slug: "acme-corp", displayName: "Acme Autonomous Corp", role: "owner" },
      { orgId: "org_staging_lab", slug: "acme-staging", displayName: "Acme Staging Lab", role: "admin" },
    ],
  };
}

function mockAgentDef(agentId: string, name: string, role: string, description: string, provider: string, model: string): AgentDefinition {
  return {
    schemaVersion: 1,
    agentId: agentId as any,
    orgId: "org_acme_prod" as any,
    slug: agentId,
    identity: { displayName: name, role },
    instructions: { text: description },
    model: { providerId: provider as any, modelId: model as any },
    tools: { toolNames: ["vps-deploy" as any, "dns-sync" as any], integrations: [] },
    skills: [],
    knowledge: [],
    computer: { enabled: false, allowBrowser: true, sandbox: "container" },
    voice: { enabled: false },
    channels: [],
    deployment: { kind: "sandbox" },
    permissions: { toolPolicy: "default" as any },
    memory: { enabled: true, scope: "thread" as any },
    schedules: [],
    workflows: [],
    subagents: [],
    authoring: { mode: "simple" },
    metadata: {},
    createdAt: new Date(Date.now() - 3600000 * 24).toISOString(),
    updatedAt: new Date(Date.now() - 3600000 * 12).toISOString(),
  };
}

export function createCustomerAgentsFixture(): AgentSummary[] {
  return [
    {
      agentId: "agent_orchestrator",
      definition: mockAgentDef(
        "agent_orchestrator",
        "Cloud Fleet Commander",
        "Primary VPS & Infrastructure Coordinator",
        "Autonomous supervisor managing agent scaling, compute allocations, and cluster recovery.",
        "anthropic",
        "claude-3-7-sonnet",
      ),
      deploymentState: "running",
      runtimeStatus: "working",
      status: "active",
      currentVersion: 4,
      modelBadge: "Claude 3.7 Sonnet",
    },
    {
      agentId: "agent_researcher",
      definition: mockAgentDef(
        "agent_researcher",
        "Deep Research Specialist",
        "Synthetic Analyst",
        "Automated real-time technical analysis and documentation synthesizer.",
        "openai",
        "gpt-4o",
      ),
      deploymentState: "running",
      runtimeStatus: "idle",
      status: "active",
      currentVersion: 2,
      modelBadge: "GPT-4o",
    },
    {
      agentId: "agent_sentry",
      definition: mockAgentDef(
        "agent_sentry",
        "Security & Drift Sentry",
        "Compliance Sentinel",
        "Continuously inspects runtime processes and enforces least-privilege security.",
        "deepseek",
        "deepseek-r1",
      ),
      deploymentState: "running",
      runtimeStatus: "working",
      status: "active",
      currentVersion: 1,
      modelBadge: "DeepSeek R1",
    },
  ];
}

export function createCustomerRoomsFixture(): AgentRoom[] {
  return [
    {
      roomId: "room_incident_response" as any,
      orgId: "org_acme_prod" as any,
      title: "Incident Response Room",
      memberAgentIds: ["agent_orchestrator" as any, "agent_sentry" as any],
      memberUserIds: ["usr_fixture_001" as any],
      createdAt: new Date(Date.now() - 3600000 * 24).toISOString(),
    },
    {
      roomId: "room_model_benchmarks" as any,
      orgId: "org_acme_prod" as any,
      title: "Model Performance Benchmarks",
      memberAgentIds: ["agent_researcher" as any],
      memberUserIds: ["usr_fixture_001" as any],
      createdAt: new Date(Date.now() - 3600000 * 48).toISOString(),
    },
  ];
}

export function createCustomerServersFixture(): ServerSummary[] {
  return [
    {
      serverId: "srv_vps_helsinki_01",
      orderId: "ord_hetzner_01",
      displayName: "VPS Cluster Primary — Helsinki CX41",
      kind: "mox-cloud",
      computeClass: "dedicated-cx41",
      region: "eu-central-helsinki",
      state: "running",
      agentsRunning: 2,
      cpuPct: 18,
      memPct: 42,
      createdAt: new Date(Date.now() - 3600000 * 240).toISOString(),
      updatedAt: new Date(Date.now() - 60000).toISOString(),
    },
    {
      serverId: "srv_vps_ashburn_02",
      orderId: "ord_ashburn_02",
      displayName: "Worker Node 02 — US-East Dedicated",
      kind: "customer-vps",
      computeClass: "byo-metal",
      region: "us-east-ashburn",
      state: "running",
      agentsRunning: 1,
      cpuPct: 8,
      memPct: 24,
      createdAt: new Date(Date.now() - 3600000 * 120).toISOString(),
      updatedAt: new Date(Date.now() - 120000).toISOString(),
    },
  ];
}

export function createCustomerDeploymentsFixture(): AgentDeployment[] {
  return [
    {
      deploymentId: "dep_orch_prod" as any,
      orgId: "org_acme_prod" as any,
      agentId: "agent_orchestrator" as any,
      versionId: "ver_orch_4" as any,
      revision: 4,
      state: "running",
      target: { kind: "mox-cloud" },
      createdAt: new Date(Date.now() - 3600000 * 12).toISOString(),
      updatedAt: new Date(Date.now() - 3600000 * 12).toISOString(),
    } as unknown as AgentDeployment,
    {
      deploymentId: "dep_res_prod" as any,
      orgId: "org_acme_prod" as any,
      agentId: "agent_researcher" as any,
      versionId: "ver_res_2" as any,
      revision: 2,
      state: "running",
      target: { kind: "mox-cloud" },
      createdAt: new Date(Date.now() - 3600000 * 36).toISOString(),
      updatedAt: new Date(Date.now() - 3600000 * 36).toISOString(),
    } as unknown as AgentDeployment,
  ];
}

export function createCustomerModelsFixture(): { models: ModelOption[]; connections: ModelConnectionRow[] } {
  return {
    models: [
      { modelId: "anthropic/claude-3-7-sonnet", providerId: "anthropic", displayName: "Claude 3.7 Sonnet", byok: true, available: true },
      { modelId: "openai/gpt-4o", providerId: "openai", displayName: "GPT-4o Omnimodel", byok: true, available: true },
      { modelId: "deepseek/deepseek-r1", providerId: "deepseek", displayName: "DeepSeek R1", byok: false, available: true },
    ],
    connections: [
      {
        providerId: "anthropic",
        displayName: "Anthropic",
        kind: "byok",
        status: "connected",
        credentialConfigured: true,
        connected: true,
        authMethods: ["api_key"],
        baseUrlSupported: false,
        baseUrl: null,
        modelCount: 2,
      },
      {
        providerId: "openai",
        displayName: "OpenAI",
        kind: "byok",
        status: "connected",
        credentialConfigured: true,
        connected: true,
        authMethods: ["api_key"],
        baseUrlSupported: true,
        baseUrl: "https://api.openai.com/v1",
        modelCount: 2,
      },
    ],
  };
}

export function createCustomerIntegrationsFixture(): IntegrationCatalogRow[] {
  return [
    {
      integrationId: "github",
      displayName: "GitHub Enterprise",
      kind: "vcs",
      connectionId: "conn_github",
      status: "connected",
      credentialConfigured: true,
      connected: true,
      requiresRuntimeSession: false,
      dangerous: false,
      tools: ["vcs-read", "vcs-write"],
      configFields: [],
    },
    {
      integrationId: "slack",
      displayName: "Slack Bot Integration",
      kind: "communication",
      connectionId: "conn_slack",
      status: "connected",
      credentialConfigured: true,
      connected: true,
      requiresRuntimeSession: false,
      dangerous: false,
      tools: ["chat-post", "channel-list"],
      configFields: [],
    },
    {
      integrationId: "postgres",
      displayName: "PostgreSQL Gateway",
      kind: "database",
      connectionId: null,
      status: "available",
      credentialConfigured: false,
      connected: false,
      requiresRuntimeSession: true,
      dangerous: false,
      tools: ["sql-query"],
      configFields: [],
    },
  ];
}

export function createCustomerChannelsFixture(): ChannelCatalogRow[] {
  return [
    {
      channelId: "chan_slack_ops",
      displayName: "Ops Alert Channel (#fleet-ops)",
      kind: "slack",
      setupInstructions: "Authorize Slack workspace and bind bot user.",
      prerequisites: null,
      secretKeys: ["bot_token", "app_token"],
      connectionId: "conn_chan_slack",
      status: "connected",
      credentialConfigured: true,
      connected: true,
      boundAgentId: "agent_orchestrator",
      boundAgentName: "Cloud Fleet Commander",
    },
    {
      channelId: "chan_discord_community",
      displayName: "Community Help Desk",
      kind: "discord",
      setupInstructions: "Invite Mox Bot into target Discord server.",
      prerequisites: null,
      secretKeys: ["bot_token"],
      connectionId: null,
      status: "available",
      credentialConfigured: false,
      connected: false,
      boundAgentId: null,
      boundAgentName: null,
    },
  ];
}

export function createCustomerUsageFixture(): { rows: UsageRow[]; details: UsageDetails } {
  return {
    rows: [
      { metric: "LLM Input Tokens", quantity: 2450000, unit: "tokens" },
      { metric: "LLM Output Tokens", quantity: 512000, unit: "tokens" },
      { metric: "VPS Compute Hours", quantity: 142, unit: "hours" },
    ],
    details: {
      period: {
        start: new Date(Date.now() - 3600000 * 24 * 14).toISOString(),
        end: new Date(Date.now() + 3600000 * 24 * 16).toISOString(),
      },
      metrics: [
        {
          kind: "tokens",
          metric: "LLM Tokens",
          quantity: 2450000,
          unit: "tokens",
          includedQuantity: 10000000,
          remaining: 7550000,
          unlimited: false,
          status: "within_included",
        },
        {
          kind: "compute",
          metric: "VPS Compute Time",
          quantity: 142,
          unit: "hours",
          includedQuantity: 500,
          remaining: 358,
          unlimited: false,
          status: "within_included",
        },
      ],
      credits: {
        included: 100,
        consumed: 24.5,
        remaining: 75.5,
      },
    },
  };
}

export function createCustomerBillingFixture(): {
  plans: PlanOption[];
  subscription: SubscriptionView;
  invoices: InvoiceRow[];
} {
  return {
    plans: [
      {
        planVersionId: "pv_scale_v1",
        tier: "pro",
        name: "Scale Team Plan",
        features: { max_agents: 10, compute_hours: 500 },
        pricingRegions: [
          {
            pricingRegionCode: "global",
            displayName: "Global Standard",
            available: true,
            currency: "USD",
            amountMinor: 24900,
          },
        ],
        available: true,
      },
    ],
    subscription: {
      id: "sub_scale_active",
      planVersionId: "pv_scale_v1",
      state: "active",
      cancelAtPeriodEnd: false,
      reconciliationRequired: false,
      plan: { planVersionId: "pv_scale_v1", version: 1, tier: "pro", name: "Scale Team Plan" },
      commercialAccess: { entitled: true },
      cancellation: null,
      currentPeriodStart: new Date(Date.now() - 3600000 * 24 * 14).toISOString(),
      currentPeriodEnd: new Date(Date.now() + 3600000 * 24 * 16).toISOString(),
    },
    invoices: [
      {
        invoiceId: "inv_2026_02",
        periodStart: new Date(Date.now() - 3600000 * 24 * 30).toISOString(),
        periodEnd: new Date(Date.now()).toISOString(),
        amountCents: 24900,
        currency: "USD",
        state: "paid",
      },
    ],
  };
}

export function createCustomerBackupsFixture(): BackupsOverview {
  return {
    availability: true,
    retentionDays: 30,
    lastSuccessfulAt: new Date(Date.now() - 3600000 * 4).toISOString(),
    failedCount: 0,
    backups: [
      {
        backupId: "bak_snap_20260228",
        serverOrderId: "ord_hetzner_01",
        kind: "provider_snapshot",
        state: "completed",
        sizeBytes: 1024 * 1024 * 1420,
        createdAt: new Date(Date.now() - 3600000 * 4).toISOString(),
        completedAt: new Date(Date.now() - 3600000 * 3.8).toISOString(),
        locationLabel: "Helsinki DC (Automated Snapshot)",
      },
      {
        backupId: "bak_s3_archive_20260227",
        serverOrderId: "ord_hetzner_01",
        kind: "s3_copy",
        state: "completed",
        sizeBytes: 1024 * 1024 * 1380,
        createdAt: new Date(Date.now() - 3600000 * 28).toISOString(),
        completedAt: new Date(Date.now() - 3600000 * 27.5).toISOString(),
        locationLabel: "Mox Cold Vault (S3 Glacier)",
      },
    ],
    cancellationExportSummary: {
      eligible: true,
      retentionWindowDays: 30,
      description: "Full snapshot and agent code state is kept for 30 days after cancellation.",
    },
  };
}

export function createCustomerTeamFixture(): WorkspaceTeamOverview {
  return {
    totalUsed: 3,
    limit: 10,
    members: [
      {
        id: "mem_01",
        userId: "usr_01",
        email: "alex@acme-ai.io",
        displayName: "Alex Rivera",
        role: "owner",
        isOwner: true,
        createdAt: new Date(Date.now() - 3600000 * 24 * 90).toISOString(),
      },
      {
        id: "mem_02",
        userId: "usr_02",
        email: "elena@acme-ai.io",
        displayName: "Elena Rostova",
        role: "admin",
        isOwner: false,
        createdAt: new Date(Date.now() - 3600000 * 24 * 45).toISOString(),
      },
      {
        id: "mem_03",
        userId: "usr_03",
        email: "marcus@acme-ai.io",
        displayName: "Marcus Vance",
        role: "member",
        isOwner: false,
        createdAt: new Date(Date.now() - 3600000 * 24 * 10).toISOString(),
      },
    ],
    invitations: [],
  };
}

export function createCustomerNotificationsFixture(): NotificationPreferencesView {
  return {
    availableRoutes: ["in_app", "email", "web_push"],
    items: [
      {
        eventType: "server.down",
        title: "Server Down & Unreachable",
        category: "servers",
        mandatory: true,
        routes: ["in_app", "email"],
        muted: false,
      },
      {
        eventType: "agent.error",
        title: "Agent Execution Failure",
        category: "agents",
        mandatory: false,
        routes: ["in_app", "email"],
        muted: false,
      },
      {
        eventType: "billing.invoice",
        title: "Invoice Generated & Charge Success",
        category: "billing",
        mandatory: true,
        routes: ["in_app", "email"],
        muted: false,
      },
    ],
  };
}
