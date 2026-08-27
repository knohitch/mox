/**
 * Prompt 03 staff-surface navigation/authorization rules, kept as a pure,
 * unit-testable module (the web test env is `node`, so DOM rendering is
 * avoided in favour of asserting these rules directly).
 *
 * Capabilities are ALWAYS computed server-side and echoed to the client for
 * UI gating only — the control plane re-enforces every gate.
 */

export type AdminTabKey =
  | "dashboard"
  | "customers"
  | "plans"
  | "payments"
  | "compute"
  | "intelligence"
  | "runtime"
  | "notifications"
  | "operations"
  | "staff";

/** One capability per admin tab. Staff & Access is reserved for `admin.staff.write`. */
export const ADMIN_TAB_CAPABILITY: Record<AdminTabKey, string> = {
  dashboard: "admin.read",
  customers: "admin.read",
  plans: "admin.billing.write",
  payments: "admin.billing.write",
  compute: "admin.compute.write",
  intelligence: "admin.intelligence.write",
  runtime: "admin.operations.write",
  notifications: "admin.notifications.write",
  operations: "admin.read",
  staff: "admin.staff.write",
};

export const ADMIN_TAB_LABEL: Record<AdminTabKey, string> = {
  dashboard: "Dashboard",
  customers: "Customers",
  plans: "Plans",
  payments: "Payments",
  compute: "Compute",
  intelligence: "Models",
  runtime: "Runtime",
  notifications: "Notifications",
  operations: "Operations",
  staff: "Staff & Access",
};

/** A capability list grants a capability when it contains it or the wildcard. */
export function hasSurfaceCapability(capabilities: string[], capability: string): boolean {
  return capabilities.includes("*") || capabilities.includes(capability);
}

/** Admin tabs visible to a given capability list, in declaration order. */
export function visibleAdminTabs(capabilities: string[]): AdminTabKey[] {
  return (Object.keys(ADMIN_TAB_CAPABILITY) as AdminTabKey[]).filter((key) =>
    hasSurfaceCapability(capabilities, ADMIN_TAB_CAPABILITY[key]),
  );
}

/** Prompt 03: only a superadmin grant (`admin.staff.write`) reaches Staff & Access. */
export function canManageStaff(capabilities: string[]): boolean {
  return hasSurfaceCapability(capabilities, "admin.staff.write");
}

export function canSupportLookup(capabilities: string[]): boolean {
  return hasSurfaceCapability(capabilities, "support.customer.lookup");
}

export function canSupportNote(capabilities: string[]): boolean {
  return hasSurfaceCapability(capabilities, "support.ticket.write");
}

export const SUPPORT_ROLES = ["superadmin", "platform_admin", "support_manager", "support_agent"] as const;
