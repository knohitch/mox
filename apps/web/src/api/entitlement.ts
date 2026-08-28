/**
 * Canonical entitlement representation for the customer surface (Phase 01 §B).
 *
 * The web app consumes the SAME canonical entitlement keys the backend defines
 * in `@mox/entitlements` (`ENTITLEMENT_KEYS`). The legacy boolean buckets
 * (computer / terminal / voice / rooms / customModels) are deliberately gone:
 * numeric quota keys stay numeric, commercial-access denial stays DISTINCT from
 * an entitlement value, and the UI derives capability/UX concepts from the
 * canonical keys via small selectors below.
 *
 * `values` is only present while `commerciallyEntitled` is true — a denied or
 * suspended workspace must not be treated as "zero of everything".
 */

export const CANONICAL_ENTITLEMENT_KEYS = [
  "included_compute_class",
  "included_server_count",
  "max_agents",
  "active_concurrent_agents",
  "agent_rooms",
  "agents_per_room",
  "browser_sessions",
  "cli_sessions",
  "developer_mode",
  "model_connections",
  "mox_ai_credits",
  "channel_connections",
  "integrations",
  "storage_gb",
  "backup_retention_days",
  "team_members",
  "voice_minutes",
  "schedule_workflow_limit",
] as const;

export type CanonicalEntitlementKey = (typeof CANONICAL_ENTITLEMENT_KEYS)[number];

export type EntitlementValue = boolean | number | string;

export interface Entitlements {
  /** Server-verified commercial access; false while denied (never a value). */
  commerciallyEntitled: boolean;
  /** Effective entitlement VALUES; present only while commercially entitled. */
  values: Partial<Record<CanonicalEntitlementKey, EntitlementValue>>;
}

/**
 * A quota is "usable" when commercial access holds and the numeric limit is
 * positive (-1 is the unlimited convention; do not gate on the presence of 0).
 */
function usable(values: Entitlements | undefined, key: CanonicalEntitlementKey): boolean {
  if (!values || !values.commerciallyEntitled) return false;
  const v = values.values[key];
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v > 0;
  if (typeof v === "string") return v !== "" && v !== "0" && v !== "false";
  return false;
}

/** A boolean/text capability toggled on by a truthy canonical value. */
function enabled(values: Entitlements | undefined, key: CanonicalEntitlementKey): boolean {
  if (!values || !values.commerciallyEntitled) return false;
  const v = values.values[key];
  return v === true || v === "true";
}

/**
 * UX selectors derived from canonical entitlement keys. These ARE the only
 * place the UI maps canonical quota keys to capability concepts — call sites
 * never reach into raw values themselves.
 */
export function hasBrowser(values: Entitlements | undefined): boolean {
  return usable(values, "browser_sessions");
}

export function hasTerminal(values: Entitlements | undefined): boolean {
  return usable(values, "cli_sessions");
}

export function hasAgentRooms(values: Entitlements | undefined): boolean {
  return usable(values, "agent_rooms");
}

export function hasModelConnections(values: Entitlements | undefined): boolean {
  return usable(values, "model_connections");
}

export function hasVoice(values: Entitlements | undefined): boolean {
  return usable(values, "voice_minutes");
}

export function hasIntegrations(values: Entitlements | undefined): boolean {
  return usable(values, "integrations");
}

export function hasChannels(values: Entitlements | undefined): boolean {
  return usable(values, "channel_connections");
}

export function hasDeveloperMode(values: Entitlements | undefined): boolean {
  return enabled(values, "developer_mode");
}

export function hasBackups(values: Entitlements | undefined): boolean {
  return usable(values, "backup_retention_days");
}

export function hasTeamMembers(values: Entitlements | undefined): boolean {
  return usable(values, "team_members");
}

export function hasStorage(values: Entitlements | undefined): boolean {
  return usable(values, "storage_gb");
}

export function hasMoxAiCredits(values: Entitlements | undefined): boolean {
  return usable(values, "mox_ai_credits");
}

/** Numeric limit for a canonical key (0 when denied/unavailable). */
export function limitOf(
  values: Entitlements | undefined,
  key: CanonicalEntitlementKey,
  fallback = 0,
): number {
  if (!values || !values.commerciallyEntitled) return fallback;
  const v = values.values[key];
  if (typeof v === "number") return v;
  if (typeof v === "string" && v !== "") {
    const parsed = Number(v);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}
