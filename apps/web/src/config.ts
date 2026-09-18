/**
 * Web client configuration (Prompt 00 §A / 00B §A).
 *
 * Fail-closed rules:
 * - Production builds ALWAYS talk to the real control plane. An explicit
 *   `VITE_MOX_API_URL` is used when the API is on another host; when it is
 *   omitted the client uses same-origin `/api` (the control plane serves
 *   the SPA). There is NO silent fallback to demo data.
 * - Demo mode exists for local development only and must be requested
 *   explicitly via VITE_DEMO_MODE=1 in a dev build.
 *
 * Prompt 00B §A: there is deliberately NO browser-visible deployment or
 * master credential of any kind (the former bootstrap env variable was
 * removed). Users authenticate with their own accounts over HttpOnly
 * cookie sessions.
 */

export class WebConfigError extends Error {}

export interface WebConfig {
  mode: "production-api" | "demo";
  apiBaseUrl: string;
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

  const raw = env.VITE_MOX_API_URL;
  if (!raw || raw.trim() === "") {
    if (env.PROD) {
      // Combined production deploy: the control plane serves the SPA from
      // the same origin, so relative `/api` URLs are the real backend.
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
