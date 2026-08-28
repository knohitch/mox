import { describe, expect, it } from "vitest";
import {
  ADMIN_TAB_CAPABILITY,
  canManageStaff,
  canSupportLookup,
  canSupportNote,
  hasSurfaceCapability,
  visibleAdminTabs,
} from "../src/concepts/staffNav.js";

const SUPERADMIN = ["*"];
const PLATFORM_ADMIN = ["admin.read", "admin.customers.write", "admin.support.write", "admin.operations.write"];
const SUPPORT_AGENT = ["support.read", "support.customer.lookup", "support.ticket.write"];

describe("staff-surface capability gating (Prompt 03)", () => {
  it("grants a capability via wildcard or exact match", () => {
    expect(hasSurfaceCapability(SUPERADMIN, "admin.staff.write")).toBe(true);
    expect(hasSurfaceCapability(PLATFORM_ADMIN, "admin.read")).toBe(true);
    expect(hasSurfaceCapability(PLATFORM_ADMIN, "admin.billing.write")).toBe(false);
    expect(hasSurfaceCapability(SUPPORT_AGENT, "support.customer.lookup")).toBe(true);
  });

  it("only superadmin (admin.staff.write) reaches Staff & Access", () => {
    expect(canManageStaff(SUPERADMIN)).toBe(true);
    expect(canManageStaff(PLATFORM_ADMIN)).toBe(false);
    expect(canManageStaff(SUPPORT_AGENT)).toBe(false);
  });

  it("a support role can look up and note customers but never admin", () => {
    expect(canSupportLookup(SUPPORT_AGENT)).toBe(true);
    expect(canSupportNote(SUPPORT_AGENT)).toBe(true);
    // Support capabilities contain no admin.* gates at all.
    expect(Object.keys(ADMIN_TAB_CAPABILITY).every((k) => !hasSurfaceCapability(SUPPORT_AGENT, ADMIN_TAB_CAPABILITY[k as keyof typeof ADMIN_TAB_CAPABILITY]))).toBe(true);
  });

  it("superadmin sees every admin tab including Staff & Access", () => {
    const tabs = visibleAdminTabs(SUPERADMIN);
    expect(tabs).toContain("dashboard");
    expect(tabs).toContain("staff");
    expect(tabs.length).toBe(Object.keys(ADMIN_TAB_CAPABILITY).length);
  });

  it("a platform_admin without staff.write never sees Staff & Access", () => {
    const tabs = visibleAdminTabs(PLATFORM_ADMIN);
    expect(tabs).not.toContain("staff");
    // Limited caps show only the viewable set (runtime is gated by admin.operations.write).
    expect(tabs).toEqual(["dashboard", "customers", "runtime", "operations"]);
  });

  it("a support agent sees no admin tabs at all", () => {
    expect(visibleAdminTabs(SUPPORT_AGENT)).toEqual([]);
  });

  it("a billing_admin sees commercial tabs including contracts but not staff", () => {
    const BILLING_ADMIN = ["admin.read", "admin.billing.write", "admin.notifications.write"];
    expect(visibleAdminTabs(BILLING_ADMIN)).toEqual([
      "dashboard",
      "customers",
      "plans",
      "payments",
      "notifications",
      "operations",
      "contracts",
    ]);
  });
});
