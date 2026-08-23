/**
 * Control Plane deployment configuration (Prompt 00 §B/§F).
 *
 * Fail-closed: missing durable dependencies abort startup with a clear,
 * actionable error instead of booting a fake system. There is NO fallback
 * to in-memory authoritative state in production.
 */

export class ConfigError extends Error {}

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
  /**
   * Explicit platform-admin user ids (Prompt 01 §Provider config):
   * payment-provider administration requires membership in this list.
   * Org owner/admin alone is NOT platform authority. Empty list = no
   * provider administration until an operator provisions ids explicitly.
   */
  platformAdminUserIds: string[];
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
    platformAdminUserIds: (env["MOX_PLATFORM_ADMIN_USER_IDS"] ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
    ...overrides,
  };
}
