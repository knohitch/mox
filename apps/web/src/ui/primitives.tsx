import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from "react";
import { avatarHue, initials, STATUS_LABEL } from "../domain/roster.js";
import type { AgentStatus } from "../domain/roster.js";

export function Avatar({
  slug,
  name,
  size = 36,
  status,
}: {
  slug: string;
  name: string;
  size?: number;
  status?: AgentStatus;
}) {
  const hue = avatarHue(slug);
  const style: CSSProperties = {
    width: size,
    height: size,
    fontSize: size * 0.38,
    background: `linear-gradient(135deg, hsl(${hue} 65% 46%), hsl(${(hue + 40) % 360} 70% 38%))`,
  };
  return (
    <span className="avatar-wrap" style={{ width: size, height: size }}>
      <span className="avatar" style={style} aria-hidden>
        {initials({ identity: { displayName: name }, slug })}
      </span>
      {status && <span className={`status-dot status-${status}`} title={STATUS_LABEL[status]} />}
    </span>
  );
}

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "good" | "warn" | "bad" | "accent" }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Button({
  kind = "default",
  size,
  ...rest
}: { kind?: "default" | "primary" | "danger" | "ghost"; size?: "sm" | "md" } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={`btn btn-${kind}${size ? ` btn-${size}` : ""}`} {...rest} />
  );
}

/** Page title bar used across customer views (title + subtitle + actions). */
export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        {subtitle ? <p className="page-sub">{subtitle}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}

/** Layered surface panel (section) with optional header. */
export function Panel({ title, subtitle, actions, children }: { title?: string; subtitle?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel">
      {title || actions ? (
        <header className="panel-head">
          <div>
            {title ? <h3>{title}</h3> : null}
            {subtitle ? <p className="panel-sub">{subtitle}</p> : null}
          </div>
          {actions ? <div className="panel-actions">{actions}</div> : null}
        </header>
      ) : null}
      <div className="panel-body">{children}</div>
    </section>
  );
}

/** Compact stat / KPI card. */
export function KpiCard({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "good" | "warn" | "bad" | "accent" }) {
  return (
    <div className={`kpi ${tone ? `kpi-${tone}` : ""}`}>
      <span className="kpi-label">{label}</span>
      <strong className="kpi-value">{value}</strong>
      {hint ? <span className="kpi-hint">{hint}</span> : null}
    </div>
  );
}

export function Card({ title, children, actions }: { title?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="card">
      {(title || actions) && (
        <header className="card-head">
          {title && <h3>{title}</h3>}
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

/** Honest loading indicator used before authoritative data arrives. */
export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="state" role="status" aria-live="polite">
      <span className="spinner" aria-hidden />
      <span className="muted">{label}</span>
    </div>
  );
}

/** Honest empty state. */
export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

/** Honest error state (localized, does not destroy navigation). */
export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="state state-error" role="alert">
      <p className="muted">{message}</p>
      {onRetry ? (
        <Button kind="ghost" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}

/** Responsive data table with horizontal scroll on small screens. */
export function DataTable<T extends object>({
  head,
  rows,
  empty = "No records.",
}: {
  head: { key: string; label: string; render?: (row: T) => ReactNode }[];
  rows: T[];
  empty?: ReactNode;
}) {
  if (rows.length === 0) return <EmptyState>{empty}</EmptyState>;
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h.key}>{h.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {head.map((h) => (
                <td key={h.key}>{h.render ? h.render(row) : asText((row as Record<string, unknown>)[h.key])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function asText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
