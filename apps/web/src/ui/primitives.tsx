import type { CSSProperties, ReactNode } from "react";
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

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
