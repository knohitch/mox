/**
 * Customer information architecture & surface routes (Prompt 02).
 *
 * The IA is a GROUPED sidebar and is a pure data module so it can be unit
 * tested without a DOM: the tests prove the customer nav contains the expected
 * items and — critically — NEVER exposes Admin, Support, or any staff surface.
 *
 * The customer-only rule is enforced both here (no linked destinations) and on
 * the backend (authorization remains mandatory even though links are absent).
 */

export interface NavEntry {
  to: string;
  label: string;
  /** Small inline glyph; keep it minimal — no icon framework dependency. */
  icon?: string;
}

export interface NavGroup {
  /** Screen-reader/heading label for the group. */
  label: string;
  entries: NavEntry[];
}

/** Grouped customer information architecture (Prompt 02 §Target IA). */
export const CUSTOMER_NAV: readonly NavGroup[] = [
  {
    label: "Home",
    entries: [{ to: "/dashboard", label: "Dashboard", icon: "⌂" }],
  },
  {
    label: "Build",
    entries: [
      { to: "/agents", label: "Agents", icon: "◈" },
      { to: "/rooms", label: "Agent Rooms", icon: "☰" },
      { to: "/deployments", label: "Deployments", icon: "⬆" },
    ],
  },
  {
    label: "Infrastructure",
    entries: [
      { to: "/servers", label: "Servers", icon: "▣" },
      { to: "/models", label: "Models", icon: "◆" },
    ],
  },
  {
    label: "Connect",
    entries: [
      { to: "/integrations", label: "Apps & Integrations", icon: "⌁" },
      { to: "/channels", label: "Channels", icon: "➤" },
    ],
  },
  {
    label: "Account",
    entries: [
      { to: "/usage", label: "Usage", icon: "∑" },
      { to: "/billing", label: "Billing", icon: "¢" },
      { to: "/backups", label: "Backups", icon: "◫" },
      { to: "/settings", label: "Settings", icon: "⚙" },
    ],
  },
];

/** Flat list of all customer destinations (authoritative for validation). */
export const CUSTOMER_DESTINATIONS: readonly string[] = CUSTOMER_NAV.flatMap((g) =>
  g.entries.map((e) => e.to),
);

export const CUSTOMER_NAV_GROUPS = CUSTOMER_NAV;

export function isCustomerDestination(path: string): boolean {
  return (CUSTOMER_DESTINATIONS as readonly string[]).includes(path);
}

/**
 * Staff surface roots and public auth routes. These are intentionally NOT in
 * the customer nav; customers reach staff surfaces only by direct URL, which
 * the backend independently forbids without staff authority.
 */
export const STAFF_SURFACE_ROOTS = {
  admin: "/admin",
  support: "/support",
} as const;

/** Customer-facing public (no-shell) auth routes. */
export const CUSTOMER_AUTH_ROUTES = [
  "/login",
  "/signup",
  "/forgot-password",
  "/reset-password",
] as const;

/** Destinations that must never appear in the customer nav or its labels. */
const FORBIDDEN_NAV_TERMS = ["admin", "support", "operations", "abuse", "runtime", "provider", "payment", "margin", "notification"] as const;

/** True if a given flat destination list contains any staff-surface term. */
export function hasForbiddenDestination(destinations: readonly string[]): boolean {
  return destinations.some((d) => FORBIDDEN_NAV_TERMS.some((t) => d.toLowerCase().includes(t)));
}
