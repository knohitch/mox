import { useEffect, useState } from "react";
import { useMox, useEntitlement } from "../api/store.js";
import { Avatar, Badge, Card, EmptyState } from "../ui/primitives.js";
import { Markdown } from "../ui/markdown.js";
import type { AgentRoom } from "@mox/contracts";

export function HomeView() {
  const mox = useMox();
  const working = mox.agents.filter((a) => a.runtimeStatus === "busy").length;
  const degraded = mox.agents.filter((a) => a.deploymentState === "degraded" || a.deploymentState === "failed").length;
  return (
    <div>
      <h1>Home</h1>
      <div className="demo-banner">Demo workspace — data is local to this browser session until the control plane is connected.</div>
      <div className="grid grid-3">
        <Card title="Agents">
          <h1 style={{ margin: 0 }}>{mox.agents.length}</h1>
          <div className="muted">{working} working right now</div>
        </Card>
        <Card title="Deployments">
          <h1 style={{ margin: 0 }}>{mox.agents.length - mox.agents.filter((a) => a.deploymentState === "stopped").length}</h1>
          <div className="muted">{degraded} need attention</div>
        </Card>
        <Card title="Approvals">
          <h1 style={{ margin: 0 }}>{mox.approvals.length}</h1>
          <div className="muted">open human gates</div>
        </Card>
      </div>
    </div>
  );
}

export function RoomsView() {
  const mox = useMox();
  const roomsAllowed = useEntitlement("rooms");
  const [rooms, setRooms] = useState<AgentRoom[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  useEffect(() => {
    void mox.api.listRooms().then(setRooms);
  }, [mox.api]);
  const selected = rooms.find((r) => r.roomId === selectedId) ?? null;

  if (!roomsAllowed) return <EmptyState>Rooms are not enabled for this workspace.</EmptyState>;

  return (
    <div>
      <h1>Agent Rooms</h1>
      <div className="grid grid-2">
        <Card title={`Rooms (${rooms.length})`}>
          {rooms.map((r) => (
            <div key={r.roomId} className={`agent-row ${r.roomId === selectedId ? "active" : ""}`} onClick={() => setSelectedId(r.roomId)} role="button" tabIndex={0}>
              <strong>{r.title}</strong>
              <span className="muted">{r.memberAgentIds.length} agents</span>
            </div>
          ))}
        </Card>
        <Card title={selected ? `#${selected.title}` : "Shared thread"}>
          {!selected ? (
            <EmptyState>Select a room.</EmptyState>
          ) : (
            <>
              <div className="muted" style={{ marginBottom: 8 }}>
                Objective: coordinate the launch checklist. Members:{" "}
                {selected.memberAgentIds.join(", ")} + humans.
              </div>
              <RoomThread roomId={`room:${selected.roomId}`} />
              <form
                className="composer"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!draft.trim()) return;
                  void mox.send(selected.memberAgentIds[0] ?? "a_browse", `room:${selected.roomId}`, draft);
                  setDraft("");
                }}
              >
                <textarea value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Post to the room…" />
                <button className="primary" type="submit">Send</button>
              </form>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}

function RoomThread({ roomId }: { roomId: string }) {
  const mox = useMox();
  const msgs = mox.messages(roomId);
  useEffect(() => {
    void mox.loadThread("*", roomId);
  }, [roomId, mox]);
  if (msgs.length === 0) return <EmptyState>No messages yet.</EmptyState>;
  return (
    <div className="chat-scroll" style={{ maxHeight: 300 }}>
      {msgs.map((m) => (
        <div key={m.messageId} className={`bubble ${m.role}`}>
          <Markdown text={m.text || "…"} />
        </div>
      ))}
    </div>
  );
}

type Row = string[];

function TableView({ title, head, rows }: { title: string; head: string[]; rows: Row[] }) {
  return (
    <Card title={title}>
      <table>
        <thead>
          <tr>{head.map((h) => <th key={h}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => <td key={j}>{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

export function ServersView() {
  const mox = useMox();
  const [servers, setServers] = useState<Awaited<ReturnType<typeof mox.api.listServers>>>([]);
  useEffect(() => {
    void mox.api.listServers().then(setServers);
  }, [mox.api]);
  return (
    <div>
      <h1>Servers</h1>
      <TableView
        title={`${servers.length} servers`}
        head={["Server", "Kind", "Region", "State", "Agents", "CPU", "Mem"]}
        rows={servers.map(
          (s) => [s.displayName, s.kind, s.region, s.state, String(s.agentsRunning), `${s.cpuPct}%`, `${s.memPct}%`],
        )}
      />
    </div>
  );
}

export function DeploymentsView() {
  const mox = useMox();
  const [deps, setDeps] = useState<Awaited<ReturnType<typeof mox.api.listDeployments>>>([]);
  useEffect(() => {
    void mox.api.listDeployments().then(setDeps);
  }, [mox.api]);
  const byId = new Map(mox.agents.map((a) => [a.definition.agentId, a]));
  return (
    <div>
      <h1>Deployments</h1>
      <TableView
        title={`${deps.length} deployments`}
        head={["Agent", "Target", "Version", "State"]}
        rows={deps.map((dep) => [
          byId.get(dep.agentId)?.definition.identity.displayName ?? dep.agentId,
          dep.target.kind,
          dep.versionId,
          dep.state,
        ])}
      />
    </div>
  );
}

export function ModelsView() {
  const mox = useMox();
  const custom = useEntitlement("customModels");
  const [models, setModels] = useState<Awaited<ReturnType<typeof mox.api.listModels>>>([]);
  const [cliEngines, setCliEngines] = useState<Awaited<ReturnType<typeof mox.api.listCliEngines>>>([]);
  const [status, setStatus] = useState<string | null>(null);
  useEffect(() => {
    void mox.api.listModels().then(setModels);
    void mox.api.listCliEngines().then(setCliEngines);
  }, [mox.api]);

  return (
    <div>
      <h1>Models</h1>
      {!custom && <div className="demo-banner">Custom provider connections are not entitled for this workspace.</div>}
      <TableView
        title="Provider catalog"
        head={["Model", "Provider", "Credentials", "Availability", ""]}
        rows={models.map((m) => [
          m.displayName,
          m.providerId,
          m.byok ? "BYOK supported" : "Mox-managed",
          m.available ? "" : "",
        ])}
      />
      {custom && (
        <Card title="Connection test">
          <div className="row-actions">
            {models.slice(0, 4).map((m) => (
              <button
                key={m.providerId}
                onClick={() =>
                  void mox.api.testProviderConnection(m.providerId).then((r) =>
                    setStatus(`${m.displayName}: ${r.ok ? "connection OK" : r.reason ?? "failed"}`),
                  )
                }
              >
                Test {m.providerId.replace("p_", "")}
              </button>
            ))}
          </div>
          {status && <p className="muted mono">{status}</p>}
        </Card>
      )}
      <TableView
        title="Subscription / CLI engines (official device login only)"
        head={["Engine", "Support tier", "Connection state", "Note"]}
        rows={cliEngines.map((e) => [e.displayName, e.supportTier, e.state, e.reason ?? ""])}
      />
    </div>
  );
}

export function IntegrationsView() {
  const mox = useMox();
  const [items, setItems] = useState<Awaited<ReturnType<typeof mox.api.listIntegrations>>>([]);
  useEffect(() => {
    void mox.api.listIntegrations().then(setItems);
  }, [mox.api]);
  return (
    <div>
      <h1>Apps &amp; Integrations</h1>
      <TableView
        title={`${items.length} providers`}
        head={["App", "Status"]}
        rows={items.map((i) => [i.displayName, i.connected ? "connected" : "not connected"])}
      />
    </div>
  );
}

export function ChannelsView() {
  const mox = useMox();
  const [channels, setChannels] = useState<Awaited<ReturnType<typeof mox.api.listChannels>>>([]);
  useEffect(() => {
    void mox.api.listChannels().then(setChannels);
  }, [mox.api]);
  return (
    <div>
      <h1>Channels</h1>
      <TableView
        title="Messaging channels"
        head={["Channel", "Kind", "Status"]}
        rows={channels.map((c) => [c.displayName, c.kind, c.connected ? "connected" : "not connected"])}
      />
    </div>
  );
}

export function UsageView() {
  const mox = useMox();
  const [usage, setUsage] = useState<Awaited<ReturnType<typeof mox.api.getUsage>>>([]);
  useEffect(() => {
    void mox.api.getUsage().then(setUsage);
  }, [mox.api]);
  return (
    <div>
      <h1>Usage</h1>
      <TableView
        title="This billing period"
        head={["Metric", "Quantity", "Unit"]}
        rows={usage.map((u) => [u.metric, u.quantity.toLocaleString(), u.unit])}
      />
    </div>
  );
}

export function BillingView() {
  const mox = useMox();
  const [invoices, setInvoices] = useState<Awaited<ReturnType<typeof mox.api.listInvoices>>>([]);
  useEffect(() => {
    void mox.api.listInvoices().then(setInvoices);
  }, [mox.api]);
  return (
    <div>
      <h1>Billing</h1>
      <Card title="Plan">
        <Badge tone="accent">Demo workspace</Badge>
        <p className="muted" style={{ marginTop: 8 }}>
          Plans, regional pricing and add-ons are owned by the Mox billing service (build-pack prompt 08).
        </p>
      </Card>
      <TableView
        title="Invoices"
        head={["Invoice", "Period", "Amount", "State"]}
        rows={invoices.map((i) => [
          i.invoiceId,
          `${i.periodStart} → ${i.periodEnd}`,
          `${(i.amountCents / 100).toFixed(2)} ${i.currency}`,
          i.state,
        ])}
      />
    </div>
  );
}

export function SettingsView() {
  const mox = useMox();
  return (
    <div>
      <h1>Settings</h1>
      <Card title="Workspace">
        <p><strong>Organization:</strong> Demo org (<span className="mono">org_demo</span>)</p>
        <p><strong>Data residency:</strong> eu-central (demo)</p>
      </Card>
      <Card title="Capabilities">
        <ul>
          {Object.entries(mox.entitlements ?? {}).map(([k, v]) => (
            <li key={k}>
              <span className="mono">{k}</span>: {v ? "enabled" : "disabled"}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
