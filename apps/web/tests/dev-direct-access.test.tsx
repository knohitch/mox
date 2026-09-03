import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { AuthLayout, DEV_DIRECT_ACCESS_SHORTCUTS, DevDirectAccess } from "../src/views/AuthPages.js";
import { isUiStudioAllowed } from "../src/uiStudio/security.js";
import { parseStudioSearch } from "../src/uiStudio/previewNavigation.js";

/**
 * PRODUCT_COMPLETION_01 §A — safe dev direct access.
 *
 * The auth pages keep the development-only shortcut block with explicit,
 * populated UI-Studio fixture URLs for Customer/Admin/Support. Production
 * renders no shortcut, and the /__ui route stays gated by the Studio
 * security policy in every build (no production auth bypass).
 */

const EXPECTED_HREFS = {
  customer: "/__ui?surface=customer&page=/dashboard&state=populated",
  admin: "/__ui?surface=admin&page=dashboard&state=populated&role=superadmin",
  support: "/__ui?surface=support&page=overview&state=populated&role=support_manager",
} as const;

describe("DEV MODE DIRECT ACCESS", () => {
  it("renders the three populated fixture shortcuts in development", () => {
    const html = renderToString(<AuthLayout surface="customer"><div /></AuthLayout>);
    expect(html).toContain("DEV MODE DIRECT ACCESS");
    // renderToString escapes attribute separators (& -> &amp;).
    for (const surface of ["customer", "admin", "support"] as const) {
      expect(html).toContain(EXPECTED_HREFS[surface].replaceAll("&", "&amp;"));
    }
    expect(html).toContain("User Dashboard");
    expect(html).toContain("Admin Dashboard");
    expect(html).toContain("Support Dashboard");
  });

  it("exports the canonical shortcut hrefs used by the auth pages", () => {
    expect(DEV_DIRECT_ACCESS_SHORTCUTS.map((s) => s.href)).toEqual([
      EXPECTED_HREFS.customer,
      EXPECTED_HREFS.admin,
      EXPECTED_HREFS.support,
    ]);
  });

  it("renders nothing outside development", () => {
    const html = renderToString(<DevDirectAccess isDev={false} />);
    expect(html).toBe("");
  });

  it("every shortcut URL parses to a valid populated Studio state", () => {
    const customer = parseStudioSearch(EXPECTED_HREFS.customer.replace("/__ui", ""));
    expect(customer.surface).toBe("customer");
    expect(customer.page).toBe("/dashboard");
    expect(customer.previewState).toBe("populated");

    const admin = parseStudioSearch(EXPECTED_HREFS.admin.replace("/__ui", ""));
    expect(admin.surface).toBe("admin");
    expect(admin.page).toBe("dashboard");
    expect(admin.previewState).toBe("populated");
    expect(admin.role).toBe("superadmin");

    const support = parseStudioSearch(EXPECTED_HREFS.support.replace("/__ui", ""));
    expect(support.surface).toBe("support");
    expect(support.page).toBe("overview");
    expect(support.previewState).toBe("populated");
    expect(support.role).toBe("support_manager");
  });

  it("Studio route stays denied in production regardless of opt-in", () => {
    expect(isUiStudioAllowed({ isDev: false, envStudioFlag: "1", hostname: "localhost" })).toBe(false);
    expect(isUiStudioAllowed({ isDev: false, envStudioFlag: "1", hostname: "mox.example.com" })).toBe(false);
    expect(isUiStudioAllowed({ isDev: true, envStudioFlag: "1", hostname: "mox.example.com" })).toBe(false);
  });
});
