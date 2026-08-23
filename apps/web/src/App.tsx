import { useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { MoxProvider, useMox } from "./api/store.js";
import { NotificationBell } from "./views/NotificationCenter.js";
import { resolveParams, useRoute, Link } from "./router.js";
import { AgentsView, WorkTab } from "./views/AgentsView.js";
import { AdminView } from "./views/AdminView.js";
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
  "/admin": () => <AdminView />,
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
  ["/admin", "Mox Admin"],
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
  const { error, ready, needsAuth, signIn, signUp, signOut } = useMox();
  const match = resolveParams(Object.keys(ROUTES), path);
  const active = match?.pattern ?? null;
  const View = active ? ROUTES[active] : undefined;
  const adminRoute = active === "/admin";

  return (
    <div className="app">
      <div className="topbar">
        <NotificationBell />
      </div>
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
        {ready ? (
          <button type="button" className="nav-item signout" onClick={() => void signOut()}>
            Sign out
          </button>
        ) : null}
      </aside>
      <main className="main">
        {needsAuth && !ready ? (
          <AuthGate onSignIn={signIn} onSignUp={signUp} allowSignup={!adminRoute} title={adminRoute ? "Sign in to Mox Admin" : undefined} />
        ) : (
          <>
            {error ? (
              <div className="backend-error" role="alert">
                Backend unavailable: {error} — the Mox web app never falls back to demo data.
              </div>
            ) : null}
            {!error && !ready ? <div className="backend-error">Connecting to the Mox control plane…</div> : null}
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
          </>
        )}
      </main>
    </div>
  );
}

function AuthGate(props: {
  onSignIn: (input: { email: string; password: string }) => Promise<void>;
  onSignUp: (input: { email: string; password: string; orgName?: string }) => Promise<void>;
  allowSignup?: boolean;
  title?: string;
}): ReactNode {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [orgName, setOrgName] = useState("");
  const [busy, setBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setAuthError(null);
    const action =
      mode === "login" || props.allowSignup === false
        ? props.onSignIn({ email, password })
        : props.onSignUp({ email, password, orgName: orgName || undefined });
    action.catch((error) => setAuthError(error instanceof Error ? error.message : String(error))).finally(() => setBusy(false));
  };

  return (
    <form className="auth-gate" onSubmit={submit}>
      <h1>{props.title ?? (mode === "login" ? "Sign in to Mox" : "Create your Mox workspace")}</h1>
      <label>
        Email
        <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
      </label>
      <label>
        Password
        <input
          type="password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={mode === "login" ? "current-password" : "new-password"}
        />
      </label>
      {props.allowSignup !== false && mode === "signup" ? (
        <label>
          Workspace name (optional)
          <input type="text" value={orgName} onChange={(e) => setOrgName(e.target.value)} />
        </label>
      ) : null}
      {authError ? (
        <div className="backend-error" role="alert">
          {authError}
        </div>
      ) : null}
      <button type="submit" disabled={busy}>
        {busy ? "Working…" : mode === "login" || props.allowSignup === false ? "Sign in" : "Sign up"}
      </button>
      {props.allowSignup === false ? (
        <p className="muted">Admin access is provisioned by Mox operators. Public admin signup is not available.</p>
      ) : (
        <button
          type="button"
          className="linklike"
          onClick={() => setMode(mode === "login" ? "signup" : "login")}
        >
          {mode === "login" ? "Need an account? Sign up" : "Have an account? Sign in"}
        </button>
      )}
    </form>
  );
}

// WorkTab is re-exported for potential embedding in room panes later.
export { WorkTab };
