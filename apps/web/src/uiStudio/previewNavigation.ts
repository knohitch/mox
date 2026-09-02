/**
 * Canonical UI Studio URL state. Production routing is unchanged: Studio
 * never leaves `/__ui`. Product Link/navigate calls are rewritten onto
 * shareable query params so refresh and history work.
 *
 * Example:
 *   /__ui?surface=customer&page=/agents&state=populated
 *   /__ui?surface=admin&page=compute&role=superadmin&state=populated
 *   /__ui?surface=support&page=diagnostics&role=support_manager&state=populated
 */

import { CUSTOMER_DESTINATIONS, CUSTOMER_NAV, isCustomerDestination } from "../concepts/nav.js";
import {
  ADMIN_PREVIEW_ROLES,
  ADMIN_TAB_LABEL,
  ADMIN_TABS,
  SUPPORT_PREVIEW_ROLES,
  SUPPORT_SECTION_LABEL,
  SUPPORT_SECTIONS,
  isAdminTabKey,
  isSupportSectionKey,
  type AdminTabKey,
  type SupportSectionKey,
} from "../concepts/staffNav.js";
export type StudioSurface = "customer" | "admin" | "support";
export type StudioPreviewState = "populated" | "empty" | "loading" | "error" | "gated";

/** Dev-only onboarding preview states (visual only — never real authority). */
export const STUDIO_ONBOARDING_STATES = [
  "step1",
  "step2",
  "step3",
  "step4",
  "step5",
  "step6",
  "error",
  "provider-unavailable",
  "mobile",
] as const;
export type StudioOnboardingState = (typeof STUDIO_ONBOARDING_STATES)[number];

export type StudioAdminRole = keyof typeof ADMIN_PREVIEW_ROLES;
export type StudioSupportRole = keyof typeof SUPPORT_PREVIEW_ROLES;

export interface StudioUrlState {
  surface: StudioSurface;
  page: string;
  previewState: StudioPreviewState;
  role: string;
  theme?: string;
  /** Only meaningful while previewing the /onboarding page. */
  onboarding?: StudioOnboardingState;
}

export const STUDIO_PATH = "/__ui";

export const STUDIO_ONBOARDING_PAGE = { id: "/onboarding", label: "Onboarding" } as const;

export const STUDIO_CUSTOMER_PAGES: readonly { id: string; label: string }[] = [
  STUDIO_ONBOARDING_PAGE,
  ...CUSTOMER_NAV.flatMap((group) => group.entries.map((entry) => ({ id: entry.to, label: entry.label }))),
];

export const STUDIO_ADMIN_PAGES: readonly { id: AdminTabKey; label: string }[] = ADMIN_TABS.map((id) => ({
  id,
  label: ADMIN_TAB_LABEL[id],
}));

export const STUDIO_SUPPORT_PAGES: readonly { id: SupportSectionKey; label: string }[] = SUPPORT_SECTIONS.map((id) => ({
  id,
  label: SUPPORT_SECTION_LABEL[id],
}));

const SURFACES: readonly StudioSurface[] = ["customer", "admin", "support"];
const PREVIEW_STATES: readonly StudioPreviewState[] = ["populated", "empty", "loading", "error", "gated"];

export function isStudioPath(pathname: string): boolean {
  return pathname === STUDIO_PATH || pathname.startsWith(`${STUDIO_PATH}/`);
}

export function defaultPageFor(surface: StudioSurface): string {
  if (surface === "admin") return "dashboard";
  if (surface === "support") return "overview";
  return "/dashboard";
}

export function defaultRoleFor(surface: StudioSurface): string {
  if (surface === "support") return "support_manager";
  return "superadmin";
}

export function isStudioAdminRole(value: string | null | undefined): value is StudioAdminRole {
  return !!value && Object.prototype.hasOwnProperty.call(ADMIN_PREVIEW_ROLES, value);
}

export function isStudioSupportRole(value: string | null | undefined): value is StudioSupportRole {
  return !!value && Object.prototype.hasOwnProperty.call(SUPPORT_PREVIEW_ROLES, value);
}

export function resolveCustomerPage(path: string): string | null {
  const clean = stripQueryAndHash(path);
  if (clean === STUDIO_ONBOARDING_PAGE.id) return clean;
  if (isCustomerDestination(clean)) return clean;
  const prefix = CUSTOMER_DESTINATIONS.find((dest) => clean === dest || clean.startsWith(`${dest}/`));
  return prefix ?? null;
}

export function isStudioOnboardingState(value: string | null | undefined): value is StudioOnboardingState {
  return !!value && (STUDIO_ONBOARDING_STATES as readonly string[]).includes(value);
}

export function parseStudioSearch(search: string): StudioUrlState {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const surface = parseSurface(params.get("surface"));
  const previewState = parsePreviewState(params.get("state"));
  const role = parseRole(surface, params.get("role"));
  const page = parsePage(surface, params.get("page"));
  const theme = params.get("theme");
  const rawOnboarding = params.get("onboarding");
  const state: StudioUrlState = { surface, page, previewState, role };
  if (theme) state.theme = theme;
  if (page === STUDIO_ONBOARDING_PAGE.id && isStudioOnboardingState(rawOnboarding)) {
    state.onboarding = rawOnboarding;
  }
  return state;
}

export function serializeStudioSearch(state: StudioUrlState): string {
  const params = new URLSearchParams();
  params.set("surface", state.surface);
  params.set("page", state.page);
  params.set("state", state.previewState);
  if (state.surface !== "customer") params.set("role", state.role);
  if (state.theme) params.set("theme", state.theme);
  if (state.page === STUDIO_ONBOARDING_PAGE.id && state.onboarding) params.set("onboarding", state.onboarding);
  return `?${params.toString()}`;
}

export function studioLocation(state: StudioUrlState): string {
  return `${STUDIO_PATH}${serializeStudioSearch(state)}`;
}

export function logicalPathFor(state: StudioUrlState): string {
  if (state.surface === "admin") return "/admin";
  if (state.surface === "support") return "/support";
  return state.page;
}

/**
 * Map a product destination onto Studio URL state. The browser path is always
 * `/__ui`; this never returns a production route.
 */
export function applyStudioNavigation(current: StudioUrlState, to: string): StudioUrlState {
  const path = stripQueryAndHash(to);
  if (isStudioPath(path)) return current;

  if (path === "/admin" || path.startsWith("/admin/")) {
    const rest = path === "/admin" ? "dashboard" : path.slice("/admin/".length);
    const page = isAdminTabKey(rest) ? rest : defaultPageFor("admin");
    return {
      ...current,
      surface: "admin",
      page,
      role: current.surface === "admin" ? current.role : defaultRoleFor("admin"),
    };
  }

  if (path === "/support" || path.startsWith("/support/")) {
    const rest = path === "/support" ? "overview" : path.slice("/support/".length);
    const page = isSupportSectionKey(rest) ? rest : defaultPageFor("support");
    return {
      ...current,
      surface: "support",
      page,
      role: current.surface === "support" ? current.role : defaultRoleFor("support"),
    };
  }

  const customerPage = resolveCustomerPage(path);
  if (customerPage) {
    return { ...current, surface: "customer", page: customerPage };
  }

  // Unknown destinations stay inside Studio rather than escaping to production.
  return current;
}

export function withStudioPage(current: StudioUrlState, page: string): StudioUrlState {
  return { ...current, page, onboarding: page === STUDIO_ONBOARDING_PAGE.id ? (current.onboarding ?? "step1") : undefined };
}

export function withStudioOnboardingState(current: StudioUrlState, onboarding: StudioOnboardingState): StudioUrlState {
  return { ...current, onboarding };
}

export function withStudioSurface(current: StudioUrlState, surface: StudioSurface): StudioUrlState {
  return {
    ...current,
    surface,
    page: defaultPageFor(surface),
    role: defaultRoleFor(surface),
  };
}

export function withStudioState(current: StudioUrlState, previewState: StudioPreviewState): StudioUrlState {
  return { ...current, previewState };
}

export function withStudioRole(current: StudioUrlState, role: string): StudioUrlState {
  return { ...current, role };
}

function stripQueryAndHash(path: string): string {
  const noHash = path.split("#")[0] ?? path;
  const noQuery = noHash.split("?")[0] ?? noHash;
  return noQuery.startsWith("/") ? noQuery : `/${noQuery}`;
}

function parseSurface(raw: string | null): StudioSurface {
  return SURFACES.includes(raw as StudioSurface) ? (raw as StudioSurface) : "customer";
}

function parsePreviewState(raw: string | null): StudioPreviewState {
  return PREVIEW_STATES.includes(raw as StudioPreviewState) ? (raw as StudioPreviewState) : "populated";
}

function parseRole(surface: StudioSurface, raw: string | null): string {
  if (surface === "admin") return isStudioAdminRole(raw) ? raw : defaultRoleFor("admin");
  if (surface === "support") return isStudioSupportRole(raw) ? raw : defaultRoleFor("support");
  return defaultRoleFor(surface);
}

function parsePage(surface: StudioSurface, raw: string | null): string {
  if (!raw) return defaultPageFor(surface);
  if (surface === "admin") return isAdminTabKey(raw) ? raw : defaultPageFor("admin");
  if (surface === "support") return isSupportSectionKey(raw) ? raw : defaultPageFor("support");
  return resolveCustomerPage(raw) ?? defaultPageFor("customer");
}

