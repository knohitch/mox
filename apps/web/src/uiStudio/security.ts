import { isPublicDemoEnabled } from "../config.js";

/**
 * UI Studio security controls (Part C / Critical Security Requirements).
 *
 * The UI Studio is strictly for visual component development.
 * It is impossible to use as a production auth bypass because:
 * Local development requires import.meta.env.DEV + VITE_MOX_UI_STUDIO=1 +
 * localhost. A hosted showcase can also explicitly enable MOX_PUBLIC_DEMO=1
 * through the web runtime config; that path still uses only deterministic,
 * isolated in-memory fixtures and never touches cookies, backend APIs, or
 * PostgreSQL.
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
  publicDemo?: boolean;
}

export function isUiStudioAllowed(ctx?: UiStudioContext | string): boolean {
  let isDev = isUiStudioDevMode();
  let optIn = isUiStudioOptedIn();
  let publicDemo = isPublicDemoEnabled();
  let host = typeof window !== "undefined" ? window.location.hostname : "localhost";

  if (typeof ctx === "string") {
    host = ctx;
  } else if (ctx) {
    if (ctx.isDev !== undefined) isDev = ctx.isDev;
    if (ctx.envStudioFlag !== undefined) {
      optIn = ctx.envStudioFlag === "1" || ctx.envStudioFlag === "true" || ctx.envStudioFlag === true;
    }
    if (ctx.hostname !== undefined) host = ctx.hostname;
    if (ctx.publicDemo !== undefined) publicDemo = ctx.publicDemo;
  }

  if (publicDemo) return true;
  if (!isDev) return false;
  if (!optIn) return false;
  if (!isLocalHostname(host)) return false;
  return true;
}
