/**
 * Default commercial catalog (Prompt 08). Plans and limits are data:
 * admin-editable, never hard-coded into feature code.
 */

import type { BillingService } from "./service.js";

export const DEFAULT_PLAN_CODES = ["plus", "pro", "max", "enterprise"] as const;

export interface SeedOptions {
  /** Base USD minor units per plan; regional books derive from these. */
  basePricesMinor?: Record<string, number>;
}

const DEFAULT_PRICES: Record<string, number> = {
  plus: 2000,
  pro: 4900,
  max: 9900,
  enterprise: 29900,
};

export interface SeededCatalog {
  productIds: Record<string, string>;
  activePlanVersionIds: Record<string, string>;
  priceVersionIdsByRegion: Record<string, Record<string, string>>;
}

/** Seeds products, v1 plan versions, regions and price books. Idempotent. */
export async function seedCatalog(billing: BillingService, options: SeedOptions = {}): Promise<SeededCatalog> {
  const basePrices = options.basePricesMinor ?? DEFAULT_PRICES;
  const productIds: Record<string, string> = {};
  const planVersions: Record<string, string> = {};
  const priceVersionIdsByRegion: Record<string, Record<string, string>> = {};

  for (const tier of ["GLOBAL", "UK", "NG", "GH"]) {
    await billing.definePricingRegion({
      code: tier,
      displayName: tier,
      chargeCurrency: tier === "UK" ? "GBP" : tier === "NG" ? "NGN" : tier === "GH" ? "GHS" : "USD",
      displayCurrency: tier === "UK" ? "GBP" : tier === "NG" ? "NGN" : tier === "GH" ? "GHS" : "USD",
    });
  }

  for (const code of DEFAULT_PLAN_CODES) {
    const product = await billing.createProduct({ code, tier: code as "plus", displayName: `Mox ${code}` });
    productIds[code] = product.id;

    const version = await billing.createPlanVersion(product.id, 1);
    await billing.activatePlanVersion(version.id);
    planVersions[code] = version.id;

    // USD anchor book (fixed) + FX-derived books for other regions.
    const usdBook = await billing.upsertPriceBook({
      productId: product.id,
      pricingRegionCode: "GLOBAL",
      mode: "fixed",
    });
    const usdPrice = await billing.addFixedPriceVersion(usdBook.id, basePrices[code]!, "USD");
    (priceVersionIdsByRegion[code] ??= {}).GLOBAL = usdPrice.id;

    const ukRates: Record<string, number> = { plus: 0.79, pro: 0.79, max: 0.79, enterprise: 0.82 };
    const ukBook = await billing.upsertPriceBook({
      productId: product.id,
      pricingRegionCode: "UK",
      mode: "fx_derived",
      baseCurrency: "USD",
      baseAmountMinor: basePrices[code]!,
      fxRate: ukRates[code],
    });
    void ukBook;

    const ngnBook = await billing.upsertPriceBook({
      productId: product.id,
      pricingRegionCode: "NG",
      mode: "fx_derived",
      baseCurrency: "USD",
      baseAmountMinor: basePrices[code]!,
      fxRate: 1550,
    });
    void ngnBook;

    const ghsBook = await billing.upsertPriceBook({
      productId: product.id,
      pricingRegionCode: "GH",
      mode: "fx_derived",
      baseCurrency: "USD",
      baseAmountMinor: basePrices[code]!,
      fxRate: 15.2,
    });
    void ghsBook;
  }

  for (const addon of [
    { code: "extra_vps", displayName: "Additional VPS node", consumable: false, unit: "node" },
    { code: "larger_compute", displayName: "Larger compute class", consumable: false, unit: "class" },
    { code: "storage_100gb", displayName: "100 GB storage", consumable: false, unit: "100gb" },
    { code: "backup_pack", displayName: "Backup pack", consumable: false, unit: "pack" },
    { code: "ai_credits_1k", displayName: "1k Mox AI credits", consumable: true, unit: "credits" },
    { code: "messaging_pack", displayName: "Messaging volume pack", consumable: true, unit: "messages" },
    { code: "voice_minutes_100", displayName: "100 voice minutes", consumable: true, unit: "minutes" },
    { code: "team_seat", displayName: "Additional team seat", consumable: false, unit: "seat" },
  ]) {
    await billing.defineAddon(addon);
  }

  return { productIds, activePlanVersionIds: planVersions, priceVersionIdsByRegion };
}
