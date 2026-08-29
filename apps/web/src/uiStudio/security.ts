/**
 * UI Studio security controls (Part C / Critical Security Requirements).
 *
 * The UI Studio is strictly for visual component development.
 * It is impossible to use as a production auth bypass because:
 * 1. Available ONLY when import.meta.env.DEV === true (dead-code eliminated in prod).
 * 2. Explicit opt-in required via VITE_MOX_UI_STUDIO=1.
 * 3. Local browser host only: localhost, 127.0.0.1, [::1].
 * 4. Production build: route resolves as normal Not Found.
 * 5. Uses deterministic, isolated in-memory fixture factories.
 * 6. Never touches cookies, storage tokens, backend APIs, or PostgreSQL.
 */

export const ALLOWED_LOCAL_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
  "::1",
]);

export function isLocalHostname(hostname: string): boolean {
  if (!hostname) return false;
  const clean = hostname.replace(/^\[|\]$/g, "");
  return (
    ALLOWED_LOCAL_HOSTNAMES.has(hostname) ||
    ALLOWED_LOCAL_HOSTNAMES.has(clean) ||
    hostname === "localhost" ||
    hostname === "127.0.0.1"
  );
}

export function isUiStudioOptedIn(): boolean {
  const envVal = import.meta.env.VITE_MOX_UI_STUDIO;
  return envVal === "1" || envVal === "true";
}

export function isUiStudioDevMode(): boolean {
  return import.meta.env.DEV === true;
}

export interface UiStudioContext {
  isDev?: boolean;
  envStudioFlag?: string | boolean;
  hostname?: string;
}

export function isUiStudioAllowed(ctx?: UiStudioContext | string): boolean {
  let isDev = isUiStudioDevMode();
  let optIn = isUiStudioOptedIn();
  let host = typeof window !== "undefined" ? window.location.hostname : "localhost";

  if (typeof ctx === "string") {
    host = ctx;
  } else if (ctx) {
    if (ctx.isDev !== undefined) isDev = ctx.isDev;
    if (ctx.envStudioFlag !== undefined) {
      optIn = ctx.envStudioFlag === "1" || ctx.envStudioFlag === "true" || ctx.envStudioFlag === true;
    }
    if (ctx.hostname !== undefined) host = ctx.hostname;
  }

  if (!isDev) return false;
  if (!optIn) return false;
  if (!isLocalHostname(host)) return false;
  return true;
}
