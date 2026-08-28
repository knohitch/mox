import { useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { MoxProvider, useMox } from "./api/store.js";
import { resolveParams, useRoute } from "./router.js";
import { CustomerShell } from "./shell/CustomerShell.js";
import { AgentsView, WorkTab } from "./views/AgentsView.js";
import { AdminView } from "./views/AdminView.js";
import { ForgotPasswordPage, LoginPage, ResetPasswordPage, SignupPage } from "./views/AuthPages.js";
import { Badge, Card, EmptyState } from "./ui/primitives.js";
import { canSupportLookup, canSupportNote } from "./concepts/staffNav.js";
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
  if (!raw) return "/";
  if (raw.startsWith("//") || raw.includes("://") || raw.includes("\\")) return "/";
  if (!raw.startsWith("/")) return "/";
  if (raw === "/admin" || raw.startsWith("/admin/")) return "/";
  if (raw === "/support" || raw.startsWith("/support/")) return "/";
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
          navigate(returnTo || "/");
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
          navigate(returnTo || "/");
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

// ----------------------------------------------------------------------------
// Staff surfaces (admin / support) — Prompt 01 isolation
// ----------------------------------------------------------------------------

function StaffShell({ surface, children }: { surface: "admin" | "support"; children: ReactNode }) {
  const { staffSignOut, staffSession } = useMox();
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          M<span>ox</span>
          <small>{surface === "support" ? "Support" : "Admin"}</small>
        </div>
        <div className="section-label">{surface === "support" ? "Support console" : "Admin console"}</div>
        {staffSession ? (
          <div className="staff-identity muted">
            {staffSession.displayName}
            <br />
            {staffSession.email}
          </div>
        ) : null}
        <button type="button" className="nav-item signout" onClick={() => void staffSignOut()}>
          Sign out
        </button>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}

function SupportConsole() {
  const { api, staffSession } = useMox();
  const capabilities = staffSession?.capabilities ?? [];
  const canLookup = canSupportLookup(capabilities);
  const canNote = canSupportNote(capabilities);
  const [query, setQuery] = useState("");
  const [customers, setCustomers] = useState<SupportCustomer[]>([]);
  const [selected, setSelected] = useState<SupportCustomerDetail | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!staffSession) return <Connecting />;

  const search = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!canLookup) return;
    setBusy(true);
    setStatus(null);
    try {
      setCustomers(await api.supportCustomers(query.trim() || undefined));
      if (customers.length === 0 && !selectedId) setSelected(null);
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
    if (!canNote || !selectedId || !note.trim()) return;
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
      <header className="admin-console-head">
        <div>
          <div className="admin-kicker">Mox Support</div>
          <h1>Support console</h1>
        </div>
        <span className="muted">Least-privilege customer lookup — support sees safe diagnostics only.</span>
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
          <form className="admin-inline-form" onSubmit={(event) => void search(event)}>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search customers (name, slug, id)" />
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
                    <DataTable columns={["email", "displayName", "role", "disabledAt"]} rows={selected.users} />
                  </Card>
                  <Card title="Subscriptions (no billing details)">
                    <DataTable columns={["subscriptionId", "state", "plan", "currentPeriodEnd"]} rows={selected.subscriptions} />
                  </Card>
                  <Card title="Servers (infrastructure state only)">
                    <DataTable columns={["id", "computeClassCode", "state", "providerName", "regionCode", "createdAt"]} rows={selected.servers} />
                  </Card>
                  <Card title="Agents">
                    <DataTable columns={["agentId", "displayName", "status", "currentVersion"]} rows={selected.agents} />
                  </Card>
                  <Card title="Recent activity (audited)">
                    <DataTable columns={["at", "action", "actorType", "resourceType"]} rows={selected.recentActivity} />
                  </Card>
                  <Card title="Support notes">
                    {canNote ? (
                      <form className="admin-inline-form" onSubmit={(event) => void addNote(event)}>
                        <input value={note} onChange={(event) => setNote(event.target.value)} placeholder="Add a support note (audited)" />
                        <button type="submit">Add note</button>
                      </form>
                    ) : null}
                    <DataTable columns={["at", "actorId", "note"]} rows={selected.supportNotes} />
                  </Card>
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
function DataTable({ columns, rows, empty = "No records." }: { columns: string[]; rows: Array<Record<string, unknown>>; empty?: string }) {
  const asString = (value: unknown): string => {
    if (value === null || value === undefined) return "";
    if (value instanceof Date) return value.toISOString();
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  };
  if (rows.length === 0) return <EmptyState>{empty}</EmptyState>;
  return (
    <div className="admin-table-wrap">
      <table className="admin-table">
        <thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={asString(row.id ?? row.orgId ?? row.subscriptionId ?? row.agentId ?? index)}>
              {columns.map((column) => <td key={column}>{asString(row[column])}</td>)}
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
  if (path === "/admin" || path.startsWith("/admin/")) return <StaffSurface kind="admin" />;
  if (path === "/support" || path.startsWith("/support/")) return <StaffSurface kind="support" />;
  return <CustomerSurface />;
}

// WorkTab is re-exported for potential embedding in room panes later.
export { WorkTab };
