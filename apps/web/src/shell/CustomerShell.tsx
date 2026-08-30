import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { MeResponse } from "@mox/control-plane-contracts";
import { useMox } from "../api/store.js";
import { Link, useRoute } from "../router.js";
import { CUSTOMER_NAV } from "../concepts/nav.js";
import { NotificationBell } from "../views/NotificationCenter.js";
import { SidebarToggleIcon } from "../ui/primitives.js";

/**
 * Customer app shell (Prompt 02): grouped sidebar + useful top bar using real
 * state. NEVER exposes staff surfaces — the nav IA is the customer-only
 * CUSTOMER_NAV, and the backend authorization remains mandatory regardless.
 */

function Brand({ showText = true }: { showText?: boolean }) {
  const { me } = useMox();
  return (
    <div className="brand" aria-label="Mox">
      <div className="brand-logo-pill" aria-hidden>
        <span className="brand-logo-glyph">M</span>
      </div>
      {showText ? (
        <div className="brand-text-col">
          <span className="brand-title">Mox <em>cloud</em></span>
          <span className="brand-subtitle">
            {me?.orgDisplayName ? `${me.orgDisplayName.toLowerCase().replace(/[^a-z0-9]/g, "")}.studio` : "mox.studio"}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function SidebarContent({
  active,
  collapsed,
  onToggleCollapse,
  onNavigate,
}: {
  active: string;
  collapsed: boolean;
  onToggleCollapse?: () => void;
  onNavigate: () => void;
}) {
  const { me, agents } = useMox();
  const { navigate } = useRoute();

  return (
    <>
      <div className="sidebar-head">
        {onToggleCollapse ? (
          <button
            type="button"
            className="sidebar-collapse-toggle-top"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={onToggleCollapse}
          >
            <SidebarToggleIcon collapsed={collapsed} size={16} />
          </button>
        ) : null}
        {!collapsed && me ? (
          <div className="sidebar-org-wrap">
            <OrgSwitcher me={me} />
          </div>
        ) : null}
      </div>
      <nav className="nav-scroll" aria-label="Main navigation">
        {CUSTOMER_NAV.map((group) => (
          <div className="nav-group" key={group.label}>
            <div className="section-label">
              <span>{group.label}</span>
              <span className="section-chevron" aria-hidden>▾</span>
            </div>
            {group.entries.map((entry) => {
              const isAgents = entry.to === "/agents";
              const isRooms = entry.to === "/rooms";
              const isDeployments = entry.to === "/deployments";
              const badgeCount = isAgents ? agents.length : isRooms ? 2 : isDeployments ? 4 : undefined;

              return (
                <Link
                  key={entry.to}
                  to={entry.to}
                  className={`nav-item ${active === entry.to ? "active" : ""}`}
                  onClick={onNavigate}
                  aria-current={active === entry.to ? "page" : undefined}
                >
                  {entry.icon ? <span className="nav-icon" aria-hidden>{entry.icon}</span> : null}
                  <span className="nav-label">{collapsed ? "" : entry.label}</span>
                  {!collapsed && badgeCount !== undefined && badgeCount > 0 ? (
                    <span className={`nav-badge ${isAgents ? "nav-badge-accent" : ""}`}>{badgeCount}</span>
                  ) : null}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      {/* Sidebar Footer matching reference bottom links & user profile card */}
      <div className="sidebar-footer">
        {!collapsed ? (
          <div className="sidebar-secondary-links">
            <a
              href="https://github.com/knohitch/mox"
              target="_blank"
              rel="noreferrer"
              className="nav-item"
            >
              <span className="nav-icon" aria-hidden>↗</span>
              <span>Documentation</span>
            </a>
          </div>
        ) : null}

        </div>
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

function getPageName(path: string): string {
  const entry = CUSTOMER_NAV.flatMap((g) => g.entries).find((e) => e.to === path);
  if (entry) return entry.label;
  if (path.startsWith("/agents")) return "Agents";
  if (path.startsWith("/rooms")) return "Agent Rooms";
  if (path.startsWith("/deployments")) return "Deployments";
  if (path.startsWith("/servers")) return "Servers";
  if (path.startsWith("/models")) return "Models";
  if (path.startsWith("/integrations")) return "Apps & Integrations";
  if (path.startsWith("/channels")) return "Channels";
  if (path.startsWith("/usage")) return "Usage";
  if (path.startsWith("/billing")) return "Billing";
  if (path.startsWith("/backups")) return "Backups";
  if (path.startsWith("/settings")) return "Settings";
  return "Dashboard";
}

export function CustomerShell({
  children,
  activePath,
  collapsed: externalCollapsed,
  onToggleCollapse: externalOnToggleCollapse,
}: {
  children: ReactNode;
  activePath: string;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}) {
  const [internalCollapsed, setInternalCollapsed] = useState(() => {
    if (typeof window !== "undefined") {
      const stored = sessionStorage.getItem("mox.sidebar.collapsed");
      if (stored !== null) return stored === "true";
      if (activePath === "/agents" && window.innerWidth >= 1024) return true;
    }
    return false;
  });
  const collapsed = externalCollapsed !== undefined ? externalCollapsed : internalCollapsed;
  const toggleCollapse = externalOnToggleCollapse ?? (() => setInternalCollapsed((v) => {
    const next = !v;
    if (typeof window !== "undefined") sessionStorage.setItem("mox.sidebar.collapsed", String(next));
    return next;
  }));
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { me } = useMox();
  const { navigate } = useRoute();

  useEffect(() => {
    if (activePath === "/agents" && typeof window !== "undefined" && window.innerWidth >= 1024) {
      if (sessionStorage.getItem("mox.sidebar.collapsed") === null && !internalCollapsed) {
        setInternalCollapsed(true);
        sessionStorage.setItem("mox.sidebar.collapsed", "true");
      }
    }
  }, [activePath, internalCollapsed]);

  // Escape key closes the mobile drawer.
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  const pageTitle = getPageName(activePath);

  return (
    <div className={`app${collapsed ? " sidebar-collapsed" : ""}`}>
      {/* Desktop sidebar */}
      <aside className={`sidebar sidebar-desktop${collapsed ? " collapsed" : ""}`} aria-label="Primary">
        <SidebarContent
          active={activePath}
          collapsed={collapsed}
          onToggleCollapse={toggleCollapse}
          onNavigate={() => undefined}
        />
      </aside>

      {/* Mobile drawer */}
      {drawerOpen ? (
        <div className="drawer-backdrop" onClick={() => setDrawerOpen(false)} role="presentation" />
      ) : null}
      <aside className={`sidebar sidebar-drawer${drawerOpen ? " open" : ""}`} aria-label="Primary (mobile)" aria-hidden={!drawerOpen}>
        {drawerOpen ? (
          <SidebarContent
            active={activePath}
            collapsed={false}
            onToggleCollapse={toggleCollapse}
            onNavigate={() => setDrawerOpen(false)}
          />
        ) : null}
      </aside>

      <div className="shell-body">
        {/* Modern Topbar matching reference image */}
        <header className="topbar-customer">
          <button
            type="button"
            className="menu-toggle"
            aria-label="Open menu"
            onClick={() => setDrawerOpen(true)}
          >
            ☰
          </button>


          <div className="topbar-breadcrumb">
            <span className="topbar-page-title">{pageTitle}</span>
          </div>

          <div className="topbar-actions">
            <NotificationBell />
            <button
              type="button"
              className="topbar-cta-btn"
              onClick={() => navigate("/agents")}
              title="Create a new agent"
            >
              Create agent
            </button>
            <ProfileMenu />
          </div>
        </header>

        <main className="main">{children}</main>
      </div>
    </div>
  );
}
