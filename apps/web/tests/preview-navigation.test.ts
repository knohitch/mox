import { describe, expect, it } from "vitest";
import {
  ADMIN_PREVIEW_ROLES,
  ADMIN_TAB_CAPABILITY,
  SUPPORT_PREVIEW_ROLES,
  visibleAdminTabs,
  visibleSupportSections,
} from "../src/concepts/staffNav.js";
import { CUSTOMER_DESTINATIONS } from "../src/concepts/nav.js";
import {
  STUDIO_ADMIN_PAGES,
  STUDIO_CUSTOMER_PAGES,
  STUDIO_PATH,
  STUDIO_SUPPORT_PAGES,
  applyStudioNavigation,
  defaultPageFor,
  defaultRoleFor,
  isStudioPath,
  logicalPathFor,
  parseStudioSearch,
  serializeStudioSearch,
  studioLocation,
  withStudioPage,
  withStudioSurface,
  type StudioUrlState,
} from "../src/uiStudio/previewNavigation.js";
import { createMockMoxStore } from "../src/uiStudio/mockStore.js";

const customerHome: StudioUrlState = {
  surface: "customer",
  page: "/dashboard",
  previewState: "populated",
  role: "superadmin",
};

describe("Studio URL state", () => {
  it("round-trips surface, page, state, and role", () => {
    const admin: StudioUrlState = {
      surface: "admin",
      page: "compute",
      previewState: "populated",
      role: "superadmin",
    };
    expect(parseStudioSearch(serializeStudioSearch(admin))).toEqual(admin);

    const support: StudioUrlState = {
      surface: "support",
      page: "diagnostics",
      previewState: "empty",
      role: "support_manager",
    };
    expect(parseStudioSearch(`?${serializeStudioSearch(support)}`)).toEqual(support);

    const customer = parseStudioSearch("surface=customer&page=/agents&state=gated");
    expect(customer.surface).toBe("customer");
    expect(customer.page).toBe("/agents");
    expect(customer.previewState).toBe("gated");
  });

  it("refresh preserves selection via URL parse", () => {
    const href = studioLocation({
      surface: "admin",
      page: "contracts",
      previewState: "populated",
      role: "billing_admin",
    });
    expect(href.startsWith(`${STUDIO_PATH}?`)).toBe(true);
    const restored = parseStudioSearch(href.slice(STUDIO_PATH.length));
    expect(restored.page).toBe("contracts");
    expect(restored.role).toBe("billing_admin");
    expect(restored.surface).toBe("admin");
  });

  it("rejects invented roles and pages", () => {
    const parsed = parseStudioSearch("surface=admin&page=secret&role=root&state=wired");
    expect(parsed.page).toBe("dashboard");
    expect(parsed.role).toBe("superadmin");
    expect(parsed.previewState).toBe("populated");
  });
});

describe("Studio product navigation stays on /__ui", () => {
  it("covers all 12 customer pages from sidebar destinations", () => {
    expect(STUDIO_CUSTOMER_PAGES.map((p) => p.id)).toEqual([...CUSTOMER_DESTINATIONS]);
    for (const dest of CUSTOMER_DESTINATIONS) {
      const next = applyStudioNavigation(customerHome, dest);
      expect(isStudioPath(studioLocation(next).split("?")[0]!)).toBe(true);
      expect(next.surface).toBe("customer");
      expect(next.page).toBe(dest);
      expect(logicalPathFor(next)).toBe(dest);
    }
  });

  it("toolbar page selector updates Studio page without leaving /__ui", () => {
    const next = withStudioPage(customerHome, "/billing");
    expect(studioLocation(next)).toBe("/__ui?surface=customer&page=%2Fbilling&state=populated");
    expect(next.page).toBe("/billing");
  });

  it("contextual product links (Manage, Back, Settings) stay in Studio", () => {
    const fromAgents = applyStudioNavigation({ ...customerHome, page: "/agents" }, "/deployments");
    expect(fromAgents.page).toBe("/deployments");
    expect(studioLocation(fromAgents).startsWith("/__ui?")).toBe(true);

    const back = applyStudioNavigation(fromAgents, "/dashboard");
    expect(back.page).toBe("/dashboard");

    const settings = applyStudioNavigation(back, "/settings#knowledge");
    expect(settings.page).toBe("/settings");
  });

  it("never emits a production /agents /admin /support browser path", () => {
    const hops = ["/agents", "/admin", "/admin/compute", "/support", "/support/diagnostics", "/login"];
    for (const hop of hops) {
      const next = applyStudioNavigation(customerHome, hop);
      const href = studioLocation(next);
      expect(href.startsWith("/__ui")).toBe(true);
      expect(href.startsWith("/agents")).toBe(false);
      expect(href.startsWith("/admin")).toBe(false);
      expect(href.startsWith("/support")).toBe(false);
    }
  });

  it("back/forward is represented by re-parsing prior search strings", () => {
    const first = withStudioPage(customerHome, "/agents");
    const second = withStudioSurface(first, "admin");
    const third = withStudioPage(second, "compute");
    const history = [first, second, third].map((s) => serializeStudioSearch(s));
    expect(parseStudioSearch(history[0]!).page).toBe("/agents");
    expect(parseStudioSearch(history[1]!).surface).toBe("admin");
    expect(parseStudioSearch(history[2]!).page).toBe("compute");
  });

  it("admin and support page catalogs match production sections", () => {
    expect(STUDIO_ADMIN_PAGES.map((p) => p.id)).toEqual([
      "dashboard",
      "customers",
      "plans",
      "payments",
      "compute",
      "intelligence",
      "runtime",
      "notifications",
      "operations",
      "contracts",
      "staff",
    ]);
    expect(STUDIO_SUPPORT_PAGES.map((p) => p.id)).toEqual([
      "lookup",
      "diagnostics",
      "notes",
      "activity",
      "escalation",
    ]);
    expect(defaultPageFor("admin")).toBe("dashboard");
    expect(defaultRoleFor("admin")).toBe("superadmin");
    expect(defaultRoleFor("support")).toBe("support_manager");
  });
});

describe("Studio capability profiles match production vocabulary", () => {
  it("superadmin populated preview exposes every admin tab", () => {
    const store = createMockMoxStore("admin", "populated", "superadmin");
    expect(store.staffSession?.role).toBe("superadmin");
    expect(store.staffSession?.capabilities).toEqual(["*"]);
    expect(visibleAdminTabs(store.staffSession?.capabilities ?? []).length).toBe(Object.keys(ADMIN_TAB_CAPABILITY).length);
    expect(visibleAdminTabs(store.staffSession?.capabilities ?? [])).toContain("staff");
  });

  it("reduced admin roles only own their canonical sections", () => {
    const billing = createMockMoxStore("admin", "populated", "billing_admin");
    expect(billing.staffSession?.capabilities).toEqual([...ADMIN_PREVIEW_ROLES.billing_admin.capabilities]);
    expect(visibleAdminTabs(billing.staffSession?.capabilities ?? [])).toEqual([
      "dashboard",
      "customers",
      "plans",
      "payments",
      "notifications",
      "operations",
      "contracts",
    ]);

    const ops = createMockMoxStore("admin", "populated", "ops_admin");
    expect(visibleAdminTabs(ops.staffSession?.capabilities ?? [])).toEqual([
      "dashboard",
      "customers",
      "compute",
      "intelligence",
      "runtime",
      "notifications",
      "operations",
    ]);
    expect(visibleAdminTabs(ops.staffSession?.capabilities ?? [])).not.toContain("staff");

    const platform = createMockMoxStore("admin", "populated", "platform_admin");
    expect(visibleAdminTabs(platform.staffSession?.capabilities ?? [])).not.toContain("staff");
    expect(visibleAdminTabs(platform.staffSession?.capabilities ?? [])).not.toContain("plans");
  });

  it("does not use the historical fake admin.overview.read vocabulary", () => {
    const store = createMockMoxStore("admin", "populated");
    for (const cap of store.staffSession?.capabilities ?? []) {
      expect(cap === "*" || cap.startsWith("admin.")).toBe(true);
      expect(cap).not.toContain("overview.read");
      expect(cap).not.toBe("admin.customers.read");
      expect(cap).not.toBe("admin.plans.read");
    }
  });

  it("support manager receives escalation; support agent does not and never gets admin caps", () => {
    const manager = createMockMoxStore("support", "populated", "support_manager");
    expect(manager.staffSession?.capabilities).toEqual([...SUPPORT_PREVIEW_ROLES.support_manager.capabilities]);
    expect(visibleSupportSections(manager.staffSession?.capabilities ?? [])).toContain("escalation");

    const agent = createMockMoxStore("support", "populated", "support_agent");
    expect(visibleSupportSections(agent.staffSession?.capabilities ?? [])).toEqual([
      "lookup",
      "diagnostics",
      "notes",
      "activity",
    ]);
    expect(agent.staffSession?.capabilities.some((c) => c.startsWith("admin."))).toBe(false);
  });

  it("gated preview demonstrates least privilege", () => {
    const admin = createMockMoxStore("admin", "gated", "superadmin");
    expect(admin.staffSession?.capabilities).toEqual([]);
    expect(visibleAdminTabs(admin.staffSession?.capabilities ?? [])).toEqual([]);

    const support = createMockMoxStore("support", "gated", "support_manager");
    expect(support.staffSession?.capabilities).toEqual([]);
    expect(visibleSupportSections(support.staffSession?.capabilities ?? [])).toEqual([]);

    const customer = createMockMoxStore("customer", "gated");
    expect(customer.entitlements?.commerciallyEntitled).toBe(false);
  });

  it("empty fixture mutations do not assume populated rows", async () => {
    const store = createMockMoxStore("customer", "empty");
    expect(store.agents).toEqual([]);
    const draft = await store.api.createAgentDraft({} as never);
    expect(draft.definition).toBeDefined();
    const connected = await store.api.connectModelConnection("anthropic", {});
    expect(connected.providerId).toBeDefined();
    const team = await store.api.getTeamOverview();
    expect(team.members.length).toBeGreaterThanOrEqual(0);
  });

  it("populated support fixtures are immediately listable without a search string", async () => {
    const store = createMockMoxStore("support", "populated", "support_manager");
    const customers = await store.api.supportCustomers();
    expect(customers.length).toBeGreaterThan(0);
    const detail = await store.api.supportCustomer(customers[0]!.orgId);
    expect(detail.supportNotes.length).toBeGreaterThan(0);
    expect(detail.recentActivity.length).toBeGreaterThan(0);
    expect(detail.diagnostics).toBeDefined();
  });
});
