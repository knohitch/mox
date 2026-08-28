/**
 * Pure, testable billing formatting/derivation for the customer surface
 * (Phase 03 §A). No network, no components — the views delegate ALL money
 * formatting to these helpers so the "amount is integer minor units" rule
 * cannot be violated in JSX.
 */

import type { PlanOption, PlanPricingRegion, SubscriptionView } from "../api/types.js";

/** ISO 4217 exponent map; anything unknown falls back to 2 decimals. */
const CURRENCY_EXPONENTS: Record<string, number> = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  NGN: 2,
  JPY: 0,
  KRW: 0,
  VND: 0,
};

export function moneyMinorToDisplay(amountMinor: number, currency: string): string {
  const exponent = CURRENCY_EXPONENTS[currency.toUpperCase()] ?? 2;
  const value = amountMinor / 10 ** exponent;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
  }).format(value);
}

/** Best (cheapest available) region price for a plan, if any. */
export function bestPlanPrice(
  plan: PlanOption,
): { pricingRegionCode: string; displayName: string; amountMinor: number; currency: string } | null {
  let best: PlanPricingRegion | null = null;
  for (const region of plan.pricingRegions) {
    if (!region.available || region.amountMinor === null) continue;
    if (!best || (region.amountMinor ?? Infinity) < (best.amountMinor ?? Infinity)) best = region;
  }
  return best ? { pricingRegionCode: best.pricingRegionCode, displayName: best.displayName, amountMinor: best.amountMinor ?? 0, currency: best.currency } : null;
}

export type CommercialStatus =
  | "active"
  | "canceled"
  | "trial"
  | "grace"
  | "past_due"
  | "suspended"
  | "denied"
  | "none";

/** Derive a single commercial-eligibility status from the subscription view. */
export function commercialStatus(sub: SubscriptionView | null): CommercialStatus {
  if (!sub) return "none";
  if (!sub.commercialAccess.entitled) {
    if (sub.state === "suspended") return "suspended";
    return "denied";
  }
  switch (sub.state) {
    case "active":
      return sub.cancelAtPeriodEnd ? "canceled" : "active";
    case "trial":
      return "trial";
    case "grace_period":
      return "grace";
    case "past_due":
      return "past_due";
    case "suspended":
      return "suspended";
    default:
      return "denied";
  }
}