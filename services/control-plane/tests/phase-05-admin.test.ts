import { describe, expect, it } from "vitest";
import {
  PLATFORM_ROLE_CAPABILITIES,
  STAFF_ROLE_CAPABILITIES,
} from "../src/config.js";
import { FeatureFlagService, InMemoryFeatureFlagStore } from "@mox/feature-flags";
import { EntitlementService, InMemoryEntitlementStore } from "@mox/entitlements";
import { EnterpriseContractService, InMemoryEnterpriseStore } from "../../admin/src/enterprise.js";

describe("Phase 05: Admin Surface Parity (Control Plane & Engine)", () => {
  describe("Admin & Staff Role Capability Mapping & Surface Isolation", () => {
    it("superadmin holds wildcard and reaches all administrative capabilities", () => {
      expect(PLATFORM_ROLE_CAPABILITIES.superadmin).toEqual(["*"]);
      expect(STAFF_ROLE_CAPABILITIES.superadmin.surface).toBe("admin");
      expect(STAFF_ROLE_CAPABILITIES.superadmin.adminCapabilities).toEqual(["*"]);
      expect(STAFF_ROLE_CAPABILITIES.superadmin.supportCapabilities).toEqual([]);
    });

    it("billing_admin holds billing.write and notifications.write but cannot touch compute or staff", () => {
      const caps = PLATFORM_ROLE_CAPABILITIES.billing_admin;
      expect(caps).toContain("admin.read");
      expect(caps).toContain("admin.billing.write");
      expect(caps).toContain("admin.notifications.write");
      expect(caps).not.toContain("admin.compute.write");
      expect(caps).not.toContain("admin.staff.write");
    });

    it("ops_admin holds compute, intelligence and operations write but cannot touch billing or staff", () => {
      const caps = PLATFORM_ROLE_CAPABILITIES.ops_admin;
      expect(caps).toContain("admin.read");
      expect(caps).toContain("admin.compute.write");
      expect(caps).toContain("admin.intelligence.write");
      expect(caps).toContain("admin.operations.write");
      expect(caps).not.toContain("admin.billing.write");
      expect(caps).not.toContain("admin.staff.write");
    });

    it("support roles are strictly isolated to the support surface and possess no admin capabilities", () => {
      expect(STAFF_ROLE_CAPABILITIES.support_manager.surface).toBe("support");
      expect(STAFF_ROLE_CAPABILITIES.support_manager.adminCapabilities).toEqual([]);
      expect(STAFF_ROLE_CAPABILITIES.support_agent.surface).toBe("support");
      expect(STAFF_ROLE_CAPABILITIES.support_agent.adminCapabilities).toEqual([]);
    });
  });

  describe("Enterprise Contracts Engine Integration", () => {
    it("custom enterprise contracts override plan defaults when active and fall back when deactivated", async () => {
      const entStore = new InMemoryEntitlementStore();
      await entStore.upsertDefinition({
        key: "agents_limit",
        valueType: "integer",
        defaultValue: 5,
      });
      await entStore.setPlanValues("plan_v1", { agents_limit: 10 });

      const entService = new EntitlementService(entStore);
      const enterpriseStore = new InMemoryEnterpriseStore();
      const enterpriseService = new EnterpriseContractService(entService, enterpriseStore);

      const orgId = "org_enterprise_123";
      const now = new Date().toISOString();

      // Before contract: resolves plan version value
      const initial = await entService.resolve(orgId, "agents_limit", "plan_v1", now);
      expect(initial.value).toBe(10);
      expect(initial.source).toBe("plan");

      // Apply enterprise contract with 100 agents limit
      await enterpriseService.apply({
        config: {
          orgId,
          contractRef: "ACME-CORP-2026",
          entitlementValues: { agents_limit: 100 },
          active: true,
          effectiveFrom: now,
          metadata: {
            includedNodes: 5,
            dedicatedDatabase: true,
            dedicatedRuntime: true,
            customDomains: ["corp.acme.internal"],
            auditExportEnabled: true,
            ssoSamlReady: true,
            whiteLabel: true,
          },
        },
        actor: "admin_user_1",
      });

      // After contract: resolves contract override
      const contracted = await entService.resolve(orgId, "agents_limit", "plan_v1", now);
      expect(contracted.value).toBe(100);
      expect(contracted.source).toBe("custom_contract");

      // Deactivate enterprise contract
      await enterpriseService.deactivate({ orgId, actor: "admin_user_1" });

      // After deactivation: falls back to plan value
      const postDeactivation = await entService.resolve(orgId, "agents_limit", "plan_v1", now);
      expect(postDeactivation.value).toBe(10);
      expect(postDeactivation.source).toBe("plan");
    });
  });

  describe("Feature Flag Precedence and Audit", () => {
    it("enforces hierarchical precedence: user > org > plan > provider > region > global", async () => {
      const store = new InMemoryFeatureFlagStore();
      const flagService = new FeatureFlagService(store);

      // Global flag disabled
      await flagService.setFlag({ flag: "beta_feature", scope: "global", enabled: false, actor: "admin_1" });
      expect(await flagService.isEnabled("beta_feature", {})).toBe(false);

      // Region flag enabled
      await flagService.setFlag({ flag: "beta_feature", scope: "region", scopeKey: "us-east", enabled: true, actor: "admin_1" });
      expect(await flagService.isEnabled("beta_feature", { regionCode: "us-east" })).toBe(true);
      expect(await flagService.isEnabled("beta_feature", { regionCode: "eu-west" })).toBe(false);

      // Org flag disabled overrides region
      await flagService.setFlag({ flag: "beta_feature", scope: "organization", scopeKey: "org_1", enabled: false, actor: "admin_1" });
      expect(await flagService.isEnabled("beta_feature", { regionCode: "us-east", orgId: "org_1" })).toBe(false);

      // User flag enabled overrides org
      await flagService.setFlag({ flag: "beta_feature", scope: "user", scopeKey: "user_special", enabled: true, actor: "admin_1" });
      expect(await flagService.isEnabled("beta_feature", { regionCode: "us-east", orgId: "org_1", userId: "user_special" })).toBe(true);

      // Verify audit log has recorded each mutation
      const audit = await store.listAudit("beta_feature");
      expect(audit.length).toBe(4);
      expect(audit[0]!.actor).toBe("admin_1");
    });
  });
});
