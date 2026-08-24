/**
 * Control Plane deployment configuration (Prompt 00 §B/§F).
 *
 * Fail-closed: missing durable dependencies abort startup with a clear,
 * actionable error instead of booting a fake system. There is NO fallback
 * to in-memory authoritative state in production.
 */

export class ConfigError extends Error {}

export type PlatformAdminRole = "superadmin" | "billing_admin" | "ops_admin" | "support";

export type PlatformAdminCapability =
  | "admin.read"
  | "admin.support.write"
  | "admin.customers.write"
  | "admin.billing.write"
  | "admin.compute.write"
  | "admin.intelligence.write"
  | "admin.notifications.write"
  | "admin.operations.write";

export const PLATFORM_ROLE_CAPABILITIES: Record<PlatformAdminRole, readonly PlatformAdminCapability[] | readonly ["*"]> = {
  superadmin: ["*"],
  billing_admin: ["admin.read", "admin.billing.write", "admin.notifications.write"],
  ops_admin: ["admin.read", "admin.compute.write", "admin.intelligence.write", "admin.operations.write", "admin.notifications.write"],
  support: ["admin.read", "admin.support.write"],
};

const PLATFORM_CAPABILITY_SET = new Set<string>([
  "admin.read",
  "admin.support.write",
  "admin.customers.write",
  "admin.billing.write",
  "admin.compute.write",
  "admin.intelligence.write",
  "admin.notifications.write",
  "admin.operations.write",
  "*",
]);

export interface ControlPlaneConfig {
  env: "production" | "development" | "test";
  port: number;
  /** PostgreSQL connection string; business truth (required). */
  databaseUrl: string;
  /**
   * Public https endpoint nodes and browsers use to reach this control
   * plane; baked into cloud-init and returned to clients (§F).
   */
  publicUrl: string;
  /** Redis is optional at the foundation stage; queues/cache only. */
  redisUrl?: string;
  /**
   * Server-side ONLY one-time platform-setup credential (Prompt 00B §A).
   * It may provision the designated owner exactly once and is never sent
   * to browsers, never used as a login path, and never logged.
   */
  setupToken?: string;
  sessionTtlMs: number;
  /** Optional CORS allowlist for API origins (credentials excluded). */
  corsOrigins: string[];
  trustedProxyIps: string[];
  /**
   * Explicit platform-admin user ids (Prompt 01 §Provider config):
   * membership in this list grants all admin capabilities. Org owner/admin
   * alone is NOT platform authority. Empty list = no provider administration
   * until an operator provisions ids explicitly.
   */
  platformAdminUserIds: string[];
  /** Preferred platform-admin RBAC mapping. Only superadmin expands to "*". */
  platformAdminRoles: Record<string, PlatformAdminRole>;
  /**
   * Optional per-admin capability allowlist. Keys are user ids; values are
   * admin capability names or "*" for all. This is evaluated server-side.
   */
  platformAdminCapabilities: Record<string, string[]>;
  /** Explicit Mox Runtime mode. Production accepts only "full". */
  runtimeMode: "full" | "disabled" | "reference-dev";
  /** Command used to launch the production Mox Runtime protocol process. */
  runtimeCommand?: string;
  runtimeArgs: string[];
  runtimeCwd?: string;
  runtimeRequestTimeoutMs: number;
}

function requireValue(env: Record<string, string | undefined>, key: string, purpose: string): string {
  const value = env[key];
  if (!value || value.trim() === "") {
    throw new ConfigError(
      `missing required configuration ${key}: ${purpose}. ` +
        `The control plane refuses to start without its durable dependencies — set ${key} explicitly.`,
    );
  }
  return value.trim();
}

function validatePublicUrl(raw: string, env: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ConfigError(`MOX_PUBLIC_URL is not a valid URL: ${JSON.stringify(raw)}`);
  }
  if (env === "production" && parsed.protocol !== "https:") {
    throw new ConfigError(`MOX_PUBLIC_URL must use https in production (got ${parsed.protocol})`);
  }
  return parsed.toString().replace(/\/$/, "");
}

function parsePlatformAdminCapabilities(raw: string | undefined): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const entry of (raw ?? "").split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(":");
    if (idx <= 0) throw new ConfigError(`invalid MOX_PLATFORM_ADMIN_CAPABILITIES entry: ${trimmed}`);
    const userId = trimmed.slice(0, idx).trim();
    const capabilities = trimmed
      .slice(idx + 1)
      .split(/[| ]+/)
      .map((cap) => cap.trim())
      .filter(Boolean);
    if (capabilities.length === 0) throw new ConfigError(`no capabilities configured for platform admin ${userId}`);
    for (const capability of capabilities) {
      if (!PLATFORM_CAPABILITY_SET.has(capability)) {
        throw new ConfigError(`unknown platform admin capability for ${userId}: ${capability}`);
      }
    }
    out[userId] = capabilities;
  }
  return out;
}

function parsePlatformAdminRoles(raw: string | undefined): Record<string, PlatformAdminRole> {
  const out: Record<string, PlatformAdminRole> = {};
  for (const entry of (raw ?? "").split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(":");
    if (idx <= 0) throw new ConfigError(`invalid MOX_PLATFORM_ADMIN_ROLES entry: ${trimmed}`);
    const userId = trimmed.slice(0, idx).trim();
    const role = trimmed.slice(idx + 1).trim() as PlatformAdminRole;
    if (!Object.prototype.hasOwnProperty.call(PLATFORM_ROLE_CAPABILITIES, role)) {
      throw new ConfigError(`invalid platform admin role for ${userId}: ${role}`);
    }
    out[userId] = role;
  }
  return out;
}

/** Parses and validates environment config; throws ConfigError when absent/invalid. */
export function loadControlPlaneConfig(
  env: Record<string, string | undefined>,
  overrides: Partial<ControlPlaneConfig> = {},
): ControlPlaneConfig {
  const errors: string[] = [];
  const rawEnv = (env["NODE_ENV"] ?? "").toLowerCase();
  const nodeEnv: ControlPlaneConfig["env"] =
    rawEnv === "production" || rawEnv === "test" ? (rawEnv as ControlPlaneConfig["env"]) : "development";

  let databaseUrl = "";
  try {
    databaseUrl = requireValue(env, "DATABASE_URL", "PostgreSQL is the business truth for billing/compute/notifications");
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  let publicUrl = "";
  try {
    publicUrl = validatePublicUrl(
      requireValue(env, "MOX_PUBLIC_URL", "public control-plane endpoint passed to browser clients and Mox Node cloud-init"),
      nodeEnv,
    );
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  if (errors.length > 0) {
    throw new ConfigError(`control plane configuration invalid:\n- ${errors.join("\n- ")}`);
  }

  const runtimeMode = ((env["MOX_RUNTIME_MODE"] ?? (nodeEnv === "production" ? "full" : "disabled")).trim() || "disabled") as ControlPlaneConfig["runtimeMode"];
  if (!["full", "disabled", "reference-dev"].includes(runtimeMode)) {
    throw new ConfigError(`MOX_RUNTIME_MODE must be full, disabled, or reference-dev (got ${runtimeMode})`);
  }
  const runtimeCommand = env["MOX_RUNTIME_COMMAND"]?.trim() || undefined;
  if (nodeEnv === "production" && runtimeMode !== "full") {
    throw new ConfigError("production requires MOX_RUNTIME_MODE=full; reference-dev/disabled runtimes are not allowed");
  }
  if (nodeEnv === "production" && !runtimeCommand) {
    throw new ConfigError("production requires MOX_RUNTIME_COMMAND for the full Mox Runtime");
  }

  const platformAdminUserIds = (env["MOX_PLATFORM_ADMIN_USER_IDS"] ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const platformAdminRoles = parsePlatformAdminRoles(env["MOX_PLATFORM_ADMIN_ROLES"]);
  const platformAdminCapabilities = parsePlatformAdminCapabilities(env["MOX_PLATFORM_ADMIN_CAPABILITIES"]);
  for (const [id, capabilities] of Object.entries(platformAdminCapabilities)) {
    if (capabilities.includes("*") && platformAdminRoles[id] !== "superadmin") {
      throw new ConfigError(`platform admin ${id} uses wildcard capability but is not mapped to superadmin`);
    }
  }
  for (const id of platformAdminUserIds) {
    if (!platformAdminRoles[id] && !platformAdminCapabilities[id]?.length) {
      throw new ConfigError(
        `platform admin ${id} has no role/capability mapping; set MOX_PLATFORM_ADMIN_ROLES or MOX_PLATFORM_ADMIN_CAPABILITIES`,
      );
    }
  }

  return {
    env: nodeEnv,
    port: Number(env["PORT"] ?? 8080),
    databaseUrl,
    publicUrl,
    redisUrl: env["REDIS_URL"] || undefined,
    // Server-side only; absent setupToken means setup cannot run until an
    // operator configures it — accounts are created via signup or setup.
    setupToken: env["MOX_SETUP_TOKEN"] || undefined,
    sessionTtlMs: Number(env["MOX_SESSION_TTL_MS"] ?? 12 * 3600_000),
    corsOrigins: (env["MOX_CORS_ORIGINS"] ?? "")
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean),
    trustedProxyIps: (env["MOX_TRUSTED_PROXY_IPS"] ?? "")
      .split(",")
      .map((ip) => ip.trim())
      .filter(Boolean),
    platformAdminUserIds,
    platformAdminRoles,
    platformAdminCapabilities,
    runtimeMode,
    runtimeCommand,
    runtimeArgs: (env["MOX_RUNTIME_ARGS"] ?? "")
      .split(" ")
      .map((arg) => arg.trim())
      .filter(Boolean),
    runtimeCwd: env["MOX_RUNTIME_CWD"] || undefined,
    runtimeRequestTimeoutMs: Number(env["MOX_RUNTIME_REQUEST_TIMEOUT_MS"] ?? 60_000),
    ...overrides,
  };
}
