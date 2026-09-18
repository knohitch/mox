/**
 * Web client configuration (Prompt 00 §A / 00B §A).
 *
 * Fail-closed rules:
 * - Production builds ALWAYS talk to the real control plane. Split-host
 *   deployments may inject the public API URL at container runtime through
 *   /mox-runtime-config.js; VITE_MOX_API_URL remains the build-time fallback.
 * - When neither URL is present in production, the client uses same-origin
 *   /api for the combined control-plane + SPA deployment.
 * - Demo mode exists for local development only and must be requested
 *   explicitly via VITE_DEMO_MODE=1 in a dev build.
 *
 * Prompt 00B §A: there is deliberately NO browser-visible deployment or
 * master credential of any kind. Users authenticate with their own accounts
 * over HttpOnly cookie sessions.
 */

export class WebConfigError extends Error {}

export interface WebConfig {
  mode: "production-api" | "demo";
  apiBaseUrl: string;
}

type MoxRuntimeConfig = {
  apiBaseUrl?: string;
  /**
   * Presentation-only hosted showcase mode. This never switches the API seam
   * to demo data; it only exposes isolated UI Studio fixtures and demo chrome.
   */
  publicDemo?: boolean;
};

function runtimeConfig(): MoxRuntimeConfig {
  return (
    (globalThis as typeof globalThis & { __MOX_RUNTIME_CONFIG__?: MoxRuntimeConfig })
      .__MOX_RUNTIME_CONFIG__ ?? {}
  );
}

function runtimeApiBaseUrl(): string | undefined {
  const value = runtimeConfig().apiBaseUrl?.trim();
  return value || undefined;
}

/** True only when the web container explicitly enables hosted showcase mode. */
export function isPublicDemoEnabled(): boolean {
  return runtimeConfig().publicDemo === true;
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
    return { mode: "demo", apiBaseUrl: "" };
  }

  const raw = runtimeApiBaseUrl() ?? env.VITE_MOX_API_URL;
  if (!raw || raw.trim() === "") {
    if (env.PROD) {
      return { mode: "production-api", apiBaseUrl: "" };
    }
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

  return { mode: "production-api", apiBaseUrl: parsed.toString().replace(/\/$/, "") };
}
