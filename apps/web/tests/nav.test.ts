import { describe, expect, it } from "vitest";
import {
  CUSTOMER_AUTH_ROUTES,
  CUSTOMER_DESTINATIONS,
  CUSTOMER_NAV,
  STAFF_SURFACE_ROOTS,
  hasForbiddenDestination,
} from "../src/concepts/nav.js";

describe("customer nav information architecture (Prompt 02)", () => {
  it("contains the grouped destinations matching the target IA", () => {
    const labels = CUSTOMER_NAV.map((g) => g.label);
    expect(labels).toEqual(["Home", "Build", "Infrastructure", "Connect", "Account"]);

    const flat = CUSTOMER_NAV.flatMap((g) => g.entries.map((e) => e.label));
    expect(flat).toEqual([
      "Dashboard",
      "Agents",
      "Agent Rooms",
      "Deployments",
      "Servers",
      "Models",
      "Apps & Integrations",
      "Channels",
      "Usage",
      "Billing",
      "Backups",
      "Settings",
    ]);
  });

  it("maps every customer route to the protected path table", () => {
    // Every protected customer route must be reachable from the nav.
    expect(CUSTOMER_DESTINATIONS).toEqual([
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
    ]);
  });

  it("never exposes admin, support, or any staff/staff-leaning surface", () => {
    // Flat destinations must not include staff roots.
    for (const root of Object.values(STAFF_SURFACE_ROOTS)) {
      expect(CUSTOMER_DESTINATIONS).not.toContain(root);
      expect(CUSTOMER_DESTINATIONS.some((d) => d.startsWith(root))).toBe(false);
    }
    // The forbidden-term guard must agree (customer IA is clean).
    expect(hasForbiddenDestination(CUSTOMER_DESTINATIONS)).toBe(false);
  });

  it("flags staff surfaces as forbidden via hasForbiddenDestination", () => {
    expect(hasForbiddenDestination(["/admin"])).toBe(true);
    expect(hasForbiddenDestination(["/support"])).toBe(true);
    expect(hasForbiddenDestination(["/admin/customers"])).toBe(true);
    expect(hasForbiddenDestination(["/support/queue"])).toBe(true);
    expect(hasForbiddenDestination(["/agents", "/usage"])).toBe(false);
  });

  it("keeps customer auth routes standalone and free of staff prefixes", () => {
    expect(CUSTOMER_AUTH_ROUTES).toEqual([
      "/login",
      "/signup",
      "/forgot-password",
      "/reset-password",
    ]);
    for (const path of CUSTOMER_AUTH_ROUTES) {
      expect(path.startsWith(STAFF_SURFACE_ROOTS.admin)).toBe(false);
      expect(path.startsWith(STAFF_SURFACE_ROOTS.support)).toBe(false);
    }
  });
});
