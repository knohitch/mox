import { useCallback, useEffect, useState } from "react";
import { useMox } from "../api/store.js";
import { useAgentRooms, useModelConnections, useEntitlements } from "../api/store.js";
import { CANONICAL_ENTITLEMENT_KEYS } from "../api/entitlement.js";
import { Avatar, Badge, Button, DataTable, EmptyState, ErrorState, KpiCard, LoadingState, PageHeader, Panel } from "../ui/primitives.js";
import { Markdown } from "../ui/markdown.js";
import { Link } from "../router.js";
import type { AgentDeployment, AgentRoom } from "@mox/contracts";
import type { AgentSummary, AgentVersionRow, ServerSummary } from "../api/types.js";
import type { AgentStatus } from "../domain/roster.js";

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
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([mox.api.listServers(), mox.api.listDeployments(), mox.api.getUsage()])
      .then(([s, d, u]) => {
        setServers(s);
        setDeployments(d);
        setUsage(u);
      })
      .catch((e: unknown) => setLoadError(e instanceof Error ? e.message : String(e)));
  }, [mox.api]);

  const agents = mox.agents;
  const working = agents.filter((a) => (a.runtimeStatus ?? "").toLowerCase().startsWith("busy")).length;
  const runningServers = servers.filter((s) => s.state === "running").length;
  const healthyDeps = deployments.filter((d) => d.state === "running").length;

  return (
    <div className="home">
      <PageHeader
        title={`${greeting()}`}
        subtitle={mox.me ? `${mox.me.orgDisplayName} — workspace overview` : "Mox workspace overview"}
      />

      {loadError ? (
        <ErrorState message={`Some summary data is unavailable right now: ${loadError}`} onRetry={() => window.location.reload()} />
      ) : null}

      <section className="kpi-row" aria-label="Key metrics">
        <KpiCard label="Agents" value={agents.length} hint={`${working} working now`} />
        <KpiCard label="Deployments" value={deployments.length} hint={`${healthyDeps} healthy`} tone={deployments.length && deployments.length === healthyDeps ? "good" : "warn"} />
        <KpiCard label="Open approvals" value={mox.approvals.length} hint="awaiting decision" tone={mox.approvals.length ? "accent" : undefined} />
        <KpiCard label="Servers" value={servers.length} hint={`${runningServers} running`} tone={servers.length && servers.length === runningServers ? "good" : "warn"} />
      </section>

      <div className="home-grid">
        <Panel title="Agents" subtitle="Active agents in this workspace">
          {agents.length === 0 ? (
            <EmptyState>No agents yet. Create your first agent to get started.</EmptyState>
          ) : agents.length > 6 ? (
            <>{agents.slice(0, 6).map((a) => <AgentRow key={a.agentId} agent={a} />)}<p className="muted">… and {agents.length - 6} more.</p></>
          ) : (
            agents.map((a) => <AgentRow key={a.agentId} agent={a} />)
          )}
          {agents.length ? (
            <div style={{ marginTop: 8 }}>
              <Link to="/agents" className="linklike">View all agents →</Link>
            </div>
          ) : null}
        </Panel>

        <Panel title="Pending approvals" subtitle="Human gates that need a decision">
          {mox.approvals.length === 0 ? (
            <EmptyState>All clear — no open human approval gates.</EmptyState>
          ) : (
            mox.approvals.slice(0, 5).map((ap) => (
              <div key={ap.approvalId} className="approval-card">
                <strong>{ap.summary || "Approval required"}</strong>
                <div className="row">
                  <Button kind="primary" size="sm" onClick={() => void mox.resolveApproval(ap.approvalId, "approved")}>Approve</Button>
                  <Button kind="danger" size="sm" onClick={() => void mox.resolveApproval(ap.approvalId, "denied")}>Deny</Button>
                </div>
              </div>
            ))
          )}
        </Panel>
      </div>

      <div className="home-grid">
        <Panel title="Deployments" subtitle="Recent deployment activity">
          {deployments.length === 0 ? (
            <EmptyState>No deployments yet.</EmptyState>
          ) : (
            <DataTable
              head={[
                { key: "agentId", label: "Agent", render: (r) => agentName(mox.agents, r.agentId) },
                { key: "target", label: "Target", render: (r) => humanState(r.target?.kind) },
                { key: "state", label: "State", render: (r) => <Badge tone={statusTone(r.state)}>{humanState(r.state)}</Badge> },
              ]}
              rows={deployments.slice(0, 6)}
            />
          )}
        </Panel>

        <Panel title="Usage" subtitle="This billing period (top line) by metric">
          {usage.length === 0 ? (
            <EmptyState>No usage recorded this period.</EmptyState>
          ) : (
            <DataTable
              head={[
                { key: "metric", label: "Metric", render: (r) => humanState(r.metric) },
                { key: "quantity", label: "Quantity", render: (r) => r.quantity.toLocaleString() },
                { key: "unit", label: "Unit" },
              ]}
              rows={usage.slice(0, 5)}
            />
          )}
          <div style={{ marginTop: 8 }}>
            <Link to="/usage" className="linklike">Full usage report →</Link>
          </div>
        </Panel>
      </div>
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

  if (!roomsAllowed) return <EmptyState>Agent Rooms are not enabled for this workspace.</EmptyState>;

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
      <PageHeader title="Servers" subtitle="Compute infrastructure hosting your agents." />
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
    </div>
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
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div className="modal" role="dialog" aria-modal="true" aria-label="Deploy agent" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h3>Deploy agent</h3>
          <Button kind="ghost" size="sm" onClick={onClose}>✕</Button>
        </header>
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
        <footer className="modal-foot">
          <span className="muted" style={{ fontSize: 12.5 }}>Deploying sets the desired state; the orchestrator reconciles it.</span>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <Button onClick={onClose} disabled={busy}>Cancel</Button>
            <Button kind="primary" disabled={busy || typeof revision !== "number" || !agentId} onClick={() => void deploy()}>
              {busy ? "Deploying…" : "Deploy"}
            </Button>
          </div>
        </footer>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Models
// ----------------------------------------------------------------------------

export function ModelsView() {
  const mox = useMox();
  const custom = useModelConnections();
  const [models, setModels] = useState<Awaited<ReturnType<typeof mox.api.listModels>>>([]);
  const [cliEngines, setCliEngines] = useState<Awaited<ReturnType<typeof mox.api.listCliEngines>>>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void Promise.all([mox.api.listModels(), mox.api.listCliEngines().catch(() => [])])
      .then(([m, c]) => {
        setModels(m);
        setCliEngines(c);
        setLoading(false);
      })
      .catch((e: unknown) => { setError(e instanceof Error ? e.message : String(e)); setLoading(false); });
  }, [mox.api]);

  return (
    <div>
      <PageHeader title="Models" subtitle="Model providers available to your agents." />
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
      {custom ? (
        <Panel title="Connection test" subtitle="Test provider credentials without exposing secrets.">
          <div className="row-actions" style={{ flexWrap: "wrap" }}>
            {models.slice(0, 4).map((m) => (
              <Button
                key={m.providerId}
                kind="ghost"
                onClick={() =>
                  void mox.api.testProviderConnection(m.providerId).then((r) =>
                    setStatus(`${m.displayName}: ${r.ok ? "connection OK" : r.reason ?? "failed"}`),
                  )
                }
              >
                Test {m.providerId.replace("p_", "")}
              </Button>
            ))}
          </div>
          {status ? <p className="muted mono">{status}</p> : null}
        </Panel>
      ) : null}
      <Panel title="Subscription engines" subtitle="Official device login only.">
        <DataTable
          head={[
            { key: "displayName", label: "Engine" },
            { key: "supportTier", label: "Support tier", render: (r) => humanState(r.supportTier) },
            { key: "state", label: "State", render: (r) => <Badge tone={statusTone(r.state)}>{humanState(r.state)}</Badge> },
            { key: "reason", label: "Note", render: (r) => String(r.reason ?? "") },
          ]}
          rows={cliEngines}
          empty="No device engines."
        />
      </Panel>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Integrations & Channels
// ----------------------------------------------------------------------------

export function IntegrationsView() {
  const mox = useMox();
  const [items, setItems] = useState<Awaited<ReturnType<typeof mox.api.listIntegrations>>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void mox.api.listIntegrations().then((i) => { setItems(i); setLoading(false); }).catch((e: unknown) => { setError(e instanceof Error ? e.message : String(e)); setLoading(false); });
  }, [mox.api]);

  return (
    <div>
      <PageHeader title="Apps & Integrations" subtitle="Third-party apps connected to your workspace." />
      {error ? <ErrorState message={error} /> : null}
      {loading ? <LoadingState /> : null}
      <Panel>
        <DataTable
          head={[
            { key: "displayName", label: "App" },
            { key: "connected", label: "Status", render: (r) => (r.connected ? <Badge tone="good">connected</Badge> : <Badge>not connected</Badge>) },
          ]}
          rows={items}
          empty="No integrations configured."
        />
      </Panel>
    </div>
  );
}

export function ChannelsView() {
  const mox = useMox();
  const [channels, setChannels] = useState<Awaited<ReturnType<typeof mox.api.listChannels>>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void mox.api.listChannels().then((c) => { setChannels(c); setLoading(false); }).catch((e: unknown) => { setError(e instanceof Error ? e.message : String(e)); setLoading(false); });
  }, [mox.api]);

  return (
    <div>
      <PageHeader title="Channels" subtitle="Messaging channels your agents can send and receive through." />
      {error ? <ErrorState message={error} /> : null}
      {loading ? <LoadingState /> : null}
      <Panel>
        <DataTable
          head={[
            { key: "displayName", label: "Channel" },
            { key: "kind", label: "Kind", render: (r) => humanState(r.kind) },
            { key: "connected", label: "Status", render: (r) => (r.connected ? <Badge tone="good">connected</Badge> : <Badge>not connected</Badge>) },
          ]}
          rows={channels}
          empty="No channels configured."
        />
      </Panel>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Usage
// ----------------------------------------------------------------------------

export function UsageView() {
  const mox = useMox();
  const [usage, setUsage] = useState<Awaited<ReturnType<typeof mox.api.getUsage>>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  useEffect(() => {
    void mox.api.getUsage().then((u) => { setUsage(u); setTotal(u.reduce((n, x) => n + x.quantity, 0)); setLoading(false); }).catch((e: unknown) => { setError(e instanceof Error ? e.message : String(e)); setLoading(false); });
  }, [mox.api]);

  return (
    <div>
      <PageHeader title="Usage" subtitle="Consumption in the current billing period." />
      {error ? <ErrorState message={error} /> : null}
      {loading ? <LoadingState /> : null}
      <section className="kpi-row" aria-label="Usage summary">
        <KpiCard label="Total measured units" value={total.toLocaleString()} hint="across this period" />
        <KpiCard label="Line items" value={usage.length} hint="distinct metrics tracked" />
      </section>
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void mox.api.listInvoices().then((i) => { setInvoices(i); setLoading(false); }).catch((e: unknown) => { setError(e instanceof Error ? e.message : String(e)); setLoading(false); });
  }, [mox.api]);

  const open = invoices.filter((i) => i.state === "open");
  const totalCents = invoices.reduce((n, i) => n + i.amountCents, 0);

  return (
    <div>
      <PageHeader title="Billing" subtitle="Plans, invoices and spending for this workspace." />
      {error ? <ErrorState message={error} /> : null}
      {loading ? <LoadingState /> : null}
      <section className="kpi-row" aria-label="Billing summary">
        <KpiCard label="Open invoices" value={open.length} hint="awaiting payment" tone={open.length ? "warn" : "good"} />
        <KpiCard label="Total invoiced" value={`${(totalCents / 100).toFixed(2)} ${invoices[0]?.currency ?? ""}`.trim()} hint="all periods" />
      </section>
      <Panel title="Plan">
        <div className="notice">
          Your workspace is billed through the Mox billing service. Plans, regional pricing and add-ons are managed
          centrally — there is no self-serve pricing here.
        </div>
      </Panel>
      <Panel title="Invoices">
        <DataTable
          head={[
            { key: "invoiceId", label: "Invoice", render: (r) => String(r.invoiceId) },
            { key: "periodStart", label: "Period", render: (r) => `${r.periodStart} → ${r.periodEnd}` },
            { key: "amountCents", label: "Amount", render: (r) => `${(Number(r.amountCents) / 100).toFixed(2)} ${r.currency}` },
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
// Settings (customer-only)
// ----------------------------------------------------------------------------

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
  return (
    <div>
      <PageHeader title="Settings" subtitle="Workspace capabilities and account details." />
      <div className="settings-grid">
        <Panel title="Workspace" subtitle="Identity and residency">
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
        <Panel title="Capabilities" subtitle={ents?.commerciallyEntitled ? "Entitlements for this workspace" : "Commercial access is currently denied"}>
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
    </div>
  );
}
