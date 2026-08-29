import type { SupportCustomer, SupportCustomerDetail } from "../api/types.js";

/**
 * Deterministic fixture factories for Support console UI development.
 * Strictly local / in-memory. Zero real credentials, least-privilege diagnostics only.
 */

export function createSupportCustomersFixture(): SupportCustomer[] {
  return [
    {
      orgId: "org_acme_prod",
      slug: "acme-corp",
      displayName: "Acme Autonomous Corp",
      workspaceName: "Acme Production",
      createdAt: new Date(Date.now() - 3600000 * 24 * 180).toISOString(),
      memberCount: 14,
      users: [
        {
          userId: "usr_01",
          email: "alex@acme-ai.io",
          displayName: "Alex Rivera",
          role: "owner",
          disabledAt: null,
        },
        {
          userId: "usr_02",
          email: "elena@acme-ai.io",
          displayName: "Elena Rostova",
          role: "admin",
          disabledAt: null,
        },
      ],
      subscriptions: [
        {
          subscriptionId: "sub_scale_active",
          state: "active",
          plan: "scale",
          tier: "team",
          currentPeriodStart: new Date(Date.now() - 3600000 * 24 * 14).toISOString(),
          currentPeriodEnd: new Date(Date.now() + 3600000 * 24 * 16).toISOString(),
          trialEndsAt: null,
          graceEndsAt: null,
          retentionUntil: null,
          failedRenewals: 0,
          cancelAtPeriodEnd: false,
          suspensionReason: null,
          reconciliationRequired: false,
        },
      ],
      servers: [
        {
          id: "srv_vps_helsinki_01",
          orgId: "org_acme_prod",
          computeClassCode: "dedicated-cx41",
          state: "running",
          providerName: "Hetzner Cloud",
          regionCode: "eu-central-helsinki",
          lifecycle: { state: "running", attemptCount: 1, errorSummary: null },
          nodeHealth: { status: "healthy", version: "1.4.2", lastSeenAt: new Date(Date.now() - 12000).toISOString(), health: "nominal" },
          createdAt: new Date(Date.now() - 3600000 * 240).toISOString(),
          updatedAt: new Date(Date.now() - 60000).toISOString(),
        },
      ],
      agents: [
        {
          agentId: "agent_orchestrator",
          slug: "fleet-commander",
          displayName: "Cloud Fleet Commander",
          status: "active",
          currentVersion: 4,
          deploymentKind: "mox-cloud",
          deploymentState: "running",
          desiredRevision: 4,
          runtimeHealth: "healthy",
        },
        {
          agentId: "agent_researcher",
          slug: "deep-analyst",
          displayName: "Deep Research Specialist",
          status: "active",
          currentVersion: 2,
          deploymentKind: "mox-cloud",
          deploymentState: "running",
          desiredRevision: 2,
          runtimeHealth: "healthy",
        },
      ],
      supportNoteCount: 2,
      diagnostics: {
        subscriptionsRequiringAttention: 0,
        serversInError: 0,
        nodesStaleOrMissing: 0,
        agentsDegraded: 0,
        connectionsConfigured: 4,
        connectionsTotal: 4,
        recentNotificationFailures: 0,
      },
    },
    {
      orgId: "org_helios_ai",
      slug: "helios-labs",
      displayName: "Helios Neural Labs",
      workspaceName: "Helios Research",
      createdAt: new Date(Date.now() - 3600000 * 24 * 95).toISOString(),
      memberCount: 6,
      users: [
        {
          userId: "usr_hel_01",
          email: "dev@helios.ai",
          displayName: "Dr. Liam Scott",
          role: "owner",
          disabledAt: null,
        },
      ],
      subscriptions: [
        {
          subscriptionId: "sub_ent_01",
          state: "active",
          plan: "enterprise",
          tier: "dedicated",
          currentPeriodStart: new Date(Date.now() - 3600000 * 24 * 30).toISOString(),
          currentPeriodEnd: new Date(Date.now() + 3600000 * 24 * 335).toISOString(),
          trialEndsAt: null,
          graceEndsAt: null,
          retentionUntil: null,
          failedRenewals: 0,
          cancelAtPeriodEnd: false,
          suspensionReason: null,
          reconciliationRequired: false,
        },
      ],
      servers: [],
      agents: [],
      supportNoteCount: 1,
      diagnostics: {
        subscriptionsRequiringAttention: 0,
        serversInError: 0,
        nodesStaleOrMissing: 0,
        agentsDegraded: 0,
        connectionsConfigured: 2,
        connectionsTotal: 3,
        recentNotificationFailures: 0,
      },
    },
  ];
}

export function createSupportCustomerDetailFixture(orgId = "org_acme_prod"): SupportCustomerDetail {
  const customer = createSupportCustomersFixture().find((c) => c.orgId === orgId) ?? createSupportCustomersFixture()[0]!;

  return {
    orgId: customer.orgId,
    slug: customer.slug,
    displayName: customer.displayName,
    workspaceName: customer.workspaceName,
    createdAt: customer.createdAt,
    users: customer.users,
    subscriptions: customer.subscriptions,
    servers: customer.servers,
    agents: customer.agents,
    supportNotes: [
      {
        id: "note_001",
        actorId: "usr_support_rep",
        note: "Verified customer VPS firewall ingress rules. All agents communicating normally.",
        at: new Date(Date.now() - 3600000 * 48).toISOString(),
      },
      {
        id: "note_002",
        actorId: "usr_support_lead",
        note: "Customer inquired about dedicated BYO-metal clustering. Advised on requirements.",
        at: new Date(Date.now() - 3600000 * 12).toISOString(),
      },
    ],
    recentActivity: [
      {
        at: new Date(Date.now() - 3600000 * 2).toISOString(),
        action: "server.restart",
        actorType: "customer_owner",
        resourceType: "server",
      },
      {
        at: new Date(Date.now() - 3600000 * 16).toISOString(),
        action: "agent.deploy",
        actorType: "customer_admin",
        resourceType: "agent",
      },
    ],
    connections: {
      models: [
        { providerId: "anthropic", displayName: "Anthropic Claude", kind: "byok", status: "connected", credentialConfigured: true, connected: true },
        { providerId: "openai", displayName: "OpenAI GPT-4o", kind: "byok", status: "connected", credentialConfigured: true, connected: true },
      ],
      integrations: [
        { integrationId: "github", displayName: "GitHub Enterprise", kind: "vcs", status: "connected", credentialConfigured: true, connected: true },
        { integrationId: "slack", displayName: "Slack Alerts", kind: "communication", status: "connected", credentialConfigured: true, connected: true },
      ],
      channels: [
        {
          channelId: "chan_slack_ops",
          displayName: "Ops Alert Channel (#fleet-ops)",
          kind: "slack",
          status: "connected",
          credentialConfigured: true,
          connected: true,
          boundAgentId: "agent_orchestrator",
          boundAgentName: "Cloud Fleet Commander",
        },
      ],
    },
    notificationFailures: [],
    diagnostics: customer.diagnostics,
  };
}
