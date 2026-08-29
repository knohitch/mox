import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { AnchorHTMLAttributes, ReactNode } from "react";

/**
 * Minimal dependency-free path router built on the History API (Prompt 05,
 * refactored in Prompt 01 to REAL paths — not hashes — so surface isolation
 * is enforced by the URL itself). The web product is primary and must not
 * require Electron; this keeps the bundle small while providing the
 * navigation IA (paths + params) the product needs.
 *
 * Path routing requires a static-server fallback that maps any unmatched URL
 * to `index.html` (dev/preview handled in vite.config.ts; the production
 * static host must be configured likewise — never a 404 at a real path).
 */

export interface RouteMatch {
  path: string;
  /** e.g. "/agents/:agentId" → "/agents/a1" gives { agentId: "a1" }. */
  pattern: string | null;
  params: Record<string, string>;
}

export interface RouterConfig {
  /** Base path prefix when the app is served under a sub-path (default "/"). */
  basename?: string;
}

function routeBasename(config: RouterConfig = {}): string {
  const base = config.basename?.trim() ?? "";
  if (!base || base === "/") return "";
  return base.startsWith("/") ? base.replace(/\/$/, "") : `/${base.replace(/\/$/, "")}`;
}

function currentPath(): string {
  const raw = window.location.pathname.replace(routeBasename(), "") || "/";
  return raw.startsWith("/") ? raw : `/${raw}`;
}

/** Navigation events that are NOT browser-initiated (pushState) must still
 *  rerender observers; useRoute subscribes to this custom event as well. */
const NAV_EVENT = "mox:navigate";
function emitNavigate(): void {
  window.dispatchEvent(new Event(NAV_EVENT));
}
function pushPath(to: string): void {
  const target = to.startsWith("/") ? to : `/${to}`;
  window.history.pushState(null, "", `${routeBasename()}${target}`);
  emitNavigate();
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

/**
 * Optional navigation adapter. Production leaves this unset so Link/useRoute
 * talk to the History API. UI Studio provides one so product chrome stays on
 * `/__ui` without `if (studio)` checks in views.
 */
export interface NavAdapter {
  path: string;
  navigate: (to: string) => void;
  hrefFor: (to: string) => string;
  section?: string;
  setSection?: (section: string) => void;
}

const NavAdapterContext = createContext<NavAdapter | null>(null);

export function NavAdapterProvider({ adapter, children }: { adapter: NavAdapter; children: ReactNode }) {
  return <NavAdapterContext.Provider value={adapter}>{children}</NavAdapterContext.Provider>;
}

export function useNavSection(): {
  section: string | undefined;
  setSection: ((section: string) => void) | undefined;
} {
  const adapter = useContext(NavAdapterContext);
  return { section: adapter?.section, setSection: adapter?.setSection };
}

export function useRoute(config?: RouterConfig): RouteMatch & { navigate: (to: string) => void } {
  const adapter = useContext(NavAdapterContext);
  const [path, setPath] = useState(currentPath);

  useEffect(() => {
    const onChange = () => setPath(currentPath());
    window.addEventListener("popstate", onChange);
    window.addEventListener(NAV_EVENT, onChange);
    return () => {
      window.removeEventListener("popstate", onChange);
      window.removeEventListener(NAV_EVENT, onChange);
    };
  }, []);

  const navigate = useCallback(
    (to: string) => {
      if (adapter) {
        adapter.navigate(to);
        return;
      }
      if (to === currentPath()) {
        // still normalize a scroll reset / state sync without a duplicate entry
        return;
      }
      pushPath(to);
    },
    [adapter, config],
  );

  // Route table is evaluated by callers via <Route> composition; here we
  // expose the raw path plus a helper consumers use with their patterns.
  return { path: adapter?.path ?? path, pattern: null, params: {}, navigate };
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
  const adapter = useContext(NavAdapterContext);
  const onClick = rest.onClick;
  const href = adapter?.hrefFor(to) ?? `${routeBasename()}${to.startsWith("/") ? to : `/${to}`}`;
  return (
    <a
      href={href}
      {...rest}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        const modifier = event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0;
        if (modifier || event.target instanceof HTMLAnchorElement && event.target.target === "_blank") return;
        event.preventDefault();
        if (adapter) adapter.navigate(to);
        else pushPath(to);
      }}
    >
      {children}
    </a>
  );
}
