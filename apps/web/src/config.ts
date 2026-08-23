/**
 * Web client configuration (Prompt 00 §A/§B).
 *
 * Fail-closed rules:
 * - Production builds ALWAYS talk to the real control plane; the API URL is
 *   validated configuration and its absence aborts startup with an honest
 *   error. There is NO silent fallback to demo data.
 * - Demo mode exists for local development only and must be requested
 *   explicitly via VITE_DEMO_MODE=1 in a dev build.
 */

export class WebConfigError extends Error {}

export interface WebConfig {
  mode: "production-api" | "demo";
  apiBaseUrl: string;
  bootstrapToken?: string;
}

export function resolveWebConfig(env: ImportMeta["env"]): WebConfig {
  const demoRequested = env.VITE_DEMO_MODE === "1";
  if (demoRequested) {
    if (env.PROD) {
      throw new WebConfigError(
        "VITE_DEMO_MODE=1 was set in a production build. The hosted product never serves demo data — " +
          "build without VITE_DEMO_MODE or run `vite` in development.",
      );
    }
    return { mode: "demo", apiBaseUrl: "", bootstrapToken: undefined };
  }

  const raw = env.VITE_MOX_API_URL;
  if (!raw || raw.trim() === "") {
    throw new WebConfigError(
      "missing VITE_MOX_API_URL: the web client requires the Mox Control Plane API URL. " +
        "Set it explicitly (e.g. VITE_MOX_API_URL=https://api.mox.example) — there is no demo fallback.",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new WebConfigError(`VITE_MOX_API_URL is not a valid URL: ${JSON.stringify(raw)}`);
  }
  const isLocalhost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !(isLocalhost && env.DEV)) {
    throw new WebConfigError(
      `VITE_MOX_API_URL must use https (got ${parsed.protocol}); http is allowed only for localhost in development.`,
    );
  }
  return {
    mode: "production-api",
    apiBaseUrl: parsed.toString().replace(/\/$/, ""),
    bootstrapToken: env.VITE_MOX_BOOTSTRAP_TOKEN || undefined,
  };
}
