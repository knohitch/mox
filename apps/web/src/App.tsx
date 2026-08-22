import type { ReactNode } from "react";
import { MoxProvider } from "./api/store.js";
import { resolveParams, useRoute, Link } from "./router.js";
import { AgentsView, WorkTab } from "./views/AgentsView.js";
import {
  BillingView,
  ChannelsView,
  DeploymentsView,
  HomeView,
  IntegrationsView,
  ModelsView,
  RoomsView,
  ServersView,
  SettingsView,
  UsageView,
} from "./views/MiscViews.js";

const ROUTES: Record<string, (params: Record<string, string>) => ReactNode> = {
  "/": () => <HomeView />,
  "/agents": () => <AgentsView />,
  "/rooms": () => <RoomsView />,
  "/servers": () => <ServersView />,
  "/deployments": () => <DeploymentsView />,
  "/models": () => <ModelsView />,
  "/integrations": () => <IntegrationsView />,
  "/channels": () => <ChannelsView />,
  "/usage": () => <UsageView />,
  "/billing": () => <BillingView />,
  "/settings": () => <SettingsView />,
};

const NAV = [
  ["/", "Home"],
  ["/agents", "Agents"],
  ["/rooms", "Agent Rooms"],
  ["/servers", "Servers"],
  ["/deployments", "Deployments"],
  ["/models", "Models"],
  ["/integrations", "Apps & Integrations"],
  ["/channels", "Channels"],
  ["/usage", "Usage"],
  ["/billing", "Billing"],
  ["/settings", "Settings"],
] as const;

export function App() {
  return (
    <MoxProvider>
      <Shell />
    </MoxProvider>
  );
}

function Shell() {
  const { path } = useRoute();
  const match = resolveParams(Object.keys(ROUTES), path);
  const active = match?.pattern ?? null;
  const View = active ? ROUTES[active] : undefined;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          M<span>ox</span>
        </div>
        {NAV.map(([to, label]) => (
          <Link key={to} to={to} className={`nav-item ${active === to ? "active" : ""}`}>
            {label}
          </Link>
        ))}
        <div className="section-label">Workspace</div>
        <Link to="/settings" className={`nav-item ${active === "/settings" ? "active" : ""}`}>
          Preferences
        </Link>
      </aside>
      <main className="main">
        {View ? (
          View(match?.params ?? {})
        ) : (
          <>
            <h1>Not found</h1>
            <p className="muted">
              No route for <code>{path}</code>.
            </p>
          </>
        )}
      </main>
    </div>
  );
}

// WorkTab is re-exported for potential embedding in room panes later.
export { WorkTab };
