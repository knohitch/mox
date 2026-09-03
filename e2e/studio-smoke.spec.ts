/**
 * Phase 08: Browser E2E smoke tests.
 * Layer 1 — UI Studio smoke: deterministic Customer/Admin/Support coverage.
 * Runs against the dev-only UI Studio with isolated fixtures.
 */
import { test, expect } from "@playwright/test";

// ---- Customer Dashboard ----

test.describe("Customer Dashboard", () => {
  test("loads with populated fixtures", async ({ page }) => {
    await page.goto("/__ui?surface=customer&state=populated");
    await expect(page.locator("h1")).toBeVisible({ timeout: 10_000 });
    // Dashboard should show operational overview
    await expect(page.getByText("Agents")).toBeVisible();
    await expect(page.getByText("Servers")).toBeVisible();
  });

  test("navigates to Agents page", async ({ page }) => {
    await page.goto("/__ui?surface=customer&state=populated");
    await page.getByText("Agents", { exact: false }).first().click();
    await expect(page.locator("h1")).toBeVisible();
  });

  test("navigates to Servers page", async ({ page }) => {
    await page.goto("/__ui?surface=customer&state=populated&page=servers");
    await expect(page.getByText("Servers")).toBeVisible();
    await expect(page.getByText("Provision Server")).toBeVisible();
  });

  test("navigates to Models page", async ({ page }) => {
    await page.goto("/__ui?surface=customer&state=populated&page=models");
    await expect(page.getByText("Models")).toBeVisible();
  });

  test("navigates to Rooms page", async ({ page }) => {
    await page.goto("/__ui?surface=customer&state=populated&page=rooms");
    await expect(page.getByText("Agent Rooms")).toBeVisible();
  });
});

// ---- Admin Dashboard ----

test.describe("Admin Dashboard", () => {
  test("loads with populated fixtures", async ({ page }) => {
    await page.goto("/__ui?surface=admin&state=populated&role=superadmin");
    await expect(page.locator("h1")).toBeVisible({ timeout: 10_000 });
  });

  test("shows Staff & Access for superadmin", async ({ page }) => {
    await page.goto("/__ui?surface=admin&state=populated&role=superadmin&page=staff");
    await expect(page.getByText("Staff")).toBeVisible();
  });
});

// ---- Support Dashboard ----

test.describe("Support Dashboard", () => {
  test("loads with populated fixtures", async ({ page }) => {
    await page.goto("/__ui?surface=support&state=populated&role=support_manager");
    await expect(page.locator("h1")).toBeVisible({ timeout: 10_000 });
  });

  test("shows escalation section for support_manager", async ({ page }) => {
    await page.goto("/__ui?surface=support&state=populated&role=support_manager&page=escalation");
    await expect(page.getByText("Escalation")).toBeVisible();
  });
});

// ---- Theme persistence ----

test.describe("Theme", () => {
  test("light theme renders", async ({ page }) => {
    await page.goto("/__ui?surface=customer&state=populated&theme=light");
    await expect(page.locator("h1")).toBeVisible();
  });

  test("dark theme renders", async ({ page }) => {
    await page.goto("/__ui?surface=customer&state=populated&theme=dark");
    await expect(page.locator("h1")).toBeVisible();
  });
});

// ---- No blank page regression ----

test.describe("No blank pages", () => {
  const routes = [
    "/__ui?surface=customer&state=populated&page=dashboard",
    "/__ui?surface=customer&state=populated&page=agents",
    "/__ui?surface=customer&state=populated&page=servers",
    "/__ui?surface=customer&state=populated&page=rooms",
    "/__ui?surface=customer&state=populated&page=models",
    "/__ui?surface=customer&state=populated&page=usage",
    "/__ui?surface=customer&state=populated&page=billing",
    "/__ui?surface=admin&state=populated&role=superadmin&page=dashboard",
    "/__ui?surface=admin&state=populated&role=superadmin&page=customers",
    "/__ui?surface=support&state=populated&role=support_manager&page=overview",
    "/__ui?surface=support&state=populated&role=support_manager&page=lookup",
  ];

  for (const route of routes) {
    test(`renders landmark on ${route.split("page=")[1] ?? route}`, async ({ page }) => {
      await page.goto(route);
      // Assert at least one heading or landmark exists (no blank page)
      const landmark = page.locator("h1, h2, [role='main'], [role='status'], .empty-state, .admin-kicker").first();
      await expect(landmark).toBeVisible({ timeout: 10_000 });
    });
  }
});
