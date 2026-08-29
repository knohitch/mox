import { useState } from "react";
import type { ReactNode } from "react";
import { isUiStudioAllowed } from "../uiStudio/security.js";
import { createMockMoxStore, type UiStudioSurface, type UiStudioState } from "../uiStudio/mockStore.js";
import { MoxPreviewProvider } from "../api/store.js";
import { CustomerShell } from "../shell/CustomerShell.js";
import { StaffShell, SupportConsole } from "../App.js";
import { AdminView } from "./AdminView.js";
import { AgentsView } from "./AgentsView.js";
import {
  BackupsView,
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
} from "./MiscViews.js";

const CUSTOMER_PAGES = [
  { id: "/dashboard", label: "Dashboard", component: () => <HomeView /> },
  { id: "/agents", label: "Agents", component: () => <AgentsView /> },
  { id: "/rooms", label: "Rooms", component: () => <RoomsView /> },
  { id: "/deployments", label: "Deployments", component: () => <DeploymentsView /> },
  { id: "/servers", label: "Servers", component: () => <ServersView /> },
  { id: "/models", label: "Models", component: () => <ModelsView /> },
  { id: "/integrations", label: "Integrations", component: () => <IntegrationsView /> },
  { id: "/channels", label: "Channels", component: () => <ChannelsView /> },
  { id: "/usage", label: "Usage", component: () => <UsageView /> },
  { id: "/billing", label: "Billing", component: () => <BillingView /> },
  { id: "/backups", label: "Backups", component: () => <BackupsView /> },
  { id: "/settings", label: "Settings", component: () => <SettingsView /> },
] as const;

export function UiStudioView() {
  const getInitialSurface = (): UiStudioSurface => {
    if (typeof window === "undefined") return "customer";
    const params = new URLSearchParams(window.location.search);
    const s = params.get("surface");
    if (s === "admin" || s === "support" || s === "customer") return s;
    return "customer";
  };

  const [surface, setSurface] = useState<UiStudioSurface>(getInitialSurface);
  const [customerPage, setCustomerPage] = useState<string>("/dashboard");
  const [state, setState] = useState<UiStudioState>("populated");

  const handleSurfaceChange = (s: UiStudioSurface) => {
    setSurface(s);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.set("surface", s);
      window.history.replaceState(null, "", url.toString());
    }
  };

  // Security gate: Render regular 404 if not DEV + opt-in + local host.
  if (!isUiStudioAllowed()) {
    return (
      <div className="state state-error" style={{ margin: 40 }} role="alert">
        <h1>404 Not Found</h1>
        <p className="muted">The requested development route does not exist in this environment.</p>
      </div>
    );
  }

  const mockStore = createMockMoxStore(surface, state);

  const activeCustomerPage = CUSTOMER_PAGES.find((p) => p.id === customerPage) ?? CUSTOMER_PAGES[0]!;

  const renderSurfaceContent = (): ReactNode => {
    if (surface === "customer") {
      return (
        <CustomerShell activePath={activeCustomerPage.id}>
          {activeCustomerPage.component()}
        </CustomerShell>
      );
    }
    if (surface === "admin") {
      return (
        <StaffShell surface="admin">
          <AdminView />
        </StaffShell>
      );
    }
    return (
      <StaffShell surface="support">
        <SupportConsole />
      </StaffShell>
    );
  };

  return (
    <div className="ui-studio-shell">
      {/* Studio Header Toolbar */}
      <header className="ui-studio-bar">
        <div className="ui-studio-brand">
          <span className="ui-studio-glyph" aria-hidden>⬡</span>
          <strong>Mox</strong>
          <span className="ui-studio-pill dev">DEV ONLY</span>
          <span className="ui-studio-pill safe">ISOLATED FIXTURES</span>
          <a href="/login" className="ui-studio-auth-link" title="Jump to Auth Page">
            ← Auth Page
          </a>
        </div>

        <div className="ui-studio-controls">
          {/* Surface selection */}
          <div className="ui-studio-group" role="group" aria-label="Surface">
            <span className="ui-studio-group-label">Surface</span>
            <div className="ui-studio-segmented">
              {(["customer", "admin", "support"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  className={surface === s ? "active" : ""}
                  onClick={() => handleSurfaceChange(s)}
                >
                  {s.charAt(0).toUpperCase() + s.slice(1)}
                </button>
              ))}
            </div>
          </div>

          {/* Customer Page Selection */}
          {surface === "customer" ? (
            <div className="ui-studio-group" role="group" aria-label="Page">
              <span className="ui-studio-group-label">Page</span>
              <select
                className="ui-studio-select"
                value={customerPage}
                onChange={(e) => setCustomerPage(e.target.value)}
                aria-label="Customer Page"
              >
                {CUSTOMER_PAGES.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {/* State selection */}
          <div className="ui-studio-group" role="group" aria-label="State">
            <span className="ui-studio-group-label">State</span>
            <div className="ui-studio-segmented">
              {(["populated", "empty", "loading", "error", "gated"] as const).map((st) => (
                <button
                  key={st}
                  type="button"
                  className={state === st ? "active" : ""}
                  onClick={() => setState(st)}
                >
                  {st.charAt(0).toUpperCase() + st.slice(1)}
                </button>
              ))}
            </div>
          </div>
        </div>
      </header>

      {/* Absolute Fluid Screen */}
      <div className="ui-studio-stage fluid-stage">
        <div className="ui-studio-viewport fluid-viewport">
          <MoxPreviewProvider value={mockStore}>
            {renderSurfaceContent()}
          </MoxPreviewProvider>
        </div>
      </div>
    </div>
  );
}
