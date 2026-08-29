import { describe, expect, it } from "vitest";
import { isLocalHostname, isUiStudioAllowed } from "../src/uiStudio/security.js";
import { CUSTOMER_DESTINATIONS, CUSTOMER_NAV_GROUPS, isCustomerDestination } from "../src/concepts/nav.js";
import { ADMIN_TABS, SUPPORT_SECTIONS, canSupportLookup, canSupportNote, visibleSupportSections } from "../src/concepts/staffNav.js";
import {
  createAdminComputeFixture,
  createAdminCustomersFixture,
  createAdminIntelligenceFixture,
  createAdminOverviewFixture,
  createAdminPlansFixture,
  createAdminStaffFixture,
} from "../src/fixtures/adminFixtures.js";
import {
  createCustomerAgentsFixture,
  createCustomerBackupsFixture,
  createCustomerBillingFixture,
  createCustomerChannelsFixture,
  createCustomerDeploymentsFixture,
  createCustomerIntegrationsFixture,
  createCustomerModelsFixture,
  createCustomerNotificationsFixture,
  createCustomerRoomsFixture,
  createCustomerServersFixture,
  createCustomerTeamFixture,
  createCustomerUsageFixture,
  createCustomerUserFixture,
} from "../src/fixtures/customerFixtures.js";
import {
  createSupportCustomerDetailFixture,
  createSupportCustomersFixture,
} from "../src/fixtures/supportFixtures.js";
import { createMockMoxStore } from "../src/uiStudio/mockStore.js";

describe("UI Studio Security Module", () => {
  it("allows UI Studio only under dev mode + local hostname + opt-in env", () => {
    expect(
      isUiStudioAllowed({
        isDev: true,
        envStudioFlag: "1",
        hostname: "localhost",
      }),
    ).toBe(true);

    expect(
      isUiStudioAllowed({
        isDev: true,
        envStudioFlag: "true",
        hostname: "127.0.0.1",
      }),
    ).toBe(true);

    expect(
      isUiStudioAllowed({
        isDev: true,
        envStudioFlag: "true",
        hostname: "[::1]",
      }),
    ).toBe(true);
  });

  it("strictly blocks UI Studio in production builds", () => {
    expect(
      isUiStudioAllowed({
        isDev: false,
        envStudioFlag: "1",
        hostname: "localhost",
      }),
    ).toBe(false);
  });

  it("strictly blocks UI Studio on external or LAN hostnames", () => {
    expect(
      isUiStudioAllowed({
        isDev: true,
        envStudioFlag: "1",
        hostname: "app.mox.ai",
      }),
    ).toBe(false);

    expect(
      isUiStudioAllowed({
        isDev: true,
        envStudioFlag: "1",
        hostname: "192.168.1.50",
      }),
    ).toBe(false);

    expect(
      isUiStudioAllowed({
        isDev: true,
        envStudioFlag: "1",
        hostname: "staging.mox.internal",
      }),
    ).toBe(false);
  });

  it("strictly blocks UI Studio when the studio env flag is not set", () => {
    expect(
      isUiStudioAllowed({
        isDev: true,
        envStudioFlag: undefined,
        hostname: "localhost",
      }),
    ).toBe(false);

    expect(
      isUiStudioAllowed({
        isDev: true,
        envStudioFlag: "0",
        hostname: "localhost",
      }),
    ).toBe(false);

    expect(
      isUiStudioAllowed({
        isDev: true,
        envStudioFlag: "false",
        hostname: "localhost",
      }),
    ).toBe(false);
  });

  it("validates local hostnames accurately", () => {
    expect(isLocalHostname("localhost")).toBe(true);
    expect(isLocalHostname("127.0.0.1")).toBe(true);
    expect(isLocalHostname("[::1]")).toBe(true);
    expect(isLocalHostname("::1")).toBe(true);
    expect(isLocalHostname("mox.localhost")).toBe(false);
    expect(isLocalHostname("evil.com")).toBe(false);
  });
});

describe("Canonical Customer Routing & Surface Isolation", () => {
  it("defines /dashboard as the canonical customer home", () => {
    expect(CUSTOMER_DESTINATIONS).toContain("/dashboard");
    expect(isCustomerDestination("/dashboard")).toBe(true);

    const homeGroup = CUSTOMER_NAV_GROUPS.find((g) => g.label === "Home");
    expect(homeGroup).toBeDefined();
    const dashboardEntry = homeGroup?.entries.find((i) => i.to === "/dashboard");
    expect(dashboardEntry).toBeDefined();
    expect(dashboardEntry?.label).toBe("Dashboard");
  });

  it("contains all 12 canonical customer routes", () => {
    const expected = [
      "/dashboard",
      "/agents",
      "/rooms",
      "/deployments",
      "/servers",
      "/models",
      "/integrations",
      "/channels",
      "/usage",
      "/billing",
      "/backups",
      "/settings",
    ];
    for (const route of expected) {
      expect(CUSTOMER_DESTINATIONS).toContain(route);
      expect(isCustomerDestination(route)).toBe(true);
    }
  });

  it("strictly isolates Customer navigation from Admin and Support surfaces", () => {
    for (const dest of CUSTOMER_DESTINATIONS) {
      expect(dest.startsWith("/admin")).toBe(false);
      expect(dest.startsWith("/support")).toBe(false);
    }

    for (const group of CUSTOMER_NAV_GROUPS) {
      for (const item of group.entries) {
        expect(item.to.startsWith("/admin")).toBe(false);
        expect(item.to.startsWith("/support")).toBe(false);
      }
    }
  });

  it("strictly isolates Support navigation from Admin authority", () => {
    for (const section of SUPPORT_SECTIONS) {
      expect(section).not.toBe("plans");
      expect(section).not.toBe("compute");
      expect(section).not.toBe("staff");
      expect(section).not.toBe("payments");
    }

    expect(ADMIN_TABS).toContain("plans");
    expect(ADMIN_TABS).toContain("compute");
    expect(ADMIN_TABS).toContain("staff");
  });

  it("enforces least-privilege capability gates for Support console", () => {
    expect(canSupportLookup([])).toBe(false);
    expect(canSupportLookup(["support.customer.lookup"])).toBe(true);
    expect(canSupportNote([])).toBe(false);
    expect(canSupportNote(["support.ticket.write"])).toBe(true);

    const readOnlySections = visibleSupportSections(["support.customer.lookup"]);
    expect(readOnlySections).toContain("overview");
    expect(readOnlySections).toContain("lookup");
    expect(readOnlySections).toContain("diagnostics");
    expect(readOnlySections).toContain("activity");
    expect(readOnlySections).not.toContain("notes");
  });
});

describe("Deterministic Fixtures & State Variations", () => {
  it("provides rich populated customer fixtures", () => {
    const user = createCustomerUserFixture();
    expect(user.userId).toBe("usr_fixture_001");
    expect(user.orgDisplayName).toBe("Acme Autonomous Corp");

    const agents = createCustomerAgentsFixture();
    expect(agents.length).toBeGreaterThanOrEqual(3);
    expect(agents[0]?.agentId).toBe("agent_orchestrator");
    expect(agents[0]?.deploymentState).toBe("running");

    const rooms = createCustomerRoomsFixture();
    expect(rooms.length).toBe(2);

    const servers = createCustomerServersFixture();
    expect(servers.length).toBe(2);
    expect(servers[0]?.state).toBe("running");

    const deployments = createCustomerDeploymentsFixture();
    expect(deployments.length).toBe(2);

    const models = createCustomerModelsFixture();
    expect(models.models.length).toBe(3);
    expect(models.connections.length).toBe(2);

    const integrations = createCustomerIntegrationsFixture();
    expect(integrations.length).toBe(3);

    const channels = createCustomerChannelsFixture();
    expect(channels.length).toBe(2);

    const usage = createCustomerUsageFixture();
    expect(usage.rows.length).toBe(3);

    const billing = createCustomerBillingFixture();
    expect(billing.subscription.state).toBe("active");

    const backups = createCustomerBackupsFixture();
    expect(backups.availability).toBe(true);
    expect(backups.backups.length).toBe(2);

    const team = createCustomerTeamFixture();
    expect(team.members.length).toBe(3);

    const notifications = createCustomerNotificationsFixture();
    expect(notifications.items.length).toBe(3);
  });

  it("provides rich populated admin fixtures", () => {
    const overview = createAdminOverviewFixture();
    expect(overview.metrics.customers).toBe(142);
    expect(overview.metrics.activeSubscriptions).toBe(118);

    const customers = createAdminCustomersFixture();
    expect(customers.length).toBe(2);

    const plans = createAdminPlansFixture();
    expect(plans.products.length).toBe(3);

    const compute = createAdminComputeFixture();
    expect(compute.providers).toContain("hetzner");

    const intelligence = createAdminIntelligenceFixture();
    expect(intelligence.providers.length).toBe(3);

    const staff = createAdminStaffFixture();
    expect(staff.members.length).toBe(2);
  });

  it("provides safe diagnostics-only support fixtures without provider secrets", () => {
    const customers = createSupportCustomersFixture();
    expect(customers.length).toBe(2);

    const detail = createSupportCustomerDetailFixture("org_acme_prod");
    expect(detail.orgId).toBe("org_acme_prod");
    expect(detail.users.length).toBe(2);
    expect(detail.supportNotes.length).toBe(2);
    expect(detail.connections.models.length).toBe(2);
    // Verify zero secrets leaked in support models
    for (const model of detail.connections.models) {
      expect((model as Record<string, unknown>).apiKey).toBeUndefined();
      expect((model as Record<string, unknown>).secretKey).toBeUndefined();
    }
  });

  it("mock store supports populated, empty, loading, error, and gated states", () => {
    // Populated
    const populatedStore = createMockMoxStore("customer", "populated");
    expect(populatedStore.ready).toBe(true);
    expect(populatedStore.error).toBeNull();
    expect(populatedStore.agents.length).toBeGreaterThan(0);
    expect(populatedStore.entitlements?.commerciallyEntitled).toBe(true);

    // Empty
    const emptyStore = createMockMoxStore("customer", "empty");
    expect(emptyStore.ready).toBe(true);
    expect(emptyStore.error).toBeNull();
    expect(emptyStore.agents.length).toBe(0);

    // Loading
    const loadingStore = createMockMoxStore("customer", "loading");
    expect(loadingStore.ready).toBe(false);
    expect(loadingStore.error).toBeNull();

    // Error
    const errorStore = createMockMoxStore("customer", "error");
    expect(errorStore.ready).toBe(false);
    expect(errorStore.error).toContain("Simulated Network Error");

    // Gated
    const gatedStore = createMockMoxStore("customer", "gated");
    expect(gatedStore.ready).toBe(true);
    expect(gatedStore.entitlements?.commerciallyEntitled).toBe(false);
    expect(gatedStore.entitlements?.values).toEqual({});
  });
});
