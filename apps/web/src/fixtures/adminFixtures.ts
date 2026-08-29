import type {
  AdminCompute,
  AdminCustomer,
  AdminEnterpriseContract,
  AdminIntelligence,
  AdminNotificationJobs,
  AdminOperations,
  AdminOverview,
  AdminPaymentProvider,
  AdminPlans,
  AdminRuntimeAgent,
  AdminStaff,
} from "../api/types.js";

/**
 * Deterministic fixture factories for Admin console UI development.
 * Strictly local / in-memory. Zero real secrets, no backend mutation.
 */

export function createAdminOverviewFixture(): AdminOverview {
  return {
    metrics: {
      customers: 142,
      activeSubscriptions: 118,
      paymentFailures: 0,
      activeServers: 326,
      serverProvisioningFailures: 0,
      runtimeAgentHealth: { total: 894, degraded: 0 },
      providerIncidents: 0,
      notifications: 2,
      abuse: 0,
      costMargin: { currency: "USD", revenueMinor: "4820000", costMinor: "1280000" },
    },
    incidents: [],
    notifications: [],
    abuse: [],
  };
}

export function createAdminCustomersFixture(): AdminCustomer[] {
  return [
    {
      orgId: "org_acme_prod",
      displayName: "Acme Autonomous Corp",
      slug: "acme-corp",
      workspaceName: "Acme Production",
      createdAt: new Date(Date.now() - 3600000 * 24 * 180).toISOString(),
      users: [],
      memberships: [],
      subscriptions: [],
      servers: [],
      agents: [],
      supportNotes: [
        {
          id: "note_01",
          actorId: "usr_admin_01",
          note: "Enterprise account onboarded with dedicated EU cluster.",
          at: new Date(Date.now() - 3600000 * 24 * 170).toISOString(),
        },
      ],
    },
    {
      orgId: "org_helios_ai",
      displayName: "Helios Neural Labs",
      slug: "helios-labs",
      workspaceName: "Helios Research",
      createdAt: new Date(Date.now() - 3600000 * 24 * 95).toISOString(),
      users: [],
      memberships: [],
      subscriptions: [],
      servers: [],
      agents: [],
      supportNotes: [],
    },
  ];
}

export function createAdminPlansFixture(): AdminPlans {
  return {
    products: [
      { id: "prod_starter", name: "Starter Pilot", code: "starter" },
      { id: "prod_scale", name: "Scale Team Plan", code: "scale" },
      { id: "prod_enterprise", name: "Enterprise Dedicated", code: "enterprise" },
    ],
    planVersions: [
      { id: "pv_scale_v1", productId: "prod_scale", name: "Scale Team Plan", tier: "pro", active: true },
    ],
    entitlementDefinitions: [],
    entitlementValues: [],
    currencies: [
      { code: "USD", displayName: "US Dollar", exponent: 2 },
      { code: "EUR", displayName: "Euro", exponent: 2 },
    ],
    pricingRegions: [
      { pricingRegionCode: "global", displayName: "Global Standard", available: true },
    ],
    priceBooks: [
      { id: "pb_default", name: "Global Standard 2026", currency: "USD", isDefault: true },
    ],
    priceVersions: [],
    addons: [],
  };
}

export function createAdminPaymentsFixture(): AdminPaymentProvider[] {
  return [
    {
      providerName: "stripe",
      displayName: "Stripe Billing",
      environment: "live",
      enabled: true,
      publicConfig: {},
      supportedCurrencies: ["USD", "EUR"],
      supportedRegions: ["global"],
      priority: 1,
      maintenanceMode: false,
      hasSecretRef: true,
      hasWebhookSecretRef: true,
      webhookStatus: "healthy",
      reconciliationStatus: "healthy",
      health: "healthy",
    },
    {
      providerName: "lemonsqueezy",
      displayName: "Lemon Squeezy",
      environment: "test",
      enabled: false,
      publicConfig: {},
      supportedCurrencies: ["USD"],
      supportedRegions: ["global"],
      priority: 2,
      maintenanceMode: false,
      hasSecretRef: false,
      hasWebhookSecretRef: false,
      webhookStatus: "not_configured",
      reconciliationStatus: "inactive",
      health: "degraded",
    },
  ];
}

export function createAdminComputeFixture(): AdminCompute {
  return {
    providers: ["hetzner", "aws"],
    accounts: [
      { id: "acc_hetzner_01", providerName: "hetzner", label: "Hetzner Cloud Fleet", status: "active" },
    ],
    classes: [
      { code: "dedicated-cx41", displayName: "CX41 — 4 vCPU / 16 GB RAM", providerName: "hetzner", hourlyCostMinor: 8, available: true },
    ],
    orders: [
      {
        orderId: "ord_hetzner_01",
        orgId: "org_acme_prod",
        customerName: "Acme Autonomous Corp",
        computeClassCode: "dedicated-cx41",
        state: "running",
        region: "eu-central-helsinki",
        createdAt: new Date(Date.now() - 3600000 * 240).toISOString(),
      },
    ],
    operations: [],
    nodes: [],
  };
}

export function createAdminIntelligenceFixture(): AdminIntelligence {
  return {
    providers: [
      {
        slug: "anthropic",
        displayName: "Anthropic Claude Models",
        kind: "llm",
        configured: true,
        baseUrlConfigured: false,
        settings: {},
        models: [{ id: "claude-3-7-sonnet", name: "Claude 3.7 Sonnet" }],
      },
      {
        slug: "openai",
        displayName: "OpenAI Models & Embeddings",
        kind: "llm",
        configured: true,
        baseUrlConfigured: false,
        settings: {},
        models: [{ id: "gpt-4o", name: "GPT-4o Omnimodel" }],
      },
      {
        slug: "deepseek",
        displayName: "DeepSeek Reasoning Engine",
        kind: "llm",
        configured: true,
        baseUrlConfigured: false,
        settings: {},
        models: [{ id: "deepseek-r1", name: "DeepSeek R1" }],
      },
    ],
  };
}

export function createAdminRuntimeFixture(): AdminRuntimeAgent[] {
  return [
    {
      agentId: "agent_orchestrator",
      orgId: "org_acme_prod",
      slug: "fleet-commander",
      displayName: "Cloud Fleet Commander",
      status: "active",
      deploymentState: "running",
      failures: [],
      lastHeartbeatAt: new Date(Date.now() - 5000).toISOString(),
    },
    {
      agentId: "agent_researcher",
      orgId: "org_acme_prod",
      slug: "deep-analyst",
      displayName: "Deep Research Specialist",
      status: "active",
      deploymentState: "running",
      failures: [],
      lastHeartbeatAt: new Date(Date.now() - 8000).toISOString(),
    },
  ];
}

export function createAdminOperationsFixture(): AdminOperations {
  return {
    jobs: [],
    queues: [],
    incidents: [],
    backups: [],
    abuse: [],
    audit: [],
    featureFlags: [
      { key: "mox.agent.subagents", orgId: "*", enabled: "true" },
      { key: "mox.vps.migration", orgId: "*", enabled: "true" },
    ],
    costLedger: [],
  };
}

export function createAdminNotificationsFixture(): AdminNotificationJobs {
  return {
    jobs: [
      {
        id: "job_weekly_digest_01",
        type: "weekly_summary",
        state: "completed",
        recipientsCount: 142,
        successCount: 142,
        failureCount: 0,
        createdAt: new Date(Date.now() - 3600000 * 48).toISOString(),
      },
    ],
    stats: { scheduled: 0, completed: 1, failed: 0 },
  };
}

export function createAdminEnterpriseContractsFixture(): AdminEnterpriseContract[] {
  return [
    {
      id: "ent_contract_01",
      contractRef: "ENT-2026-ACME",
      orgId: "org_acme_prod",
      orgName: "Acme Autonomous Corp",
      values: { customSla: "99.99%", nodeCount: 8 },
      active: true,
      effectiveFrom: "2026-01-01T00:00:00Z",
      createdAt: "2026-01-01T00:00:00Z",
      customPriceMinor: 3800000,
      currency: "USD",
    },
  ];
}

export function createAdminStaffFixture(): AdminStaff {
  return {
    members: [
      {
        userId: "usr_admin_01",
        email: "superadmin@mox.internal",
        displayName: "Chief Operator (Mox HQ)",
        role: "superadmin",
        surface: "admin",
        enabled: true,
        grantedByUserId: null,
        revokedAt: null,
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        userId: "usr_admin_02",
        email: "ops@mox.internal",
        displayName: "Cloud Ops Lead",
        role: "operator",
        surface: "admin",
        enabled: true,
        grantedByUserId: "usr_admin_01",
        revokedAt: null,
        createdAt: "2026-01-15T00:00:00Z",
      },
    ],
    invites: [],
  };
}
