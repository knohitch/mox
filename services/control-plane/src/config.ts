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
   * Bootstrap credential exchange: a long-lived deployment secret that can
   * create sessions. Required so authentication cannot be bypassed.
   */
  bootstrapApiToken: string;
  sessionTtlMs: number;
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

  let bootstrapApiToken = "";
  try {
    bootstrapApiToken = requireValue(
      env,
      "MOX_BOOTSTRAP_API_TOKEN",
      "long-lived credential allowed to mint authenticated sessions (provision out-of-band)",
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
    bootstrapApiToken,
    sessionTtlMs: Number(env["MOX_SESSION_TTL_MS"] ?? 12 * 3600_000),
    ...overrides,
  };
}
