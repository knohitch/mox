import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { MeResponse } from "@mox/control-plane-contracts";
import { useMox } from "../api/store.js";
import { Link, useRoute } from "../router.js";
import { CUSTOMER_NAV } from "../concepts/nav.js";
import { NotificationBell } from "../views/NotificationCenter.js";

/**
 * Customer app shell (Prompt 02): grouped sidebar + useful top bar using real
 * state. NEVER exposes staff surfaces — the nav IA is the customer-only
 * CUSTOMER_NAV, and the backend authorization remains mandatory regardless.
 */

function Brand({ showText = true }: { showText?: boolean }) {
  return (
    <div className="brand" aria-hidden>
      {showText ? (
        <>
          M<span>ox</span>
        </>
      ) : (
        <span>M</span>
      )}
    </div>
  );
}

function SidebarContent({
  active,
  collapsed,
  onNavigate,
}: {
  active: string;
  collapsed: boolean;
  onNavigate: () => void;
}) {
  return (
    <>
      <Brand showText={!collapsed} />
      <nav className="nav-scroll" aria-label="Main navigation">
        {CUSTOMER_NAV.map((group) => (
          <div className="nav-group" key={group.label}>
            <div className="section-label">{group.label}</div>
            {group.entries.map((entry) => (
              <Link
                key={entry.to}
                to={entry.to}
                className={`nav-item ${active === entry.to ? "active" : ""}`}
                onClick={onNavigate}
                aria-current={active === entry.to ? "page" : undefined}
              >
                {entry.icon ? <span className="nav-icon" aria-hidden>{entry.icon}</span> : null}
                <span className="nav-label">{collapsed ? "" : entry.label}</span>
              </Link>
            ))}
          </div>
        ))}
      </nav>
    </>
  );
}

function OrgSwitcher({ me }: { me: MeResponse }) {
  const { switchOrg } = useMox();
  const [open, setOpen] = useState(false);
  const memberships = me.orgs ?? [];
  const multiple = memberships.length > 0;

  if (!multiple) {
    return (
      <div className="org-swatch" title={me.orgDisplayName}>
        <span className="org-avatar" aria-hidden>
          {me.orgDisplayName.slice(0, 1).toUpperCase()}
        </span>
        <span className="org-name">{me.orgDisplayName}</span>
      </div>
    );
  }

  return (
    <div className="org-switcher">
      <button
        type="button"
        className="org-swatch"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="org-avatar" aria-hidden>{me.orgDisplayName.slice(0, 1).toUpperCase()}</span>
        <span className="org-name">{me.orgDisplayName}</span>
        <span className="org-caret" aria-hidden>▾</span>
      </button>
      {open ? (
        <ul className="org-menu" role="listbox" aria-label="Switch workspace">
          {memberships.map((o) => (
            <li key={o.orgId} role="option" aria-selected={o.orgId === me.orgId}>
              <button
                type="button"
                className="org-option"
                onClick={() => {
                  setOpen(false);
                  void switchOrg(o.orgId).catch(() => undefined);
                }}
              >
                <span className="org-name">{o.displayName}</span>
                <span className="muted">{o.role}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ProfileMenu() {
  const { me, signOut } = useMox();
  const { navigate } = useRoute();
  const [open, setOpen] = useState(false);
  if (!me) return null;

  return (
    <div className="profile-menu-wrap">
      <button
        type="button"
        className="profile-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="profile-avatar" aria-hidden>{me.displayName.slice(0, 1).toUpperCase()}</span>
        <span className="profile-name">{me.displayName}</span>
        <span className="org-caret" aria-hidden>▾</span>
      </button>
      {open ? (
        <ul className="profile-menu" role="menu" aria-label="Account">
          <li className="profile-info">
            <strong>{me.displayName}</strong>
            <span className="muted">{me.email}</span>
          </li>
          <li>
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                setOpen(false);
                navigate("/settings");
              }}
            >
              Settings
            </button>
          </li>
          <li>
            <button
              type="button"
              className="menu-item danger"
              onClick={() => {
                setOpen(false);
                void signOut();
              }}
            >
              Sign out
            </button>
          </li>
        </ul>
      ) : null}
    </div>
  );
}

export function CustomerShell({ children, activePath }: { children: ReactNode; activePath: string }) {
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { me } = useMox();

  // Escape key closes the mobile drawer.
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  return (
    <div className={`app${collapsed ? " sidebar-collapsed" : ""}`}>
      {/* Desktop sidebar */}
      <aside className={`sidebar sidebar-desktop${collapsed ? " collapsed" : ""}`} aria-label="Primary">
        <SidebarContent active={activePath} collapsed={collapsed} onNavigate={() => undefined} />
        <button
          type="button"
          className="collapse-btn"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={() => setCollapsed((v) => !v)}
        >
          {collapsed ? "»" : "«"}
        </button>
      </aside>

      {/* Mobile drawer */}
      {drawerOpen ? (
        <div className="drawer-backdrop" onClick={() => setDrawerOpen(false)} role="presentation" />
      ) : null}
      <aside className={`sidebar sidebar-drawer${drawerOpen ? " open" : ""}`} aria-label="Primary (mobile)" aria-hidden={!drawerOpen}>
        {drawerOpen ? <SidebarContent active={activePath} collapsed={false} onNavigate={() => setDrawerOpen(false)} /> : null}
      </aside>

      <div className="shell-body">
        <header className="topbar-customer">
          <button
            type="button"
            className="menu-toggle"
            aria-label="Open menu"
            onClick={() => setDrawerOpen(true)}
          >
            ☰
          </button>
          <div className="topbar-left">
            {me ? <OrgSwitcher me={me} /> : <span className="muted">Workspace</span>}
          </div>
          <div className="topbar-right">
            <NotificationBell />
            <ProfileMenu />
          </div>
        </header>
        <main className="main">{children}</main>
      </div>
    </div>
  );
}
