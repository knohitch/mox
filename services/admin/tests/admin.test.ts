import { describe, expect, it } from "vitest";
import { EntitlementService, InMemoryEntitlementStore } from "@mox/entitlements";
import { FeatureFlagService } from "@mox/feature-flags";
import { CostEngine } from "@mox/cost-engine";
import { InMemoryCostStore } from "@mox/cost-engine";
import { AdminService } from "../src/service.js";
import { EnterpriseContractService, InMemoryEnterpriseStore } from "../src/enterprise.js";
import type { BillingAuthority, ComputeAuthority } from "../src/service.js";

function actorOf(role: string) {
  return { userId: `u-${role}`, role: role as never };
}

function makeAdmin(options: { billing?: BillingAuthority; compute?: ComputeAuthority } = {}) {
  const entitlements = new EntitlementService(new InMemoryEntitlementStore());
  const flags = new FeatureFlagService();
  const costs = new CostEngine(new InMemoryCostStore());
  const enterpriseSvc = new EnterpriseContractService(entitlements, new InMemoryEnterpriseStore());
  const admin = new AdminService({
    entitlements,
    flags,
    costs,
    enterprise: enterpriseSvc,
    billing: options.billing,
    compute: options.compute,
  });
  return { admin, entitlements, flags, costs, enterpriseSvc };
}

describe("admin rbac", () => {
  it("enforces role boundaries per capability", async () => {
    const { admin } = makeAdmin();
    // Support can read customers and take notes…
    await expect(admin.listOrganizations(actorOf("support"))).resolves.toBeTruthy();
    await admin.addSupportNote(actorOf("support"), { orgId: "org-1", note: "vip customer" });
    // …but not write billing.
    await expect(admin.suspendSubscription(actorOf("support"), { subscriptionId: "s", reason: "r" })).rejects.toThrow(/requires billing.write/);
    // Ops can't touch billing either.
    await expect(admin.publishPlanChange(actorOf("ops_admin"), { productId: "p", version: 2, entitlementValues: {} })).rejects.toThrow(/billing.write/);
    // Billing admin can't rotate provider credentials.
    await expect(
      admin.rotateProviderCredential(actorOf("billing_admin"), { providerName: "contabo", accountLabel: "a", newCredentialRefId: "c" }),
    ).rejects.toThrow(/compute.write/);
    // Only superadmin writes system settings.
    await expect(admin.setSystemSetting(actorOf("ops_admin"), { key: "k", value: "v" })).rejects.toThrow(/settings.write/);
    await expect(admin.setSystemSetting(actorOf("superadmin"), { key: "k", value: "v" })).resolves.toBeUndefined();
  });

  it("records an audit trail for admin mutations", async () => {
    const { admin } = makeAdmin();
    await admin.setAccountStatus(actorOf("superadmin"), { orgId: "org-9", status: "suspended", reason: "fraud_review" });
    const trail = await admin.auditTrail(actorOf("superadmin"));
    expect(trail.some((e) => e.detail.includes("org-9 → suspended"))).toBe(true);
  });
});

describe("no-deploy commercial operations", () => {
  it("creates and activates plan versions + prices through authorities", async () => {
    const created: Array<{ id: string }> = [];
    let activated = "";
    let pricedBook = "";
    const billing: BillingAuthority = {
      async listSubscriptionSummaries() {
        return [];
      },
      async adminSuspend() {},
      async adminReactivate() {},
      async createPlanVersion(productId, version) {
        const v = { id: `${productId}-v${version}` };
        created.push(v);
        return v;
      },
      async activatePlanVersion(planVersionId) {
        activated = String(planVersionId);
        return {};
      },
      async setPlanEntitlementValues(planVersionId, values) {
        void planVersionId;
        void values;
        return {};
      },
      async addFixedPriceVersion(priceBookId) {
        pricedBook = priceBookId;
        return {};
      },
      async upsertPriceBook() {
        return { id: "book-1" };
      },
      async attachAddon() {
        return {};
      },
    };
    const { admin } = makeAdmin({ billing });

    const result = await admin.publishPlanChange(actorOf("billing_admin"), {
      productId: "prod-pro",
      version: 3,
      entitlementValues: { max_agents: 25, developer_mode: true },
      priceBookId: "book-1",
      newPriceMinor: 5200n,
      currency: "USD",
    });
    expect(result.planVersionId).toBe("prod-pro-v3");
    expect(activated).toBe("prod-pro-v3");
    expect(pricedBook).toBe("book-1");
    expect(created).toHaveLength(1);
  });

  it("grants controlled entitlement overrides via the shared engine", async () => {
    const { admin, entitlements } = makeAdmin();
    await admin.grantEntitlementOverride(actorOf("billing_admin"), {
      orgId: "org-x",
      key: "max_agents",
      value: 99,
      note: "launch promo",
    });
    const resolved = await entitlements.resolve("org-x", "max_agents", "*");
    expect(resolved.value).toBe(99);
    expect(resolved.source).toBe("org_override");
  });
});

describe("enterprise contracts", () => {
  it("configures negotiated terms through the SAME entitlement engine", async () => {
    const { admin, entitlements } = makeAdmin();
    await admin.applyEnterpriseContract(actorOf("billing_admin"), {
      orgId: "org-acme",
      contractRef: "ACME-2026",
      customPriceMinor: 500_000n,
      currency: "USD",
      entitlementValues: {
        max_agents: 250,
        included_server_count: 12,
        included_compute_class: "COMPUTE_LARGE",
        developer_mode: true,
        team_members: 80,
        backup_retention_days: 365,
      },
      metadata: {
        includedNodes: 12,
        customComputeClassCodes: ["COMPUTE_ACME_LARGE"],
        privateModelSlugs: ["acme-internal-only"],
        dedicatedDatabase: true,
        dedicatedRuntime: true,
        customRetentionDays: 400,
        customDomains: ["agents.acme.com"],
        auditExportEnabled: true,
        ssoSamlReady: true,
        ssoMetadataUrl: "https://acme.test/saml-metadata",
        privateNetworkingHooks: ["vpc-peering"],
        slaMonthlyUptimePct: 99.95,
        slaSupportResponseHours: 1,
        whiteLabel: false,
      },
      active: true,
      effectiveFrom: "2026-01-01T00:00:00.000Z",
    });

    // Same engine resolves enterprise limits exactly like any other plan.
    const agents = await entitlements.resolve("org-acme", "max_agents", "any-plan-version", "2026-02-01T00:00:00.000Z");
    expect(agents).toMatchObject({ value: 250, source: "custom_contract" });
    const servers = await entitlements.limitOf("org-acme", "included_server_count", "*", "2026-02-01T00:00:00.000Z");
    expect(servers).toBe(12);

    const contract = await admin.getEnterpriseContract(actorOf("support"), "org-acme");
    expect(contract?.metadata.slaMonthlyUptimePct).toBe(99.95);
    expect(contract?.metadata.dedicatedDatabase).toBe(true);
  });

  it("deactivating a contract drops its entitlement layer", async () => {
    const { admin, entitlements } = makeAdmin();
    await admin.applyEnterpriseContract(actorOf("billing_admin"), {
      orgId: "org-temp",
      contractRef: "TEMP-1",
      entitlementValues: { max_agents: 999 },
      metadata: {
        includedNodes: 5,
        customComputeClassCodes: [],
        privateModelSlugs: [],
        dedicatedDatabase: false,
        dedicatedRuntime: false,
        customDomains: [],
        auditExportEnabled: false,
        ssoSamlReady: false,
        privateNetworkingHooks: [],
        whiteLabel: false,
      },
      active: true,
      effectiveFrom: "2026-01-01T00:00:00.000Z",
    });
    expect((await entitlements.resolve("org-temp", "max_agents", "*", "2026-02-01T00:00:00.000Z")).source).toBe("custom_contract");

    await admin.deactivateEnterpriseContract!(actorOf("billing_admin"), "org-temp");
    expect((await entitlements.resolve("org-temp", "max_agents", "*", "2026-02-01T00:00:00.000Z")).source).not.toBe("custom_contract");
  });

  it("denies non-billing actors enterprise writes", async () => {
    const { admin } = makeAdmin();
    await expect(
      admin.applyEnterpriseContract(actorOf("ops_admin"), {
        orgId: "o",
        contractRef: "X",
        entitlementValues: {},
        metadata: {
          includedNodes: 0, customComputeClassCodes: [], privateModelSlugs: [], dedicatedDatabase: false,
          dedicatedRuntime: false, customDomains: [], auditExportEnabled: false, ssoSamlReady: false,
          privateNetworkingHooks: [], whiteLabel: false,
        },
        active: true, effectiveFrom: "2026-01-01T00:00:00.000Z",
      }),
    ).rejects.toThrow(/enterprise.write/);
  });
});
