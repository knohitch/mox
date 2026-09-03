import { useCallback, useEffect, useState } from "react";
import { useTheme } from "../ui/theme.js";
import { useMox } from "../api/store.js";
import { useAgentRooms, useModelConnections, useEntitlements } from "../api/store.js";
import { CANONICAL_ENTITLEMENT_KEYS } from "../api/entitlement.js";
import { Avatar, Badge, Button, DataTable, EmptyState, ErrorState, GatedState, KpiCard, LoadingState, Modal, PageHeader, Panel, StatusIndicator } from "../ui/primitives.js";
import { Link } from "../router.js";
import { buildAttentionItems, buildOpsSnapshot, isNewWorkspace } from "../domain/ops-dashboard.js";
import { resolveWebConfig } from "../config.js";
import type { AgentDeployment, AgentRoom } from "@mox/contracts";
import type {
  AgentSummary,
  AgentVersionRow,
  ApiTokenRow,
  BackupsOverview,
  BillingProviderOption,
  ChannelCatalogRow,
  CreatedApiTokenView,
  CreatedWorkspaceInvitation,
  IntegrationCatalogRow,
  KnowledgeSourceItem,
  ModelConnectionRow,
  NotificationPreferencesView,
  PlanOption,
  ProvisionOptions,
  ServerSummary,
  StoredBackupSummary,
  SubscriptionView,
  ToolGrantRow,
  UsageDetails,
  WorkspaceMemberView,
  WorkspaceTeamOverview,
} from "../api/types.js";

import type { AgentStatus } from "../domain/roster.js";
import { channelState, integrationState, kindLabel, modelConnectionState, stateLabel } from "../domain/connections.js";
import { WorkspaceSetupCard } from "./WorkspaceSetupCard.js";
import { bestPlanPrice, commercialStatus, moneyMinorToDisplay } from "../domain/billing.js";

const statusTone = (s: string | undefined): "good" | "warn" | "bad" | "accent" | "neutral" => {
  if (!s) return "neutral";
  const v = s.toLowerCase();
  if (["running", "active", "healthy", "idle", "provisioned", "online", "live"].some((x) => v.includes(x))) return "good";
  if (["degraded", "provisioning", "pending", "busy", "working", "open", "stopping"].some((x) => v.includes(x))) return "warn";
  if (["failed", "error", "suspended", "stopped", "offline", "denied"].some((x) => v.includes(x))) return "bad";
  return "neutral";
};

function humanState(state: string | undefined): string {
  return (state ?? "n/a").replace(/[_-]/g, " ");
}

/** Render telemetry that may be explicitly unavailable (Phase 01 §C). */
function telemetry(value: number | null | undefined, unit?: string): string {
  if (value === null || value === undefined) return "unavailable";
  return `${String(value)}${unit ?? ""}`;
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

// ----------------------------------------------------------------------------
// Home — operational overview from authoritative API data only.
// ----------------------------------------------------------------------------

export function HomeView() {
  const mox = useMox();
  const [servers, setServers] = useState<Awaited<ReturnType<typeof mox.api.listServers>>>([]);
  const [deployments, setDeployments] = useState<AgentDeployment[]>([]);
  const [usage, setUsage] = useState<Awaited<ReturnType<typeof mox.api.getUsage>>>([]);
  const [modelConnections, setModelConnections] = useState<ModelConnectionRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"overview" | "agents" | "deployments" | "infrastructure" | "approvals">("overview");

  useEffect(() => {
    void Promise.all([
      mox.api.listServers(),
      mox.api.listDeployments(),
      mox.api.getUsage(),
      mox.api.listModelConnections().catch(() => [] as ModelConnectionRow[]),
    ])
      .then(([s, d, u, m]) => {
        setServers(s);
        setDeployments(d);
        setUsage(u);
        setModelConnections(m);
      })
      .catch((e: unknown) => setLoadError(e instanceof Error ? e.message : String(e)));
  }, [mox.api]);

  const agents = mox.agents;
  const snapshot = buildOpsSnapshot({
    agents,
    deployments,
    servers,
    approvals: mox.approvals,
    commerciallyEntitled: mox.entitlements?.commerciallyEntitled,
  });
  const attention = buildAttentionItems({
    snapshot,
    failedDeploymentLabels: deployments.filter((d) => /fail|error/i.test(d.state ?? "")).map((d) => d.agentId ?? d.deploymentId),
    degradedServerLabels: servers.filter((row) => /fail|error|degrad|stop|offline/i.test(row.state ?? "")).map((row) => row.displayName || row.serverId),
  });

  const fresh = isNewWorkspace(snapshot);
  const workspaceName = mox.me?.orgDisplayName || "Workspace";
  const userGreeting = greeting();
  const userName = mox.me?.displayName || "Operator";

  // Calculate cluster health
  const totalNodes = snapshot.serverCount;
  const healthyNodes = snapshot.healthyServers;
  const clusterAvailability = totalNodes > 0
    ? Math.round((healthyNodes / totalNodes) * 100)
    : 100;
  const isHealthy = snapshot.failedDeployments === 0 && snapshot.degradedServers === 0;

  // Authoritative AI Usage primary & secondary metrics
  const tokenRow = usage.find((r) => /input token/i.test(r.metric)) || usage.find((r) => /token/i.test(r.metric)) || usage[0];
  const primaryUsageValue = tokenRow
    ? tokenRow.quantity >= 1_000_000
      ? `${(tokenRow.quantity / 1_000_000).toFixed(2)}M`
      : tokenRow.quantity >= 1_000
      ? `${(tokenRow.quantity / 1_000).toFixed(1)}K`
      : String(tokenRow.quantity)
    : "0";
  const primaryUsageLabel = tokenRow ? humanState(tokenRow.metric) : "Tokens Used";

  const secondaryUsageTokens = usage.filter((r) => r !== tokenRow);
  const secondaryUsageContext = secondaryUsageTokens.length > 0
    ? secondaryUsageTokens.map((r) => `${r.quantity >= 1_000 ? `${Math.round(r.quantity / 1000)}k` : r.quantity} ${r.unit}`).join(" · ")
    : "Current billing period";

  const validationApprovals = mox.approvals;

  return (
    <div className="home-dashboard">
      {/* LEVEL 1: Primary Workspace Header */}
      <header className="dashboard-header">
        <div className="dashboard-header-main">
          <h1>{userGreeting}, {userName}</h1>
          <p className="dashboard-header-sub">
            <span className="workspace-name">{workspaceName}</span>
            <span className="sub-separator">·</span>
            {mox.entitlements?.commerciallyEntitled ? (
              <span className="plan-badge plan-badge-active">Enterprise Tier</span>
            ) : (
              <span className="plan-badge plan-badge-standard">Standard Plan</span>
            )}
          </p>
        </div>
        <div className="dashboard-header-actions">
          <Link to="/agents">
            <Button kind="primary">+ Create Agent</Button>
          </Link>
          <Link to="/servers">
            <Button kind="ghost">Provision Server</Button>
          </Link>
        </div>
      </header>

      {loadError ? (
        <ErrorState message={`Some summary data is unavailable right now: ${loadError}`} onRetry={() => window.location.reload()} />
      ) : null}

      {/* Post-onboarding setup guidance — real resource state, never the wizard. */}
      <WorkspaceSetupCard />

      {/* LEVEL 2: Operational Overview */}
      <section className="dashboard-overview" aria-label="Operational overview">

        {/* ROW 1: Four separate stat cards */}
        <div className="ops-kpi-row">
          <div className="ops-card ops-kpi-card">
            <div className="ops-kpi-num">{snapshot.agentCount}</div>
            <div className="ops-kpi-label">Agents</div>
            <div className="ops-kpi-hint">{snapshot.runningAgents} active</div>
          </div>
          <div className="ops-card ops-kpi-card">
            <div className="ops-kpi-num">{snapshot.deploymentCount}</div>
            <div className="ops-kpi-label">Deployments</div>
            <div className={`ops-kpi-hint ${snapshot.failedDeployments ? "hint-bad" : ""}`}>
              {snapshot.failedDeployments ? `${snapshot.failedDeployments} failed` : "healthy"}
            </div>
          </div>
          <div className="ops-card ops-kpi-card">
            <div className="ops-kpi-num">{snapshot.serverCount}</div>
            <div className="ops-kpi-label">Servers</div>
            <div className="ops-kpi-hint">{snapshot.healthyServers} healthy</div>
          </div>
          <div className="ops-card ops-kpi-card">
            <div className="ops-kpi-num">{snapshot.openApprovals}</div>
            <div className="ops-kpi-label">Approvals</div>
            <div className={`ops-kpi-hint ${snapshot.openApprovals ? "hint-warn" : ""}`}>
              {snapshot.openApprovals ? "waiting" : "all clear"}
            </div>
          </div>
        </div>

        {/* ROW 2: Infrastructure Health (wide left) + AI Usage / Needs Attention (stacked right) */}
        <div className="ops-detail-row">
          {/* Left: Infrastructure Health */}
          <div className="ops-card ops-infra-panel">
            <div className="ops-card-head">
              <div className="ops-card-title">
                <span className="ops-icon-dot" aria-hidden>🖥</span>
                <span>Infrastructure Health</span>
              </div>
              <Link to="/servers" className="ops-card-action">
                View servers →
              </Link>
            </div>

            <div className="ops-infra-content">
              {servers.length === 0 ? (
                <div className="ops-infra-empty-state">
                  <p className="muted">No servers provisioned for this workspace.</p>
                  <Link to="/servers">
                    <Button size="sm">Provision Server</Button>
                  </Link>
                </div>
              ) : (
                <div className="ops-infra-node-list">
                  {servers.slice(0, 2).map((srv) => (
                    <div key={srv.serverId} className="ops-infra-node-row">
                      <div className="node-primary-col">
                        <div className="node-title-wrap">
                          <strong className="node-name">{srv.displayName || srv.serverId}</strong>
                          <Badge tone={statusTone(srv.state)}>{humanState(srv.state)}</Badge>
                        </div>
                        <div className="node-meta-line muted">
                          <span>{srv.computeClass || srv.kind}</span>
                          <span>·</span>
                          <span>{srv.region}</span>
                          {srv.agentsRunning !== null && srv.agentsRunning !== undefined ? (
                            <>
                              <span>·</span>
                              <span>{srv.agentsRunning} running</span>
                            </>
                          ) : null}
                        </div>
                      </div>
                      <div className="node-telemetry-col">
                        <span className="telemetry-tag">Telemetry</span>
                        <span className="telemetry-value mono">
                          {srv.cpuPct !== null && srv.memPct !== null
                            ? `${srv.cpuPct}% CPU · ${srv.memPct}% RAM`
                            : "Unavailable"}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div className="ops-infra-footer-strip">
                <span className="footer-strip-label">Model Providers:</span>
                {modelConnections.length > 0 ? (
                  <div className="footer-strip-items">
                    {modelConnections.slice(0, 3).map((conn) => (
                      <span key={conn.providerId} className="model-chip">
                        <span className={`status-dot status-${conn.status === "connected" ? "healthy" : "offline"}`} />
                        <span>{conn.displayName}</span>
                      </span>
                    ))}
                  </div>
                ) : (
                  <span className="muted footer-strip-hint">No external model connections configured</span>
                )}
              </div>
            </div>

            <div className="ops-health-row">
              <div className="ops-health-meta">
                <span>Cluster Availability</span>
                <span className="ops-health-pct mono">{clusterAvailability}%</span>
              </div>
              <div className="ops-health-track">
                <div
                  className={`ops-health-bar ${isHealthy ? "bar-good" : "bar-warn"}`}
                  style={{ width: `${clusterAvailability}%` }}
                />
              </div>
            </div>
          </div>

          {/* Right: AI Usage + Needs Attention stacked */}
          <div className="ops-stacked-column">
            {/* Card: AI Usage / Credits */}
            <div className="ops-card ops-mini-card ops-usage-card">
              <div className="ops-card-head">
                <span className="ops-mini-label">AI Usage</span>
                <span className="ops-mini-tag">Tokens</span>
              </div>
              <div className="ops-usage-body">
                <div className="ops-usage-value mono">{primaryUsageValue}</div>
                <div className="ops-usage-name">{primaryUsageLabel}</div>
              </div>
              <div className="ops-usage-context muted">{secondaryUsageContext}</div>
            </div>

            {/* Card: Needs Attention */}
            <div className="ops-card ops-mini-card ops-attention-card">
              <div className="ops-card-head">
                <span className="ops-mini-label">Needs Attention</span>
                {attention.length > 0 ? (
                  <span className="attention-badge attention-active">{attention.length} Action</span>
                ) : (
                  <span className="attention-badge attention-clear">✓ Normal</span>
                )}
              </div>
              {attention.length > 0 ? (
                <div className="ops-attention-body">
                  <div className="ops-attention-items">
                    {attention.slice(0, 2).map((item) => (
                      <Link key={item.id} to={item.href} className="ops-attention-row">
                        <span className={`attention-dot dot-${item.tone}`} />
                        <span className="ops-attention-text">{item.title}</span>
                        <span className="ops-attention-arrow">→</span>
                      </Link>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="ops-attention-body ops-attention-empty">
                  <span className="clear-icon" aria-hidden>✓</span>
                  <span className="clear-text">All systems operational</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* LEVEL 3: Primary Dashboard Work Area */}
      <div className="dashboard-subnav-row">
        <div className="subnav-tabs" role="tablist" aria-label="Dashboard sections">
          <button
            type="button"
            className={`subnav-btn ${activeTab === "overview" ? "active" : ""}`}
            onClick={() => setActiveTab("overview")}
          >
            Overview
          </button>
          <button
            type="button"
            className={`subnav-btn ${activeTab === "agents" ? "active" : ""}`}
            onClick={() => setActiveTab("agents")}
          >
            Agents ({snapshot.agentCount})
          </button>
          <button
            type="button"
            className={`subnav-btn ${activeTab === "deployments" ? "active" : ""}`}
            onClick={() => setActiveTab("deployments")}
          >
            Deployments ({snapshot.deploymentCount})
          </button>
          <button
            type="button"
            className={`subnav-btn ${activeTab === "infrastructure" ? "active" : ""}`}
            onClick={() => setActiveTab("infrastructure")}
          >
            Infrastructure ({snapshot.serverCount})
          </button>
          <button
            type="button"
            className={`subnav-btn ${activeTab === "approvals" ? "active" : ""}`}
            onClick={() => setActiveTab("approvals")}
          >
            Approvals ({snapshot.openApprovals})
          </button>
        </div>
        <div className="subnav-actions">
          <Link to="/agents">
            <Button size="sm" kind="primary">+ Create Agent</Button>
          </Link>
        </div>
      </div>

      {/* Sub-nav Tab Content */}
      {activeTab === "overview" ? (
        fresh ? (
          <Panel title="Get started" subtitle="This workspace has no agents or infrastructure yet.">
            <div className="getting-started">
              <Link to="/agents"><strong>Create an agent</strong><small>Define instructions, model, and tools.</small></Link>
              <Link to="/models"><strong>Connect a model</strong><small>Bring your own provider key.</small></Link>
              <Link to="/servers"><strong>Provision a server</strong><small>Give agents a runtime target.</small></Link>
            </div>
          </Panel>
        ) : (
          <div className="dashboard-work-grid">
            {/* Active Agents */}
            <Panel
              title="Active Agents"
              subtitle="Roster agents ready for work or currently executing."
              actions={<Link to="/agents" className="panel-action-link">View all agents →</Link>}
            >
              {agents.length === 0 ? (
                <EmptyState title="No agents" action={<Link to="/agents"><Button kind="primary" size="sm">Create agent</Button></Link>}>
                  Create an agent to start autonomous work.
                </EmptyState>
              ) : (
                <div className="work-list">
                  {agents.slice(0, 5).map((agent) => (
                    <div className="work-row" key={agent.agentId}>
                      <Avatar slug={agent.agentId} name={agent.definition.identity.displayName} size={32} />
                      <div className="meta">
                        <div className="name">{agent.definition.identity.displayName}</div>
                        <div className="muted">{agent.modelBadge || agent.definition.model.modelId}</div>
                      </div>
                      <Badge tone={statusTone(agent.runtimeStatus || agent.deploymentState)}>
                        {humanState(agent.runtimeStatus || agent.deploymentState || agent.status)}
                      </Badge>
                    </div>
                  ))}
                </div>
              )}
            </Panel>

            {/* Recent Deployments */}
            <Panel
              title="Recent Deployments"
              subtitle="Deployment states across dedicated VPS and sandboxes."
              actions={<Link to="/deployments" className="panel-action-link">View deployments →</Link>}
            >
              {deployments.length === 0 ? (
                <EmptyState title="No deployments yet">Deploy an agent to track deployment status.</EmptyState>
              ) : (
                <DataTable
                  head={[
                    { key: "agentId", label: "Agent", render: (r) => agentName(agents, r.agentId) },
                    { key: "revision", label: "Version", render: (r) => humanState(r.versionId) },
                    { key: "target", label: "Target", render: (r) => humanState(r.target?.kind) },
                    { key: "state", label: "State", render: (r) => <Badge tone={statusTone(r.state)}>{humanState(r.state)}</Badge> },
                    { key: "updatedAt", label: "Updated", render: (r) => r.updatedAt ? new Date(r.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—" },
                  ]}
                  rows={deployments.slice(0, 5)}
                />
              )}
            </Panel>

            {/* Infrastructure Nodes */}
            <Panel
              title="Infrastructure Telemetry"
              subtitle="Cluster compute classes and runtime target health."
              actions={<Link to="/servers" className="panel-action-link">Manage servers →</Link>}
            >
              {servers.length === 0 ? (
                <EmptyState title="No servers">Provision a server to host dedicated agent sandboxes.</EmptyState>
              ) : (
                <DataTable
                  head={[
                    { key: "name", label: "Server", render: (r) => r.displayName || r.serverId },
                    { key: "computeClass", label: "Compute Class", render: (r) => r.computeClass || r.kind },
                    { key: "state", label: "Status", render: (r) => <Badge tone={statusTone(r.state)}>{humanState(r.state)}</Badge> },
                    { key: "telemetry", label: "Telemetry", render: (r) => r.cpuPct !== null && r.memPct !== null ? `${r.cpuPct}% CPU · ${r.memPct}% RAM` : "Unavailable" },
                  ]}
                  rows={servers.slice(0, 4)}
                />
              )}
            </Panel>

            {/* Pending Approvals & Actionable Items */}
            <Panel
              title="Approvals & Attention"
              subtitle="Execution gates and permission requests waiting for your decision."
            >
              {validationApprovals.length === 0 && attention.length === 0 ? (
                <div className="approvals-all-clear">
                  <span className="approvals-check-icon">✓</span>
                  <div>
                    <strong>No approvals waiting</strong>
                    <p className="muted">All current agent actions can proceed without human intervention.</p>
                  </div>
                </div>
              ) : (
                <div className="approvals-work-list">
                  {validationApprovals.map((ap) => (
                    <div key={ap.approvalId} className="approval-card">
                      <div className="approval-head">
                        <strong>{ap.summary || "Human Gate Approval"}</strong>
                        <Badge tone="warn">Action Required</Badge>
                      </div>
                      <p className="approval-desc muted">{ap.summary || "An agent requires human authorization to proceed."}</p>
                      <div className="approval-actions">
                        <Button kind="primary" size="sm" onClick={() => void mox.resolveApproval(ap.approvalId, "approved")}>
                          Approve
                        </Button>
                        <Button kind="danger" size="sm" onClick={() => void mox.resolveApproval(ap.approvalId, "denied")}>
                          Deny
                        </Button>
                      </div>
                    </div>
                  ))}
                  {attention.filter(item => item.id !== "approvals").map((item) => (
                    <Link key={item.id} to={item.href} className="attention-item">
                      <div>
                        <strong>{item.title}</strong>
                        <span>{item.detail}</span>
                      </div>
                      <Badge tone={item.tone}>{item.tone === "bad" ? "Action" : "Review"}</Badge>
                    </Link>
                  ))}
                </div>
              )}
            </Panel>
          </div>
        )
      ) : activeTab === "agents" ? (
        <Panel
          title="Agent Roster"
          subtitle="All autonomous agents configured in this workspace."
          actions={<Link to="/agents"><Button kind="primary" size="sm">+ Create Agent</Button></Link>}
        >
          {agents.length === 0 ? (
            <EmptyState title="No agents">Create an agent to get started.</EmptyState>
          ) : (
            <DataTable
              head={[
                { key: "agent", label: "Agent", render: (r) => (
                  <div className="agent-table-cell" style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <Avatar slug={r.agentId} name={r.definition.identity.displayName} size={28} />
                    <span>{r.definition.identity.displayName}</span>
                  </div>
                )},
                { key: "model", label: "Model", render: (r) => r.modelBadge || r.definition.model.modelId },
                { key: "status", label: "Status", render: (r) => <Badge tone={statusTone(r.runtimeStatus || r.deploymentState)}>{humanState(r.runtimeStatus || r.deploymentState || r.status)}</Badge> },
                { key: "version", label: "Version", render: (r) => `rev ${r.currentVersion}` },
                { key: "actions", label: "", render: (r) => <Link to={`/agents?agentId=${r.agentId}`} className="linklike">Open →</Link> },
              ]}
              rows={agents}
            />
          )}
        </Panel>
      ) : activeTab === "deployments" ? (
        <Panel
          title="Deployments"
          subtitle="Release revisions deployed to sandboxes and production infrastructure."
          actions={<Link to="/deployments"><Button size="sm">Manage Deployments</Button></Link>}
        >
          {deployments.length === 0 ? (
            <EmptyState title="No deployments">No deployments have been created yet.</EmptyState>
          ) : (
            <DataTable
              head={[
                { key: "agentId", label: "Agent", render: (r) => agentName(agents, r.agentId) },
                { key: "revision", label: "Revision", render: (r) => humanState(r.versionId) },
                { key: "target", label: "Target", render: (r) => humanState(r.target?.kind) },
                { key: "state", label: "State", render: (r) => <Badge tone={statusTone(r.state)}>{humanState(r.state)}</Badge> },
                { key: "updatedAt", label: "Updated", render: (r) => r.updatedAt ? new Date(r.updatedAt).toLocaleString() : "—" },
              ]}
              rows={deployments}
            />
          )}
        </Panel>
      ) : activeTab === "infrastructure" ? (
        <Panel
          title="Infrastructure & Models"
          subtitle="Provisioned servers, BYOK model providers, and compute classes."
          actions={<Link to="/servers"><Button size="sm">Provision Server</Button></Link>}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <div>
              <h4 style={{ margin: "0 0 8px", fontSize: 13, color: "#94a3b8" }}>Server Clusters</h4>
              {servers.length === 0 ? (
                <EmptyState title="No servers">No servers provisioned.</EmptyState>
              ) : (
                <DataTable
                  head={[
                    { key: "name", label: "Server Node", render: (r) => r.displayName || r.serverId },
                    { key: "kind", label: "Provider / Kind", render: (r) => r.provider || r.kind },
                    { key: "computeClass", label: "Compute Class", render: (r) => r.computeClass || "—" },
                    { key: "region", label: "Region", render: (r) => r.region },
                    { key: "state", label: "State", render: (r) => <Badge tone={statusTone(r.state)}>{humanState(r.state)}</Badge> },
                    { key: "telemetry", label: "Telemetry", render: (r) => r.cpuPct !== null && r.memPct !== null ? `${r.cpuPct}% CPU · ${r.memPct}% RAM` : "Unavailable" },
                  ]}
                  rows={servers}
                />
              )}
            </div>
            {modelConnections.length > 0 ? (
              <div>
                <h4 style={{ margin: "0 0 8px", fontSize: 13, color: "#94a3b8" }}>Model Connections</h4>
                <DataTable
                  head={[
                    { key: "provider", label: "Provider", render: (r) => r.displayName },
                    { key: "status", label: "Status", render: (r) => <Badge tone={r.status === "connected" ? "good" : "bad"}>{r.status}</Badge> },
                    { key: "byok", label: "Mode", render: (r) => r.kind === "byok" ? "BYOK Key" : "Managed" },
                  ]}
                  rows={modelConnections}
                />
              </div>
            ) : null}
          </div>
        </Panel>
      ) : (
        <Panel
          title="Approvals & Governance"
          subtitle="Execution authorization gates and security checkpoints."
        >
          {validationApprovals.length === 0 ? (
            <EmptyState title="No approvals waiting">
              All agent runs are currently authorized to proceed.
            </EmptyState>
          ) : (
            <div className="approvals-work-list">
              {validationApprovals.map((ap) => (
                <div key={ap.approvalId} className="approval-card">
                  <div className="approval-head">
                    <strong>{ap.summary || "Approval Gate"}</strong>
                    <Badge tone="warn">Pending</Badge>
                  </div>
                  <p className="approval-desc muted">{ap.summary || "Execution permission is required."}</p>
                  <div className="approval-actions">
                    <Button kind="primary" size="sm" onClick={() => void mox.resolveApproval(ap.approvalId, "approved")}>
                      Approve
                    </Button>
                    <Button kind="danger" size="sm" onClick={() => void mox.resolveApproval(ap.approvalId, "denied")}>
                      Deny
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>
      )}
    </div>
  );
}

function agentName(agents: AgentSummary[], agentId: string): string {
  const a = agents.find((x) => x.agentId === agentId);
  return a?.definition.identity.displayName ?? agentId;
}

function AgentRow({ agent }: { agent: AgentSummary }) {
  const a = agent.definition;
  return (
    <div className="agent-row">
      <Avatar slug={a.agentId} name={a.identity.displayName} size={34} status={agent.runtimeStatus as AgentStatus | undefined} />
      <div className="meta">
        <div className="name">{a.identity.displayName}</div>
        {agent.modelBadge ? <div className="role">{agent.modelBadge}</div> : null}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Rooms
// ----------------------------------------------------------------------------

export function RoomsView() {
  const mox = useMox();
  const roomsAllowed = useAgentRooms();
  const [rooms, setRooms] = useState<AgentRoom[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [memberIds, setMemberIds] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => {
    void mox.api
      .listRooms()
      .then((r) => {
        setRooms(r);
        setLoading(false);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
  }, [mox.api]);

  useEffect(() => {
    load();
  }, [load]);

  const selected = rooms.find((r) => r.roomId === selectedId) ?? null;

  const toggleMember = (id: string) => {
    setMemberIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const createRoom = async () => {
    const title = newTitle.trim();
    if (!title || creating) return;
    setCreating(true);
    try {
      const created = await mox.api.createRoom({ title, memberAgentIds: [...memberIds] });
      setNewTitle("");
      setMemberIds(new Set());
      setShowCreate(false);
      await mox.api.listRooms().then(setRooms);
      setSelectedId(created.roomId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  if (!roomsAllowed) {
    return (
      <GatedState title="Agent Rooms require a plan entitlement">
        This workspace does not include agent rooms. Upgrade or enable the agent_rooms entitlement to create shared rooms.
      </GatedState>
    );
  }

  return (
    <div>
      <PageHeader title="Agent Rooms" subtitle="Shared threads that coordinate multiple agents together." />
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <Button kind="primary" onClick={() => setShowCreate((v) => !v)} disabled={creating}>
          + Create Room
        </Button>
        {showCreate && (
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input value={newTitle} placeholder="Room title" onChange={(e) => setNewTitle(e.target.value)} aria-label="Room title" />
            <label>Members:</label>
            {mox.agents.map((a) => (
              <label key={a.agentId} style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={memberIds.has(a.agentId)}
                  onChange={() => toggleMember(a.agentId)}
                />
                {a.definition.identity.displayName}
              </label>
            ))}
            <Button kind="primary" onClick={createRoom} disabled={creating || !newTitle.trim()}>
              {creating ? "Creating…" : "Create"}
            </Button>
          </div>
        )}
      </div>
      {error ? <ErrorState message={error} /> : null}
      {loading ? <LoadingState /> : null}
      <div className="grid grid-2">
        <Panel title={`Rooms (${rooms.length})`}>
          {rooms.length === 0 ? (
            <EmptyState>No agent rooms yet.</EmptyState>
          ) : (
            rooms.map((r) => (
              <div
                key={r.roomId}
                className={`agent-row ${r.roomId === selectedId ? "active" : ""}`}
                onClick={() => setSelectedId(r.roomId)}
                role="button"
                tabIndex={0}
                aria-pressed={r.roomId === selectedId}
                onKeyDown={(e) => { if (e.key === "Enter") setSelectedId(r.roomId); }}
              >
                <strong>{r.title}</strong>
                <span className="muted">{r.memberAgentIds.length} agents</span>
              </div>
            ))
          )}
        </Panel>
        <Panel title={selected ? `#${selected.title}` : "Room details"}>
          {!selected ? (
            <EmptyState>Select a room to see its members.</EmptyState>
          ) : (
            <>
              <div className="muted" style={{ marginBottom: 8 }}>
                Members: {selected.memberAgentIds.length ? selected.memberAgentIds.map((id) => agentName(mox.agents, id)).join(", ") : "none"} + humans.
              </div>
              {/* Phase 02 §G: no canonical room-scoped thread authority exists —
                  threads are per-agent, so a shared room thread is NOT fabricated
                  with a synthetic `room:<id>` id (that would call a guaranteed
                  failing endpoint). Render an honest unavailable state instead. */}
              <EmptyState>Shared room chat is not yet available on this deployment.</EmptyState>
            </>
          )}
        </Panel>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Servers
// ----------------------------------------------------------------------------

export function ServersView() {
  const mox = useMox();
  const [servers, setServers] = useState<Awaited<ReturnType<typeof mox.api.listServers>>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showProvision, setShowProvision] = useState(false);
  const reload = useCallback(async () => {
    setServers(await mox.api.listServers());
  }, [mox.api]);
  useEffect(() => {
    void mox.api
      .listServers()
      .then((s) => { setServers(s); setLoading(false); })
      .catch((e: unknown) => { setError(e instanceof Error ? e.message : String(e)); setLoading(false); });
  }, [mox.api]);

  return (
    <div>
      <PageHeader
        title="Servers"
        subtitle="Compute infrastructure hosting your agents."
        actions={
          <div style={{ display: "flex", gap: 8 }}>
            <Button kind="primary" onClick={() => setShowProvision(true)}>Provision Server</Button>
            <Link to="/backups"><Button size="sm">Manage Backups</Button></Link>
          </div>
        }
      />

      {error ? <ErrorState message={error} /> : null}
      {loading ? <LoadingState /> : null}
      <Panel>
        <DataTable
          head={[
            { key: "displayName", label: "Server" },
            { key: "kind", label: "Kind", render: (r) => humanState(r.kind) },
            { key: "computeClass", label: "Class", render: (r) => String(r.computeClass ?? "") },
            { key: "region", label: "Region" },
            { key: "state", label: "State", render: (r) => <Badge tone={statusTone(r.state)}>{humanState(r.state)}</Badge> },
            { key: "agentsRunning", label: "Agents", render: (r) => telemetry(r.agentsRunning as number | null) },
            { key: "cpuPct", label: "CPU", render: (r) => telemetry(r.cpuPct as number | null, "%") },
            { key: "memPct", label: "Mem", render: (r) => telemetry(r.memPct as number | null, "%") },
            { key: "lastError", label: "Last error", render: (r) => String(r.lastError ?? "") },
            { key: "orderId", label: "Actions", render: (r) => <ServerActionsCell server={r} onDone={reload} /> },
          ]}
          rows={servers}
          empty="No servers provisioned for this workspace yet."
        />
      </Panel>
      {showProvision && (
        <ProvisionServerModal
          onClose={() => setShowProvision(false)}
          onDone={async () => { setShowProvision(false); await reload(); }}
        />
      )}
    </div>
  );
}

/** Customer server provisioning wizard (Phase 02). Safe Mox abstraction — no provider internals. */
function ProvisionServerModal({ onClose, onDone }: { onClose: () => void; onDone: () => Promise<void> }) {
  const mox = useMox();
  const [step, setStep] = useState<"class" | "hostname" | "ssh" | "confirm">("class");
  const [opts, setOpts] = useState<ProvisionOptions | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Selections
  const [classCode, setClassCode] = useState("");
  const [hostname, setHostname] = useState("");
  const [sshKeyId, setSshKeyId] = useState<string | undefined>(undefined);
  const [newSshLabel, setNewSshLabel] = useState("");
  const [newSshPublicKey, setNewSshPublicKey] = useState("");
  const [addingKey, setAddingKey] = useState(false);

  useEffect(() => {
    void mox.api
      .getProvisionOptions()
      .then((o) => { setOpts(o); setLoading(false); })
      .catch((e: unknown) => { setError(e instanceof Error ? e.message : String(e)); setLoading(false); });
  }, [mox.api]);

  const selectedClass = opts?.classes.find((c) => c.code === classCode);
  const quota = opts?.serverQuota;
  const quotaExhausted = quota && !quota.entitled || (typeof quota?.included === "number" && quota.included >= 0 && quota.activeServers >= quota.included);

  const addKey = async () => {
    if (!newSshLabel.trim() || !newSshPublicKey.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const row = await mox.api.addSshKey({ label: newSshLabel.trim(), publicKey: newSshPublicKey.trim() });
      setOpts((prev) => prev ? { ...prev, sshKeys: [...prev.sshKeys, row] } : prev);
      setSshKeyId(row.id);
      setNewSshLabel("");
      setNewSshPublicKey("");
      setAddingKey(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const removeKey = async (keyId: string) => {
    setBusy(true);
    setError(null);
    try {
      await mox.api.deleteSshKey(keyId);
      setOpts((prev) => prev ? { ...prev, sshKeys: prev.sshKeys.filter((k) => k.id !== keyId) } : prev);
      if (sshKeyId === keyId) setSshKeyId(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!classCode || !hostname.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await mox.api.orderServer({
        computeClassCode: classCode,
        hostname: hostname.trim(),
        sshKeyId,
        idempotencyKey: `provision_${classCode}_${hostname.trim()}_${Date.now()}`,
      });
      await onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const canNext = step === "class" ? !!classCode
    : step === "hostname" ? hostname.trim().length > 0 && hostname.trim().length <= 63
    : step === "ssh" ? true
    : true;

  const next = () => {
    if (step === "class") setStep("hostname");
    else if (step === "hostname") setStep("ssh");
    else if (step === "ssh") setStep("confirm");
  };
  const back = () => {
    if (step === "confirm") setStep("ssh");
    else if (step === "ssh") setStep("hostname");
    else if (step === "hostname") setStep("class");
  };

  if (loading) {
    return (
      <Modal isOpen={true} onClose={onClose} title="Provision Server">
        <LoadingState label="Loading provisioning options…" />
      </Modal>
    );
  }

  if (quotaExhausted) {
    return (
      <Modal isOpen={true} onClose={onClose} title="Provision Server">
        <EmptyState>
          {quota?.entitled
            ? `Server quota reached (${quota.included} included). Cancel an existing server or upgrade your plan.`
            : "Your current plan does not include server provisioning. Upgrade to get started."}
        </EmptyState>
      </Modal>
    );
  }

  return (
    <Modal
      isOpen={true}
      onClose={onClose}
      title={`Provision Server — ${step === "class" ? "Choose class" : step === "hostname" ? "Name" : step === "ssh" ? "SSH access" : "Confirm"}`}
      footer={
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          {step !== "class" && <Button onClick={back} disabled={busy}>Back</Button>}
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          {step !== "confirm" ? (
            <Button kind="primary" disabled={!canNext} onClick={next}>Next</Button>
          ) : (
            <Button kind="primary" disabled={busy} onClick={() => void submit()}>
              {busy ? "Provisioning…" : "Provision Server"}
            </Button>
          )}
        </div>
      }
    >
      {error ? <ErrorState message={error} /> : null}

      {step === "class" && opts && (
        <div className="form-grid">
          <p className="muted" style={{ marginBottom: 8 }}>Select a Mox compute class for your server.</p>
          {opts.classes.map((c) => (
            <label
              key={c.code}
              className="form-field"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "10px 12px",
                border: classCode === c.code ? "2px solid var(--accent)" : "1px solid var(--border)",
                borderRadius: 8,
                cursor: "pointer",
                background: classCode === c.code ? "var(--accent-bg, rgba(99,102,241,0.06))" : undefined,
              }}
            >
              <input
                type="radio"
                name="compute-class"
                value={c.code}
                checked={classCode === c.code}
                onChange={() => setClassCode(c.code)}
              />
              <div>
                <strong>{c.displayName}</strong>
                <div className="muted" style={{ fontSize: 12.5 }}>{c.minVcpu} vCPU · {c.minRamGb} GB RAM{c.included ? " · included in plan" : ""}</div>
              </div>
            </label>
          ))}
        </div>
      )}

      {step === "hostname" && (
        <div className="form-grid">
          <label className="form-field">
            Hostname / display name
            <input
              value={hostname}
              placeholder="my-agent-server"
              maxLength={63}
              onChange={(e) => setHostname(e.target.value)}
            />
          </label>
          <p className="muted" style={{ fontSize: 12.5 }}>
            Alphanumeric, hyphens, and dots. Max 63 characters. Used as the server display name.
          </p>
        </div>
      )}

      {step === "ssh" && opts && (
        <div className="form-grid">
          <p className="muted" style={{ marginBottom: 8 }}>Optionally attach an SSH public key for server access.</p>
          {opts.sshKeys.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {opts.sshKeys.map((k) => (
                <label
                  key={k.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "8px 12px",
                    border: sshKeyId === k.id ? "2px solid var(--accent)" : "1px solid var(--border)",
                    borderRadius: 8,
                    cursor: "pointer",
                    background: sshKeyId === k.id ? "var(--accent-bg, rgba(99,102,241,0.06))" : undefined,
                  }}
                >
                  <input
                    type="radio"
                    name="ssh-key"
                    checked={sshKeyId === k.id}
                    onChange={() => setSshKeyId(k.id)}
                  />
                  <div style={{ flex: 1 }}>
                    <strong>{k.label}</strong>
                    <div className="muted mono" style={{ fontSize: 11 }}>{k.fingerprint}</div>
                  </div>
                  <Button size="sm" kind="danger" onClick={(e) => { e.preventDefault(); void removeKey(k.id); }}>Remove</Button>
                </label>
              ))}
              <label style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", border: sshKeyId === undefined ? "2px solid var(--border)" : "1px solid var(--border)", borderRadius: 8, cursor: "pointer" }}>
                <input type="radio" name="ssh-key" checked={sshKeyId === undefined} onChange={() => setSshKeyId(undefined)} />
                <span className="muted">No SSH key</span>
              </label>
            </div>
          )}
          {opts.sshKeys.length === 0 && !addingKey && (
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span className="muted">No SSH keys configured.</span>
              <Button size="sm" kind="ghost" onClick={() => setAddingKey(true)}>Add key</Button>
            </div>
          )}
          {addingKey ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
              <label className="form-field">
                Label
                <input value={newSshLabel} placeholder="Operator laptop" maxLength={64} onChange={(e) => setNewSshLabel(e.target.value)} />
              </label>
              <label className="form-field">
                Public key
                <input value={newSshPublicKey} placeholder="ssh-ed25519 AAAA…" onChange={(e) => setNewSshPublicKey(e.target.value)} />
              </label>
              <div style={{ display: "flex", gap: 8 }}>
                <Button size="sm" kind="primary" disabled={busy || !newSshLabel.trim() || !newSshPublicKey.trim()} onClick={() => void addKey()}>
                  {busy ? "Adding…" : "Add key"}
                </Button>
                <Button size="sm" onClick={() => { setAddingKey(false); setNewSshLabel(""); setNewSshPublicKey(""); }}>Cancel</Button>
              </div>
            </div>
          ) : opts.sshKeys.length > 0 ? (
            <Button size="sm" kind="ghost" onClick={() => setAddingKey(true)}>+ Add another key</Button>
          ) : null}
        </div>
      )}

      {step === "confirm" && selectedClass && (
        <div className="form-grid">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div><span className="muted">Compute class</span><br /><strong>{selectedClass.displayName}</strong></div>
            <div><span className="muted">Hostname</span><br /><strong>{hostname}</strong></div>
            <div><span className="muted">Resources</span><br />{selectedClass.minVcpu} vCPU · {selectedClass.minRamGb} GB RAM</div>
            <div><span className="muted">SSH key</span><br />{sshKeyId ? (opts?.sshKeys.find((k) => k.id === sshKeyId)?.label ?? "Selected") : "None"}</div>
          </div>
          {quota && (
            <div style={{ marginTop: 12, padding: "10px 12px", border: "1px solid var(--border)", borderRadius: 8 }}>
              <span className="muted">Plan impact: </span>
              <strong>{quota.activeServers + 1}</strong>
              {typeof quota.included === "number" ? <> / {quota.included} servers used</> : null}
              {selectedClass.included ? <Badge tone="good" >included</Badge> : <Badge tone="warn">may incur charges</Badge>}
            </div>
          )}
          <p className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>
            Placement is managed by Mox — the region is selected automatically based on availability.
          </p>
        </div>
      )}
    </Modal>
  );
}

/** Per-server lifecycle actions (§H). The orchestration layer is authoritative. */
function ServerActionsCell({ server, onDone }: { server: ServerSummary; onDone: () => Promise<void> }) {
  const mox = useMox();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resizing, setResizing] = useState(false);
  const [classCode, setClassCode] = useState("");
  const running = server.state === "running";
  const canceled = server.state === "canceled";

  const act = async (action: "restart" | "cancel" | "stop" | "start" | "resize", computeClassCode?: string) => {
    setError(null);
    setBusy(true);
    try {
      await mox.api.serverAction(server.orderId, action, computeClassCode);
      await onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setResizing(false);
    }
  };

  return (
    <div className="row-actions" style={{ flexWrap: "wrap" }}>
      <Button size="sm" disabled={busy || !running} onClick={() => void act("restart")}>Restart</Button>
      {running ? (
        <Button size="sm" disabled={busy} onClick={() => void act("stop")}>Stop</Button>
      ) : canceled ? null : (
        <Button size="sm" disabled={busy} onClick={() => void act("start")}>Start</Button>
      )}
      <Button size="sm" disabled={busy || canceled} onClick={() => setResizing((v) => !v)}>Resize</Button>
      {resizing && (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <input
            value={classCode}
            onChange={(e) => setClassCode(e.target.value)}
            placeholder="compute class code"
            aria-label="compute class code"
          />
          <Button size="sm" kind="primary" disabled={busy || !classCode.trim()} onClick={() => void act("resize", classCode.trim())}>
            Confirm
          </Button>
        </span>
      )}
      {!canceled && (
        <Button size="sm" kind="danger" disabled={busy} onClick={() => { if (window.confirm(`Cancel server order ${server.orderId}? This releases the infrastructure.`)) void act("cancel"); }}>
          Cancel
        </Button>
      )}
      {error ? <span className="muted" style={{ flexBasis: "100%", color: "var(--bad)" }}>{error}</span> : null}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Deployments
// ----------------------------------------------------------------------------

export function DeploymentsView() {
  const mox = useMox();
  const [deps, setDeps] = useState<AgentDeployment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showDeploy, setShowDeploy] = useState(false);
  const reload = useCallback(async () => {
    setDeps(await mox.api.listDeployments());
  }, [mox.api]);
  useEffect(() => {
    void mox.api
      .listDeployments()
      .then((d) => { setDeps(d); setLoading(false); })
      .catch((e: unknown) => { setError(e instanceof Error ? e.message : String(e)); setLoading(false); });
  }, [mox.api]);

  return (
    <div>
      <PageHeader
        title="Deployments"
        subtitle="Published versions of your agents across targets."
        actions={<Button kind="primary" onClick={() => setShowDeploy(true)}>+ Deploy</Button>}
      />
      {error ? <ErrorState message={error} /> : null}
      {loading ? <LoadingState /> : null}
      <Panel>
        <DataTable
          head={[
            { key: "agentId", label: "Agent", render: (r) => agentName(mox.agents, r.agentId) },
            { key: "target", label: "Target", render: (r) => humanState(r.target?.kind) },
            { key: "versionId", label: "Version", render: (r) => String(r.versionId) },
            { key: "state", label: "State", render: (r) => <Badge tone={statusTone(r.state)}>{humanState(r.state)}</Badge> },
            { key: "deploymentId", label: "Actions", render: (r) => <DeploymentActionsCell deployment={r} onDone={reload} /> },
          ]}
          rows={deps}
          empty="No deployments yet. Pin a published revision to a target."
        />
      </Panel>
      {showDeploy && <DeployModal onClose={() => setShowDeploy(false)} onDone={reload} />}
    </div>
  );
}

function DeploymentActionsCell({ deployment, onDone }: { deployment: AgentDeployment; onDone: () => Promise<void> }) {
  const mox = useMox();
  const [versions, setVersions] = useState<AgentVersionRow[] | null>(null);
  const [revision, setRevision] = useState<number | "">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = () => {
    if (versions === null) {
      void mox.api.listAgentVersions(deployment.agentId).then(setVersions).catch((e) => setError(e instanceof Error ? e.message : String(e)));
    } else {
      setVersions(null);
    }
  };

  const rollback = async () => {
    if (typeof revision !== "number") return;
    if (!window.confirm(`Roll back ${agentName(mox.agents, deployment.agentId)} to v${revision} on this target?`)) return;
    setBusy(true);
    setError(null);
    try {
      await mox.api.deploymentRollback(deployment.deploymentId, revision);
      await onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setVersions(null);
    }
  };

  return (
    <div className="row-actions" style={{ flexWrap: "wrap" }}>
      <Button size="sm" disabled={busy} onClick={() => void mox.api.redeployDeployment(deployment.deploymentId).then(onDone).catch((e) => setError(e instanceof Error ? e.message : String(e)))}>
        Redeploy
      </Button>
      <Button size="sm" disabled={busy} onClick={toggle}>Rollback</Button>
      {versions !== null && (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <select value={revision} onChange={(e) => setRevision(e.target.value ? Number(e.target.value) : "")} aria-label="revision">
            <option value="">v…</option>
            {[...versions].reverse().filter((v) => v.revision !== (deployment as { desiredRevision?: number }).desiredRevision).map((v) => (
              <option key={v.revision} value={v.revision}>v{v.revision}{v.changelog ? ` · ${v.changelog}` : ""}</option>
            ))}
          </select>
          <Button size="sm" kind="primary" disabled={busy || typeof revision !== "number"} onClick={() => void rollback()}>
            Go
          </Button>
        </span>
      )}
      {error ? <span className="muted" style={{ flexBasis: "100%", color: "var(--bad)" }}>{error}</span> : null}
    </div>
  );
}

/** Deploy a published revision to a target (§I). */
function DeployModal({ onClose, onDone }: { onClose: () => void; onDone: () => Promise<void> }) {
  const mox = useMox();
  const [agentId, setAgentId] = useState("");
  const [versions, setVersions] = useState<AgentVersionRow[] | null>(null);
  const [revision, setRevision] = useState<number | "">("");
  const [target, setTarget] = useState<"sandbox" | "mox-cloud" | "customer-vps">("sandbox");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pickAgent = (id: string) => {
    setAgentId(id);
    setRevision("");
    setVersions(null);
    if (!id) return;
    void mox.api
      .listAgentVersions(id)
      .then((vs) => { setVersions(vs); if (vs.length) setRevision(vs[vs.length - 1]!.revision); })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };

  const deploy = async () => {
    if (typeof revision !== "number") return;
    setBusy(true);
    setError(null);
    try {
      await mox.api.deployAgent({
        agentId,
        revision,
        target:
          target === "sandbox"
            ? { kind: "sandbox" }
            : target === "mox-cloud"
              ? { kind: "mox-cloud", vpsId: "eu-central" }
              : { kind: "customer-vps" },
      });
      onClose();
      await onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const publishedOnly = mox.agents.map((a) => a).filter((a) => a.currentVersion && a.currentVersion > 0);
  return (
    <Modal
      isOpen={true}
      onClose={onClose}
      title="Deploy agent"
      footer={
        <>
          <span className="muted" style={{ fontSize: 12.5 }}>Deploying sets the desired state; the orchestrator reconciles it.</span>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <Button onClick={onClose} disabled={busy}>Cancel</Button>
            <Button kind="primary" disabled={busy || typeof revision !== "number" || !agentId} onClick={() => void deploy()}>
              {busy ? "Deploying…" : "Deploy"}
            </Button>
          </div>
        </>
      }
    >
      {publishedOnly.length === 0 ? (
        <EmptyState>No published agents yet. Publish an agent from its Settings → Versions first.</EmptyState>
      ) : (
        <div className="form-grid">
          <label className="form-field">
            Agent
            <select value={agentId} onChange={(e) => pickAgent(e.target.value)}>
              <option value="">Select agent…</option>
              {publishedOnly.map((a) => (
                <option key={a.agentId} value={a.agentId}>{a.definition.identity.displayName} (v{a.currentVersion})</option>
              ))}
            </select>
          </label>
          <label className="form-field">
            Revision
            <select disabled={versions === null} value={revision} onChange={(e) => setRevision(e.target.value ? Number(e.target.value) : "")}>
              {versions === null ? (
                <option value="">—</option>
              ) : versions.length === 0 ? (
                <option value="">no published revisions</option>
              ) : (
                [...versions].reverse().map((v) => (
                  <option key={v.revision} value={v.revision}>v{v.revision}{v.changelog ? ` · ${v.changelog}` : ""}</option>
                ))
              )}
            </select>
          </label>
          <label className="form-field">
            Target
            <select value={target} onChange={(e) => setTarget(e.target.value as typeof target)}>
              <option value="sandbox">Sandbox</option>
              <option value="mox-cloud">Mox cloud</option>
              <option value="customer-vps">Customer VPS</option>
            </select>
          </label>
        </div>
      )}
      {error ? <ErrorState message={error} /> : null}
    </Modal>
  );
}

// ----------------------------------------------------------------------------
// Models
// ----------------------------------------------------------------------------

export function ModelsView() {
  const mox = useMox();
  const custom = useModelConnections();
  const [models, setModels] = useState<Awaited<ReturnType<typeof mox.api.listModels>>>([]);
  const [connections, setConnections] = useState<Awaited<ReturnType<typeof mox.api.listModelConnections>>>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<ModelConnectionRow | null>(null);
  const [mode, setMode] = useState<"connect" | "rotate" | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    void Promise.all([mox.api.listModels(), mox.api.listModelConnections()])
      .then(([m, c]) => {
        setModels(m);
        setConnections(c);
        setLoading(false);
      })
      .catch((e: unknown) => { setError(e instanceof Error ? e.message : String(e)); setLoading(false); });
  }, [mox.api]);

  useEffect(() => { load(); }, [load]);

  const submit = async () => {
    if (!active || busy) return;
    setBusy(true);
    try {
      if (mode === "connect") {
        const next = await mox.api.connectModelConnection(active.providerId, {
          apiKey: apiKey.trim() || undefined,
          baseUrl: baseUrl.trim() || undefined,
        });
        load();
        setStatus(`${active.displayName}: ${next.credentialConfigured ? "connected — credentials stored in your vault" : "connected — no credentials set"}`);
      } else {
        await mox.api.rotateModelConnection(active.providerId, { apiKey: apiKey.trim() });
        load();
        setStatus(`${active.displayName}: key rotated`);
      }
      setActive(null);
      setMode(null);
      setApiKey("");
      setBaseUrl("");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async (row: ModelConnectionRow) => {
    setBusy(true);
    try {
      await mox.api.disconnectModelConnection(row.providerId);
      load();
      setStatus(`${row.displayName}: disconnected`);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader title="Models" subtitle="Model providers available to your agents and their bring-your-own-key connections." />
      {error ? <ErrorState message={error} /> : null}
      {loading ? <LoadingState /> : null}
      {!custom && !loading ? <div className="notice">Custom provider connections are not entitled for this workspace.</div> : null}
      <Panel title="Provider catalog">
        <DataTable
          head={[
            { key: "displayName", label: "Model" },
            { key: "providerId", label: "Provider", render: (r) => humanState(r.providerId.replace(/^p_/, "")) },
            { key: "byok", label: "Credentials", render: (r) => (r.byok ? <Badge>BYOK supported</Badge> : <Badge tone="accent">Mox-managed</Badge>) },
            { key: "available", label: "Availability", render: (r) => (r.available ? <Badge tone="good">available</Badge> : <Badge tone="bad">unavailable</Badge>) },
          ]}
          rows={models}
          empty="No model providers configured."
        />
      </Panel>
      <Panel
        title="Your connections"
        subtitle="API keys for BYOK providers are encrypted in your workspace vault — never shown back."
        actions={
          <div className="row-actions">
            {connections.slice(0, 4).map((m) => (
              <Button
                key={m.providerId}
                size="sm"
                kind="ghost"
                onClick={() => mox.api.testProviderConnection(m.providerId).then((r) => setStatus(`${m.displayName}: ${r.ok ? "connection OK" : r.reason ?? "failed"}`))}
              >
                Test {m.displayName}
              </Button>
            ))}
          </div>
        }
      >
        {!custom ? null : (
          <DataTable
            head={[
              { key: "displayName", label: "Provider", render: (r) => kindLabel(r.kind) },
              { key: "state", label: "State", render: (r) => <Badge tone={statusTone(modelConnectionState(r))}>{stateLabel(modelConnectionState(r))}</Badge> },
              { key: "models", label: "Models in catalog", render: (r) => r.modelCount },
              { key: "baseUrl", label: "Endpoint", render: (r) => (r.baseUrl ? <span className="mono">{r.baseUrl}</span> : <span className="muted">DEFAULT</span>) },
              { key: "actions", label: "", render: (r) => (
                <div className="row-actions">
                  {modelConnectionState(r) !== "connected" ? (
                    <Button size="sm" kind="primary" onClick={() => { setActive(r); setMode("connect"); setApiKey(""); setBaseUrl(r.baseUrl ?? ""); }}>Connect</Button>
                  ) : (
                    <>
                      <Button size="sm" onClick={() => { setActive(r); setMode("rotate"); setApiKey(""); }}>Rotate key</Button>
                      <Button size="sm" kind="danger" onClick={() => void disconnect(r)} disabled={busy}>Disconnect</Button>
                    </>
                  )}
                </div>
              ) },
            ]}
            rows={connections}
            empty="No bring-your-own-key connections yet. Open one of the BYOK providers above and connect it with an API key."
          />
        )}
      </Panel>
      {status ? <p className={`muted mono`} role="status">{status}</p> : null}
      {active && mode ? (
        <Modal
          isOpen={true}
          onClose={() => { if (!busy) { setActive(null); setMode(null); } }}
          title={mode === "connect" ? `Connect ${active.displayName}` : `Rotate API key — ${active.displayName}`}
          footer={
            <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
              <Button onClick={() => { setActive(null); setMode(null); }} disabled={busy}>Cancel</Button>
              <Button kind="primary" disabled={busy || (mode === "rotate" && !apiKey.trim())} onClick={() => void submit()}>
                {busy ? "Working…" : mode === "connect" ? "Connect" : "Rotate"}
              </Button>
            </div>
          }
        >
          <div className="form-grid">
            <label className="form-field">
              API key
              <input type="password" value={apiKey} placeholder={mode === "connect" ? "Paste your provider API key (optional)" : "Paste the new API key"} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" />
            </label>
            {mode === "connect" && active.baseUrlSupported ? (
              <label className="form-field">
                Endpoint (optional)
                <input value={baseUrl} placeholder="https://api.example.com/v1 — leave empty for default" onChange={(e) => setBaseUrl(e.target.value)} />
              </label>
            ) : null}
          </div>
          <p className="muted" style={{ fontSize: 12.5 }}>
            Your key is encrypted before it touches our servers and never returned by any API call.
          </p>
        </Modal>
      ) : null}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Integrations & Channels
// ----------------------------------------------------------------------------

export function IntegrationsView() {
  const mox = useMox();
  const [items, setItems] = useState<Awaited<ReturnType<typeof mox.api.listIntegrations>>>([]);
  const [grants, setGrants] = useState<Map<string, ToolGrantRow[]>>(new Map());
  const [grantError, setGrantError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connectFor, setConnectFor] = useState<IntegrationCatalogRow | null>(null);
  const [secretsInput, setSecretsInput] = useState<Record<string, string>>({});
  const [grantFor, setGrantFor] = useState<string | null>(null);
  const [grantAgentId, setGrantAgentId] = useState("");
  const [grantPattern, setGrantPattern] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const i = await mox.api.listIntegrations();
      setItems(i);
      setLoading(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setLoading(false);
    }
  }, [mox.api]);

  const loadGrants = useCallback(async (integrationId: string) => {
    try {
      const g = await mox.api.listIntegrationGrants(integrationId);
      setGrants((prev) => new Map(prev).set(integrationId, g));
      setGrantError(null);
    } catch (e) {
      setGrantError(e instanceof Error ? e.message : String(e));
    }
  }, [mox.api]);

  useEffect(() => { void load(); }, [load]);

  const connected = (r: IntegrationCatalogRow) => integrationState(r) === "connected";

  const connect = async () => {
    if (!connectFor || busy) return;
    setBusy(true);
    try {
      const secrets: Record<string, string> = {};
      const config: Record<string, unknown> = {};
      for (const f of connectFor.configFields) {
        if (f.secret) secrets[f.key] = secretsInput[f.key] ?? "";
        else if ((secretsInput[f.key] ?? "").trim()) config[f.key] = secretsInput[f.key]?.trim();
      }
      const res = await mox.api.connectIntegration(connectFor.integrationId, { secrets, config });
      setStatus(res.connected ? `${connectFor.displayName}: connected` : `${connectFor.displayName}: not connected`);
      setConnectFor(null);
      setSecretsInput({});
      await load();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async (r: IntegrationCatalogRow) => {
    setBusy(true);
    try {
      const res = await mox.api.disconnectIntegration(r.integrationId);
      setStatus(res.connected ? `${r.displayName}: connected` : `${r.displayName}: disconnected`);
      await load();
      setGrants((prev) => new Map(prev).set(r.integrationId, []));
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const submitGrant = async (integrationId: string) => {
    if (!grantAgentId || busy) return;
    setBusy(true);
    try {
      await mox.api.grantIntegrationTool(integrationId, { agentId: grantAgentId, toolPattern: grantPattern.trim() || undefined });
      setGrantFor(null);
      setGrantAgentId("");
      setGrantPattern("");
      await loadGrants(integrationId);
    } catch (e) {
      setGrantError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const revokeGrant = async (integrationId: string, grantId: string) => {
    setBusy(true);
    try {
      await mox.api.revokeIntegrationGrant(integrationId, grantId);
      await loadGrants(integrationId);
    } catch (e) {
      setGrantError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader title="Apps & Integrations" subtitle="Third-party apps your agents can use — credentials stay in your vault." />
      {error ? <ErrorState message={error} /> : null}
      {loading ? <LoadingState /> : null}
      {status ? <p className="muted mono" role="status">{status}</p> : null}
      <Panel>
        <DataTable
          head={[
            { key: "displayName", label: "App" },
            { key: "kind", label: "Kind", render: (r) => kindLabel(r.kind) },
            { key: "tools", label: "Tools", render: (r) => (r.requiresRuntimeSession ? <Badge tone="warn">needs runtime session</Badge> : r.tools.length ? r.tools.join(", ") : "—") },
            { key: "connected", label: "Status", render: (r) => (connected(r) ? <Badge tone="good">connected</Badge> : r.credentialConfigured ? <Badge tone="warn">connecting</Badge> : <Badge>not connected</Badge>) },
            { key: "actions", label: "", render: (r) => (
              <div className="row-actions">
                {connected(r) ? (
                  <>
                    <Button size="sm" onClick={() => { void loadGrants(r.integrationId); setGrantFor(r.integrationId === grantFor ? null : r.integrationId); }}>{grantFor === r.integrationId ? "Hide grants" : "Tool grants"}</Button>
                    <Button size="sm" kind="danger" onClick={() => void disconnect(r)} disabled={busy}>Disconnect</Button>
                  </>
                ) : (
                  <Button size="sm" kind="primary" onClick={() => { setConnectFor(r); setSecretsInput({}); }}>Connect</Button>
                )}
                {r.dangerous ? <Badge tone="bad" >dangerous</Badge> : null}
              </div>
            ) },
          ]}
          rows={items}
          empty="No integrations configured."
        />
      </Panel>
      {items.map((r) => connected(r) && grantFor === r.integrationId ? (
        <Panel key={r.integrationId} title={`Tool grants — ${r.displayName}`} subtitle="Which agents may call this app's tools (per-tool, wildcards allowed).">
          {grantError ? <ErrorState message={grantError} /> : null}
          <DataTable
            head={[
              { key: "agentName", label: "Agent", render: (g) => g.agentName ?? g.agentId },
              { key: "toolPattern", label: "Tool pattern", render: (g) => <span className="mono">{g.toolPattern}</span> },
              { key: "grantId", label: "", render: (g) => (
                <Button size="sm" kind="danger" onClick={() => void revokeGrant(r.integrationId, g.grantId)} disabled={busy}>Revoke</Button>
              ) },
            ]}
            rows={grants.get(r.integrationId) ?? []}
            empty="No tools granted yet."
          />
          {grantFor === r.integrationId ? (
            <div className="row-actions" style={{ marginTop: 10 }}>
              <select aria-label="Agent" value={grantAgentId} onChange={(e) => setGrantAgentId(e.target.value)}>
                <option value="">Select agent…</option>
                {mox.agents.map((a) => <option key={a.agentId} value={a.agentId}>{a.definition.identity.displayName}</option>)}
              </select>
              <input aria-label="Tool pattern" value={grantPattern} placeholder="tool pattern (default *)" onChange={(e) => setGrantPattern(e.target.value)} />
              <Button kind="primary" size="sm" disabled={busy || !grantAgentId} onClick={() => void submitGrant(r.integrationId)}>Grant tool</Button>
            </div>
          ) : null}
        </Panel>
      ) : null)}
      {connectFor ? (
        <Modal
          isOpen={true}
          onClose={() => { if (!busy) setConnectFor(null); }}
          title={`Connect ${connectFor.displayName}`}
          footer={
            <>
              <span className="muted" style={{ fontSize: 12.5 }}>Secrets are encrypted at rest and never shown back to you.</span>
              <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                <Button onClick={() => { setConnectFor(null); setSecretsInput({}); }} disabled={busy}>Cancel</Button>
                <Button kind="primary" onClick={() => void connect()} disabled={busy}>{busy ? "Working…" : "Connect"}</Button>
              </div>
            </>
          }
        >
          <div className="form-grid">
            {connectFor.configFields.map((f) => (
              <label className="form-field" key={f.key}>
                {f.label}{f.optional ? " (optional)" : ""}
                {f.secret ? (
                  <input type="password" value={secretsInput[f.key] ?? ""} autoComplete="off" onChange={(e) => setSecretsInput((prev) => ({ ...prev, [f.key]: e.target.value }))} />
                ) : (
                  <input value={secretsInput[f.key] ?? ""} onChange={(e) => setSecretsInput((prev) => ({ ...prev, [f.key]: e.target.value }))} />
                )}
              </label>
            ))}
            {connectFor.configFields.length === 0 ? <p className="muted">This integration is already connected server-side; reconnect with new credentials if needed.</p> : null}
          </div>
          {connectFor.requiresRuntimeSession ? <p className="muted" style={{ fontSize: 12.5 }}>This app also needs a runtime session on your deployment.</p> : null}
          {connectFor.dangerous ? <p className="muted" style={{ fontSize: 12.5 }}>This app can execute arbitrary remote actions — connect at your own risk.</p> : null}
          {status ? <p className="muted mono">{status}</p> : null}
        </Modal>
      ) : null}
    </div>
  );
}

export function ChannelsView() {
  const mox = useMox();
  const [channels, setChannels] = useState<Awaited<ReturnType<typeof mox.api.listChannels>>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connectFor, setConnectFor] = useState<ChannelCatalogRow | null>(null);
  const [reconnectFor, setReconnectFor] = useState<ChannelCatalogRow | null>(null);
  const [agentId, setAgentId] = useState("");
  const [secretsInput, setSecretsInput] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const c = await mox.api.listChannels();
      setChannels(c);
      setLoading(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setLoading(false);
    }
  }, [mox.api]);

  useEffect(() => { void load(); }, [load]);

  const secretLabel = (key: string) => key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()).replace(/I d$/i, " ID");

  const connect = async () => {
    if (!connectFor || !agentId || busy) return;
    setBusy(true);
    try {
      const secrets: Record<string, string> = {};
      for (const k of connectFor.secretKeys) secrets[k] = secretsInput[k] ?? "";
      const res = await mox.api.connectChannel(connectFor.channelId, { agentId, secrets });
      setStatus(res.connected ? `${connectFor.displayName} → connected` : `${connectFor.displayName} → not connected`);
      setConnectFor(null);
      setAgentId("");
      setSecretsInput({});
      await load();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const reconnect = async (row: ChannelCatalogRow) => {
    if (!row.connectionId || busy) return;
    setBusy(true);
    try {
      const secrets: Record<string, string> = {};
      for (const k of row.secretKeys) secrets[k] = secretsInput[k] ?? "";
      await mox.api.reconnectChannel(row.connectionId, { secrets });
      setStatus(`${row.displayName}: reconnected`);
      setReconnectFor(null);
      setSecretsInput({});
      await load();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async (row: ChannelCatalogRow) => {
    if (!row.connectionId || busy) return;
    setBusy(true);
    try {
      await mox.api.disconnectChannel(row.connectionId);
      setStatus(`${row.displayName}: disconnected`);
      await load();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const test = async (row: ChannelCatalogRow) => {
    if (!row.connectionId) return;
    const r = await mox.api.testChannel(row.connectionId);
    setStatus(`${row.displayName}: ${r.ok ? "probe OK" : r.reason ?? "probe failed"}`);
  };

  return (
    <div>
      <PageHeader title="Channels" subtitle="Messaging channels your agents can send and receive through — each connection binds one agent." />
      {error ? <ErrorState message={error} /> : null}
      {loading ? <LoadingState /> : null}
      {status ? <p className="muted mono" role="status">{status}</p> : null}
      <Panel>
        <DataTable
          head={[
            { key: "displayName", label: "Channel" },
            { key: "kind", label: "Kind", render: (r) => kindLabel(r.kind) },
            { key: "boundAgentName", label: "Bound agent", render: (r) => r.boundAgentName ?? <span className="muted">—</span> },
            { key: "connected", label: "Status", render: (r) => <Badge tone={statusTone(channelState(r))}>{stateLabel(channelState(r))}</Badge> },
            { key: "actions", label: "", render: (r) => (
              <div className="row-actions">
                {channelState(r) === "connected" ? (
                  <>
                    <Button size="sm" onClick={() => void test(r)}>Test</Button>
                    <Button size="sm" onClick={() => { setReconnectFor(r); setSecretsInput({}); }}>Reconnect</Button>
                    <Button size="sm" kind="danger" onClick={() => void disconnect(r)} disabled={busy}>Disconnect</Button>
                  </>
                ) : (
                  <Button size="sm" kind="primary" onClick={() => { setConnectFor(r); setAgentId(""); setSecretsInput({}); }}>Connect</Button>
                )}
              </div>
            ) },
          ]}
          rows={channels}
          empty="No channels configured."
        />
      </Panel>
      <Panel title="Setup help" subtitle="Provider-side steps for each channel.">
        <ul className="cap-list" style={{ flexDirection: "column", alignItems: "flex-start", gap: 10 }}>
          {channels.map((c) => (
            <li key={c.channelId}>
              <Badge tone="accent">{c.displayName}</Badge> <span className="muted">{c.setupInstructions}</span>
              {c.prerequisites ? <span className="muted" style={{ display: "block", fontSize: 12.5 }}>Requires: {c.prerequisites}</span> : null}
            </li>
          ))}
        </ul>
      </Panel>
      {connectFor ? (
        <Modal
          isOpen={true}
          onClose={() => { if (!busy) setConnectFor(null); }}
          title={`Connect ${connectFor.displayName}`}
          footer={
            <>
              <span className="muted" style={{ fontSize: 12.5 }}>Secrets are encrypted at rest and never shown back to you.</span>
              <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                <Button onClick={() => { setConnectFor(null); setAgentId(""); setSecretsInput({}); }} disabled={busy}>Cancel</Button>
                <Button kind="primary" disabled={busy || !agentId} onClick={() => void connect()}>{busy ? "Working…" : "Connect"}</Button>
              </div>
            </>
          }
        >
          <div className="form-grid">
            <label className="form-field">
              Bind to agent
              <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                <option value="">Select agent…</option>
                {mox.agents.map((a) => <option key={a.agentId} value={a.agentId}>{a.definition.identity.displayName}</option>)}
              </select>
            </label>
            {connectFor.secretKeys.map((k) => (
              <label className="form-field" key={k}>
                {secretLabel(k)}
                <input type="password" value={secretsInput[k] ?? ""} autoComplete="off" onChange={(e) => setSecretsInput((prev) => ({ ...prev, [k]: e.target.value }))} />
              </label>
            ))}
            {connectFor.secretKeys.length === 0 ? <p className="muted">No external credential required for this channel.</p> : null}
          </div>
          <p className="muted" style={{ fontSize: 12.5 }}>{connectFor.setupInstructions}</p>
        </Modal>
      ) : null}
      {reconnectFor ? (
        <Modal
          isOpen={true}
          onClose={() => { if (!busy) { setReconnectFor(null); setSecretsInput({}); } }}
          title={`Reconnect ${reconnectFor.displayName}`}
          footer={
            <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
              <Button onClick={() => { setReconnectFor(null); setSecretsInput({}); }} disabled={busy}>Cancel</Button>
              <Button kind="primary" onClick={() => void reconnect(reconnectFor)} disabled={busy}>{busy ? "Working…" : "Reconnect"}</Button>
            </div>
          }
        >
          <div className="form-grid">
            <label className="form-field">
              Bound agent
              <input value={reconnectFor.boundAgentName ?? reconnectFor.boundAgentId ?? ""} disabled />
            </label>
            {reconnectFor.secretKeys.map((k) => (
              <label className="form-field" key={k}>
                {secretLabel(k)} (new value)
                <input type="password" value={secretsInput[k] ?? ""} autoComplete="off" onChange={(e) => setSecretsInput((prev) => ({ ...prev, [k]: e.target.value }))} />
              </label>
            ))}
            {reconnectFor.secretKeys.length === 0 ? <p className="muted">This channel needs no credential — reconnecting just re-checks the binding.</p> : null}
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Usage
// ----------------------------------------------------------------------------

export function UsageView() {
  const mox = useMox();
  const [usage, setUsage] = useState<Awaited<ReturnType<typeof mox.api.getUsage>>>([]);
  const [details, setDetails] = useState<UsageDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    let alive = true;
    Promise.allSettled([mox.api.getUsage(), mox.api.getUsageDetails()])
      .then(([uRes, dRes]) => {
        if (!alive) return;
        if (uRes.status === "fulfilled") {
          setUsage(uRes.value);
          setTotal(uRes.value.reduce((n, x) => n + x.quantity, 0));
        }
        if (dRes.status === "fulfilled") {
          setDetails(dRes.value);
        } else if (uRes.status === "rejected") {
          setError(uRes.reason instanceof Error ? uRes.reason.message : String(uRes.reason));
        }
        setLoading(false);
      });
    return () => { alive = false; };
  }, [mox.api]);

  return (
    <div>
      <PageHeader title="Usage" subtitle="Consumption and plan quotas in the current billing period." />
      {error ? <ErrorState message={error} /> : null}
      {loading ? <LoadingState /> : null}
      <section className="kpi-row" aria-label="Usage summary">
        <KpiCard label="Total measured units" value={total.toLocaleString()} hint="across this period" />
        <KpiCard label="Line items" value={usage.length} hint="distinct metrics tracked" />
        {details?.credits ? (
          <KpiCard
            label="Mox AI Credits"
            value={`${details.credits.remaining.toLocaleString()} / ${details.credits.included.toLocaleString()}`}
            hint={`Consumed: ${details.credits.consumed.toLocaleString()}`}
          />
        ) : null}
        {details?.period ? (
          <KpiCard
            label="Billing window"
            value={new Date(details.period.start).toLocaleDateString()}
            hint={`to ${new Date(details.period.end).toLocaleDateString()}`}
          />
        ) : null}
      </section>
      {details?.metrics && details.metrics.length > 0 ? (
        <Panel title="Plan Quotas & Entitlement Limits" subtitle="Authoritative limits evaluated against your current active plan">
          <DataTable
            head={[
              { key: "metric", label: "Metric", render: (r) => r.metric },
              { key: "quantity", label: "Consumed", render: (r) => `${r.quantity.toLocaleString()} ${r.unit}` },
              { key: "included", label: "Plan Limit", render: (r) => r.unlimited ? "Unlimited" : `${r.includedQuantity.toLocaleString()} ${r.unit}` },
              { key: "remaining", label: "Remaining", render: (r) => r.unlimited ? "∞" : r.remaining !== null ? `${r.remaining.toLocaleString()} ${r.unit}` : "—" },
              {
                key: "status",
                label: "Status",
                render: (r) => {
                  const tone =
                    r.status === "hard_limit_blocked" ? "bad" :
                    r.status === "soft_limit_warning" || r.status === "overage" ? "warn" :
                    r.status === "unlimited" ? "accent" : "good";
                  return <Badge tone={tone}>{humanState(r.status)}</Badge>;
                },
              },
            ]}
            rows={details.metrics}
            empty="No quota metrics available."
          />
        </Panel>
      ) : null}
      <Panel title="This billing period">
        <DataTable
          head={[
            { key: "metric", label: "Metric", render: (r) => humanState(r.metric) },
            { key: "quantity", label: "Quantity", render: (r) => r.quantity.toLocaleString() },
            { key: "unit", label: "Unit" },
          ]}
          rows={usage}
          empty="No usage recorded this period."
        />
      </Panel>
    </div>
  );
}


// ----------------------------------------------------------------------------
// Billing
// ----------------------------------------------------------------------------

export function BillingView() {
  const mox = useMox();
  const [invoices, setInvoices] = useState<Awaited<ReturnType<typeof mox.api.listInvoices>>>([]);
  const [plans, setPlans] = useState<Awaited<ReturnType<typeof mox.api.listPlans>>>([]);
  const [subscription, setSubscription] = useState<Awaited<ReturnType<typeof mox.api.getSubscription>>>(null);
  const [providers, setProviders] = useState<Awaited<ReturnType<typeof mox.api.listBillingProviders>>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [checkoutFor, setCheckoutFor] = useState<PlanOption | null>(null);
  const [providerName, setProviderName] = useState("");
  const [regionCode, setRegionCode] = useState("");
  const [createdSession, setCreatedSession] = useState<{ sessionId: string; redirectUrl: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [i, p, s, b] = await Promise.all([mox.api.listInvoices(), mox.api.listPlans(), mox.api.getSubscription(), mox.api.listBillingProviders()]);
      setInvoices(i);
      setPlans(p);
      setSubscription(s);
      setProviders(b);
      setLoading(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setLoading(false);
    }
  }, [mox.api]);

  useEffect(() => { void load(); }, [load]);

  const open = invoices.filter((i) => i.state === "open");
  const state = commercialStatus(subscription);

  const startCheckout = async () => {
    if (!checkoutFor || busy) return;
    setBusy(true);
    try {
      const res = await mox.api.startCheckout({
        planVersionId: checkoutFor.planVersionId,
        pricingRegionCode: regionCode || undefined,
        providerName,
        successUrl: `${window.location.origin}${window.location.pathname}?checkout=success`,
        cancelUrl: window.location.href,
      });
      setCreatedSession({ sessionId: res.sessionId, redirectUrl: res.redirectUrl });
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const reconcile = async () => {
    if (!createdSession || busy) return;
    setBusy(true);
    try {
      const res = await mox.api.reconcileCheckout({ sessionId: createdSession.sessionId });
      setStatus(`reconciliation ${String(res.state ?? "done")} — entitlement refreshed`);
      await mox.refreshEntitlements();
      await load();
      setCheckoutFor(null);
      setCreatedSession(null);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const cancelPlan = async () => {
    if (busy || !subscription) return;
    setBusy(true);
    try {
      await mox.api.cancelSubscription();
      setStatus("Cancellation scheduled at the end of the current period.");
      await load();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const openPlan = (p: PlanOption) => {
    setCheckoutFor(p);
    setProviderName(providers.find((b) => b.enabled && b.available)?.providerName ?? "");
    setRegionCode(p.pricingRegions.find((r) => r.available)?.pricingRegionCode ?? "");
    setCreatedSession(null);
  };

  return (
    <div>
      <PageHeader title="Billing" subtitle="Plans, subscriptions and invoices for this workspace." />
      {error ? <ErrorState message={error} /> : null}
      {loading ? <LoadingState /> : null}
      {status ? <p className="muted mono" role="status">{status}</p> : null}
      <section className="kpi-row" aria-label="Billing summary">
        <KpiCard label="Commercial access" value={subscription?.commercialAccess.entitled ? "Active" : "Denied"} hint={subscription?.commercialAccess.denialReason ?? (subscription?.commercialAccess.entitled ? "all services on" : "not entitled")} tone={subscription?.commercialAccess.entitled ? "good" : "warn"} />
        <KpiCard label="Current plan" value={subscription?.plan?.name ?? "None"} hint={subscription?.plan ? `v${subscription.plan.version} · ${subscription.plan.tier}` : "no active subscription"} tone={subscription?.state ? (() => { const t = statusTone(subscription.state); return t === "neutral" ? undefined : t; })() : undefined} />
        <KpiCard label="Open invoices" value={open.length} hint="awaiting payment" tone={open.length ? "warn" : "good"} />
      </section>

      <Panel title="Subscription" subtitle={subscription?.state ? humanState(subscription.state) : "No active subscription."}>
        {!subscription ? (
          <EmptyState>No subscription yet — pick a plan below to get started.</EmptyState>
        ) : (
          <div className="form-field" style={{ maxWidth: "none" }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
              <div><span className="muted">Plan</span><br /><strong>{subscription.plan?.name ?? "—"}</strong></div>
              <div><span className="muted">State</span><br /><Badge tone={statusTone(subscription.state)}>{humanState(subscription.state)}</Badge></div>
              <div><span className="muted">Current period</span><br />{subscription.currentPeriodStart ?? "—"} → {subscription.currentPeriodEnd ?? "—"}</div>
              <div><span className="muted">Ends when period ends</span><br />{subscription.cancelAtPeriodEnd ? "yes" : "no"}</div>
            </div>
            {subscription.cancellation ? (
              <p className="muted" style={{ marginTop: 8 }}>
                Cancellation: {humanState(subscription.cancellation.state)}{subscription.cancellation.attempts ? ` — ${subscription.cancellation.attempts} attempt(s)` : ""}
                {subscription.cancellation.lastError ? <> — {subscription.cancellation.lastError}</> : null}
              </p>
            ) : null}
            <div className="row-actions" style={{ marginTop: 12 }}>
              <Button kind="primary" onClick={() => setCheckoutFor(plans.find((p) => p.planVersionId === subscription?.planVersionId) ?? plans[0] ?? null)} disabled={busy || !plans.length}>
                Change plan
              </Button>
              <Button kind="danger" onClick={() => void cancelPlan()} disabled={busy || subscription.cancelAtPeriodEnd}>
                Cancel subscription
              </Button>
            </div>
          </div>
        )}
      </Panel>

      <Panel title="Plans" subtitle="Self-serve plan catalog with regional pricing.">
        <DataTable
          head={[
            { key: "name", label: "Plan" },
            { key: "tier", label: "Tier", render: (r) => <Badge tone="accent">{r.tier}</Badge> },
            { key: "price", label: "From", render: (r) => {
              const p = bestPlanPrice(r);
              return p ? <span>{moneyMinorToDisplay(p.amountMinor, p.currency)}<span className="muted"> /mo in {p.displayName}</span></span> : <span className="muted">—</span>;
            } },
            { key: "actions", label: "", render: (r) => (
              <div className="row-actions">
                <Button size="sm" kind="primary" onClick={() => openPlan(r)} disabled={busy || !r.available}>Choose {r.tier}</Button>
              </div>
            ) },
          ]}
          rows={plans}
          empty="No plans available yet."
        />
      </Panel>

      {checkoutFor ? (
        <Modal
          isOpen={true}
          onClose={() => { if (!busy) { setCheckoutFor(null); setCreatedSession(null); } }}
          title={`Subscribe — ${checkoutFor.name}`}
          footer={
            !createdSession ? (
              <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                <Button onClick={() => { setCheckoutFor(null); setCreatedSession(null); }} disabled={busy}>Cancel</Button>
                <Button kind="primary" disabled={busy || !providerName || !regionCode} onClick={() => void startCheckout()}>
                  {busy ? "Starting…" : "Start checkout"}
                </Button>
              </div>
            ) : (
              <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                <Button kind="ghost" onClick={() => window.open(createdSession.redirectUrl, "_blank", "noopener,noreferrer")} disabled={busy}>Open payment page</Button>
                <Button kind="primary" disabled={busy} onClick={() => void reconcile()}>
                  {busy ? "Reconciling…" : "I've paid — reconcile"}
                </Button>
              </div>
            )
          }
        >
          {!createdSession ? (
            <>
              <div className="form-grid">
                <label className="form-field">
                  Payment provider
                  <select value={providerName} onChange={(e) => setProviderName(e.target.value)}>
                    {providers.filter((b) => b.enabled && b.available).map((b) => <option key={b.providerName} value={b.providerName}>{b.displayName}</option>)}
                  </select>
                </label>
                <label className="form-field">
                  Region
                  <select value={regionCode} onChange={(e) => setRegionCode(e.target.value)}>
                    {checkoutFor.pricingRegions.filter((r) => r.available).map((r) => <option key={r.pricingRegionCode} value={r.pricingRegionCode}>{r.displayName} — {r.amountMinor === null ? "TBD" : moneyMinorToDisplay(r.amountMinor, r.currency)}</option>)}
                  </select>
                </label>
              </div>
              <p className="muted" style={{ fontSize: 12.5 }}>
                Checkout is handled by the payment provider directly. Pricing is quoted in the selected region's currency.
              </p>
              {status ? <p className="muted mono">{status}</p> : null}
            </>
          ) : (
            <>
              <EmptyState>
                Checkout session created — follow the provider's payment page to complete the purchase.
              </EmptyState>
              <p className="mono muted">session: {createdSession.sessionId}</p>
              <p className="mono muted">redirect: {createdSession.redirectUrl}</p>
              <p className="muted" style={{ fontSize: 12.5 }}>
                On this deployment the checkout happens in a provider window; when you return, confirm the session so billing can reconcile the payment.
              </p>
            </>
          )}
        </Modal>
      ) : null}

      <Panel title="Invoices">
        <DataTable
          head={[
            { key: "invoiceId", label: "Invoice", render: (r) => String(r.invoiceId) },
            { key: "periodStart", label: "Period", render: (r) => `${r.periodStart} → ${r.periodEnd}` },
            { key: "amountCents", label: "Amount", render: (r) => moneyMinorToDisplay(Number(r.amountCents), r.currency) },
            { key: "state", label: "State", render: (r) => <Badge tone={statusTone(r.state)}>{humanState(r.state)}</Badge> },
          ]}
          rows={invoices}
          empty="No invoices yet."
        />
      </Panel>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Backups (customer-only)
// ----------------------------------------------------------------------------

export function BackupsView() {
  const mox = useMox();
  const [overview, setOverview] = useState<BackupsOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState<{ id: string; message: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await mox.api.getBackupsOverview();
      setOverview(data);
      setLoading(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setLoading(false);
    }
  }, [mox.api]);

  useEffect(() => { void load(); }, [load]);

  const triggerBackup = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await mox.api.triggerManualBackup();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const testRestore = async (backupId: string) => {
    setBusy(true);
    setTestResult(null);
    try {
      const res = await mox.api.testBackupRestore(backupId);
      setTestResult({ id: backupId, message: res.message });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Backups"
        subtitle="Automated and manual snapshot archives for disaster recovery and offsite persistence."
        actions={
          <Button
            kind="primary"
            disabled={busy || (overview !== null && !overview.availability)}
            title={overview !== null && !overview.availability ? "Backups not included in current plan entitlement" : undefined}
            onClick={() => void triggerBackup()}
          >
            {busy ? "Backing up…" : "Create manual backup"}
          </Button>
        }
      />

      {error ? <ErrorState message={error} /> : null}
      {loading ? <LoadingState /> : null}
      {testResult ? (
        <div className="notice" style={{ marginBottom: 16 }}>
          <strong>Restore verification:</strong> {testResult.message} (backup <code>{testResult.id}</code>)
        </div>
      ) : null}
      <section className="kpi-row" aria-label="Backup summary">
        <KpiCard
          label="Retention allowance"
          value={overview ? `${overview.retentionDays} days` : "—"}
          hint={overview?.availability ? "Active plan allowance" : "Not included in plan"}
        />
        <KpiCard
          label="Last successful backup"
          value={overview?.lastSuccessfulAt ? new Date(overview.lastSuccessfulAt).toLocaleDateString() : "Never"}
          hint={overview?.lastSuccessfulAt ? new Date(overview.lastSuccessfulAt).toLocaleTimeString() : "No successful backups"}
        />
        <KpiCard
          label="Total snapshots"
          value={overview ? overview.backups.length : 0}
          hint={`Failed count: ${overview?.failedCount ?? 0}`}
        />
      </section>

      {overview?.cancellationExportSummary ? (
        <Panel title="Cancellation & Snapshot Retention Policy">
          <p className="muted" style={{ margin: 0 }}>
            <strong>{overview.cancellationExportSummary.description}</strong> — Even if compute servers are canceled or torn down, snapshots remain accessible offsite throughout the {overview.cancellationExportSummary.retentionWindowDays}-day retention window for cancellation export or migration.
          </p>
        </Panel>
      ) : null}

      <Panel title="Stored Backups">
        <DataTable
          head={[
            { key: "id", label: "Backup ID", render: (r) => <code className="mono">{r.backupId}</code> },
            { key: "kind", label: "Kind", render: (r) => humanState(r.kind) },
            {
              key: "state",
              label: "Status",
              render: (r) => (
                <Badge tone={r.state === "completed" ? "good" : r.state === "failed" ? "bad" : "warn"}>
                  {humanState(r.state)}
                </Badge>
              ),
            },
            { key: "size", label: "Size", render: (r) => r.sizeBytes ? `${(r.sizeBytes / (1024 * 1024)).toFixed(1)} MB` : "—" },
            { key: "location", label: "Storage Location", render: (r) => r.locationLabel },
            { key: "date", label: "Created At", render: (r) => new Date(r.createdAt).toLocaleString() },
            {
              key: "action",
              label: "Action",
              render: (r) => (
                <Button size="sm" disabled={busy || r.state !== "completed"} onClick={() => void testRestore(r.backupId)}>
                  Verify Integrity
                </Button>
              ),
            },
          ]}
          rows={overview?.backups ?? []}
          empty="No backups created yet."
        />
      </Panel>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Settings (customer-only)
// ----------------------------------------------------------------------------


function ThemeSettings() {
  const { theme, setTheme } = useTheme();
  return (
    <div className="theme-control">
      <div className="theme-control-label">Theme</div>
      <p className="theme-control-hint muted">Use your device setting, or choose a fixed appearance.</p>
      <div className="theme-segmented">
        <button
          type="button"
          aria-checked={theme === "system"}
          onClick={() => setTheme("system")}
        >
          System
        </button>
        <button
          type="button"
          aria-checked={theme === "light"}
          onClick={() => setTheme("light")}
        >
          Light
        </button>
        <button
          type="button"
          aria-checked={theme === "dark"}
          onClick={() => setTheme("dark")}
        >
          Dark
        </button>
      </div>
    </div>
  );
}

export function SettingsView() {
  const mox = useMox();
  const ents = useEntitlements();
  const caps = ents?.values ?? {};
  const enabled = CANONICAL_ENTITLEMENT_KEYS.filter((k) => {
    const v = caps[k];
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v > 0;
    if (typeof v === "string") return v !== "";
    return false;
  });

  const [tokens, setTokens] = useState<Awaited<ReturnType<typeof mox.api.listApiTokens>>>([]);
  const [newTokenName, setNewTokenName] = useState("");
  const [newTokenScopes, setNewTokenScopes] = useState("");
  const [latestToken, setLatestToken] = useState<CreatedApiTokenView | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [loadingTokens, setLoadingTokens] = useState(true);
  const [busy, setBusy] = useState(false);

  const loadTokens = useCallback(async () => {
    try {
      setTokens(await mox.api.listApiTokens());
      setLoadingTokens(false);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
      setLoadingTokens(false);
    }
  }, [mox.api]);

  useEffect(() => { void loadTokens(); }, [loadTokens]);

  let cliBaseUrl = "";
  try {
    const cfg = resolveWebConfig(import.meta.env);
    if (cfg.mode === "production-api") cliBaseUrl = cfg.apiBaseUrl;
  } catch {
    // Production builds require a valid configured URL; a missing one leaves
    // the CLI snippet generic rather than leaking an empty/incorrect URL.
  }

  // Phase 04 §D: Team state
  const [team, setTeam] = useState<WorkspaceTeamOverview | null>(null);
  const [loadingTeam, setLoadingTeam] = useState(true);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "member" | "viewer">("member");
  const [createdInvite, setCreatedInvite] = useState<CreatedWorkspaceInvitation | null>(null);
  const [teamError, setTeamError] = useState<string | null>(null);

  // Phase 04 §B: Notification preferences state
  const [notifPrefs, setNotifPrefs] = useState<NotificationPreferencesView | null>(null);
  const [loadingNotifs, setLoadingNotifs] = useState(true);
  const [notifError, setNotifError] = useState<string | null>(null);
  const [savingNotifs, setSavingNotifs] = useState(false);
  const [notifSuccess, setNotifSuccess] = useState<string | null>(null);

  // Phase 04 §E/§H: Knowledge sources & storage state
  const [knowledgeSources, setKnowledgeSources] = useState<KnowledgeSourceItem[]>([]);
  const [loadingKnowledge, setLoadingKnowledge] = useState(true);
  const [knowledgeError, setKnowledgeError] = useState<string | null>(null);
  const [newKnowledgeName, setNewKnowledgeName] = useState("");
  const [newKnowledgeKind, setNewKnowledgeKind] = useState("document");

  const loadTeam = useCallback(async () => {
    try {
      setTeam(await mox.api.getTeamOverview());
      setLoadingTeam(false);
    } catch (e) {
      setTeamError(e instanceof Error ? e.message : String(e));
      setLoadingTeam(false);
    }
  }, [mox.api]);

  const loadNotifPrefs = useCallback(async () => {
    try {
      setNotifPrefs(await mox.api.getNotificationPreferences());
      setLoadingNotifs(false);
    } catch (e) {
      setNotifError(e instanceof Error ? e.message : String(e));
      setLoadingNotifs(false);
    }
  }, [mox.api]);

  const loadKnowledge = useCallback(async () => {
    try {
      setKnowledgeSources(await mox.api.listKnowledgeSources());
      setLoadingKnowledge(false);
    } catch (e) {
      setKnowledgeError(e instanceof Error ? e.message : String(e));
      setLoadingKnowledge(false);
    }
  }, [mox.api]);

  useEffect(() => {
    void loadTeam();
    void loadNotifPrefs();
    void loadKnowledge();
  }, [loadTeam, loadNotifPrefs, loadKnowledge]);

  const handleInvite = async () => {
    const email = inviteEmail.trim();
    if (!email || busy) return;
    setBusy(true);
    setTeamError(null);
    try {
      const inv = await mox.api.inviteTeamMember(email, inviteRole);
      setCreatedInvite(inv);
      setInviteEmail("");
      await loadTeam();
    } catch (e) {
      setTeamError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleRevokeInvite = async (invitationId: string) => {
    setBusy(true);
    setTeamError(null);
    try {
      await mox.api.revokeTeamInvitation(invitationId);
      await loadTeam();
    } catch (e) {
      setTeamError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleUpdateRole = async (userId: string, role: "admin" | "member" | "viewer") => {
    setBusy(true);
    setTeamError(null);
    try {
      await mox.api.updateTeamMemberRole(userId, role);
      await loadTeam();
    } catch (e) {
      setTeamError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleRemoveMember = async (userId: string) => {
    if (!window.confirm("Remove this team member from the workspace?")) return;
    setBusy(true);
    setTeamError(null);
    try {
      await mox.api.removeTeamMember(userId);
      await loadTeam();
    } catch (e) {
      setTeamError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleRoute = (eventType: string, route: "in_app" | "email" | "web_push") => {
    if (!notifPrefs) return;
    setNotifPrefs({
      ...notifPrefs,
      items: notifPrefs.items.map((item) => {
        if (item.eventType !== eventType) return item;
        const exists = item.routes.includes(route);
        const nextRoutes = exists ? item.routes.filter((r) => r !== route) : [...item.routes, route];
        return { ...item, routes: nextRoutes };
      }),
    });
  };

  const toggleMute = (eventType: string) => {
    if (!notifPrefs) return;
    setNotifPrefs({
      ...notifPrefs,
      items: notifPrefs.items.map((item) => {
        if (item.eventType !== eventType) return item;
        if (item.mandatory) return item;
        return { ...item, muted: !item.muted };
      }),
    });
  };

  const saveNotifPrefs = async () => {
    if (!notifPrefs || savingNotifs) return;
    setSavingNotifs(true);
    setNotifError(null);
    setNotifSuccess(null);
    try {
      const routes: Record<string, string[]> = {};
      const mutedEventTypes: string[] = [];
      for (const item of notifPrefs.items) {
        routes[item.eventType] = item.routes;
        if (item.muted) mutedEventTypes.push(item.eventType);
      }
      const updated = await mox.api.updateNotificationPreferences({ routes, mutedEventTypes });
      setNotifPrefs(updated);
      setNotifSuccess("Notification preferences saved successfully.");
    } catch (e) {
      setNotifError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingNotifs(false);
    }
  };

  const handleCreateKnowledge = async () => {
    const name = newKnowledgeName.trim();
    if (!name || busy) return;
    setBusy(true);
    setKnowledgeError(null);
    try {
      await mox.api.createKnowledgeSource({ name, kind: newKnowledgeKind });
      setNewKnowledgeName("");
      await loadKnowledge();
    } catch (e) {
      setKnowledgeError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteKnowledge = async (id: string) => {
    if (!window.confirm("Delete this knowledge source? Agents referencing it will lose grounding access.")) return;
    setBusy(true);
    setKnowledgeError(null);
    try {
      await mox.api.deleteKnowledgeSource(id);
      await loadKnowledge();
    } catch (e) {
      setKnowledgeError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const createToken = async () => {

    const name = newTokenName.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      const scopes = newTokenScopes.split(",").map((s) => s.trim()).filter(Boolean);
      const created = await mox.api.createApiToken({ name, scopes: scopes.length ? scopes : undefined });
      setLatestToken(created);
      setNewTokenName("");
      setNewTokenScopes("");
      await loadTokens();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const revokeToken = async (tokenId: string) => {
    setBusy(true);
    try {
      await mox.api.revokeApiToken(tokenId);
      await loadTokens();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const [settingsTab, setSettingsTab] = useState<"profile" | "workspace" | "team" | "notifications" | "developer">(() => {
    if (typeof window !== "undefined" && window.location.hash === "#knowledge") return "developer";
    return "profile";
  });

  return (
    <div className="settings-page">
      <PageHeader title="Settings" subtitle="Profile, workspace, team, notifications, and developer access." />
      <nav className="settings-tabs" aria-label="Settings sections">
        {([
          ["profile", "Profile"],
          ["workspace", "Workspace"],
          ["team", "Team"],
          ["notifications", "Notifications"],
          ["developer", "Developer"],
        ] as const).map(([id, label]) => (
          <button key={id} type="button" className={settingsTab === id ? "active" : ""} onClick={() => setSettingsTab(id)}>
            {label}
          </button>
        ))}
      </nav>
      <div hidden={settingsTab !== "profile"}>
      <div className="settings-grid">
        <Panel title="Profile" subtitle="Signed-in identity">
          {mox.me ? (
            <>
              <p><strong>Organization:</strong> {mox.me.orgDisplayName}</p>
              <p><strong>Email:</strong> {mox.me.email}</p>
              <p><strong>Role in workspace:</strong> {humanState(mox.me.role)}</p>
            </>
          ) : (
            <p className="muted">Workspace identity available after sign-in.</p>
          )}
        </Panel>
        
        <Panel title="Appearance" subtitle="Manage your theme preference">
          <ThemeSettings />
        </Panel>
      </div>
      </div>
      <div hidden={settingsTab !== "workspace"}>
        <Panel title="Workspace capabilities" subtitle={ents?.commerciallyEntitled ? "Entitlements for this workspace" : "Commercial access is currently denied"}>
          {!ents?.commerciallyEntitled ? (
            <EmptyState>
              {ents?.commerciallyEntitled === false
                ? "Commercial access is not currently active for this workspace. Capability values are hidden until access is restored."
                : "No capability data available."}
            </EmptyState>
          ) : enabled.length === 0 ? (
            <EmptyState>No add-on capabilities enabled.</EmptyState>
          ) : (
            <ul className="cap-list">
              {CANONICAL_ENTITLEMENT_KEYS.filter((k) => caps[k] !== undefined && caps[k] !== "" && caps[k] !== false && caps[k] !== 0).map((k) => (
                <li key={k}><Badge tone="accent">{humanState(k)}</Badge> <span className="muted">{String(caps[k])}</span></li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <div hidden={settingsTab !== "team"}>
      <Panel
        id="team"
        title="Team Members & Collaboration"
        subtitle={team ? `${team.totalUsed} of ${team.limit} seats allocated on current plan` : "Workspace membership"}
      >
        <p className="muted" style={{ marginBottom: 10 }}>
          Manage workspace members and invitations. At least one workspace owner is required at all times; owner accounts cannot be removed or demoted.
        </p>
        {teamError ? <ErrorState message={teamError} /> : null}
        {createdInvite ? (
          <div className="notice" style={{ marginBottom: 12 }}>
            <p style={{ margin: "0 0 4px" }}><strong>Invitation generated for {createdInvite.email}:</strong></p>
            <code className="mono">{createdInvite.inviteUrl}</code>
            <p className="muted" style={{ margin: "4px 0 0", fontSize: 12 }}>Role: {humanState(createdInvite.role)} · Expires: {new Date(createdInvite.expiresAt).toLocaleDateString()}</p>
          </div>
        ) : null}

        <div className="form-grid" style={{ marginBottom: 16 }}>
          <label className="form-field">
            Email address
            <input
              type="email"
              value={inviteEmail}
              placeholder="colleague@example.com"
              onChange={(e) => setInviteEmail(e.target.value)}
              disabled={busy}
            />
          </label>
          <label className="form-field">
            Role
            <select
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value as "admin" | "member" | "viewer")}
              disabled={busy}
            >
              <option value="admin">Admin (full workspace management)</option>
              <option value="member">Member (build, deploy, run agents)</option>
              <option value="viewer">Viewer (read-only audit access)</option>
            </select>
          </label>
          <div className="row-actions" style={{ alignItems: "flex-end" }}>
            <Button
              kind="primary"
              disabled={busy || !inviteEmail.trim()}
              onClick={() => void handleInvite()}
            >
              {busy ? "Sending…" : "Send Invitation"}
            </Button>
          </div>
        </div>

        {team?.invitations && team.invitations.length > 0 ? (
          <div style={{ marginBottom: 16 }}>
            <h4 style={{ margin: "0 0 8px" }}>Pending Invitations</h4>
            <DataTable
              head={[
                { key: "email", label: "Email" },
                { key: "role", label: "Role", render: (r) => <Badge tone="accent">{humanState(r.role)}</Badge> },
                { key: "expires", label: "Expires", render: (r) => new Date(r.expiresAt).toLocaleDateString() },
                {
                  key: "action",
                  label: "",
                  render: (r) => (
                    <Button size="sm" kind="danger" disabled={busy} onClick={() => void handleRevokeInvite(r.id)}>
                      Revoke
                    </Button>
                  ),
                },
              ]}
              rows={team.invitations}
              empty="No pending invitations."
            />
          </div>
        ) : null}

        <h4 style={{ margin: "0 0 8px" }}>Active Members</h4>
        {loadingTeam ? <LoadingState label="Loading team members…" /> : (
          <DataTable
            head={[
              { key: "name", label: "Name", render: (r) => r.displayName || r.email },
              { key: "email", label: "Email" },
              {
                key: "role",
                label: "Role",
                render: (r) => (
                  <div style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                    <Badge tone={r.isOwner ? "good" : "neutral"}>{humanState(r.role)}</Badge>
                    {r.isOwner ? <small className="muted">(Owner)</small> : null}
                  </div>
                ),
              },
              { key: "joined", label: "Joined", render: (r) => r.joinedAt ? new Date(r.joinedAt).toLocaleDateString() : "—" },
              {
                key: "actions",
                label: "",
                render: (r) => {
                  if (r.isOwner) return <span className="muted">Protected</span>;
                  return (
                    <div style={{ display: "flex", gap: 6 }}>
                      <select
                        value={r.role}
                        onChange={(e) => void handleUpdateRole(r.userId, e.target.value as "admin" | "member" | "viewer")}
                        disabled={busy}
                        style={{ padding: "2px 6px", fontSize: 12 }}
                        aria-label={`Change role for ${r.email}`}
                      >
                        <option value="admin">Admin</option>
                        <option value="member">Member</option>
                        <option value="viewer">Viewer</option>
                      </select>
                      <Button size="sm" kind="danger" disabled={busy} onClick={() => void handleRemoveMember(r.userId)}>
                        Remove
                      </Button>
                    </div>
                  );
                },
              },
            ]}
            rows={team?.members ?? []}
            empty="No team members loaded."
          />
        )}
      </Panel>
      </div>

      <div hidden={settingsTab !== "notifications"}>
      <Panel
        id="notifications"
        title="Notification Preferences"
        subtitle="Manage routing channels and mute alert categories"
        actions={
          <Button
            kind="primary"
            size="sm"
            disabled={savingNotifs || loadingNotifs}
            onClick={() => void saveNotifPrefs()}
          >
            {savingNotifs ? "Saving…" : "Save preferences"}
          </Button>
        }
      >
        <p className="muted" style={{ marginBottom: 10 }}>
          Configure delivery channels (in-app notifications, email, browser push). Mandatory alerts (security incidents and billing status updates) cannot be muted to ensure account security.
        </p>
        {notifError ? <ErrorState message={notifError} /> : null}
        {notifSuccess ? <div className="notice" style={{ marginBottom: 12 }}>{notifSuccess}</div> : null}
        {loadingNotifs ? <LoadingState label="Loading notification preferences…" /> : (
          <DataTable
            head={[
              { key: "title", label: "Notification Event" },
              {
                key: "category",
                label: "Category",
                render: (r) => (
                  <Badge tone={r.mandatory ? "bad" : "neutral"}>
                    {humanState(r.category)} {r.mandatory ? "· Mandatory" : ""}
                  </Badge>
                ),
              },
              {
                key: "routes",
                label: "Delivery Channels",
                render: (r) => (
                  <div style={{ display: "inline-flex", gap: 12, alignItems: "center" }}>
                    <label style={{ display: "inline-flex", gap: 4, alignItems: "center", fontSize: 12.5 }}>
                      <input
                        type="checkbox"
                        checked={r.routes.includes("in_app")}
                        onChange={() => toggleRoute(r.eventType, "in_app")}
                      />
                      In-app
                    </label>
                    <label style={{ display: "inline-flex", gap: 4, alignItems: "center", fontSize: 12.5 }}>
                      <input
                        type="checkbox"
                        checked={r.routes.includes("email")}
                        onChange={() => toggleRoute(r.eventType, "email")}
                      />
                      Email
                    </label>
                    <label style={{ display: "inline-flex", gap: 4, alignItems: "center", fontSize: 12.5 }}>
                      <input
                        type="checkbox"
                        checked={r.routes.includes("web_push")}
                        onChange={() => toggleRoute(r.eventType, "web_push")}
                      />
                      Push
                    </label>
                  </div>
                ),
              },
              {
                key: "muted",
                label: "Mute",
                render: (r) => (
                  r.mandatory ? (
                    <span className="muted" style={{ fontSize: 12 }}>Required</span>
                  ) : (
                    <input
                      type="checkbox"
                      checked={r.muted}
                      onChange={() => toggleMute(r.eventType)}
                      aria-label={`Mute ${r.title}`}
                    />
                  )
                ),
              },
            ]}
            rows={notifPrefs?.items ?? []}
            empty="No notifications configured."
          />
        )}
      </Panel>
      </div>

      <div hidden={settingsTab !== "developer"}>
      <Panel
        id="knowledge"
        title="Knowledge Sources & Storage"
        subtitle={`Storage quota: ${typeof caps.storage_gb === "number" ? `${caps.storage_gb} GB` : "10 GB"} allowance`}
      >
        <p className="muted" style={{ marginBottom: 10 }}>
          Manage organization knowledge resources and document stores for agent context grounding (RAG). Note: This persistent knowledge storage is distinct from isolated agent container execution scratchpads.
        </p>
        {knowledgeError ? <ErrorState message={knowledgeError} /> : null}
        <div className="form-grid" style={{ marginBottom: 16 }}>
          <label className="form-field">
            Source name
            <input
              value={newKnowledgeName}
              placeholder="e.g. Product Documentation, API Reference"
              onChange={(e) => setNewKnowledgeName(e.target.value)}
              disabled={busy}
            />
          </label>
          <label className="form-field">
            Source kind
            <select
              value={newKnowledgeKind}
              onChange={(e) => setNewKnowledgeKind(e.target.value)}
              disabled={busy}
            >
              <option value="document">Document catalog (PDF, Markdown, Text)</option>
              <option value="website">Web crawl & scraped knowledge</option>
              <option value="api">External API schema / OpenAPI</option>
              <option value="database">Structured data / database dictionary</option>
            </select>
          </label>
          <div className="row-actions" style={{ alignItems: "flex-end" }}>
            <Button
              kind="primary"
              disabled={busy || !newKnowledgeName.trim()}
              onClick={() => void handleCreateKnowledge()}
            >
              {busy ? "Adding…" : "Add Knowledge Source"}
            </Button>
          </div>
        </div>
        {loadingKnowledge ? <LoadingState label="Loading knowledge sources…" /> : (
          <DataTable
            head={[
              { key: "name", label: "Name" },
              { key: "kind", label: "Kind", render: (r) => <Badge tone="accent">{r.kind}</Badge> },
              { key: "created", label: "Created", render: (r) => new Date(r.createdAt).toLocaleDateString() },
              { key: "synced", label: "Last Synced", render: (r) => r.lastSyncedAt ? new Date(r.lastSyncedAt).toLocaleString() : "—" },
              {
                key: "actions",
                label: "",
                render: (r) => (
                  <Button size="sm" kind="danger" disabled={busy} onClick={() => void handleDeleteKnowledge(r.id)}>
                    Delete
                  </Button>
                ),
              },
            ]}
            rows={knowledgeSources}
            empty="No knowledge sources registered yet."
          />
        )}
      </Panel>

      <Panel id="developer" title="Developer" subtitle="Personal API tokens for the Mox API.">
        <p className="muted" style={{ marginBottom: 10 }}>
          Tokens grant access scoped to you and your workspace. The plaintext value is shown once at creation — store it somewhere safe.
        </p>
        {status ? <p className="muted mono" role="status">{status}</p> : null}
        {latestToken ? (
          <div className="notice" style={{ marginBottom: 12 }}>
            <p style={{ margin: "0 0 6px" }}>Token created — this is the only time the plaintext is shown:</p>
            <code className="mono">{latestToken.token}</code>
            <p className="muted" style={{ margin: "6px 0 0", fontSize: 12.5 }}>expires {latestToken.expiresAt} · scopes: {latestToken.scopes.join(", ")}</p>
          </div>
        ) : null}
        <div className="form-grid" style={{ marginBottom: 12 }}>
          <label className="form-field">
            Token name
            <input value={newTokenName} placeholder="e.g. ci-deploy" onChange={(e) => setNewTokenName(e.target.value)} />
          </label>
          <label className="form-field">
            Scopes (comma-separated, optional)
            <input value={newTokenScopes} placeholder="agents:read, deployments:write" onChange={(e) => setNewTokenScopes(e.target.value)} />
          </label>
          <div className="row-actions" style={{ alignItems: "flex-end" }}>
            <Button kind="primary" disabled={busy || !newTokenName.trim()} onClick={() => void createToken()}>{busy ? "Creating…" : "Create token"}</Button>
          </div>
        </div>
        {loadingTokens ? <LoadingState label="Loading tokens…" /> : (
          <DataTable
            head={[
              { key: "name", label: "Name" },
              { key: "scopes", label: "Scopes", render: (r) => r.scopes.join(", ") },
              { key: "createdAt", label: "Created" },
              { key: "status", label: "Status", render: (r) => (r.revoked ? <Badge tone="bad">revoked</Badge> : <Badge tone="good">active</Badge>) },
              { key: "actions", label: "", render: (r) => (
                r.revoked ? <span className="muted">—</span> : <Button size="sm" kind="danger" onClick={() => void revokeToken(r.tokenId)} disabled={busy}>Revoke</Button>
              ) },
            ]}
            rows={tokens}
            empty="No personal tokens yet."
          />
        )}
        <div className="notice" style={{ marginTop: 12 }}>
          <p className="muted" style={{ margin: "0 0 6px" }}>CLI usage — point the Mox CLI at this app's control plane and authenticate with a token:</p>
          <pre className="mono" style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
{`mox config set api_url ${cliBaseUrl || "<https API URL>"}\nmox --token "\${TOKEN}" me\nmox --token "\${TOKEN}" agents list`}
          </pre>
        </div>
      </Panel>
      </div>
    </div>
  );
}
