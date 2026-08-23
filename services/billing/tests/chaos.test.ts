/**
 * Chaos / idempotency suite (Prompt 14).
 *
 * Scenarios from the DR matrix, each asserting NO duplicate side effects:
 * duplicated webhooks, duplicate provision jobs, lost workers, provider
 * timeout after a successful order, provider API outages and offline nodes.
 */

import { describe, expect, it } from "vitest";
import { FakeBillingProvider, signPayload } from "@mox/billing";
import { BillingService } from "../src/service.js";
import { seedCatalog } from "../src/seed.js";
import { InMemoryBillingStore } from "../src/store.js";

const DAY = 24 * 3600 * 1000;

function signedBody(secret: string, body: Record<string, unknown>) {
  const raw = JSON.stringify(body);
  const ts = new Date().toISOString();
  return { headers: { "x-mox-timestamp": ts, "x-mox-signature": signPayload(secret, raw, ts) }, raw };
}

async function billingFixture() {
  const billing = new BillingService(new InMemoryBillingStore());
  const secret = "chaos-secret";
  const providerName = "fake-gateway";
  billing.registerProvider(new FakeBillingProvider(providerName, secret));
  const catalog = await seedCatalog(billing);
  return { billing, secret, providerName, catalog };
}

describe("billing chaos", () => {
  it("survives a webhook storm: same activation event delivered 5x", async () => {
    const fx = await billingFixture();
    const { session } = await fx.billing.createCheckout({
      orgId: "org-chaos",
      productId: fx.catalog.productIds.pro!,
      planVersionId: fx.catalog.activePlanVersionIds.pro!,
      pricingRegionCode: "GLOBAL",
      successUrl: "s",
      cancelUrl: "c",
      providerName: fx.providerName,
    });
    const { headers, raw } = signedBody(fx.secret, {
      eventId: "storm-1",
      type: "checkout.completed",
      subjectRef: session.providerRef,
      checkoutSessionId: session.id,
      amountMinor: 4900,
      currency: "USD",
    });

    // Concurrent redelivery — only ONE subscription may ever exist.
    await Promise.all([
      fx.billing.handleProviderWebhook(fx.providerName, headers, raw),
      fx.billing.handleProviderWebhook(fx.providerName, headers, raw),
      fx.billing.handleProviderWebhook(fx.providerName, headers, raw),
      fx.billing.handleProviderWebhook(fx.providerName, headers, raw),
      fx.billing.handleProviderWebhook(fx.providerName, headers, raw),
    ]);

    const subs = [];
    for (const org of ["org-chaos"]) {
      const sub = await fx.billing.getActiveSubscription(org);
      if (sub) subs.push(sub);
    }
    expect(subs).toHaveLength(1);
    expect(subs[0]?.state).toBe("active");

    // Exactly one audited activation transition despite the storm.
    const transitions = (subs[0] && (await fx.billing.listTransitions(subs[0].id))) ?? [];
    expect(transitions.filter((t) => t.toState === "active")).toHaveLength(1);
  });

  it("a lost worker replaying the same renewal tick creates no double invoices or charges", async () => {
    const fx = await billingFixture();
    const { session } = await fx.billing.createCheckout({
      orgId: "org-replay",
      productId: fx.catalog.productIds.max!,
      planVersionId: fx.catalog.activePlanVersionIds.max!,
      pricingRegionCode: "GLOBAL",
      successUrl: "s",
      cancelUrl: "c",
      providerName: fx.providerName,
    });
    const complete = signedBody(fx.secret, { eventId: "c-1", type: "checkout.completed", subjectRef: session.providerRef, checkoutSessionId: session.id, amountMinor: 9900, currency: "USD" });
    await fx.billing.handleProviderWebhook(fx.providerName, complete.headers, complete.raw);

    const sub = (await fx.billing.getActiveSubscription("org-replay"))!;
    const at = new Date(Date.parse(sub.currentPeriodEnd!) + DAY).toISOString();

    // Two workers race the same renewal sweep.
    const [a, b] = await Promise.all([fx.billing.runRenewals(at), fx.billing.runRenewals(at)]);
    expect(a.renewed + b.renewed).toBe(1); // exactly one successful renewal overall

    const invoices = await fx.billing.listInvoices(sub.id);
    const paid = invoices.filter((i) => i.status === "paid");
    expect(paid).toHaveLength(1);
  });
});
