import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BillingService } from "../src/service.js";
import { StripeProvider } from "../src/providers/stripe.js";
import { InMemoryBillingStore } from "../src/store.js";

const WHSEC = "whsec_security_repair_07";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function stripeRefundEvent(eventId: string, chargeId: string, paymentIntentId: string, amountRefunded: number) {
  const ts = Math.floor(Date.now() / 1000);
  const raw = JSON.stringify({
    id: eventId,
    type: "charge.refunded",
    created: ts,
    livemode: false,
    data: {
      object: {
        id: chargeId,
        payment_intent: paymentIntentId,
        amount_refunded: amountRefunded,
        currency: "usd",
      },
    },
  });
  const signature = createHmac("sha256", WHSEC).update(`${ts}.${raw}`).digest("hex");
  return { raw, headers: { "stripe-signature": `t=${ts},v1=${signature}` } };
}

async function refundFixture(orgId = "org-refund-r07") {
  const store = new InMemoryBillingStore();
  const billing = new BillingService(store);
  billing.registerProvider(new StripeProvider({
    environment: "test",
    secretKey: "sk_test_security_repair_07",
    webhookSecret: WHSEC,
    fetchImpl: async () => jsonResponse(200, { id: "unused" }),
  }));

  const product = await billing.createProduct({ code: `r07-${orgId}`, tier: "plus", displayName: "Repair 07" });
  const plan = await billing.createPlanVersion(product.id, 1);
  await billing.activatePlanVersion(plan.id);
  await billing.definePricingRegion({ code: `R07-${orgId}`, displayName: "Repair 07", chargeCurrency: "USD", displayCurrency: "USD" });
  const book = await billing.upsertPriceBook({ productId: product.id, pricingRegionCode: `R07-${orgId}`, mode: "fixed" });
  const price = await billing.addFixedPriceVersion(book.id, 10_000n, "USD", "2020-01-01T00:00:00.000Z");
  const subscription = await store.createSubscription({
    id: `sub-local-${orgId}`,
    orgId,
    planVersionId: plan.id,
    priceVersionId: price.id,
    state: "active",
    providerName: "stripe",
    providerEnvironment: "test",
    providerRef: `sub-provider-${orgId}`,
    currentPeriodStart: "2026-08-01T00:00:00.000Z",
    currentPeriodEnd: "2026-09-01T00:00:00.000Z",
    failedRenewals: 0,
    cancelAtPeriodEnd: false,
    createdAt: "2026-08-01T00:00:00.000Z",
  });
  const paymentIntentId = `pi-${orgId}`;
  const chargeId = `ch-${orgId}`;
  await store.upsertProviderObjectMapping({
    id: `map-${orgId}`,
    providerName: "stripe",
    environment: "test",
    orgId,
    subscriptionId: subscription.id,
    providerSubscriptionRef: subscription.providerRef,
    providerPaymentIntentRef: paymentIntentId,
    resolutionState: "resolved",
  });
  return { billing, store, subscription, paymentIntentId, chargeId };
}

async function applyRefund(
  fx: Awaited<ReturnType<typeof refundFixture>>,
  eventId: string,
  amountRefunded: number,
) {
  const event = stripeRefundEvent(eventId, fx.chargeId, fx.paymentIntentId, amountRefunded);
  return fx.billing.handleProviderWebhook("stripe", event.headers, event.raw);
}

describe("Security Repair 07 — Stripe cumulative refund authority", () => {
  it("B1: advances 3000 → 10000 for one charge and suspends only at full refund", async () => {
    const fx = await refundFixture("org-b1");
    const partial = await applyRefund(fx, "evt-b1-3000", 3000);
    expect(partial.applied).toBe(true);
    expect((await fx.store.getSubscription(fx.subscription.id))?.state).toBe("active");

    const full = await applyRefund(fx, "evt-b1-10000", 10_000);
    expect(full.applied).toBe(true);
    const sub = await fx.store.getSubscription(fx.subscription.id);
    expect(sub?.state).toBe("suspended");
    expect(sub?.suspensionSource).toBe("refund");
    expect(sub?.suspensionReason).toBe("full_refund_processed");
    expect((await fx.billing.dequeueCommercialReconciliations(10)).map((q) => q.subscriptionId)).toContain(sub!.id);
  });

  it("B2: identical 3000 cumulative state replay is idempotent", async () => {
    const fx = await refundFixture("org-b2");
    expect((await applyRefund(fx, "evt-b2-a", 3000)).applied).toBe(true);
    const replay = await applyRefund(fx, "evt-b2-b", 3000);
    expect(replay.duplicate).toBe(true);
    expect((await fx.store.getSubscription(fx.subscription.id))?.state).toBe("active");
  });

  it("B3: 3000 → 6000 → 10000 converges monotonically", async () => {
    const fx = await refundFixture("org-b3");
    expect((await applyRefund(fx, "evt-b3-3", 3000)).applied).toBe(true);
    expect((await applyRefund(fx, "evt-b3-6", 6000)).applied).toBe(true);
    expect((await applyRefund(fx, "evt-b3-10", 10_000)).applied).toBe(true);
    const state = await fx.store.advanceProviderRefundState({
      providerName: "stripe",
      environment: "test",
      billingIdentity: `charge:${fx.chargeId}`,
      subscriptionId: fx.subscription.id,
      cumulativeAmountMinor: 6000n,
      externalEventId: "probe-lower",
    });
    expect(state.advanced).toBe(false);
    expect(state.state.cumulativeAmountMinor).toBe(10_000n);
    expect((await fx.store.getSubscription(fx.subscription.id))?.state).toBe("suspended");
  });

  it("B4: full-refund replay does not duplicate suspension or reconciliation", async () => {
    const fx = await refundFixture("org-b4");
    expect((await applyRefund(fx, "evt-b4-a", 10_000)).applied).toBe(true);
    const replay = await applyRefund(fx, "evt-b4-b", 10_000);
    expect(replay.duplicate).toBe(true);
    const transitions = await fx.store.listTransitions(fx.subscription.id);
    expect(transitions.filter((t) => t.idempotencyKey === `refund-full:charge:${fx.chargeId}`)).toHaveLength(1);
    expect((await fx.billing.dequeueCommercialReconciliations(10)).filter((q) => q.subscriptionId === fx.subscription.id)).toHaveLength(1);
  });

  it("B5: concurrent cumulative updates preserve the durable maximum and full suspension", async () => {
    const fx = await refundFixture("org-b5");
    await Promise.all([
      applyRefund(fx, "evt-b5-3", 3000),
      applyRefund(fx, "evt-b5-6", 6000),
      applyRefund(fx, "evt-b5-10", 10_000),
    ]);
    const probe = await fx.store.advanceProviderRefundState({
      providerName: "stripe",
      environment: "test",
      billingIdentity: `charge:${fx.chargeId}`,
      subscriptionId: fx.subscription.id,
      cumulativeAmountMinor: 1n,
      externalEventId: "probe",
    });
    expect(probe.state.cumulativeAmountMinor).toBe(10_000n);
    expect((await fx.store.getSubscription(fx.subscription.id))?.state).toBe("suspended");
    expect((await fx.store.listTransitions(fx.subscription.id)).filter((t) => t.idempotencyKey === `refund-full:charge:${fx.chargeId}`)).toHaveLength(1);
  });
});
