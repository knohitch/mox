import { useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { MoxProvider, useMox } from "./api/store.js";
import { resolveParams, useRoute } from "./router.js";
import { CustomerShell } from "./shell/CustomerShell.js";
import { AgentsView, WorkTab } from "./views/AgentsView.js";
import { AdminView } from "./views/AdminView.js";
import { ForgotPasswordPage, LoginPage, ResetPasswordPage, SignupPage } from "./views/AuthPages.js";
import { Badge, BrandLogo, Card, EmptyState, SidebarToggleIcon } from "./ui/primitives.js";
import { UiStudioView } from "./views/UiStudioView.js";
import {
  ADMIN_NAV_GROUPS,
  ADMIN_TAB_LABEL,
  SUPPORT_NAV_GROUPS,
  SUPPORT_SECTION_LABEL,
  canSupportLookup,
  canSupportNote,
  isSupportSectionKey,
  visibleAdminTabs,
  visibleSupportSections,
  type AdminTabKey,
  type SupportSectionKey,
} from "./concepts/staffNav.js";
import { StaffSectionProvider, useStaffSection } from "./shell/staffSection.js";
import { humanizeLabel } from "./domain/labels.js";
import type { SupportCustomer, SupportCustomerDetail } from "./api/types.js";
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
} from "./views/MiscViews.js";

// ----------------------------------------------------------------------------
// Route tables (Prompt 01) — customer protected routes, PUBLIC auth routes, and
// the staff surfaces (admin/support). Isolation is enforced at the URL prefix
// so a customer can never reach the Admin/Support shell.
// ----------------------------------------------------------------------------

const CUSTOMER_ROUTES: Record<string, (params: Record<string, string>) => ReactNode> = {
  "/": () => <Redirect to="/dashboard" />,
  "/dashboard": () => <HomeView />,
  "/agents": () => <AgentsView />,
  "/rooms": () => <RoomsView />,
  "/servers": () => <ServersView />,
  "/deployments": () => <DeploymentsView />,
  "/models": () => <ModelsView />,
  "/integrations": () => <IntegrationsView />,
  "/channels": () => <ChannelsView />,
  "/usage": () => <UsageView />,
  "/billing": () => <BillingView />,
  "/backups": () => <BackupsView />,
  "/settings": () => <SettingsView />,
};


/** Customer-facing public auth routes (standalone, NO app shell). */
const CUSTOMER_PUBLIC = ["/login", "/signup", "/forgot-password", "/reset-password"] as const;

const ADMIN_PUBLIC = ["/admin/login", "/admin/signup", "/admin/forgot-password", "/admin/reset-password"] as const;
const SUPPORT_PUBLIC = ["/support/login", "/support/signup", "/support/forgot-password", "/support/reset-password"] as const;

/**
 * Client-side return-target guard for the CUSTOMER surface (defense in depth;
 * the control plane enforces the same policy with `safeCustomerReturnTarget`).
 * A customer may return only to a same-surface path — never to `/admin`,
 * `/support`, `//`, a scheme, or an encoded escape.
 */
function safeCustomerReturn(raw: string | null): string {
  if (!raw) return "/dashboard";
  if (raw.startsWith("//") || raw.includes("://") || raw.includes("\\")) return "/dashboard";
  if (!raw.startsWith("/")) return "/dashboard";
  if (raw === "/" || raw === "") return "/dashboard";
  if (raw === "/admin" || raw.startsWith("/admin/")) return "/dashboard";
  if (raw === "/support" || raw.startsWith("/support/")) return "/dashboard";
  return raw;
}

function currentReturnTo(): string | null {
  return new URLSearchParams(window.location.search).get("returnTo");
}

function returnQuery(path: string): string {
  return path === "/" ? "" : `?returnTo=${encodeURIComponent(path)}`;
}

/** Renders the standalone customer surface auth pages (no shell shown). */
function CustomerPublicAuth({ pattern }: { pattern: string }) {
  const { signIn, signUp, forgotPassword, resetPassword } = useMox();
  const { navigate } = useRoute();
  const returnTo = safeCustomerReturn(currentReturnTo());

  if (pattern === "/login") {
    return (
      <LoginPage
        surface="customer"
        title="Sign in to Mox"
        onSubmit={async (input) => {
          await signIn({ email: input.email, password: input.password });
          navigate(returnTo || "/dashboard");
        }}
        signupPath="/signup"
        forgotPath="/forgot-password"
      />
    );
  }
  if (pattern === "/signup") {
    return (
      <SignupPage
        surface="customer"
        title="Create your Mox workspace"
        onSubmit={async (input) => {
          await signUp({ email: input.email, password: input.password, orgName: input.orgName });
          navigate(returnTo || "/dashboard");
        }}
        loginPath="/login"
      />
    );
  }
  if (pattern === "/forgot-password") {
    return (
      <ForgotPasswordPage
        surface="customer"
        title="Reset your password"
        onSubmit={(email) => forgotPassword(email).then(() => undefined)}
        backPath="/login"
      />
    );
  }
  const token = new URLSearchParams(window.location.search).get("token") ?? "";
  return (
    <ResetPasswordPage
      surface="customer"
      title="Set a new password"
      token={token}
      onSubmit={(t, password) => resetPassword({ token: t, password }).then(() => undefined)}
      backPath="/login"
    />
  );
}

function Redirect({ to }: { to: string }) {
  const { navigate } = useRoute();
  useEffect(() => {
    navigate(to);
  }, [navigate, to]);
  return null;
}

function Connecting() {
  return <div className="backend-error">Connecting to the Mox control plane…</div>;
}

// ----------------------------------------------------------------------------
// Customer surface
// ----------------------------------------------------------------------------

export function CustomerSurface() {
  const { path } = useRoute();
  const { needsAuth, ready, error } = useMox();
  const authMatch = resolveParams(CUSTOMER_PUBLIC, path);

  if (authMatch) return <CustomerPublicAuth pattern={authMatch.pattern} />;

  // Protected customer route.
  if (needsAuth) return <Redirect to={`/login${returnQuery(path)}`} />;
  if (!ready && !error) return <Connecting />;

  const match = resolveParams(Object.keys(CUSTOMER_ROUTES), path);
  const active = match?.pattern ?? null;
  const View = active ? CUSTOMER_ROUTES[active] : undefined;

  return (
    <CustomerShell activePath={active ?? ""}>
      {error ? (
        <div className="backend-error" role="alert">
          Backend unavailable: {error} — the Mox web app never falls back to demo data.
        </div>
      ) : null}
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
    </CustomerShell>
  );
}

export function StaffShell({
  surface,
  children,
  collapsed: externalCollapsed,
  onToggleCollapse: externalOnToggleCollapse,
}: {
  surface: "admin" | "support";
  children: ReactNode;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}) {
  return (
    <StaffSectionProvider defaultSection={surface === "admin" ? "dashboard" : "overview"}>
      <StaffShellFrame
        surface={surface}
        collapsed={externalCollapsed}
        onToggleCollapse={externalOnToggleCollapse}
      >
        {children}
      </StaffShellFrame>
    </StaffSectionProvider>
  );
}

function StaffShellFrame({
  surface,
  children,
  collapsed: externalCollapsed,
  onToggleCollapse: externalOnToggleCollapse,
}: {
  surface: "admin" | "support";
  children: ReactNode;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}) {
  const { staffSignOut, staffSession } = useMox();
  const { section, setSection } = useStaffSection();
  const [internalCollapsed, setInternalCollapsed] = useState(false);
  const collapsed = externalCollapsed !== undefined ? externalCollapsed : internalCollapsed;
  const toggleCollapse = externalOnToggleCollapse ?? (() => setInternalCollapsed((v) => !v));
  const [drawerOpen, setDrawerOpen] = useState(false);
  const capabilities = staffSession?.capabilities ?? [];
  const adminVisible = new Set(visibleAdminTabs(capabilities));
  const supportVisible = new Set(visibleSupportSections(capabilities));
  const groups =
    surface === "admin"
      ? ADMIN_NAV_GROUPS.map((group) => ({
          label: group.label,
          entries: group.entries
            .filter((key) => adminVisible.has(key))
            .map((key) => ({ id: key, label: ADMIN_TAB_LABEL[key as AdminTabKey] })),
        })).filter((group) => group.entries.length > 0)
      : SUPPORT_NAV_GROUPS.map((group) => ({
          label: group.label,
          entries: group.entries
            .filter((key) => supportVisible.has(key))
            .map((key) => ({ id: key, label: SUPPORT_SECTION_LABEL[key as SupportSectionKey] })),
        })).filter((group) => group.entries.length > 0);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  const sidebarBody = (
    <>
      <div className="sidebar-head">
        <BrandLogo surface={surface} collapsed={collapsed} />
        <button
          type="button"
          className="sidebar-collapse-toggle-top"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={toggleCollapse}
        >
          <SidebarToggleIcon collapsed={collapsed} size={18} />
        </button>
      </div>
      <nav className="nav-scroll" aria-label={surface === "support" ? "Support navigation" : "Admin navigation"}>
        {groups.map((group) => (
          <div className="nav-group" key={group.label}>
            <div className="section-label">
              <span>{group.label}</span>
            </div>
            {group.entries.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className={`nav-item ${section === entry.id ? "active" : ""}`}
                onClick={() => {
                  setSection?.(entry.id);
                  setDrawerOpen(false);
                }}
                aria-current={section === entry.id ? "page" : undefined}
              >
                <span className="nav-label">{collapsed ? "" : entry.label}</span>
              </button>
            ))}
          </div>
        ))}
      </nav>
      <div className="sidebar-footer">
        {staffSession && !collapsed ? (
          <div className="staff-identity muted">
            <strong>{staffSession.displayName}</strong>
            <small>{staffSession.email}</small>
          </div>
        ) : null}
        <button type="button" className="nav-item signout" onClick={() => void staffSignOut()}>
          <span className="nav-icon" aria-hidden>⎋</span>
          <span className="nav-label">{collapsed ? "" : "Sign out"}</span>
        </button>
      </div>
    </>
  );

  return (
    <div className={`app${collapsed ? " sidebar-collapsed" : ""}`}>
      {/* Desktop sidebar */}
      <aside className={`sidebar sidebar-desktop${collapsed ? " collapsed" : ""}`} aria-label="Primary">
        {sidebarBody}
      </aside>

      {/* Mobile drawer */}
      {drawerOpen ? (
        <div className="drawer-backdrop" onClick={() => setDrawerOpen(false)} role="presentation" />
      ) : null}
      <aside className={`sidebar sidebar-drawer${drawerOpen ? " open" : ""}`} aria-label="Primary (mobile)" aria-hidden={!drawerOpen}>
        {drawerOpen ? sidebarBody : null}
      </aside>

      <div className="shell-body">
        <header className="topbar-staff">
          <button
            type="button"
            className="menu-toggle"
            aria-label="Open menu"
            onClick={() => setDrawerOpen(true)}
          >
            ☰
          </button>
          <button
            type="button"
            className="sidebar-toggle-btn"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={toggleCollapse}
          >
            <SidebarToggleIcon collapsed={collapsed} size={18} />
          </button>
          <div className="topbar-left">
            <span className={`surface-badge surface-${surface}`}>
              {surface === "support" ? "Mox Support" : "Mox Admin"}
            </span>
          </div>
          <div className="topbar-right">
            {staffSession ? (
              <div className="staff-topbar-info">
                <span className="staff-name">{staffSession.displayName}</span>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => void staffSignOut()}>
                  Sign out
                </button>
              </div>
            ) : null}
          </div>
        </header>
        <main className="main">{children}</main>
      </div>
    </div>
  );
}

export function SupportConsole() {
  const NOTE_MAX_LENGTH = 4000;
  const NOTE_HTML_RE = /<\s*\/?\s*(script|iframe|object|embed|img|svg|math|style|link|meta|base)\b/i;
  const { api, staffSession } = useMox();
  const capabilities = staffSession?.capabilities ?? [];
  const canLookup = canSupportLookup(capabilities);
  const canNote = canSupportNote(capabilities);
  const sections = visibleSupportSections(capabilities);
  const { section: staffSection, setSection: setStaffSection } = useStaffSection();
  const [query, setQuery] = useState("");
  const [customers, setCustomers] = useState<SupportCustomer[]>([]);
  const [selected, setSelected] = useState<SupportCustomerDetail | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const section: SupportSectionKey = isSupportSectionKey(staffSection) ? staffSection : "overview";
  const setSection = (next: SupportSectionKey) => setStaffSection?.(next);

  useEffect(() => {
    if (sections.length > 0 && !sections.includes(section)) setSection(sections[0]!);
  }, [section, sections]);

  useEffect(() => {
    if (!canLookup) return;
    let cancelled = false;
    const load = async () => {
      setBusy(true);
      setStatus(null);
      try {
        const list = await api.supportCustomers(undefined);
        if (cancelled) return;
        setCustomers(list);
        if (list.length === 0) {
          setSelected(null);
          setSelectedId(null);
          return;
        }
        const first = list[0]!;
        setSelectedId(first.orgId);
        setSelected(await api.supportCustomer(first.orgId));
      } catch (error) {
        if (!cancelled) setStatus(error instanceof Error ? error.message : String(error));
      } finally {
        if (!cancelled) setBusy(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [canLookup, api]);

  if (!staffSession) return <Connecting />;

  const noteValidation = (() => {
    const trimmed = note.trim();
    if (!trimmed) return "Note is required.";
    if (trimmed.length > NOTE_MAX_LENGTH) return `Note must be ${NOTE_MAX_LENGTH} characters or less.`;
    if (NOTE_HTML_RE.test(trimmed)) return "Notes cannot contain HTML or script content.";
    return null;
  })();

  const search = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!canLookup) return;
    setBusy(true);
    setStatus(null);
    try {
      const list = await api.supportCustomers(query.trim() || undefined);
      setCustomers(list);
      if (list.length === 0) {
        setSelected(null);
        setSelectedId(null);
        return;
      }
      if (!list.some((c) => c.orgId === selectedId)) {
        const first = list[0]!;
        setSelectedId(first.orgId);
        setSelected(await api.supportCustomer(first.orgId));
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const openCustomer = async (orgId: string) => {
    setSelectedId(orgId);
    setStatus(null);
    try {
      setSelected(await api.supportCustomer(orgId));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const addNote = async (event: FormEvent) => {
    event.preventDefault();
    if (!canNote || !selectedId || noteValidation) return;
    setStatus(null);
    try {
      await api.supportAddNote(selectedId, note);
      setNote("");
      await openCustomer(selectedId);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="admin-console">
      <header className="admin-page-head">
        <div>
          <div className="admin-kicker">Mox Support</div>
          <h1>{SUPPORT_SECTION_LABEL[section]}</h1>
          <p className="page-sub">Safe customer diagnostics. Credentials, costs, and staff controls stay hidden.</p>
        </div>
      </header>
      {!canLookup ? (
        <section className="admin-body">
          <div className="empty-state" role="status">
            This account holds no support.customer.lookup capability on this surface. Only authorized support staff
            may view customer data.
          </div>
        </section>
      ) : (
        <section className="admin-body">
          {section === "overview" ? (
            <div className="support-overview-grid" aria-label="Support attention">
              <div className="needs-chip"><strong>{customers.length}</strong><span>Customers in view</span></div>
              <div className="needs-chip"><strong>{customers.reduce((n, c) => n + c.diagnostics.subscriptionsRequiringAttention, 0)}</strong><span>Subscription alerts</span></div>
              <div className="needs-chip"><strong>{customers.reduce((n, c) => n + c.diagnostics.agentsDegraded, 0)}</strong><span>Degraded agents</span></div>
              <div className="needs-chip"><strong>{customers.reduce((n, c) => n + c.diagnostics.serversInError, 0)}</strong><span>Servers in error</span></div>
              <div className="needs-chip"><strong>{customers.reduce((n, c) => n + c.diagnostics.recentNotificationFailures, 0)}</strong><span>Notification failures</span></div>
            </div>
          ) : null}
          <form className="admin-inline-form" onSubmit={(event) => void search(event)}>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search customers (name, slug, id)" aria-label="Search customers" />
            <button type="submit" disabled={busy}>{busy ? "Searching…" : "Search"}</button>
          </form>
          {status ? <div className="admin-alert" role="alert">{status}</div> : null}
          <div className="admin-split">
            <Card title={`Customers (${customers.length})`}>
              {customers.length === 0 ? (
                <EmptyState>Search reveals safe customer summaries.</EmptyState>
              ) : (
                customers.map((customer) => (
                  <button key={customer.orgId} type="button" className={`admin-list-item ${selectedId === customer.orgId ? "active" : ""}`} onClick={() => void openCustomer(customer.orgId)}>
                    <strong>{customer.displayName}</strong>
                    <span>{customer.memberCount} users · {customer.subscriptions.length} subscriptions · {customer.servers.length} servers · {customer.supportNoteCount} notes</span>
                    <span>{customer.diagnostics.subscriptionsRequiringAttention} subscription alerts · {customer.diagnostics.agentsDegraded} agent alerts · {customer.diagnostics.recentNotificationFailures} notification failures</span>
                  </button>
                ))
              )}
            </Card>
            <section>
              {!selected ? (
                <EmptyState>Select a customer to view safe diagnostics and support notes.</EmptyState>
              ) : (
                <>
                  <Card title={selected.displayName} actions={<Badge tone="accent">{selected.slug}</Badge>}>
                    <DataTable
                      columns={["orgId", "workspaceName", "createdAt"]}
                      rows={[{ orgId: selected.orgId, workspaceName: selected.workspaceName, createdAt: selected.createdAt }]}
                    />
                    <div className="admin-metrics">
                      <Metric label="Subscription alerts" value={selected.diagnostics.subscriptionsRequiringAttention} />
                      <Metric label="Server errors" value={selected.diagnostics.serversInError} />
                      <Metric label="Node stale/missing" value={selected.diagnostics.nodesStaleOrMissing} />
                      <Metric label="Agent alerts" value={selected.diagnostics.agentsDegraded} />
                      <Metric label="Connections" value={`${selected.diagnostics.connectionsConfigured}/${selected.diagnostics.connectionsTotal}`} />
                      <Metric label="Notification failures" value={selected.diagnostics.recentNotificationFailures} />
                    </div>
                  </Card>
                  {section === "lookup" ? (
                    <>
                      <Card title="Users">
                        <DataTable columns={["email", "displayName", "role", "disabledAt"]} rows={selected.users} />
                      </Card>
                      <Card title="Subscriptions (lifecycle only)">
                        <DataTable columns={["subscriptionId", "state", "plan", "tier", "currentPeriodEnd", "failedRenewals", "suspensionReason", "reconciliationRequired"]} rows={selected.subscriptions} />
                      </Card>
                    </>
                  ) : null}
                  {section === "diagnostics" ? (
                    <>
                      <Card title="Servers (safe lifecycle state)">
                        <DataTable columns={["id", "computeClassCode", "state", "providerName", "regionCode", "lifecycle", "nodeHealth", "createdAt"]} rows={selected.servers} />
                      </Card>
                      <Card title="Agents and deployments">
                        <DataTable columns={["agentId", "displayName", "status", "currentVersion", "deploymentKind", "deploymentState", "desiredRevision", "runtimeHealth"]} rows={selected.agents} />
                      </Card>
                      <Card title="Model connections">
                        <DataTable columns={["providerId", "displayName", "kind", "status", "credentialConfigured", "connected"]} rows={selected.connections.models} />
                      </Card>
                      <Card title="Integration connections">
                        <DataTable columns={["integrationId", "displayName", "kind", "status", "credentialConfigured", "connected"]} rows={selected.connections.integrations} />
                      </Card>
                      <Card title="Channel connections">
                        <DataTable columns={["channelId", "displayName", "kind", "status", "credentialConfigured", "connected", "boundAgentName"]} rows={selected.connections.channels} />
                      </Card>
                      <Card title="Recent notification failures">
                        <DataTable columns={["at", "eventType", "route", "deliveryState", "attempts", "errorSummary"]} rows={selected.notificationFailures} />
                      </Card>
                    </>
                  ) : null}
                  {section === "notes" ? (
                    <Card title="Support notes">
                      {canNote ? (
                        <form className="admin-form support-note-form" onSubmit={(event) => void addNote(event)}>
                          <textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Add a support note (audited)" rows={4} />
                          <div className="support-note-meta">
                            <span className={noteValidation && note.trim() ? "admin-form-error" : "muted"}>
                              {note.trim().length}/{NOTE_MAX_LENGTH}{noteValidation && note.trim() ? ` · ${noteValidation}` : ""}
                            </span>
                            <button type="submit" disabled={Boolean(noteValidation)}>Add note</button>
                          </div>
                        </form>
                      ) : null}
                      <DataTable columns={["at", "actorId", "note"]} rows={selected.supportNotes} />
                    </Card>
                  ) : null}
                  {section === "activity" ? (
                    <Card title="Recent activity (safe audit metadata)">
                      <DataTable columns={["at", "action", "actorType", "resourceType"]} rows={selected.recentActivity} />
                    </Card>
                  ) : null}
                  {section === "escalation" ? (
                    <Card title="Escalation">
                      <EmptyState>Escalation capability is present. No audited escalation action is configured in this domain yet.</EmptyState>
                    </Card>
                  ) : null}
                </>
              )}
            </section>
          </div>
        </section>
      )}
    </div>
  );
}

/** Minimal column/row table reused by the staff surfaces. */
function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="admin-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function staffCellTone(value: string): "neutral" | "good" | "warn" | "bad" | "accent" {
  const v = value.toLowerCase();
  if (["active", "running", "healthy", "completed", "current", "enabled", "available", "provisioned", "online", "live"].some((x) => v.includes(x))) return "good";
  if (["pending", "scheduled", "maintenance", "trial", "grace", "degraded", "busy", "working", "stopping"].some((x) => v.includes(x))) return "warn";
  if (["failed", "error", "denied", "suspended", "canceled", "not_configured", "stopped", "offline", "unavailable"].some((x) => v.includes(x))) return "bad";
  return "neutral";
}

function DataTable({ columns, rows, empty = "No records." }: { columns: string[]; rows: object[]; empty?: string }) {
  const asString = (value: unknown): string => {
    if (value === null || value === undefined) return "";
    if (value instanceof Date) return value.toISOString();
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  };
  const renderCell = (column: string, val: unknown): ReactNode => {
    const str = asString(val);
    if (!str) return "";
    const lower = str.toLowerCase();
    const stateColumns = ["state", "status", "lifecycle", "nodehealth", "runtimehealth", "deliverystate", "deploymentstate", "health"];
    const stateKeywords = ["running", "active", "healthy", "idle", "provisioned", "online", "live", "degraded", "pending", "working", "failed", "error", "stopped", "unavailable", "offline", "suspended", "enabled", "disabled"];
    if (stateColumns.includes(column.toLowerCase()) || stateKeywords.includes(lower)) {
      return <Badge tone={staffCellTone(str)}>{str}</Badge>;
    }
    return str;
  };
  if (rows.length === 0) return <EmptyState>{empty}</EmptyState>;
  return (
    <div className="admin-table-wrap">
      <table className="admin-table">
        <thead><tr>{columns.map((column) => <th key={column}>{humanizeLabel(column)}</th>)}</tr></thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={asString((row as Record<string, unknown>).id ?? (row as Record<string, unknown>).orgId ?? (row as Record<string, unknown>).subscriptionId ?? (row as Record<string, unknown>).agentId ?? index)}>
              {columns.map((column) => <td key={column}>{renderCell(column, (row as Record<string, unknown>)[column])}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StaffSurface({ kind }: { kind: "admin" | "support" }) {
  const { path, navigate } = useRoute();
  const publicRoutes = kind === "admin" ? ADMIN_PUBLIC : SUPPORT_PUBLIC;
  const home = kind === "admin" ? "/admin" : "/support";
  const {
    staffReady,
    staffSession,
    staffError,
    verifyStaffSession,
    adminLogin,
    adminSignup,
    supportLogin,
    supportSignup,
    forgotPassword,
    resetPassword,
  } = useMox();

  useEffect(() => {
    void verifyStaffSession(kind);
  }, [verifyStaffSession, kind]);

  const authMatch = resolveParams(publicRoutes, path);
  if (authMatch) {
    const pattern = authMatch.pattern;
    const returnTo = safeReturnToStaff(safeCustomerReturn(currentReturnTo()), kind);
    const loginOf = kind === "admin" ? "/admin/login" : "/support/login";

    if (pattern.endsWith("/login")) {
      const submit =
        kind === "admin"
          ? async (input: { email: string; password: string }) => {
              await adminLogin({ email: input.email, password: input.password });
            }
          : async (input: { email: string; password: string }) => {
              await supportLogin({ email: input.email, password: input.password });
            };
      return (
        <LoginPage
          surface={kind}
          title={kind === "admin" ? "Sign in to Mox Admin" : "Sign in to Mox Support"}
          onSubmit={async (input) => {
            await submit({ email: input.email, password: input.password });
            navigate(returnTo === "/" ? home : returnTo);
          }}
          signupPath={kind === "admin" ? "/admin/signup" : "/support/signup"}
          forgotPath={kind === "admin" ? "/admin/forgot-password" : "/support/forgot-password"}
        />
      );
    }
    if (pattern.endsWith("/signup")) {
      const submit =
        kind === "admin"
          ? async (i: { email: string; password: string; inviteToken?: string }) =>
              adminSignup({ email: i.email, password: i.password, inviteToken: i.inviteToken ?? "" })
          : async (i: { email: string; password: string; inviteToken?: string }) =>
              supportSignup({ email: i.email, password: i.password, inviteToken: i.inviteToken ?? "" });
      return (
        <SignupPage
          surface={kind}
          title={kind === "admin" ? "Join Mox Admin" : "Join Mox Support"}
          inviteRequired
          onSubmit={async (input) => {
            await submit({ email: input.email, password: input.password, inviteToken: input.inviteToken });
            navigate(returnTo === "/" ? home : returnTo);
          }}
          loginPath={loginOf}
        />
      );
    }
    if (pattern.endsWith("/forgot-password")) {
      return (
        <ForgotPasswordPage
          surface={kind}
          title={kind === "admin" ? "Reset admin password" : "Reset support password"}
          onSubmit={(email) => forgotPassword(email).then(() => undefined)}
          backPath={loginOf}
        />
      );
    }
    const token = new URLSearchParams(window.location.search).get("token") ?? "";
    return (
      <ResetPasswordPage
        surface={kind}
        title="Set a new password"
        token={token}
        onSubmit={(t, password) => resetPassword({ token: t, password }).then(() => undefined)}
        backPath={loginOf}
      />
    );
  }

  // Protected staff route under this surface's prefix.
  if (staffReady && staffSession) {
    if (path === home || path.startsWith(home + "/")) {
      return (
        <StaffShell surface={kind}>{kind === "admin" ? <AdminView /> : <SupportConsole />}</StaffShell>
      );
    }
    return (
      <StaffShell surface={kind}>
        <h1>Not found</h1>
        <p className="muted">
          No route for <code>{path}</code>.
        </p>
      </StaffShell>
    );
  }
  if (staffError && !staffReady && !staffSession) {
    return (
      <div className="backend-error" role="alert">
        Backend unavailable: {staffError}
      </div>
    );
  }
  if (staffReady && !staffSession) {
    const loginPath = kind === "admin" ? "/admin/login" : "/support/login";
    return <Redirect to={`${loginPath}${returnQuery(path)}`} />;
  }
  return <Connecting />;
}

/** Staff return-target: the customer guard already blocks escape; constrain
 *  further to paths within this staff surface's own root. */
function safeReturnToStaff(target: string, kind: "admin" | "support"): string {
  const root = kind === "admin" ? "/admin" : "/support";
  if (target === root || target.startsWith(root + "/")) return target;
  return root;
}

// ----------------------------------------------------------------------------
// Root surface router
// ----------------------------------------------------------------------------

export function App() {
  return (
    <MoxProvider>
      <SurfaceRouter />
    </MoxProvider>
  );
}

export function SurfaceRouter() {
  const { path } = useRoute();
  if (path === "/__ui" || path.startsWith("/__ui/")) {
    return <UiStudioView />;
  }
  if (path === "/admin" || path.startsWith("/admin/")) return <StaffSurface kind="admin" />;
  if (path === "/support" || path.startsWith("/support/")) return <StaffSurface kind="support" />;
  return <CustomerSurface />;
}

// WorkTab is re-exported for potential embedding in room panes later.
export { WorkTab };
