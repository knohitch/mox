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

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#EA4335"
        d="M12 5c1.6 0 3 .6 4.1 1.7l3.1-3.1C17.3 1.8 14.8 1 12 1 7.5 1 3.7 3.6 1.9 7.3l3.7 2.9C6.5 7.3 9 5 12 5z"
      />
      <path
        fill="#4285F4"
        d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.6h6.5c-.3 1.5-1.1 2.8-2.4 3.7l3.7 2.9c2.2-2 3.7-5 3.7-8.9z"
      />
      <path
        fill="#FBBC05"
        d="M5.6 14.8c-.2-.7-.4-1.5-.4-2.3 0-.8.2-1.6.4-2.3L1.9 7.3C.7 9.7 0 12.3 0 15.2c0 2.8.7 5.5 1.9 7.9l3.7-2.9z"
      />
      <path
        fill="#34A853"
        d="M12 23.5c3.2 0 6-1.1 8-3l-3.7-2.9c-1.1.7-2.5 1.2-4.3 1.2-3 0-5.5-2.3-6.4-5.2L1.9 16.5C3.7 20.3 7.5 23.5 12 23.5z"
      />
    </svg>
  );
}

function MailIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect width="20" height="16" x="2" y="4" rx="2" />
      <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

function BuildingIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect width="16" height="20" x="4" y="2" rx="2" ry="2" />
      <path d="M9 22v-4h6v4" />
      <path d="M8 6h.01" />
      <path d="M16 6h.01" />
      <path d="M8 10h.01" />
      <path d="M16 10h.01" />
    </svg>
  );
}

function KeyIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m21 2-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4" />
    </svg>
  );
}

function EyeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
      <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
      <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
      <line x1="2" x2="22" y1="2" y2="22" />
    </svg>
  );
}

function MoxLogo({ className = "mox-brand-logo" }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 760 220"
      fill="none"
      role="img"
      aria-label="Mox"
      className={className}
    >
      <g fill="currentColor">
        {/* MOX SYMBOL */}
        <path d="M30 28C30 22 37 19 42 23L112 75V132L30 72V28Z" />
        <path d="M196 28C196 22 189 19 184 23L114 75V132L196 72V28Z" />
        <path d="M30 190C30 196 37 199 42 195L112 143L72 114L30 145V190Z" />
        <path d="M196 190C196 196 189 199 184 195L114 143L154 114L196 145V190Z" />

        {/* M */}
        <path d="M265 52 H292 L344 111 L396 52 H423 V178 H397 V91 L344 150 L291 91 V178 H265 Z" />

        {/* O */}
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M500 49 C458 49 429 77 429 115 C429 153 458 181 500 181 C542 181 571 153 571 115 C571 77 542 49 500 49 Z M500 76 C526 76 544 92 544 115 C544 138 526 154 500 154 C474 154 456 138 456 115 C456 92 474 76 500 76 Z"
        />

        {/* X */}
        <path d="M585 54 H618 L653 96 L688 54 H721 L670 115 L724 178 H691 L653 133 L615 178 H582 L636 115 Z" />
      </g>
    </svg>
  );
}

export function AuthLayout({ surface, children }: { surface: SurfaceKind; children: ReactNode }) {
  return (
    <div className="mastra-auth-shell" data-surface={surface}>
      <div className="mastra-auth-card">
        {/* Left Form Column */}
        <div className="mastra-form-col">
          <div className="mastra-form-wrapper">
            {/* Logo & Brand */}
            <div className="mastra-brand-block">
              <div className="mox-logo-wrapper">
                <MoxLogo className="mox-brand-logo" />
                {surface !== "customer" ? <span className="mastra-surface-tag">{surface}</span> : null}
              </div>
              <p className="mastra-tagline">
                The hosted AI agent cloud and control plane for autonomous multi-model teams on dedicated VPS compute.
              </p>
            </div>

            {/* Form and Controls */}
            {children}
          </div>
        </div>

        {/* Right Showcase Column (Rich rock texture with floating dashboard) */}
        <div className="mastra-showcase-col">
          <div className="mastra-showcase-frame">
            <img
              className="mastra-showcase-img"
              src="/assets/auth/mox-showcase-panel.png"
              alt="Mox Platform Overview"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  type,
  value,
  onChange,
  autoComplete,
  placeholder,
  hint,
  icon,
  required = true,
}: {
  label: string;
  type: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
  placeholder?: string;
  hint?: string;
  icon?: "mail" | "lock" | "building" | "key";
  required?: boolean;
}) {
  const [showPassword, setShowPassword] = useState(false);
  const isPassword = type === "password";
  const actualType = isPassword ? (showPassword ? "text" : "password") : type;

  return (
    <div className="mastra-field">
      <div className="mastra-field-head">
        <label className="mastra-label-text">{label}</label>
        {hint ? <span className="mastra-hint">{hint}</span> : null}
      </div>
      <div className="mastra-input-box">
        {icon === "mail" && <span className="mastra-input-icon"><MailIcon /></span>}
        {icon === "lock" && <span className="mastra-input-icon"><LockIcon /></span>}
        {icon === "building" && <span className="mastra-input-icon"><BuildingIcon /></span>}
        {icon === "key" && <span className="mastra-input-icon"><KeyIcon /></span>}
        <input
          type={actualType}
          required={required}
          value={value}
          autoComplete={autoComplete}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          className="mastra-input"
        />
        {isPassword ? (
          <button
            type="button"
            className="mastra-pwd-toggle"
            onClick={() => setShowPassword(!showPassword)}
            aria-label={showPassword ? "Hide password" : "Show password"}
            tabIndex={-1}
          >
            {showPassword ? <EyeOffIcon /> : <EyeIcon />}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ErrorBox({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div className="mastra-error-box" role="alert">
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
      <form className="mastra-gate" onSubmit={submit}>
        {notify ? (
          <div className="mastra-notify" role="status">
            {notify}
          </div>
        ) : null}

        <Field
          label="Email"
          type="email"
          icon="mail"
          value={email}
          onChange={setEmail}
          autoComplete="username"
          placeholder="name@work-email.com"
        />
        <Field
          label="Password"
          type="password"
          icon="lock"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          placeholder="••••••••••••"
        />

        <ErrorBox error={error} />

        <button type="submit" className="mastra-btn-primary" disabled={busy}>
          {busy ? "Signing in…" : submissionLabel}
        </button>

        <div className="mastra-auth-divider">
          <span>or continue with</span>
        </div>

        <button type="button" className="mastra-btn-google">
          <GoogleIcon />
          <span>Continue with Google</span>
        </button>

        <div className="mastra-footer-links">
          {signupPath && !hideSignup ? (
            <p className="mastra-switch-text">
              Don&apos;t have an account?{" "}
              <Link to={signupPath} className="mastra-link-highlight">
                Sign up
              </Link>
            </p>
          ) : null}
          <Link to={forgotPath} className="mastra-link-muted">
            Forgot password?
          </Link>
        </div>
      </form>
    </AuthLayout>
  );
}

export function SignupPage({
  surface,
  title,
  submissionLabel = "Sign Up",
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
      <form className="mastra-gate" onSubmit={submit}>
        {inviteRequired ? (
          <div className="mastra-notify invite-warning" role="status">
            Signup on this authority surface requires a valid invitation token from a Mox operator.
          </div>
        ) : null}

        <Field
          label="Email"
          type="email"
          icon="mail"
          value={email}
          onChange={setEmail}
          autoComplete="username"
          placeholder="name@work-email.com"
        />
        <Field
          label="Password"
          type="password"
          icon="lock"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          placeholder="At least 12 characters"
          hint="Min. 12 characters"
        />

        {inviteRequired ? (
          <Field
            label="Invitation token"
            type="text"
            icon="key"
            value={inviteToken}
            onChange={setInviteToken}
            autoComplete="off"
            placeholder="inv_..."
          />
        ) : (
          <Field
            label="Workspace name (optional)"
            type="text"
            icon="building"
            value={orgName}
            onChange={setOrgName}
            autoComplete="organization"
            placeholder="My Team"
            required={false}
          />
        )}

        <ErrorBox error={error} />

        <button type="submit" className="mastra-btn-primary" disabled={busy}>
          {busy ? "Creating account…" : submissionLabel}
        </button>

        {!inviteRequired ? (
          <>
            <div className="mastra-auth-divider">
              <span>or continue with</span>
            </div>
            <button type="button" className="mastra-btn-google">
              <GoogleIcon />
              <span>Continue with Google</span>
            </button>
          </>
        ) : null}

        {!hideSignup ? (
          <div className="mastra-footer-links">
            <p className="mastra-switch-text">
              Already have an account?{" "}
              <Link to={loginPath} className="mastra-link-highlight">
                Sign in
              </Link>
            </p>
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
      <form className="mastra-gate" onSubmit={submit}>
        {done ? (
          <div className="mastra-notify success" role="status">
            If that email address is registered, a password reset link has been dispatched. Check your inbox.
          </div>
        ) : (
          <>
            <Field
              label="Email"
              type="email"
              icon="mail"
              value={email}
              onChange={setEmail}
              autoComplete="username"
              placeholder="name@work-email.com"
            />
            <ErrorBox error={error} />
            <button type="submit" className="mastra-btn-primary" disabled={busy}>
              {busy ? "Sending reset link…" : "Send reset link"}
            </button>
          </>
        )}

        <div className="mastra-footer-links">
          <Link to={backPath} className="mastra-link-highlight">
            Back to login
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
      <form className="mastra-gate" onSubmit={submit}>
        {done ? (
          <div className="mastra-notify success" role="status">
            Password reset successfully. You can now login with your new password.
          </div>
        ) : token ? (
          <>
            <Field
              label="New password"
              type="password"
              icon="lock"
              value={password}
              onChange={setPassword}
              autoComplete="new-password"
              placeholder="At least 12 characters"
              hint="Min. 12 characters"
            />
            <Field
              label="Confirm new password"
              type="password"
              icon="lock"
              value={confirm}
              onChange={setConfirm}
              autoComplete="new-password"
              placeholder="Confirm new password"
            />
            <ErrorBox error={error} />
            <button type="submit" className="mastra-btn-primary" disabled={busy}>
              {busy ? "Updating password…" : "Reset password"}
            </button>
          </>
        ) : (
          <div className="mastra-error-box" role="alert">
            This reset link is missing its cryptographic token. Request a new reset link.
          </div>
        )}

        <div className="mastra-footer-links">
          <Link to={backPath} className="mastra-link-highlight">
            Back to login
          </Link>
        </div>
      </form>
    </AuthLayout>
  );
}

export function PermissionDenied({ surface, title }: { surface: SurfaceKind; title: string }) {
  return (
    <AuthLayout surface={surface}>
      <div className="mastra-gate">
        <div className="mastra-error-box" role="alert">
          Access denied. You do not have authority to access this surface. Mox operators provision staff access by invitation.
        </div>
      </div>
    </AuthLayout>
  );
}
