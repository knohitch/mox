import { useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { Link } from "../router.js";

/**
 * Standalone (no app-shell) authentication pages for the three surfaces:
 * customer, admin, support (Prompt 01). These render OUTSIDE the product
 * shell so a logged-out staff/customer landing can never leak the app body.
 * Semantic labels + autocomplete are used for credentials fields.
 */

export type SurfaceKind = "customer" | "admin" | "support";

export const SURFACE_PATHS: Record<SurfaceKind, string> = {
  customer: "",
  admin: "/admin",
  support: "/support",
};

export const SURFACE_LABEL: Record<SurfaceKind, string> = {
  customer: "Mox",
  admin: "Mox Admin",
  support: "Mox Support",
};

export function AuthLayout({ surface, children }: { surface: SurfaceKind; children: ReactNode }) {
  return (
    <div className="auth-shell" data-surface={surface}>
      <div className="auth-brand">
        M<span>ox</span>
        {surface !== "customer" ? <small>{SURFACE_LABEL[surface]}</small> : null}
      </div>
      {children}
    </div>
  );
}

function Field({
  label,
  type,
  value,
  onChange,
  autoComplete,
  hint,
  required = true,
}: {
  label: string;
  type: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
  hint?: string;
  required?: boolean;
}) {
  return (
    <label>
      {label}
      <input
        type={type}
        required={required}
        value={value}
        autoComplete={autoComplete}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint ? <small className="muted">{hint}</small> : null}
    </label>
  );
}

function ErrorBox({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div className="backend-error" role="alert">
      {error}
    </div>
  );
}

export function LoginPage({
  surface,
  title,
  submissionLabel = "Sign in",
  onSubmit,
  signupPath,
  forgotPath,
  hideSignup,
  notify,
}: {
  surface: SurfaceKind;
  title: string;
  submissionLabel?: string;
  onSubmit: (input: { email: string; password: string; returnTo?: string }) => Promise<void>;
  signupPath?: string;
  forgotPath: string;
  hideSignup?: boolean;
  notify?: string | null;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    onSubmit({ email, password, returnTo: undefined })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  return (
    <AuthLayout surface={surface}>
      <form className="auth-gate" onSubmit={submit}>
        <h1>{title}</h1>
        {notify ? (
          <div className="muted" role="status">
            {notify}
          </div>
        ) : null}
        <Field label="Email" type="email" value={email} onChange={setEmail} autoComplete="username" />
        <Field label="Password" type="password" value={password} onChange={setPassword} autoComplete="current-password" />
        <ErrorBox error={error} />
        <button type="submit" disabled={busy}>
          {busy ? "Working…" : submissionLabel}
        </button>
        <div className="auth-links">
          <Link to={forgotPath} className="linklike">
            Forgot password?
          </Link>
          {signupPath && !hideSignup ? (
            <Link to={signupPath} className="linklike">
              Need an account? Sign up
            </Link>
          ) : null}
        </div>
      </form>
    </AuthLayout>
  );
}

export function SignupPage({
  surface,
  title,
  submissionLabel = "Sign up",
  onSubmit,
  loginPath,
  inviteRequired,
  hideSignup,
}: {
  surface: SurfaceKind;
  title: string;
  submissionLabel?: string;
  onSubmit: (input: { email: string; password: string; inviteToken?: string; orgName?: string }) => Promise<void>;
  loginPath: string;
  inviteRequired?: boolean;
  hideSignup?: boolean;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [orgName, setOrgName] = useState("");
  const [inviteToken, setInviteToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    onSubmit({
      email,
      password,
      inviteToken: inviteRequired ? inviteToken : undefined,
      orgName: orgName || undefined,
    })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  return (
    <AuthLayout surface={surface}>
      <form className="auth-gate" onSubmit={submit}>
        <h1>{title}</h1>
        {inviteRequired ? (
          <div className="muted" role="status">
            Signup on this surface is invite-only. Enter the invitation token you received from a Mox operator.
          </div>
        ) : null}
        <Field label="Email" type="email" value={email} onChange={setEmail} autoComplete="username" />
        <Field
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          hint="At least 12 characters."
        />
        {inviteRequired ? (
          <Field label="Invitation token" type="text" value={inviteToken} onChange={setInviteToken} autoComplete="off" />
        ) : (
          <Field label="Workspace name (optional)" type="text" value={orgName} onChange={setOrgName} autoComplete="organization" required={false} />
        )}
        <ErrorBox error={error} />
        <button type="submit" disabled={busy}>
          {busy ? "Working…" : submissionLabel}
        </button>
        {!hideSignup ? (
          <div className="auth-links">
            <Link to={loginPath} className="linklike">
              Have an account? Sign in
            </Link>
          </div>
        ) : null}
      </form>
    </AuthLayout>
  );
}

export function ForgotPasswordPage({
  surface,
  title,
  onSubmit,
  backPath,
}: {
  surface: SurfaceKind;
  title: string;
  onSubmit: (email: string) => Promise<void>;
  backPath: string;
}) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    onSubmit(email)
      .then(() => setDone(true))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  return (
    <AuthLayout surface={surface}>
      <form className="auth-gate" onSubmit={submit}>
        <h1>{title}</h1>
        {done ? (
          <div className="muted" role="status">
            If that email address is registered, a reset instruction has been sent. Check your inbox.
          </div>
        ) : (
          <>
            <Field label="Email" type="email" value={email} onChange={setEmail} autoComplete="username" />
            <ErrorBox error={error} />
            <button type="submit" disabled={busy}>
              {busy ? "Working…" : "Send reset link"}
            </button>
          </>
        )}
        <div className="auth-links">
          <Link to={backPath} className="linklike">
            Back to sign in
          </Link>
        </div>
      </form>
    </AuthLayout>
  );
}

export function ResetPasswordPage({
  surface,
  title,
  token,
  onSubmit,
  backPath,
}: {
  surface: SurfaceKind;
  title: string;
  token: string;
  onSubmit: (token: string, password: string) => Promise<void>;
  backPath: string;
}) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    setError(null);
    onSubmit(token, password)
      .then(() => setDone(true))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  return (
    <AuthLayout surface={surface}>
      <form className="auth-gate" onSubmit={submit}>
        <h1>{title}</h1>
        {done ? (
          <div className="muted" role="status">
            Password reset. You can now sign in.
          </div>
        ) : token ? (
          <>
            <Field label="New password" type="password" value={password} onChange={setPassword} autoComplete="new-password" hint="At least 12 characters." />
            <Field label="Confirm new password" type="password" value={confirm} onChange={setConfirm} autoComplete="new-password" />
            <ErrorBox error={error} />
            <button type="submit" disabled={busy}>
              {busy ? "Working…" : "Reset password"}
            </button>
          </>
        ) : (
          <div className="backend-error" role="alert">
            This reset link is missing its token. Request a new reset link.
          </div>
        )}
        <div className="auth-links">
          <Link to={backPath} className="linklike">
            Back to sign in
          </Link>
        </div>
      </form>
    </AuthLayout>
  );
}

export function PermissionDenied({ surface, title }: { surface: SurfaceKind; title: string }) {
  return (
    <AuthLayout surface={surface}>
      <div className="auth-gate">
        <h1>{title}</h1>
        <div className="backend-error" role="alert">
          You do not have authority to access this surface. Mox operators provision staff access by invitation.
        </div>
      </div>
    </AuthLayout>
  );
}
