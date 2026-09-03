import { useEffect, useState } from "react";
import { Link } from "../router.js";
import { Badge } from "../ui/primitives.js";
import { useMox } from "../api/store.js";
import type {
  ApiTokenRow,
  ChannelCatalogRow,
  IntegrationCatalogRow,
  ModelConnectionRow,
  ServerSummary,
} from "../api/types.js";

/**
 * Post-onboarding setup checklist for the dashboard. Uses REAL resource state
 * (agents, model connections, servers, integrations/channels, API tokens) —
 * never the onboarding wizard's bookkeeping — and never reactivates the
 * mandatory onboarding flow. Every item is optional guidance.
 */

interface SetupItem {
  key: string;
  label: string;
  status: "done" | "todo" | "optional";
  detail: string;
  action?: { label: string; to: string };
}

export function WorkspaceSetupCard() {
  const mox = useMox();
  const [connections, setConnections] = useState<ModelConnectionRow[]>([]);
  const [servers, setServers] = useState<ServerSummary[]>([]);
  const [integrations, setIntegrations] = useState<IntegrationCatalogRow[]>([]);
  const [channels, setChannels] = useState<ChannelCatalogRow[]>([]);
  const [tokens, setTokens] = useState<ApiTokenRow[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    void Promise.all([
      mox.api.listModelConnections().catch(() => null),
      mox.api.listServers().catch(() => null),
      mox.api.listIntegrations().catch(() => null),
      mox.api.listChannels().catch(() => null),
      mox.api.listApiTokens().catch(() => null),
    ]).then(([c, s, i, ch, t]) => {
      if (!alive) return;
      if (!c || !s || !i || !ch || !t) setLoadFailed(true);
      if (c) setConnections(c);
      if (s) setServers(s);
      if (i) setIntegrations(i);
      if (ch) setChannels(ch);
      if (t) setTokens(t);
    });
    return () => {
      alive = false;
    };
  }, [mox.api]);

  const agents = mox.agents;
  const connectedModels = connections.filter((c) => c.connected).length;
  const activeServers = servers.filter((s) => !["canceled", "destroyed", "retention"].includes(s.state));
  const runningServer = activeServers.find((s) => s.state === "running");
  const provisioningServer = activeServers.find((s) => ["requested", "provisioning", "resizing"].includes(s.state));
  const connectedApps = integrations.filter((i) => i.connected).length + channels.filter((c) => c.connected).length;
  const activeTokens = tokens.filter((t) => !t.revoked).length;

  const items: SetupItem[] = [
    agents.length > 0
      ? { key: "agent", label: "First agent", status: "done", detail: `${agents.length} agent${agents.length === 1 ? "" : "s"}` }
      : { key: "agent", label: "First agent", status: "todo", detail: "Draft and publish your first agent", action: { label: "Create an agent", to: "/agents" } },
    connectedModels > 0
      ? { key: "model", label: "Model provider", status: "done", detail: `${connectedModels} connected` }
      : { key: "model", label: "Model provider", status: "todo", detail: "Connect Mox-managed models or your own provider", action: { label: "Connect a provider", to: "/models" } },
    runningServer
      ? { key: "server", label: "Server", status: "done", detail: runningServer.displayName || "Running" }
      : provisioningServer
        ? { key: "server", label: "Server", status: "todo", detail: `Provisioning (${provisioningServer.state})`, action: { label: "Check Servers", to: "/servers" } }
        : { key: "server", label: "Server", status: "optional", detail: activeServers.length > 0 ? activeServers[0]!.state : "Optional — dedicated compute when you need it", action: { label: "Go to Servers", to: "/servers" } },
    connectedApps > 0
      ? { key: "apps", label: "Apps & channels", status: "done", detail: `${connectedApps} configured` }
      : { key: "apps", label: "Apps & channels", status: "optional", detail: "Connect integrations and messaging channels", action: { label: "Connect apps", to: "/integrations" } },
    activeTokens > 0
      ? { key: "token", label: "API token", status: "done", detail: `${activeTokens} active` }
      : { key: "token", label: "API token", status: "optional", detail: "For CLI and programmatic access", action: { label: "Create a token", to: "/settings" } },
  ];

  const remaining = items.filter((item) => item.status === "todo").length;
  if (remaining === 0) return null;

  return (
    <section className="setup-card" aria-label="Workspace setup">
      <header className="setup-card-head">
        <div>
          <h2>Workspace setup</h2>
          <p className="page-sub">
            {remaining === 1 ? "One last thing to configure" : `${remaining} things you can configure`} — optional, at
            your own pace.
          </p>
        </div>
      </header>
      <ul className="setup-card-list">
        {items.map((item) => (
          <li key={item.key} className="setup-item">
            <span className="setup-item-main">
              <strong>{item.label}</strong>
              <span className="muted">{item.detail}</span>
            </span>
            {item.status === "done" ? (
              <Badge tone="good">Done</Badge>
            ) : item.status === "todo" ? (
              <>
                {item.action ? (
                  <Link to={item.action.to} className="btn btn-sm setup-item-action">
                    {item.action.label}
                  </Link>
                ) : null}
              </>
            ) : (
              <>
                <Badge tone="neutral">Optional</Badge>
                {item.action ? (
                  <Link to={item.action.to} className="setup-item-link">
                    {item.action.label}
                  </Link>
                ) : null}
              </>
            )}
          </li>
        ))}
      </ul>
      {loadFailed ? (
        <p className="muted setup-card-note" role="note">
          Some resource checks could not be refreshed — states shown reflect the last successful load.
        </p>
      ) : null}
    </section>
  );
}
