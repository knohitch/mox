import { useCallback, useEffect, useState } from "react";
import type { AnchorHTMLAttributes, ReactNode } from "react";

/**
 * Minimal dependency-free router (Prompt 05). The web product is primary and
 * must not require Electron; this keeps the bundle small while providing the
 * navigation IA (paths + params) the product needs.
 */

export interface RouteMatch {
  path: string;
  /** e.g. "/agents/:agentId" → "/agents/a1" gives { agentId: "a1" }. */
  pattern: string | null;
  params: Record<string, string>;
}

function currentPath(): string {
  const raw = window.location.hash.slice(1);
  return raw === "" ? "/" : raw.startsWith("/") ? raw : `/${raw}`;
}

export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const pParts = pattern.split("/").filter(Boolean);
  const aParts = path.split("?")[0]?.split("/").filter(Boolean) ?? [];
  if (pattern === "/") {
    return path.split("?")[0] === "/" ? {} : null;
  }
  if (pParts.length !== aParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pParts.length; i += 1) {
    const p = pParts[i] as string;
    const a = aParts[i] as string;
    if (p.startsWith(":")) {
      params[p.slice(1)] = decodeURIComponent(a);
    } else if (p !== a) {
      return null;
    }
  }
  return params;
}

export function useRoute(): RouteMatch & { navigate: (to: string) => void } {
  const [path, setPath] = useState(currentPath);

  useEffect(() => {
    const onChange = () => setPath(currentPath());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  const navigate = useCallback((to: string) => {
    window.location.hash = to;
  }, []);

  // Route table is evaluated by callers via <Route> composition; here we
  // expose the raw path plus a helper consumers use with their patterns.
  return { path, pattern: null, params: {}, navigate };
}

/** First matching pattern wins; patterns are exact or contain :params. */
export function resolveParams(
  patterns: readonly string[],
  path: string,
): { pattern: string; params: Record<string, string> } | null {
  for (const pattern of patterns) {
    const params = matchPath(pattern, path);
    if (params) return { pattern, params };
  }
  return null;
}

export function Link({
  to,
  children,
  ...rest
}: { to: string; children: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a href={`#${to}`} {...rest}>
      {children}
    </a>
  );
}
