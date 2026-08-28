import { describe, expect, it } from "vitest";
import {
  ADMIN_TAB_CAPABILITY,
  ADMIN_TAB_LABEL,
  canManageStaff,
  hasSurfaceCapability,
  visibleAdminTabs,
} from "../src/concepts/staffNav.js";
import { HttpMoxApi } from "../src/api/http-api.js";

const SUPERADMIN = ["*"];
const BILLING_ADMIN = ["admin.read", "admin.billing.write", "admin.notifications.write"];
const OPS_ADMIN = ["admin.read", "admin.compute.write", "admin.intelligence.write", "admin.operations.write", "admin.notifications.write"];
const PLATFORM_ADMIN = ["admin.read", "admin.customers.write", "admin.support.write", "admin.operations.write"];
const SUPPORT_AGENT = ["support.read", "support.customer.lookup", "support.ticket.write"];

describe("Phase 05: Admin Surface Parity (Navigation & Gating)", () => {
  it("contracts tab is strictly capability-gated to admin.billing.write", () => {
    expect(ADMIN_TAB_CAPABILITY.contracts).toBe("admin.billing.write");
    expect(ADMIN_TAB_LABEL.contracts).toBe("Contracts");

    // Superadmin has wildcard -> can see contracts
    expect(hasSurfaceCapability(SUPERADMIN, ADMIN_TAB_CAPABILITY.contracts)).toBe(true);
    expect(visibleAdminTabs(SUPERADMIN)).toContain("contracts");

    // Billing admin has admin.billing.write -> can see contracts
    expect(hasSurfaceCapability(BILLING_ADMIN, ADMIN_TAB_CAPABILITY.contracts)).toBe(true);
    expect(visibleAdminTabs(BILLING_ADMIN)).toContain("contracts");

    // Ops admin does not have admin.billing.write -> cannot see contracts
    expect(hasSurfaceCapability(OPS_ADMIN, ADMIN_TAB_CAPABILITY.contracts)).toBe(false);
    expect(visibleAdminTabs(OPS_ADMIN)).not.toContain("contracts");

    // Platform admin does not have admin.billing.write -> cannot see contracts
    expect(hasSurfaceCapability(PLATFORM_ADMIN, ADMIN_TAB_CAPABILITY.contracts)).toBe(false);
    expect(visibleAdminTabs(PLATFORM_ADMIN)).not.toContain("contracts");

    // Support agent has no admin capabilities -> cannot see any admin tabs
    expect(hasSurfaceCapability(SUPPORT_AGENT, ADMIN_TAB_CAPABILITY.contracts)).toBe(false);
    expect(visibleAdminTabs(SUPPORT_AGENT)).toEqual([]);
  });

  it("only superadmin reaches Staff & Access", () => {
    expect(canManageStaff(SUPERADMIN)).toBe(true);
    expect(canManageStaff(BILLING_ADMIN)).toBe(false);
    expect(canManageStaff(OPS_ADMIN)).toBe(false);
    expect(canManageStaff(PLATFORM_ADMIN)).toBe(false);
    expect(canManageStaff(SUPPORT_AGENT)).toBe(false);
  });

  it("HttpMoxApi declares all Phase 05 Admin methods", () => {
    const api = new HttpMoxApi({ baseUrl: "http://localhost:3000" });

    // Enterprise contracts
    expect(typeof api.adminListEnterpriseContracts).toBe("function");
    expect(typeof api.adminSaveEnterpriseContract).toBe("function");
    expect(typeof api.adminDeactivateEnterpriseContract).toBe("function");

    // Feature flags & Operations
    expect(typeof api.adminSaveFeatureFlag).toBe("function");
    expect(typeof api.adminDeleteFeatureFlag).toBe("function");
    expect(typeof api.adminRunBackup).toBe("function");
    expect(typeof api.adminRestoreTest).toBe("function");

    // Plans & Addons
    expect(typeof api.adminSavePlanEntitlement).toBe("function");
    expect(typeof api.adminSaveAddon).toBe("function");

    // Notifications inspection
    expect(typeof api.adminGetNotificationJob).toBe("function");
    expect(typeof api.adminCancelNotificationJob).toBe("function");

    // Compute orders
    expect(typeof api.adminComputeOrderAction).toBe("function");
  });
});
