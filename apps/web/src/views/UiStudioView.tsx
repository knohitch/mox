import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { isUiStudioAllowed } from "../uiStudio/security.js";
import { createMockMoxStore, type UiStudioState, type UiStudioSurface } from "../uiStudio/mockStore.js";
import { MoxPreviewProvider } from "../api/store.js";
import { CustomerShell } from "../shell/CustomerShell.js";
import { StaffShell, SupportConsole } from "../App.js";
import { SidebarToggleIcon } from "../ui/primitives.js";
import { LoadingState } from "../ui/primitives.js";
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
import { NavAdapterProvider, type NavAdapter } from "../router.js";
import { StudioErrorBoundary } from "../uiStudio/StudioErrorBoundary.js";
import {
  STUDIO_ADMIN_PAGES,
  STUDIO_CUSTOMER_PAGES,
  STUDIO_SUPPORT_PAGES,
  applyStudioNavigation,
  defaultPageFor,
  isStudioAdminRole,
  isStudioSupportRole,
  logicalPathFor,
  parseStudioSearch,
  studioLocation,
  withStudioPage,
  withStudioRole,
  withStudioState,
  withStudioSurface,
  type StudioUrlState,
} from "../uiStudio/previewNavigation.js";
import {
  ADMIN_PREVIEW_ROLES,
  SUPPORT_PREVIEW_ROLES,
  visibleAdminTabs,
  visibleSupportSections,
  type AdminTabKey,
} from "../concepts/staffNav.js";

const CUSTOMER_PAGE_RENDERERS: Record<string, () => ReactNode> = {
  "/dashboard": () => <HomeView />,
  "/agents": () => <AgentsView />,
  "/rooms": () => <RoomsView />,
  "/deployments": () => <DeploymentsView />,
  "/servers": () => <ServersView />,
  "/models": () => <ModelsView />,
  "/integrations": () => <IntegrationsView />,
  "/channels": () => <ChannelsView />,
  "/usage": () => <UsageView />,
  "/billing": () => <BillingView />,
  "/backups": () => <BackupsView />,
  "/settings": () => <SettingsView />,
};

function readStudioLocation(): StudioUrlState {
  if (typeof window === "undefined") {
    return parseStudioSearch("");
  }
  return parseStudioSearch(window.location.search);
}

import { useTheme } from "../ui/theme.js";

function commitStudioState(next: StudioUrlState, mode: "push" | "replace"): void {
  if (typeof window === "undefined") return;
  const href = studioLocation(next);
  const current = `${window.location.pathname}${window.location.search}`;
  if (href === current) return;
  if (mode === "push") window.history.pushState(null, "", href);
  else window.history.replaceState(null, "", href);
}

export function UiStudioView() {
  const [studio, setStudio] = useState<StudioUrlState>(readStudioLocation);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const { setTheme } = useTheme();

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!window.location.search) {
      commitStudioState(studio, "replace");
    }
    const onPop = () => setStudio(readStudioLocation());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    if (studio.theme) {
      // @ts-ignore
      setTheme(studio.theme);
    }
  }, [studio.theme, setTheme]);

  const updateStudio = (next: StudioUrlState, mode: "push" | "replace" = "push") => {
    commitStudioState(next, mode);
    setStudio(next);
  };

  const mockStore = useMemo(
    () => createMockMoxStore(studio.surface, studio.previewState, studio.role),
    [studio.surface, studio.previewState, studio.role],
  );

  const adapter: NavAdapter = useMemo(
    () => ({
      path: logicalPathFor(studio),
      navigate: (to: string) => updateStudio(applyStudioNavigation(studio, to)),
      hrefFor: (to: string) => studioLocation(applyStudioNavigation(studio, to)),
      section: studio.surface === "customer" ? undefined : studio.page,
      setSection: (section: string) => updateStudio(withStudioPage(studio, section)),
    }),
    [studio],
  );

  if (!isUiStudioAllowed()) {
    return (
      <div className="state state-error" style={{ margin: 40 }} role="alert">
        <h1>404 Not Found</h1>
        <p className="muted">The requested development route does not exist in this environment.</p>
      </div>
    );
  }

  const adminVisiblePages =
    studio.surface === "admin"
      ? visibleAdminTabs(mockStore.staffSession?.capabilities ?? []).map((id) => ({
          id,
          label: STUDIO_ADMIN_PAGES.find((p) => p.id === id)?.label ?? id,
        }))
      : [];
  const supportVisiblePages =
    studio.surface === "support"
      ? visibleSupportSections(mockStore.staffSession?.capabilities ?? []).map((id) => ({
          id,
          label: STUDIO_SUPPORT_PAGES.find((p) => p.id === id)?.label ?? id,
        }))
      : [];

  const handleRoleChange = (role: string) => {
    let next = withStudioRole(studio, role);
    if (studio.surface === "admin" && isStudioAdminRole(role)) {
      const tabs = visibleAdminTabs([...ADMIN_PREVIEW_ROLES[role].capabilities]);
      if (!tabs.includes(studio.page as AdminTabKey)) next = withStudioPage(next, tabs[0] ?? defaultPageFor("admin"));
    }
    if (studio.surface === "support" && isStudioSupportRole(role)) {
      const sections = visibleSupportSections([...SUPPORT_PREVIEW_ROLES[role].capabilities]);
      if (!sections.includes(studio.page as (typeof sections)[number])) {
        next = withStudioPage(next, sections[0] ?? defaultPageFor("support"));
      }
    }
    updateStudio(next);
  };

  const customerRenderer = CUSTOMER_PAGE_RENDERERS[studio.page] ?? CUSTOMER_PAGE_RENDERERS["/dashboard"]!;

  const renderSurfaceContent = (): ReactNode => {
    if (studio.previewState === "loading") {
      const body = <LoadingState label="Connecting to the Mox control plane…" />;
      if (studio.surface === "customer") {
        return (
          <CustomerShell activePath={studio.page} collapsed={sidebarCollapsed} onToggleCollapse={() => setSidebarCollapsed((v) => !v)}>
            {body}
          </CustomerShell>
        );
      }
      return (
        <StaffShell surface={studio.surface} collapsed={sidebarCollapsed} onToggleCollapse={() => setSidebarCollapsed((v) => !v)}>
          {body}
        </StaffShell>
      );
    }
    if (studio.previewState === "error") {
      const body = (
        <div className="backend-error" role="alert">
          Backend unavailable: {mockStore.error ?? mockStore.staffError} — the Mox web app never falls back to demo data.
        </div>
      );
      if (studio.surface === "customer") {
        return (
          <CustomerShell activePath={studio.page} collapsed={sidebarCollapsed} onToggleCollapse={() => setSidebarCollapsed((v) => !v)}>
            {body}
          </CustomerShell>
        );
      }
      return (
        <StaffShell surface={studio.surface} collapsed={sidebarCollapsed} onToggleCollapse={() => setSidebarCollapsed((v) => !v)}>
          {body}
        </StaffShell>
      );
    }
    if (studio.surface === "customer") {
      return (
        <CustomerShell
          activePath={studio.page}
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed((v) => !v)}
        >
          {customerRenderer()}
        </CustomerShell>
      );
    }
    if (studio.surface === "admin") {
      return (
        <StaffShell surface="admin" collapsed={sidebarCollapsed} onToggleCollapse={() => setSidebarCollapsed((v) => !v)}>
          <AdminView />
        </StaffShell>
      );
    }
    return (
      <StaffShell surface="support" collapsed={sidebarCollapsed} onToggleCollapse={() => setSidebarCollapsed((v) => !v)}>
        <SupportConsole />
      </StaffShell>
    );
  };

  return (
    <div className="ui-studio-shell">
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
          <div className="ui-studio-group" role="group" aria-label="Surface">
            <span className="ui-studio-group-label">Surface</span>
            <div className="ui-studio-segmented">
              {(["customer", "admin", "support"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  className={studio.surface === s ? "active" : ""}
                  onClick={() => updateStudio(withStudioSurface(studio, s))}
                >
                  {s.charAt(0).toUpperCase() + s.slice(1)}
                </button>
              ))}
            </div>
          </div>

          {studio.surface === "customer" ? (
            <div className="ui-studio-group" role="group" aria-label="Page">
              <span className="ui-studio-group-label">Page</span>
              <select
                className="ui-studio-select"
                value={studio.page}
                onChange={(e) => updateStudio(withStudioPage(studio, e.target.value))}
                aria-label="Customer Page"
              >
                {STUDIO_CUSTOMER_PAGES.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          <div className="ui-studio-group" role="group" aria-label="Theme">
            <span className="ui-studio-group-label">Theme</span>
            <select
              className="ui-studio-select"
              value={studio.theme || "system"}
              onChange={(e) => updateStudio({ ...studio, theme: e.target.value })}
              aria-label="Studio Theme"
            >
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </div>

          {studio.surface === "admin" ? (
            <>
              <div className="ui-studio-group" role="group" aria-label="Admin Role">
                <span className="ui-studio-group-label">Role</span>
                <select
                  className="ui-studio-select"
                  value={studio.role}
                  onChange={(e) => handleRoleChange(e.target.value)}
                  aria-label="Admin Role"
                >
                  {Object.entries(ADMIN_PREVIEW_ROLES).map(([id, profile]) => (
                    <option key={id} value={id}>
                      {profile.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="ui-studio-group" role="group" aria-label="Admin Page">
                <span className="ui-studio-group-label">Page</span>
                <select
                  className="ui-studio-select"
                  value={adminVisiblePages.some((p) => p.id === studio.page) ? studio.page : (adminVisiblePages[0]?.id ?? "dashboard")}
                  onChange={(e) => updateStudio(withStudioPage(studio, e.target.value))}
                  aria-label="Admin Page"
                  disabled={adminVisiblePages.length === 0}
                >
                  {adminVisiblePages.length === 0 ? (
                    <option value="dashboard">No sections</option>
                  ) : (
                    adminVisiblePages.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))
                  )}
                </select>
              </div>
            </>
          ) : null}

          {studio.surface === "support" ? (
            <>
              <div className="ui-studio-group" role="group" aria-label="Support Role">
                <span className="ui-studio-group-label">Role</span>
                <select
                  className="ui-studio-select"
                  value={studio.role}
                  onChange={(e) => handleRoleChange(e.target.value)}
                  aria-label="Support Role"
                >
                  {Object.entries(SUPPORT_PREVIEW_ROLES).map(([id, profile]) => (
                    <option key={id} value={id}>
                      {profile.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="ui-studio-group" role="group" aria-label="Support Page">
                <span className="ui-studio-group-label">Page</span>
                <select
                  className="ui-studio-select"
                  value={supportVisiblePages.some((p) => p.id === studio.page) ? studio.page : (supportVisiblePages[0]?.id ?? "lookup")}
                  onChange={(e) => updateStudio(withStudioPage(studio, e.target.value))}
                  aria-label="Support Page"
                  disabled={supportVisiblePages.length === 0}
                >
                  {supportVisiblePages.length === 0 ? (
                    <option value="lookup">No sections</option>
                  ) : (
                    supportVisiblePages.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))
                  )}
                </select>
              </div>
            </>
          ) : null}

          <div className="ui-studio-group" role="group" aria-label="State">
            <span className="ui-studio-group-label">State</span>
            <div className="ui-studio-segmented">
              {(["populated", "empty", "loading", "error", "gated"] as const).map((st) => (
                <button
                  key={st}
                  type="button"
                  className={studio.previewState === st ? "active" : ""}
                  onClick={() => updateStudio(withStudioState(studio, st as UiStudioState))}
                >
                  {st.charAt(0).toUpperCase() + st.slice(1)}
                </button>
              ))}
            </div>
          </div>

          <div className="ui-studio-group" role="group" aria-label="Sidebar">
            <span className="ui-studio-group-label">Sidebar</span>
            <button
              type="button"
              className={`ui-studio-toggle-btn${sidebarCollapsed ? " active" : ""}`}
              onClick={() => setSidebarCollapsed((v) => !v)}
              title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              <SidebarToggleIcon collapsed={sidebarCollapsed} size={15} />
              <span>{sidebarCollapsed ? "Collapsed" : "Expanded"}</span>
            </button>
          </div>
        </div>
      </header>

      <div className="ui-studio-stage fluid-stage">
        <div className="ui-studio-viewport fluid-viewport">
          <NavAdapterProvider adapter={adapter}>
            <MoxPreviewProvider value={mockStore}>
              <StudioErrorBoundary
                key={`${studio.surface}:${studio.page}:${studio.previewState}:${studio.role}`}
                surface={studio.surface}
                page={studio.page}
              >
                {renderSurfaceContent()}
              </StudioErrorBoundary>
            </MoxPreviewProvider>
          </NavAdapterProvider>
        </div>
      </div>
    </div>
  );
}

export type { UiStudioSurface };
