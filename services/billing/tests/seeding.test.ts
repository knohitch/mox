import { describe, expect, it } from "vitest";
import { BillingService } from "../src/service.js";
import { seedCatalog } from "../src/seed.js";
import { InMemoryBillingStore } from "../src/store.js";

/**
 * Catalog seeding idempotency (retained-branch rescue, Part B): calling
 * seedCatalog() twice against the same authoritative store must succeed both
 * times, reuse the same logical products and plan version 1, avoid
 * (product, version=1) uniqueness violations, avoid duplicate identical
 * GLOBAL USD anchor prices, and preserve pre-existing catalog data.
 */
describe("billing catalog seed idempotency", () => {
  it("reuses products, plan version 1 and the GLOBAL USD anchor on a second seed", async () => {
    const billing = new BillingService(new InMemoryBillingStore());

    const first = await seedCatalog(billing);
    const second = await seedCatalog(billing);

    // Logical product identifiers are reused.
    expect(second.productIds).toEqual(first.productIds);

    // Plan version 1 identifiers are reused and stay active.
    expect(second.activePlanVersionIds).toEqual(first.activePlanVersionIds);

    // No duplicate (product, version = 1): exactly one v1 per product.
    for (const productId of Object.values(first.productIds)) {
      const versions = await billing.store.listPlanVersions(productId);
      expect(versions.filter((v) => v.version === 1)).toHaveLength(1);
      expect(versions[0]?.status).toBe("active");
    }

    // No unnecessary duplicate identical GLOBAL USD anchor price: exactly one
    // USD price version at the anchor amount per product.
    const PRICES: Record<string, number> = { plus: 2000, pro: 4900, max: 9900, enterprise: 29900 };
    for (const code of Object.keys(first.productIds)) {
      expect((second.priceVersionIdsByRegion[code] ?? {}).GLOBAL).toBe(
        (first.priceVersionIdsByRegion[code] ?? {}).GLOBAL,
      );
    }

    // Regional price books are repeatable and unchanged.
    for (const code of Object.keys(first.productIds)) {
      const book = await billing.store.findPriceBook(first.productIds[code]!, "GLOBAL");
      expect(book).toBeDefined();
      const versions = await billing.store.listPriceVersions(book!.id);
      expect(versions).toHaveLength(1);
      expect(versions[0]!.amountMinor).toBe(PRICES[code]!);
      expect(versions[0]!.currency).toBe("USD");
    }
  });

  it("preserves pre-existing catalog data across repeated seeding", async () => {
    const billing = new BillingService(new InMemoryBillingStore());
    await seedCatalog(billing);

    // Pre-existing catalog data: a product, plan v1 and GLOBAL USD price
    // created by an unrelated flow before the second seed.
    const legacy = await billing.createProduct({ code: "legacy_pack", tier: "pro", displayName: "Legacy Pack" });
    const legacyPlan = await billing.createPlanVersion(legacy.id, 1);
    await billing.activatePlanVersion(legacyPlan.id);
    const legacyBook = await billing.upsertPriceBook({
      productId: legacy.id,
      pricingRegionCode: "GLOBAL",
      mode: "fixed",
    });
    const legacyPrice = await billing.addFixedPriceVersion(legacyBook.id, 12345, "USD");

    const second = await seedCatalog(billing);

    // Pre-existing rows are intact.
    expect(await billing.store.getPlanVersion(legacyPlan.id)).toMatchObject({ status: "active", version: 1 });
    expect(await billing.store.getPriceVersion(legacyPrice.id)).toMatchObject({ amountMinor: 12345, currency: "USD" });
    expect(await billing.store.getProduct(legacy.id)).toBeDefined();

    // Seeding did not add duplicates to the seeded products either.
    for (const productId of Object.values(second.productIds)) {
      const versions = await billing.store.listPlanVersions(productId);
      expect(versions.filter((v) => v.version === 1)).toHaveLength(1);
    }
  });
});