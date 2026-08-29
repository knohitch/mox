import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CUSTOMER_DESTINATIONS, CUSTOMER_NAV, hasForbiddenDestination } from "../src/concepts/nav.js";
import {
  ADMIN_NAV_GROUPS,
  ADMIN_TAB_LABEL,
  ADMIN_TABS,
  SUPPORT_NAV_GROUPS,
  SUPPORT_SECTIONS,
  visibleAdminTabs,
  visibleSupportSections,
} from "../src/concepts/staffNav.js";
import { humanizeLabel } from "../src/domain/labels.js";
import { buildAttentionItems, buildOpsSnapshot, isNewWorkspace } from "../src/domain/ops-dashboard.js";
import { defaultPageFor } from "../src/uiStudio/previewNavigation.js";

const root = dirname(fileURLToPath(import.meta.url));
const src = (rel: string): string => readFileSync(join(root, "..", "src", rel), "utf8");

describe("Customer IA remains customer-only", () => {
  it("keeps the 12 customer destinations and no staff links", () => {
    expect(CUSTOMER_DESTINATIONS).toHaveLength(12);
    expect(hasForbiddenDestination(CUSTOMER_DESTINATIONS)).toBe(false);
    expect(CUSTOMER_NAV.map((g) => g.label)).toEqual(["Home", "Build", "Infrastructure", "Connect", "Account"]);
  });
});

describe("Admin and Support sidebar IA", () => {
  it("groups every admin tab exactly once", () => {
    const grouped = ADMIN_NAV_GROUPS.flatMap((g) => g.entries);
    expect([...grouped].sort()).toEqual([...ADMIN_TABS].sort());
    expect(ADMIN_TAB_LABEL.contracts).toBe("Enterprise Contracts");
    expect(ADMIN_TAB_LABEL.plans).toBe("Plans & Pricing");
  });

  it("places support overview first and keeps escalation manager-only", () => {
    expect(SUPPORT_SECTIONS[0]).toBe("overview");
    expect(SUPPORT_NAV_GROUPS[0]?.entries).toContain("escalation");
    expect(defaultPageFor("support")).toBe("overview");
    const agent = visibleSupportSections(["support.read", "support.ticket.write", "support.customer.lookup"]);
    expect(agent).toContain("overview");
    expect(agent).not.toContain("escalation");
    const manager = visibleSupportSections([
      "support.read",
      "support.ticket.write",
      "support.customer.lookup",
      "support.escalate",
    ]);
    expect(manager).toContain("escalation");
  });

  it("reduced admin roles do not see Staff & Access", () => {
    expect(visibleAdminTabs(["admin.read", "admin.billing.write", "admin.notifications.write"])).not.toContain("staff");
  });
});

describe("Human labels and operational dashboard", () => {
  it("never uses raw camelCase as the primary label", () => {
    expect(humanizeLabel("providerName")).toBe("Provider");
    expect(humanizeLabel("accountLabel")).toBe("Account");
    expect(humanizeLabel("computeClassCode")).toBe("Compute class");
    expect(humanizeLabel("fanoutDone")).toBe("Sent");
  });

  it("builds attention items from real snapshot data only", () => {
    const empty = buildOpsSnapshot({ agents: [], deployments: [], servers: [], approvals: [] });
    expect(isNewWorkspace(empty)).toBe(true);
    expect(buildAttentionItems({ snapshot: empty, failedDeploymentLabels: [], degradedServerLabels: [] })).toEqual([]);

    const hot = buildOpsSnapshot({
      agents: [{ runtimeStatus: "working" }],
      deployments: [{ state: "failed" }],
      servers: [{ state: "error" }],
      approvals: [{}],
      commerciallyEntitled: false,
    });
    const items = buildAttentionItems({
      snapshot: hot,
      failedDeploymentLabels: ["agent_a"],
      degradedServerLabels: ["cx41"],
    });
    expect(items.map((i) => i.id)).toEqual(["approvals", "deployments", "servers", "billing"]);
    expect(items.every((i) => i.href.startsWith("/"))).toBe(true);
  });
});

describe("Studio uses production surfaces", () => {
  it("UiStudioView renders HomeView, AdminView, and SupportConsole", () => {
    const studio = src("views/UiStudioView.tsx");
    expect(studio).toContain("from \"./AdminView.js\"");
    expect(studio).toContain("from \"../App.js\"");
    expect(studio).toContain("<HomeView />");
    expect(studio).toContain("<AdminView />");
    expect(studio).toContain("<SupportConsole />");
    expect(studio).not.toContain("StudioHomeView");
    expect(studio).not.toContain("FakeAdmin");
  });

  it("customer dashboard no longer invents task-board counts", () => {
    const home = src("views/MiscViews.tsx");
    expect(home).toContain("buildOpsSnapshot");
    expect(home).not.toContain("|| 24");
    expect(home).not.toContain("Tasks report");
    expect(home).not.toContain("Burndown chart");
  });
});
