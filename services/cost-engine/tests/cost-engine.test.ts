import { describe, expect, it } from "vitest";
import { CostEngine } from "../src/service.js";
import { InMemoryCostStore } from "../src/types.js";

const WINDOW = { from: "2026-01-01T00:00:00.000Z", to: "2026-02-01T00:00:00.000Z" };

function makeEngine() {
  const store = new InMemoryCostStore();
  return { store, engine: new CostEngine(store) };
}

describe("cost engine", () => {
  it("computes MRR from recurring revenue only", async () => {
    const { engine } = makeEngine();
    await engine.recordRevenue({ entryId: "r1", recurring: true, amountMinor: 4900n, currency: "USD", at: "2026-01-05T00:00:00.000Z", orgId: "org-1" });
    await engine.recordRevenue({ entryId: "r2", recurring: true, amountMinor: 9900n, currency: "USD", at: "2026-01-10T00:00:00.000Z", orgId: "org-2" });
    // One-time payment excluded from MRR.
    await engine.recordRevenue({ entryId: "r3", recurring: false, amountMinor: 250000n, currency: "USD", at: "2026-01-12T00:00:00.000Z", orgId: "org-3" });
    // Outside window.
    await engine.recordRevenue({ entryId: "r4", recurring: true, amountMinor: 100n, currency: "USD", at: "2026-03-01T00:00:00.000Z", orgId: "org-1" });

    const total = await engine.mrr(undefined, WINDOW);
    expect(total.amountMinor).toBe(14800n);
    const orgOnly = await engine.mrr("org-1", WINDOW);
    expect(orgOnly.amountMinor).toBe(4900n);
  });

  it("reports margin by provider without leaking wholesale cost to customers", async () => {
    const { engine } = makeEngine();
    // Customer pays $49; Contabo wholesale is €20 (~$22) + $2 payment fees.
    await engine.recordRevenue({
      entryId: "rev-1", recurring: true, amountMinor: 4900n, currency: "USD",
      at: "2026-01-06T00:00:00.000Z", orgId: "org-1", planTier: "pro", regionCode: "GLOBAL",
    });
    await engine.recordCost({
      entryId: "c1", category: "vps_cost", amountMinor: 2000n, currency: "EUR",
      at: "2026-01-06T00:00:00.000Z", orgId: "org-1", planTier: "pro", regionCode: "GLOBAL", providerName: "contabo",
    });
    await engine.recordCost({
      entryId: "c2", category: "payment_fees", amountMinor: 200n, currency: "USD",
      at: "2026-01-07T00:00:00.000Z", orgId: "org-1", planTier: "pro", regionCode: "GLOBAL", providerName: "internal",
    });

    const report = await engine.margin({
      dimension: "provider",
      window: WINDOW,
      currency: "USD",
      fxRates: { EUR: 1.1 },
    });
    const contabo = report.rows.find((r) => r.key === "contabo")!;
    expect(contabo.cogsMinor).toBe(2200n); // 2000 * 1.1
    expect(contabo.grossProfitMinor).toBe(-2200n); // revenue booked under 'internal'
    const internal = report.rows.find((r) => r.key === "internal")!;
    expect(internal.revenueMinor).toBe(4900n);
    expect(internal.cogsMinor).toBe(200n);
    // Revenue 4900 − COGS (2200 EUR-converted + 200 fees) = 2500 → ~51.02%.
    expect(report.totals.grossProfitMinor).toBe(2500n);
    expect(report.totals.grossMarginPct).toBeCloseTo(51.02, 1);
  });

  it("groups by org and plan dimensions", async () => {
    const { engine } = makeEngine();
    for (const [i, tier] of ["plus", "pro"].entries()) {
      await engine.recordRevenue({
        entryId: `p${i}`, recurring: true, amountMinor: tier === "pro" ? 4900n : 2000n,
        currency: "USD", at: "2026-01-08T00:00:00.000Z", orgId: `org-${i}`, planTier: tier,
      });
      await engine.recordCost({
        entryId: `pc${i}`, category: "vps_cost", amountMinor: tier === "pro" ? 1500n : 800n,
        currency: "USD", at: "2026-01-08T00:00:00.000Z", orgId: `org-${i}`, planTier: tier,
      });
    }
    const byPlan = await engine.margin({ dimension: "plan", window: WINDOW, currency: "USD", fxRates: {} });
    const pro = byPlan.rows.find((r) => r.key === "pro")!;
    expect(pro.revenueMinor).toBe(4900n);
    expect(pro.cogsMinor).toBe(1500n);
    expect(byPlan.totals.cogsMinor).toBe(2300n);
  });

  it("dedupes re-recorded entries (idempotent ingestion)", async () => {
    const { engine } = makeEngine();
    const entry = {
      entryId: "dup-cost", category: "storage" as const, amountMinor: 500n, currency: "USD",
      at: "2026-01-09T00:00:00.000Z", orgId: "org-d",
    };
    await engine.recordCost(entry);
    await engine.recordCost(entry);
    const report = await engine.margin({ dimension: "org", window: WINDOW, currency: "USD", fxRates: {} });
    expect(report.rows.find((r) => r.key === "org-d")!.cogsMinor).toBe(500n);
  });

  it("requires explicit FX rates instead of guessing", async () => {
    const { engine } = makeEngine();
    await engine.recordCost({
      entryId: "eur-1", category: "backups", amountMinor: 300n, currency: "EUR",
      at: "2026-01-02T00:00:00.000Z", orgId: "org-e",
    });
    await expect(
      engine.margin({ dimension: "org", window: WINDOW, currency: "USD", fxRates: {} }),
    ).rejects.toThrow(/missing FX rate/);
  });
});

