import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from "react";
import { formatDisplayValue } from "../domain/labels.js";
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
export function Panel({ id, title, subtitle, actions, children }: { id?: string; title?: string; subtitle?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} className="panel">
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
export function KpiCard({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "good" | "warn" | "bad" | "accent" | "neutral" }) {
  return (
    <div className={`kpi ${tone ? `kpi-${tone}` : ""}`}>
      <span className="kpi-label">{label}</span>
      <strong className="kpi-value">{value}</strong>
      {hint ? <span className="kpi-hint">{hint}</span> : null}
    </div>
  );
}

/** Enhanced metric card for unified dashboard telemetry. */
export function MetricCard({
  label,
  value,
  detail,
  hint,
  tone,
  icon,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  hint?: ReactNode;
  tone?: "good" | "warn" | "bad" | "accent" | "neutral";
  icon?: ReactNode;
}) {
  return (
    <div className={`metric-card ${tone ? `metric-${tone}` : ""}`}>
      <div className="metric-head">
        <span className="metric-label">{label}</span>
        {icon ? <span className="metric-icon" aria-hidden>{icon}</span> : null}
      </div>
      <strong className="metric-value">{value}</strong>
      {detail ? <span className="metric-detail">{detail}</span> : hint ? <span className="metric-hint">{hint}</span> : null}
    </div>
  );
}

/** Pulsing or static status indicator dot + label. */
export function StatusIndicator({
  status,
  label,
  pulse = false,
}: {
  status: "good" | "warn" | "bad" | "neutral" | "accent";
  label?: ReactNode;
  pulse?: boolean;
}) {
  return (
    <span className={`status-indicator status-ind-${status}${pulse ? " pulse" : ""}`}>
      <span className="status-indicator-dot" aria-hidden />
      {label ? <span className="status-indicator-label">{label}</span> : null}
    </span>
  );
}

/** Visual surface tag (Admin / Support). */
export function SurfaceTag({ surface }: { surface: "customer" | "admin" | "support" }) {
  if (surface === "customer") return null;
  return (
    <span className={`surface-tag surface-tag-${surface}`}>
      {surface === "admin" ? "Admin" : "Support"}
    </span>
  );
}

/** Unified Brand Lockup with surface indicator. */
export function BrandLogo({
  surface = "customer",
  collapsed = false,
}: {
  surface?: "customer" | "admin" | "support";
  collapsed?: boolean;
}) {
  return (
    <div className="brand" aria-label={`Mox ${surface !== "customer" ? surface : ""}`}>
      {collapsed ? (
        <span>M</span>
      ) : (
        <>
          M<span>ox</span>
          {surface !== "customer" ? (
            <small className={`brand-surface-badge brand-${surface}`}>
              {surface === "admin" ? "Admin" : "Support"}
            </small>
          ) : null}
        </>
      )}
    </div>
  );
}

/** Collapsible sidebar toggle icon. */
export function SidebarToggleIcon({ collapsed = false, size = 18 }: { collapsed?: boolean; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="sidebar-icon-svg"
      aria-hidden="true"
    >
      <line x1="4" x2="20" y1="6" y2="6" />
      <line x1="4" x2="20" y1="12" y2="12" />
      <line x1="4" x2="20" y1="18" y2="18" />
    </svg>
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
export function EmptyState({
  title,
  children,
  action,
}: {
  title?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty" role="status">
      {title ? <strong className="empty-title">{title}</strong> : null}
      <div className="empty-body">{children}</div>
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}

/** Entitlement / role gate. Explains why a surface is unavailable. */
export function GatedState({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="state state-gated" role="status">
      <strong>{title ?? "This capability is not available"}</strong>
      <p className="muted">{children}</p>
    </div>
  );
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
  return formatDisplayValue(value);
}

/** Overlapping avatar stack matching reference header */
export function AvatarStack({
  items,
  max = 4,
}: {
  items: Array<{ name: string; slug?: string }>;
  max?: number;
}) {
  const visible = items.slice(0, max);
  const remainder = items.length - max;
  return (
    <div className="avatar-stack" aria-label="Collaborators">
      {visible.map((item, idx) => (
        <span
          key={item.slug ?? item.name + idx}
          className="avatar-stack-item"
          title={item.name}
          style={{ zIndex: max - idx }}
        >
          <span className="avatar-mini">
            {item.name.slice(0, 1).toUpperCase()}
          </span>
        </span>
      ))}
      {remainder > 0 ? (
        <span className="avatar-stack-more" title={`${remainder} more`}>
          +{remainder}
        </span>
      ) : (
        <span className="avatar-stack-add" title="Invite / Add">
          +
        </span>
      )}
    </div>
  );
}

/** Priority tag matching reference board cards (Urgent, Normal, Low) */
export function PriorityBadge({
  priority,
}: {
  priority: "urgent" | "normal" | "low" | string;
}) {
  const p = priority.toLowerCase();
  const label = p === "urgent" ? "Urgent" : p === "low" ? "Low" : "Normal";
  return (
    <span className={`priority-badge priority-${p}`}>
      <span className="priority-flag" aria-hidden>⚑</span>
      <span>{label}</span>
    </span>
  );
}

/** Miniature sparkline scatter / curve SVG */
export function MiniSparkline({
  trend = "down",
}: {
  trend?: "up" | "down";
}) {
  return (
    <svg width="68" height="24" viewBox="0 0 68 24" fill="none" className="mini-sparkline" aria-hidden="true">
      <path
        d="M2 18 C 12 14, 18 19, 28 11 C 38 4, 48 14, 58 6 L 66 8"
        stroke={trend === "up" ? "#3ecf8e" : "#818cf8"}
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <circle cx="28" cy="11" r="2" fill="#818cf8" />
      <circle cx="46" cy="13" r="2.2" fill="#a78bfa" />
      <circle cx="58" cy="6" r="2.5" fill="#c084fc" />
      <circle cx="66" cy="8" r="2.2" fill="#f43f5e" />
    </svg>
  );
}

/** Miniature bar chart with glowing bars matching reference */
export function MiniBarChart() {
  return (
    <svg width="64" height="22" viewBox="0 0 64 22" fill="none" className="mini-bar-chart" aria-hidden="true">
      <rect x="4" y="14" width="4" height="8" rx="1.5" fill="#333742" />
      <rect x="12" y="11" width="4" height="11" rx="1.5" fill="#333742" />
      <rect x="20" y="8" width="4" height="14" rx="1.5" fill="#474c5a" />
      <rect x="28" y="12" width="4" height="10" rx="1.5" fill="#333742" />
      <rect x="36" y="6" width="4" height="16" rx="1.5" fill="#f97316" />
      <rect x="44" y="2" width="4" height="20" rx="1.5" fill="#fb923c" />
      <rect x="52" y="9" width="4" height="13" rx="1.5" fill="#fdba74" />
    </svg>
  );
}

/** Stepped burndown / telemetry chart matching reference right card */
export function SteppedChart() {
  return (
    <div className="stepped-chart-wrap">
      <div className="stepped-chart-y">
        <span>120</span>
        <span>90</span>
        <span>60</span>
        <span>30</span>
      </div>
      <div className="stepped-chart-canvas">
        <svg viewBox="0 0 380 115" preserveAspectRatio="none" className="stepped-chart-svg" aria-hidden="true">
          <defs>
            <linearGradient id="burn-grad-orange" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#ea580c" stopOpacity="0.12" />
              <stop offset="100%" stopColor="#ea580c" stopOpacity="0" />
            </linearGradient>
            <linearGradient id="burn-grad-indigo" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#6366f1" stopOpacity="0.16" />
              <stop offset="100%" stopColor="#6366f1" stopOpacity="0" />
            </linearGradient>
          </defs>

          <line x1="0" y1="12" x2="380" y2="12" stroke="rgba(255, 255, 255, 0.05)" strokeDasharray="3 3" />
          <line x1="0" y1="42" x2="380" y2="42" stroke="rgba(255, 255, 255, 0.05)" strokeDasharray="3 3" />
          <line x1="0" y1="72" x2="380" y2="72" stroke="rgba(255, 255, 255, 0.05)" strokeDasharray="3 3" />
          <line x1="0" y1="102" x2="380" y2="102" stroke="rgba(255, 255, 255, 0.05)" strokeDasharray="3 3" />

          {/* Stepped orange curve area and stroke */}
          <path
            d="M 10 24 L 60 24 L 60 30 L 120 30 L 120 42 L 180 42 L 180 50 L 260 50 L 260 62 L 320 62 L 320 72 L 370 72 L 370 115 L 10 115 Z"
            fill="url(#burn-grad-orange)"
          />
          <path
            d="M 10 24 L 60 24 L 60 30 L 120 30 L 120 42 L 180 42 L 180 50 L 260 50 L 260 62 L 320 62 L 320 72 L 370 72"
            fill="none"
            stroke="#ea580c"
            strokeWidth="2"
            strokeLinecap="round"
          />

          {/* Stepped purple/indigo curve area and stroke */}
          <path
            d="M 10 18 L 45 18 L 45 28 L 90 28 L 90 32 L 150 32 L 150 48 L 210 48 L 210 65 L 230 65 L 230 80 L 260 80 L 260 98 L 290 98 L 290 110 L 370 110 L 370 115 L 10 115 Z"
            fill="url(#burn-grad-indigo)"
          />
          <path
            d="M 10 18 L 45 18 L 45 28 L 90 28 L 90 32 L 150 32 L 150 48 L 210 48 L 210 65 L 230 65 L 230 80 L 260 80 L 260 98 L 290 98 L 290 110 L 370 110"
            fill="none"
            stroke="#6366f1"
            strokeWidth="2.2"
            strokeLinecap="round"
          />
        </svg>
      </div>
    </div>
  );
}
