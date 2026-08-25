/**
 * Security Repair 05A mandatory regression suite.
 *
 * Covers the independently confirmed payment/billing/webhook/lifecycle/
 * crash-consistency/provider-state findings A–I at the service level:
 *
 *  A. Stripe refund/chargeback binding through durable provider-object
 *     mappings (charge/pi/invoice → subscription), full/partial refund
 *     policy, dispute lifecycle.
 *  B. Stripe invoice sibling events (invoice.paid + invoice.payment_succeeded
 *     for the SAME invoice) create exactly ONE period extension.
 *  C. Stripe lifecycle semantics (checkout async events, subscription.updated
 *     states, currency canonicalization, plan-change safety).
 *  D. PayPal lifecycle correctness (no entitlement from APPROVED/ACTIVATED,
 *     sale-completed exactly-once, SUSPENDED is recoverable and never a
 *     destructive remote cancel, RE-ACTIVATED requires reconciliation).
 *  E. Checkout crash consistency: fault injection after every local write
 *     step proves replay converges to exactly one subscription/item/
 *     transition.
 *  F. Ordering: older real refunds still reconcile, missing-time successes
 *     cannot resurrect refunded state, ambiguous events are persisted as
 *     reconciliation_required — never finalized as applied.
 *  G. Webhook abuse: identical invalid bodies dedupe, rejected junk purges
 *     with a short TTL, applied financial history is retained.
 *  H. Cancellation consistency: transient remote failure → durable
 *     reconciliation_required + idempotent retry; ambiguous mapping never
 *     guessed.
 *  I. Admin reactivation of refund/dispute suspensions requires explicit
 *     financial reconciliation.
 */

import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BillingService } from "../src/service.js";
import { FakeBillingProvider, signPayload, type BillingProvider, type ProviderEvent } from "../src/provider.js";
import { StripeProvider } from "../src/providers/stripe.js";
import { PayPalProvider } from "../src/providers/paypal.js";
import { InMemoryBillingStore, type BillingStore } from "../src/store.js";
import { seedCatalog } from "../src/seed.js";

const DAY = 24 * 3600 * 1000;

function signedBody(secret: string, body: Record<string, unknown>) {
  const raw = JSON.stringify(body);
  const ts = new Date().toISOString();
  return { headers: { "x-mox-timestamp": ts, "x-mox-signature": signPayload(secret, raw, ts) }, raw };
}

async function fakeFixture(plan = "plus") {
  const billing = new BillingService(new InMemoryBillingStore());
  const secret = "test-webhook-secret";
  const providerName = "fake-gateway";
  billing.registerProvider(new FakeBillingProvider(providerName, secret));
  const catalog = await seedCatalog(billing);
  return { billing, secret, providerName, catalog };
}

async function checkoutSession(billing: BillingService, providerName: string, orgId: string, productId: string, planVersionId: string, amountMinor: number) {
  const { session } = await billing.createCheckout({
    orgId,
    productId,
    planVersionId,
    pricingRegionCode: "GLOBAL",
    successUrl: "https://app.test/s",
    cancelUrl: "https://app.test/c",
    providerName,
  });
  const price = await billing.store.getPriceVersion(session.priceVersionId);
  expect(BigInt(price!.amountMinor)).toBe(BigInt(amountMinor));
  return session;
}

// ---------------------------------------------------------------------------
// Stripe adapter + service integration
// ---------------------------------------------------------------------------

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const WHSEC = "whsec_test_05a";

function stripeEvent(id: string, type: string, object: Record<string, unknown>, ts = Math.floor(Date.now() / 1000)) {
  const body = JSON.stringify({ id, type, created: ts, livemode: false, data: { object } });
  const v1 = createHmac("sha256", WHSEC).update(`${ts}.${body}`).digest("hex");
  return { headers: { "stripe-signature": `t=${ts},v1=${v1}` }, raw: body };
}

async function stripeFixture() {
  const store = new InMemoryBillingStore();
  const billing = new BillingService(store);
  const stripe = new StripeProvider({
    environment: "test",
    secretKey: "sk_test_05a",
    webhookSecret: WHSEC,
    fetchImpl: async () => jsonResponse(200, { id: "cs_ignored", object: "checkout_session", url: "https://checkout.stripe.com/ignored" }),
  });
  billing.registerProvider(stripe);
  const catalog = await seedCatalog(billing);
  return { billing, stripe, catalog };
}

describe("Security Repair 05A — Stripe", () => {
  it("real-shaped paid checkout canonicalizes lowercase currency and activates", async () => {
    const fx = await stripeFixture();
    const product = await fx.billing.store.getProductByCode("plus");
    const planVersion = (await fx.billing.store.listPlanVersions(product!.id))[0];
    const { session } = await fx.billing.createCheckout({
      orgId: "org-a1",
      productId: product!.id,
      planVersionId: planVersion!.id,
      pricingRegionCode: "GLOBAL",
      successUrl: "https://app.test/s",
      cancelUrl: "https://app.test/c",
      providerName: "stripe",
    });
    const evt = stripeEvent("evt_cs_1", "checkout.session.completed", {
      id: session.providerRef,
      subscription: "sub_1",
      customer: "cus_1",
      payment_intent: "pi_1",
      amount_total: 2000,
      currency: "usd", // lowercase must canonicalize to USD
      mode: "subscription",
      payment_status: "paid",
    });
    const result = await fx.billing.handleProviderWebhook("stripe", evt.headers, evt.raw);
    expect(result.applied).toBe(true);
    const sub = await fx.billing.getActiveSubscription("org-a1");
    expect(sub?.state).toBe("active");
    expect(sub?.providerRef).toBe("sub_1");
    // Durable mapping: checkout session + subscription + payment intent.
    const mappings = await fx.billing.store.findProviderObjectMappings("stripe", "test", {
      checkoutSessionRef: session.providerRef,
    });
    expect(mappings).toHaveLength(1);
    expect(mappings[0]?.providerSubscriptionRef).toBe("sub_1");
    expect(mappings[0]?.providerPaymentIntentRef).toBe("pi_1");
    expect(mappings[0]?.subscriptionId).toBe(sub!.id);
  });

  it("charge refund resolves through persisted provider-object mapping and suspends", async () => {
    const fx = await stripeFixture();
    const product = await fx.billing.store.getProductByCode("plus");
    const planVersion = (await fx.billing.store.listPlanVersions(product!.id))[0];
    const { session } = await fx.billing.createCheckout({
      orgId: "org-a2",
      productId: product!.id,
      planVersionId: planVersion!.id,
      pricingRegionCode: "GLOBAL",
      successUrl: "s",
      cancelUrl: "c",
      providerName: "stripe",
    });
    const done = stripeEvent("evt_cs_2", "checkout.session.completed", {
      id: session.providerRef,
      subscription: "sub_2",
      customer: "cus_2",
      payment_intent: "pi_2",
      amount_total: 2000,
      currency: "usd",
      mode: "subscription",
      payment_status: "paid",
    });
    await fx.billing.handleProviderWebhook("stripe", done.headers, done.raw);

    // charge.refunded carries ONLY the charge + payment intent — the
    // subscription ref is resolved through the durable mapping.
    const refund = stripeEvent("evt_ref_1", "charge.refunded", {
      id: "ch_2",
      payment_intent: "pi_2",
      invoice: "in_2",
      customer: "cus_2",
      amount_refunded: 2000,
      currency: "usd",
    });
    const result = await fx.billing.handleProviderWebhook("stripe", refund.headers, refund.raw);
    expect(result.applied).toBe(true);
    const sub = await fx.billing.getActiveSubscription("org-a2");
    expect(sub?.state).toBe("suspended");
    expect(sub?.suspensionSource).toBe("refund");
    expect(sub?.suspensionReason).toBe("full_refund_processed");
    // Commercial reconciliation is queued, never performed synchronously.
    const queued = await fx.billing.dequeueCommercialReconciliations(10);
    expect(queued.some((q) => q.subscriptionId === sub!.id)).toBe(true);
  });

  it("dispute-created resolves through the mapping and suspends the correct subscription", async () => {
    const fx = await stripeFixture();
    const product = await fx.billing.store.getProductByCode("pro");
    const planVersion = (await fx.billing.store.listPlanVersions(product!.id))[0];
    const { session } = await fx.billing.createCheckout({
      orgId: "org-a3",
      productId: product!.id,
      planVersionId: planVersion!.id,
      pricingRegionCode: "GLOBAL",
      successUrl: "s",
      cancelUrl: "c",
      providerName: "stripe",
    });
    await fx.billing.handleProviderWebhook("stripe", stripeEvent("evt_cs_3", "checkout.session.completed", {
      id: session.providerRef,
      subscription: "sub_3",
      customer: "cus_3",
      payment_intent: "pi_3",
      amount_total: 4900,
      currency: "usd",
      mode: "subscription",
      payment_status: "paid",
    }).headers, stripeEvent("evt_cs_3", "checkout.session.completed", {
      id: session.providerRef,
      subscription: "sub_3",
      customer: "cus_3",
      payment_intent: "pi_3",
      amount_total: 4900,
      currency: "usd",
      mode: "subscription",
      payment_status: "paid",
    }).raw);

    const dispute = stripeEvent("evt_disp_1", "charge.dispute.created", {
      id: "dp_3",
      charge: "ch_3",
      payment_intent: "pi_3",
      amount: 4900,
      currency: "usd",
    });
    const result = await fx.billing.handleProviderWebhook("stripe", dispute.headers, dispute.raw);
    expect(result.applied).toBe(true);
    const sub = await fx.billing.getActiveSubscription("org-a3");
    expect(sub?.state).toBe("suspended");
    expect(sub?.suspensionSource).toBe("dispute");
  });

  it("partial refund follows the documented policy: access preserved + reconciliation flag", async () => {
    const fx = await stripeFixture();
    const product = await fx.billing.store.getProductByCode("plus");
    const planVersion = (await fx.billing.store.listPlanVersions(product!.id))[0];
    const { session } = await fx.billing.createCheckout({
      orgId: "org-a4",
      productId: product!.id,
      planVersionId: planVersion!.id,
      pricingRegionCode: "GLOBAL",
      successUrl: "s",
      cancelUrl: "c",
      providerName: "stripe",
    });
    const done = stripeEvent("evt_cs_4", "checkout.session.completed", {
      id: session.providerRef,
      subscription: "sub_4",
      customer: "cus_4",
      payment_intent: "pi_4",
      amount_total: 2000,
      currency: "usd",
      mode: "subscription",
      payment_status: "paid",
    });
    await fx.billing.handleProviderWebhook("stripe", done.headers, done.raw);

    const partial = stripeEvent("evt_ref_part", "charge.refunded", {
      id: "ch_4",
      payment_intent: "pi_4",
      invoice: "in_4",
      amount_refunded: 500,
      currency: "usd",
    });
    const result = await fx.billing.handleProviderWebhook("stripe", partial.headers, partial.raw);
    expect(result.applied).toBe(true);
    const sub = await fx.billing.getActiveSubscription("org-a4");
    expect(sub?.state).toBe("active");
    expect(sub?.reconciliationRequired).toBe(true);
  });

  it("invoice.paid + invoice.payment_succeeded for the SAME invoice extend the period exactly once", async () => {
    const fx = await stripeFixture();
    const product = await fx.billing.store.getProductByCode("plus");
    const planVersion = (await fx.billing.store.listPlanVersions(product!.id))[0];
    const { session } = await fx.billing.createCheckout({
      orgId: "org-b1",
      productId: product!.id,
      planVersionId: planVersion!.id,
      pricingRegionCode: "GLOBAL",
      successUrl: "s",
      cancelUrl: "c",
      providerName: "stripe",
    });
    const done = stripeEvent("evt_cs_b1", "checkout.session.completed", {
      id: session.providerRef,
      subscription: "sub_b1",
      customer: "cus_b1",
      payment_intent: "pi_b1",
      amount_total: 2000,
      currency: "usd",
      mode: "subscription",
      payment_status: "paid",
    });
    await fx.billing.handleProviderWebhook("stripe", done.headers, done.raw);
    const before = (await fx.billing.getActiveSubscription("org-b1"))!;
    const firstEnd = before.currentPeriodEnd!;

    const invoice = { id: "in_b1", subscription: "sub_b1", customer: "cus_b1", payment_intent: "pi_b1", amount_paid: 2000, amount_due: 2000, currency: "usd" };
    const paid = await fx.billing.handleProviderWebhook(
      "stripe",
      stripeEvent("evt_invoice_paid_1", "invoice.paid", invoice).headers,
      stripeEvent("evt_invoice_paid_1", "invoice.paid", invoice).raw,
    );
    expect(paid.applied).toBe(true);

    const afterPaid = (await fx.billing.getActiveSubscription("org-b1"))!;
    expect(afterPaid.currentPeriodEnd).not.toBe(firstEnd);

    // Sibling event type, SAME invoice, DIFFERENT webhook event id.
    const sibling = await fx.billing.handleProviderWebhook(
      "stripe",
      stripeEvent("evt_invoice_succeeded_1", "invoice.payment_succeeded", invoice).headers,
      stripeEvent("evt_invoice_succeeded_1", "invoice.payment_succeeded", invoice).raw,
    );
    expect(sibling.applied).toBe(false);
    expect(sibling.duplicate).toBe(true);
    const afterSibling = (await fx.billing.getActiveSubscription("org-b1"))!;
    expect(afterSibling.currentPeriodEnd).toBe(afterPaid.currentPeriodEnd);

    // Duplicate same event id again → still one effect.
    const replay = await fx.billing.handleProviderWebhook(
      "stripe",
      stripeEvent("evt_invoice_paid_1", "invoice.paid", invoice).headers,
      stripeEvent("evt_invoice_paid_1", "invoice.paid", invoice).raw,
    );
    expect(replay.duplicate).toBe(true);
    expect((await fx.billing.getActiveSubscription("org-b1"))!.currentPeriodEnd).toBe(afterPaid.currentPeriodEnd);
  });

  it("subscription.updated is handled intentionally: past_due, pause, and unmapped-plan safety", async () => {
    const fx = await stripeFixture();
    const product = await fx.billing.store.getProductByCode("plus");
    const planVersion = (await fx.billing.store.listPlanVersions(product!.id))[0];
    const priceVersion = (await fx.billing.store.listPriceVersions((await fx.billing.store.findPriceBook(product!.id, "GLOBAL"))!.id))[0];
    const { session } = await fx.billing.createCheckout({
      orgId: "org-c1",
      productId: product!.id,
      planVersionId: planVersion!.id,
      pricingRegionCode: "GLOBAL",
      successUrl: "s",
      cancelUrl: "c",
      providerName: "stripe",
    });
    const done = stripeEvent("evt_cs_c1", "checkout.session.completed", {
      id: session.providerRef,
      subscription: "sub_c1",
      customer: "cus_c1",
      payment_intent: "pi_c1",
      amount_total: 2000,
      currency: "usd",
      mode: "subscription",
      payment_status: "paid",
    });
    await fx.billing.handleProviderWebhook("stripe", done.headers, done.raw);
    const sub = (await fx.billing.getActiveSubscription("org-c1"))!;

    // past_due → recoverable past_due state.
    const pastDue = stripeEvent("evt_upd_pastdue", "customer.subscription.updated", {
      id: "sub_c1",
      customer: "cus_c1",
      status: "past_due",
      cancel_at_period_end: false,
      items: { data: [{ price: { id: "price_known" } }] },
    });
    const pd = await fx.billing.handleProviderWebhook("stripe", pastDue.headers, pastDue.raw);
    expect(pd.applied).toBe(true);
    expect((await fx.billing.getActiveSubscription("org-c1"))!.state).toBe("past_due");

    // An unmapped provider plan must NOT remap Mox plan authority.
    const remap = stripeEvent("evt_upd_remap", "customer.subscription.updated", {
      id: "sub_c1",
      customer: "cus_c1",
      status: "active",
      cancel_at_period_end: false,
      items: { data: [{ price: { id: "price_unmapped" } }] },
    });
    await fx.billing.handleProviderWebhook("stripe", remap.headers, remap.raw);
    const afterRemap = await fx.billing.getSubscription(sub.id);
    expect(afterRemap.reconciliationRequired).toBe(true);
    expect(afterRemap.planVersionId).toBe(sub.planVersionId); // never remapped
    expect(afterRemap.providerPlanRef).toBe("price_unmapped");

    // paused → provider suspension (recoverable), never cancellation.
    const paused = stripeEvent("evt_upd_paused", "customer.subscription.updated", {
      id: "sub_c1",
      customer: "cus_c1",
      status: "paused",
      cancel_at_period_end: false,
    });
    await fx.billing.handleProviderWebhook("stripe", paused.headers, paused.raw);
    const pausedSub = await fx.billing.getSubscription(sub.id);
    expect(pausedSub.state).toBe("suspended");
    expect(pausedSub.suspensionSource).toBe("provider");
    expect(pausedSub.suspensionReason).toBe("provider_paused");
    void priceVersion;
  });

  it("dispute-won cannot restore a financially invalid subscription", async () => {
    const fx = await stripeFixture();
    const product = await fx.billing.store.getProductByCode("plus");
    const planVersion = (await fx.billing.store.listPlanVersions(product!.id))[0];
    const { session } = await fx.billing.createCheckout({
      orgId: "org-a5",
      productId: product!.id,
      planVersionId: planVersion!.id,
      pricingRegionCode: "GLOBAL",
      successUrl: "s",
      cancelUrl: "c",
      providerName: "stripe",
    });
    const done = stripeEvent("evt_cs_a5", "checkout.session.completed", {
      id: session.providerRef,
      subscription: "sub_a5",
      customer: "cus_a5",
      payment_intent: "pi_a5",
      amount_total: 2000,
      currency: "usd",
      mode: "subscription",
      payment_status: "paid",
    });
    await fx.billing.handleProviderWebhook("stripe", done.headers, done.raw);
    const dispute = stripeEvent("evt_disp_a5", "charge.dispute.created", {
      id: "dp_a5",
      charge: "ch_a5",
      payment_intent: "pi_a5",
      amount: 2000,
      currency: "usd",
    });
    await fx.billing.handleProviderWebhook("stripe", dispute.headers, dispute.raw);

    // The paid period is no longer valid: expire it.
    const sub = (await fx.billing.getActiveSubscription("org-a5"))!;
    sub.currentPeriodEnd = new Date(Date.now() - DAY).toISOString();
    await fx.billing.store.updateSubscription(sub);

    const won = stripeEvent("evt_disp_won_a5", "charge.dispute.closed", {
      id: "dp_a5",
      charge: "ch_a5",
      payment_intent: "pi_a5",
      status: "won",
    });
    const result = await fx.billing.handleProviderWebhook("stripe", won.headers, won.raw);
    expect(result.applied).toBe(true);
    const after = await fx.billing.getSubscription(sub.id);
    expect(after.state).toBe("suspended"); // NOT restored
    expect(after.reconciliationRequired).toBe(true);
    expect((await fx.billing.evaluateCommercialAccess("org-a5")).entitled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PayPal adapter + service integration
// ---------------------------------------------------------------------------

function paypalEvent(id: string, eventType: string, resource: Record<string, unknown>, createTime = new Date().toISOString()) {
  return JSON.stringify({ id, event_type: eventType, create_time: createTime, resource });
}

function makePaypalProvider(opts: {
  subscriptionGet?: (url: string) => unknown;
  onRequest?: (url: string, init?: RequestInit) => void;
} = {}) {
  return new PayPalProvider({
    environment: "test",
    clientId: "cid",
    clientSecret: "csec",
    webhookId: "WH-05A",
    fetchImpl: async (url, init) => {
      const u = String(url);
      opts.onRequest?.(u, init);
      if (u.includes("/oauth2/token")) return jsonResponse(200, { access_token: "t", expires_in: 3600 });
      if (u.includes("verify-webhook-signature")) return jsonResponse(200, { verification_status: "SUCCESS" });
      if (u.includes("/v1/billing/subscriptions/") && (init?.method ?? "GET") === "GET") {
        return jsonResponse(200, opts.subscriptionGet?.(u) ?? { id: "I-ABC", status: "SUSPENDED" });
      }
      throw new Error(`unexpected paypal call ${u}`);
    },
  });
}

async function paypalFixture(opts: Parameters<typeof makePaypalProvider>[0] = {}) {
  const billing = new BillingService(new InMemoryBillingStore());
  const paypal = makePaypalProvider(opts);
  billing.registerProvider(paypal);
  const catalog = await seedCatalog(billing);
  return { billing, paypal, catalog };
}

/** PayPal checkout sessions are created directly: the adapter returns the
 *  subscription id as the provider ref (PayPal Subscriptions API). */
async function paypalSession(billing: BillingService, orgId: string, providerRef: string, amountMinor: number, plan = "plus") {
  const product = (await billing.store.getProductByCode(plan))!;
  const planVersion = (await billing.store.listPlanVersions(product.id))[0]!;
  const price = (await billing.store.findPriceBook(product.id, "GLOBAL"))!;
  const priceVersion = (await billing.store.listPriceVersions(price.id))[0]!;
  expect(BigInt(priceVersion.amountMinor)).toBe(BigInt(amountMinor));
  await billing.store.createCheckoutSession({
    id: `sess-${orgId}`,
    orgId,
    planVersionId: planVersion.id,
    priceVersionId: priceVersion.id,
    state: "created",
    providerName: "paypal",
    providerRef,
    createdAt: new Date().toISOString(),
  });
  return providerRef;
}

describe("Security Repair 05A — PayPal", () => {
  it("APPROVED/ACTIVATED never grant entitlement", async () => {
    const fx = await paypalFixture();
    const active = await fx.billing.handleProviderWebhook(
      "paypal",
      {},
      paypalEvent("WH-1", "BILLING.SUBSCRIPTION.ACTIVATED", { id: "I-ABC" }),
    );
    expect(active.rejected).toBe(true);
    expect(active.applied).toBe(false);
    const approved = await fx.billing.handleProviderWebhook(
      "paypal",
      {},
      paypalEvent("WH-2", "CHECKOUT.ORDER.APPROVED", { id: "O-1" }),
    );
    expect(approved.rejected).toBe(true);
    expect(await fx.billing.getActiveSubscription("org-p1")).toBeUndefined();
  });

  it("SALE.COMPLETED grants once; repeated same sale never stacks paid time", async () => {
    const fx = await paypalFixture();
    await paypalSession(fx.billing, "org-p2", "I-P2", 2000);

    const sale = paypalEvent("WH-10", "PAYMENT.SALE.COMPLETED", {
      id: "sale_p2",
      billing_agreement_id: "I-P2",
      amount: { total: "20.00", currency: "USD" },
    });
    const first = await fx.billing.handleProviderWebhook("paypal", {}, sale);
    expect(first.applied).toBe(true);
    const sub = (await fx.billing.getActiveSubscription("org-p2"))!;
    expect(sub.state).toBe("active");
    const endAfterFirst = sub.currentPeriodEnd!;

    // A DIFFERENT webhook id for the SAME sale must not extend again.
    const resale = paypalEvent("WH-11", "PAYMENT.SALE.COMPLETED", {
      id: "sale_p2",
      billing_agreement_id: "I-P2",
      amount: { total: "20.00", currency: "USD" },
    });
    const again = await fx.billing.handleProviderWebhook("paypal", {}, resale);
    expect(again.applied).toBe(false);
    expect(again.duplicate).toBe(true);
    expect((await fx.billing.getActiveSubscription("org-p2"))!.currentPeriodEnd).toBe(endAfterFirst);

    // A NEW sale (next cycle) extends exactly once more.
    const next = paypalEvent("WH-12", "PAYMENT.SALE.COMPLETED", {
      id: "sale_p2b",
      billing_agreement_id: "I-P2",
      amount: { total: "20.00", currency: "USD" },
    });
    const nextResult = await fx.billing.handleProviderWebhook("paypal", {}, next);
    expect(nextResult.applied).toBe(true);
    expect((await fx.billing.getActiveSubscription("org-p2"))!.currentPeriodEnd).not.toBe(endAfterFirst);
  });

  it("payment-failed binds to the billing agreement and moves to recoverable past_due", async () => {
    const fx = await paypalFixture();
    await paypalSession(fx.billing, "org-p3", "I-P3", 2000);
    await fx.billing.handleProviderWebhook("paypal", {}, paypalEvent("WH-20", "PAYMENT.SALE.COMPLETED", {
      id: "sale_p3",
      billing_agreement_id: "I-P3",
      amount: { total: "20.00", currency: "USD" },
    }));

    const failed = await fx.billing.handleProviderWebhook(
      "paypal",
      {},
      paypalEvent("WH-21", "BILLING.SUBSCRIPTION.PAYMENT.FAILED", { id: "I-P3" }),
    );
    expect(failed.applied).toBe(true);
    const sub = (await fx.billing.getActiveSubscription("org-p3"))!;
    expect(sub.state).toBe("past_due");
    expect(sub.failedRenewals).toBe(1);
  });

  it("SUSPENDED is recoverable and never triggers a destructive remote cancel", async () => {
    const cancelCalls: string[] = [];
    const fx = await paypalFixture({ onRequest: (url) => { if (url.includes("/cancel")) cancelCalls.push(url); } });
    await paypalSession(fx.billing, "org-p4", "I-P4", 2000);
    await fx.billing.handleProviderWebhook("paypal", {}, paypalEvent("WH-30", "PAYMENT.SALE.COMPLETED", {
      id: "sale_p4",
      billing_agreement_id: "I-P4",
      amount: { total: "20.00", currency: "USD" },
    }));

    const suspended = await fx.billing.handleProviderWebhook(
      "paypal",
      {},
      paypalEvent("WH-31", "BILLING.SUBSCRIPTION.SUSPENDED", { id: "I-P4" }),
    );
    expect(suspended.applied).toBe(true);
    const sub = (await fx.billing.getActiveSubscription("org-p4"))!;
    expect(sub.state).toBe("suspended");
    expect(sub.suspensionSource).toBe("provider");
    expect(cancelCalls).toHaveLength(0); // no /cancel was ever issued
    // No destructive local cancellation either.
    expect(sub.canceledAt).toBeUndefined();
  });

  it("RE-ACTIVATED restores only after authoritative payment reconciliation", async () => {
    const fx = await paypalFixture({
      subscriptionGet: () => ({
        id: "I-P5",
        status: "ACTIVE",
        billing_info: { last_payment: { amount: { value: "20.00", currency_code: "USD" } } },
      }),
    });
    await paypalSession(fx.billing, "org-p5", "I-P5", 2000);
    await fx.billing.handleProviderWebhook("paypal", {}, paypalEvent("WH-40", "PAYMENT.SALE.COMPLETED", {
      id: "sale_p5",
      billing_agreement_id: "I-P5",
      amount: { total: "20.00", currency: "USD" },
    }));
    await fx.billing.handleProviderWebhook("paypal", {}, paypalEvent("WH-41", "BILLING.SUBSCRIPTION.SUSPENDED", { id: "I-P5" }));
    expect((await fx.billing.getActiveSubscription("org-p5"))!.state).toBe("suspended");

    // Authoritative reconciliation proves payment → recovery.
    const reactivated = await fx.billing.handleProviderWebhook(
      "paypal",
      {},
      paypalEvent("WH-42", "BILLING.SUBSCRIPTION.RE-ACTIVATED", { id: "I-P5" }),
    );
    expect(reactivated.applied).toBe(true);
    expect((await fx.billing.getActiveSubscription("org-p5"))!.state).toBe("active");
  });

  it("RE-ACTIVATED without payment proof stays suspended + reconciliation_required", async () => {
    const fx = await paypalFixture({
      subscriptionGet: () => ({ id: "I-P6", status: "SUSPENDED", billing_info: { last_payment: { amount: { value: "20.00", currency_code: "USD" } } } }),
    });
    await paypalSession(fx.billing, "org-p6", "I-P6", 2000);
    await fx.billing.handleProviderWebhook("paypal", {}, paypalEvent("WH-50", "PAYMENT.SALE.COMPLETED", {
      id: "sale_p6",
      billing_agreement_id: "I-P6",
      amount: { total: "20.00", currency: "USD" },
    }));
    await fx.billing.handleProviderWebhook("paypal", {}, paypalEvent("WH-51", "BILLING.SUBSCRIPTION.SUSPENDED", { id: "I-P6" }));

    const reactivated = await fx.billing.handleProviderWebhook(
      "paypal",
      {},
      paypalEvent("WH-52", "BILLING.SUBSCRIPTION.RE-ACTIVATED", { id: "I-P6" }),
    );
    expect(reactivated.reconciliationRequired).toBe(true);
    const sub = (await fx.billing.getActiveSubscription("org-p6"))!;
    expect(sub.state).toBe("suspended");
    expect(sub.reconciliationRequired).toBe(true);
  });

  it("terminal CANCELLED behaves terminally (retention policy)", async () => {
    const fx = await paypalFixture();
    await paypalSession(fx.billing, "org-p7", "I-P7", 2000);
    await fx.billing.handleProviderWebhook("paypal", {}, paypalEvent("WH-60", "PAYMENT.SALE.COMPLETED", {
      id: "sale_p7",
      billing_agreement_id: "I-P7",
      amount: { total: "20.00", currency: "USD" },
    }));
    const canceled = await fx.billing.handleProviderWebhook(
      "paypal",
      {},
      paypalEvent("WH-61", "BILLING.SUBSCRIPTION.CANCELLED", { id: "I-P7" }),
    );
    expect(canceled.applied).toBe(true);
    expect(await fx.billing.getActiveSubscription("org-p7")).toBeUndefined();
    const subs = await fx.billing.store.listSubscriptionsInState(["canceled", "retention"]);
    expect(subs.some((s) => s.orgId === "org-p7" && s.state === "canceled")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Finding E — checkout crash consistency
// ---------------------------------------------------------------------------

function crashStore(inner: BillingStore, injectAfter?: string): BillingStore {
  let injected = false;
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        const result = await (value as (...a: unknown[]) => unknown).apply(target, args);
        if (!injected && injectAfter !== undefined && prop === injectAfter) {
          injected = true;
          throw new Error(`simulated crash after ${String(prop)}`);
        }
        return result;
      };
    },
  }) as BillingStore;
}

const CRASH_POINTS = [
  "claimCheckoutSession",
  "upsertBillingCustomer",
  "updateCheckoutSession",
  "createSubscription",
  "addItem",
  "recordTransition",
] as const;

describe("Security Repair 05A — checkout crash consistency (finding E)", () => {
  for (const crashPoint of CRASH_POINTS) {
    it(`crash after ${crashPoint} recovers: replay yields exactly one subscription/item/transition`, async () => {
      const base = new InMemoryBillingStore();
      const bootStore = crashStore(base, crashPoint);
      const boot = new BillingService(bootStore, { claimLeaseMs: 40 });
      boot.registerProvider(new FakeBillingProvider("fake-gateway", "crash-secret"));
      const catalog = await seedCatalog(boot);
      const orgId = `org-crash-${crashPoint}`;
      const { session } = await boot.createCheckout({
        orgId,
        productId: catalog.productIds.plus!,
        planVersionId: catalog.activePlanVersionIds.plus!,
        pricingRegionCode: "GLOBAL",
        successUrl: "s",
        cancelUrl: "c",
        providerName: "fake-gateway",
      });
      const { headers, raw } = signedBody("crash-secret", {
        eventId: `evt_${crashPoint}`,
        type: "checkout.completed",
        subjectRef: session.providerRef,
        checkoutSessionId: session.id,
        amountMinor: 2000,
        currency: "USD",
      });

      // First attempt: the process "dies" mid-application.
      const first = await boot.handleProviderWebhook("fake-gateway", headers, raw);
      expect(first.applied).toBe(false);

      // Lease expires; a restarted process replays the same provider event.
      await new Promise((resolve) => setTimeout(resolve, 60));
      const restarted = new BillingService(base, { claimLeaseMs: 40 });
      restarted.registerProvider(new FakeBillingProvider("fake-gateway", "crash-secret"));
      const replay = await restarted.handleProviderWebhook("fake-gateway", headers, raw);

      const subs = await restarted.store.listSubscriptionsInState(["active", "trial"]);
      const orgSubs = subs.filter((s) => s.orgId === orgId);
      expect(orgSubs).toHaveLength(1);
      const sub = orgSubs[0]!;
      expect(sub.state).toBe("active");
      expect((await restarted.store.listItems(sub.id)).filter((i) => i.kind === "base")).toHaveLength(1);
      expect((await restarted.store.listTransitions(sub.id)).filter((t) => t.toState === "active")).toHaveLength(1);
      const finalSession = await restarted.store.getCheckoutSession(session.id);
      expect(finalSession?.state).toBe("completed");
      expect(replay.applied || replay.duplicate).toBe(true);
      // Commercial access works end-to-end after recovery.
      expect((await restarted.evaluateCommercialAccess(orgId)).entitled).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Finding F — ordering correctness
// ---------------------------------------------------------------------------

describe("Security Repair 05A — event ordering (finding F)", () => {
  it("an older REAL refund after a newer success still suspends", async () => {
    const fx = await fakeFixture();
    const session = await checkoutSession(fx.billing, fx.providerName, "org-f1", fx.catalog.productIds.plus!, fx.catalog.activePlanVersionIds.plus!, 2000);
    const t1 = new Date(Date.now() - 10 * 60_000).toISOString();
    const t2 = new Date(Date.now() - 5 * 60_000).toISOString();
    await fx.billing.handleProviderWebhook(fx.providerName, ...spread(signedBody(fx.secret, {
      eventId: "evt_f1_complete",
      type: "checkout.completed",
      subjectRef: session.providerRef,
      checkoutSessionId: session.id,
      occurredAt: t1,
      amountMinor: 2000,
      currency: "USD",
    })));
    await fx.billing.handleProviderWebhook(fx.providerName, ...spread(signedBody(fx.secret, {
      eventId: "evt_f1_paid",
      type: "payment.succeeded",
      subjectRef: session.providerRef,
      invoiceRef: "in_f1",
      occurredAt: t2,
      amountMinor: 2000,
      currency: "USD",
    })));
    expect((await fx.billing.getActiveSubscription("org-f1"))!.state).toBe("active");

    // Refund timestamp is OLDER than the success — it must still apply.
    const refund = await fx.billing.handleProviderWebhook(fx.providerName, ...spread(signedBody(fx.secret, {
      eventId: "evt_f1_refund",
      type: "payment.refunded",
      subjectRef: session.providerRef,
      occurredAt: new Date(Date.now() - 20 * 60_000).toISOString(),
      amountMinor: 2000,
      currency: "USD",
    })));
    expect(refund.applied).toBe(true);
    expect((await fx.billing.getActiveSubscription("org-f1"))!.state).toBe("suspended");
  });

  it("a missing-time success cannot resurrect refund-suspended state", async () => {
    const fx = await fakeFixture();
    const session = await checkoutSession(fx.billing, fx.providerName, "org-f2", fx.catalog.productIds.plus!, fx.catalog.activePlanVersionIds.plus!, 2000);
    await fx.billing.handleProviderWebhook(fx.providerName, ...spread(signedBody(fx.secret, {
      eventId: "evt_f2_complete",
      type: "checkout.completed",
      subjectRef: session.providerRef,
      checkoutSessionId: session.id,
      occurredAt: new Date(Date.now() - 60_000).toISOString(),
      amountMinor: 2000,
      currency: "USD",
    })));
    await fx.billing.handleProviderWebhook(fx.providerName, ...spread(signedBody(fx.secret, {
      eventId: "evt_f2_refund",
      type: "payment.refunded",
      subjectRef: session.providerRef,
      occurredAt: new Date(Date.now() - 30_000).toISOString(),
      amountMinor: 2000,
      currency: "USD",
    })));
    expect((await fx.billing.getActiveSubscription("org-f2"))!.state).toBe("suspended");

    const recover = await fx.billing.handleProviderWebhook(fx.providerName, ...spread(signedBody(fx.secret, {
      eventId: "evt_f2_recover",
      type: "payment.succeeded",
      subjectRef: session.providerRef,
      invoiceRef: "in_f2",
      // NO occurredAt: ordering cannot be established.
      amountMinor: 2000,
      currency: "USD",
    })));
    expect(recover.reconciliationRequired).toBe(true);
    expect(recover.applied).toBe(false);
    expect((await fx.billing.getActiveSubscription("org-f2"))!.state).toBe("suspended");
  });

  it("stale ambiguous success is persisted as reconciliation_required — never applied", async () => {
    const fx = await fakeFixture();
    const result = await fx.billing.handleProviderWebhook(fx.providerName, ...spread(signedBody(fx.secret, {
      eventId: "evt_f3_unknown",
      type: "payment.succeeded",
      subjectRef: "unknown-invoice-owner",
      invoiceRef: "in_f3",
      occurredAt: new Date().toISOString(),
      amountMinor: 2000,
      currency: "USD",
    })));
    expect(result.applied).toBe(false);
    expect(result.reconciliationRequired).toBe(true);
    const record = await fx.billing.store.getWebhook(fx.providerName, "evt_f3_unknown");
    expect(record?.status).toBe("reconciliation_required");
  });
});

function spread(input: { headers: Record<string, string>; raw: string }): [Record<string, string>, string] {
  return [input.headers, input.raw];
}

// ---------------------------------------------------------------------------
// Finding G — webhook abuse retention (service level; HTTP rate limits live
// in the control-plane auth-integration suite)
// ---------------------------------------------------------------------------

describe("Security Repair 05A — webhook abuse (finding G)", () => {
  it("identical invalid bodies dedupe into one rejected row", async () => {
    const fx = await fakeFixture();
    const raw = JSON.stringify({ eventId: "x", type: "checkout.completed", subjectRef: "y" });
    const forged = { headers: { "x-mox-timestamp": new Date().toISOString(), "x-mox-signature": "deadbeef" }, raw };
    for (let i = 0; i < 5; i++) {
      await fx.billing.handleProviderWebhook(fx.providerName, forged.headers, forged.raw);
    }
    const digest = (await import("node:crypto")).createHash("sha256").update(raw).digest("hex");
    const record = await fx.billing.store.getWebhook(fx.providerName, `rejected:${digest.slice(0, 32)}`);
    expect(record).toBeDefined();
    expect(record!.status).toBe("rejected");
  });

  it("rejected junk purges with a short TTL; applied financial history is retained", async () => {
    const fx = await fakeFixture();
    // An APPLIED financial event.
    const session = await checkoutSession(fx.billing, fx.providerName, "org-g1", fx.catalog.productIds.plus!, fx.catalog.activePlanVersionIds.plus!, 2000);
    const good = signedBody(fx.secret, {
      eventId: "evt_g_applied",
      type: "checkout.completed",
      subjectRef: session.providerRef,
      checkoutSessionId: session.id,
      amountMinor: 2000,
      currency: "USD",
    });
    await fx.billing.handleProviderWebhook(fx.providerName, good.headers, good.raw);

    // 1,000 unique invalid bodies.
    for (let i = 0; i < 1000; i++) {
      await fx.billing.handleProviderWebhook(fx.providerName, {
        "x-mox-timestamp": new Date().toISOString(),
        "x-mox-signature": "deadbeef",
      }, JSON.stringify({ unique: i, junk: "x".repeat(64) }));
    }

    const purged = await fx.billing.purgeRejectedWebhooks(new Date(Date.now() + 1000).toISOString());
    expect(purged).toBeGreaterThanOrEqual(1000);
    // The applied financial record survives the cleanup.
    expect((await fx.billing.store.getWebhook(fx.providerName, "evt_g_applied"))?.status).toBe("applied");
    // And the commercial effect is intact.
    expect((await fx.billing.getActiveSubscription("org-g1"))!.state).toBe("active");
  });
});

// ---------------------------------------------------------------------------
// Finding H — cancellation consistency
// ---------------------------------------------------------------------------

describe("Security Repair 05A — cancellation consistency (finding H)", () => {
  it("transient remote cancel failure → reconciliation_required; retry completes exactly once", async () => {
    const fx = await fakeFixture();
    const session = await checkoutSession(fx.billing, fx.providerName, "org-h1", fx.catalog.productIds.plus!, fx.catalog.activePlanVersionIds.plus!, 2000);
    await fx.billing.handleProviderWebhook(fx.providerName, ...spread(signedBody(fx.secret, {
      eventId: "evt_h1",
      type: "checkout.completed",
      subjectRef: session.providerRef,
      checkoutSessionId: session.id,
      amountMinor: 2000,
      currency: "USD",
    })));
    const sub = (await fx.billing.getActiveSubscription("org-h1"))!;

    const fake = fx.billing.provider(fx.providerName) as FakeBillingProvider;
    fake.failNextCancel();
    await fx.billing.cancelSubscription(sub.id, { actorType: "user", actorId: "user-1" });

    // Local entitlement shutdown is explicit and immediate…
    expect((await fx.billing.getSubscription(sub.id)).state).toBe("canceled");
    // …while the upstream failure is durably visible.
    const cancellation = await fx.billing.getSubscriptionCancellation(sub.id);
    expect(cancellation?.state).toBe("reconciliation_required");
    expect(cancellation?.lastError).toMatch(/outage/);
    expect(cancellation?.attempts).toBe(1);

    // The retry driver completes the cancellation idempotently.
    const retry = await fx.billing.runCancellationRetries(new Date(Date.now() + 60_000).toISOString());
    expect(retry.canceled).toBe(1);
    const done = await fx.billing.getSubscriptionCancellation(sub.id);
    expect(done?.state).toBe("canceled");
    expect(done?.lastError).toBeUndefined();
    // Running it again is a no-op.
    const again = await fx.billing.runCancellationRetries(new Date(Date.now() + 120_000).toISOString());
    expect(again.canceled).toBe(0);
  });

  it("ambiguous provider mapping is never guessed", async () => {
    const fx = await fakeFixture();
    const product = (await fx.billing.store.getProductByCode("plus"))!;
    const planVersion = (await fx.billing.store.listPlanVersions(product.id))[0]!;
    const book = (await fx.billing.store.findPriceBook(product.id, "GLOBAL"))!;
    const priceVersion = (await fx.billing.store.listPriceVersions(book.id))[0]!;
    const sub = await fx.billing.store.createSubscription({
      id: "sub-ambiguous",
      orgId: "org-h2",
      planVersionId: planVersion.id,
      priceVersionId: priceVersion.id,
      state: "active",
      providerName: "fake-gateway",
      // NO providerRef — legacy/ambiguous mapping.
      failedRenewals: 0,
      cancelAtPeriodEnd: false,
      createdAt: new Date().toISOString(),
    });
    await fx.billing.cancelSubscription(sub.id, { actorType: "user" });
    expect((await fx.billing.getSubscription(sub.id)).state).toBe("canceled");
    const cancellation = await fx.billing.getSubscriptionCancellation(sub.id);
    expect(cancellation?.state).toBe("reconciliation_required");
    expect(cancellation?.lastError).toMatch(/no provider reference/);
  });
});

// ---------------------------------------------------------------------------
// Finding I — refund/dispute/admin reactivation safety
// ---------------------------------------------------------------------------

describe("Security Repair 05A — reactivation safety (finding I)", () => {
  it("generic admin reactivation of a refund-suspended subscription is refused without financial reconciliation", async () => {
    const fx = await fakeFixture();
    const session = await checkoutSession(fx.billing, fx.providerName, "org-i1", fx.catalog.productIds.plus!, fx.catalog.activePlanVersionIds.plus!, 2000);
    await fx.billing.handleProviderWebhook(fx.providerName, ...spread(signedBody(fx.secret, {
      eventId: "evt_i1",
      type: "checkout.completed",
      subjectRef: session.providerRef,
      checkoutSessionId: session.id,
      occurredAt: new Date().toISOString(),
      amountMinor: 2000,
      currency: "USD",
    })));
    await fx.billing.handleProviderWebhook(fx.providerName, ...spread(signedBody(fx.secret, {
      eventId: "evt_i1_refund",
      type: "payment.refunded",
      subjectRef: session.providerRef,
      occurredAt: new Date().toISOString(),
      amountMinor: 2000,
      currency: "USD",
    })));
    const sub = (await fx.billing.getActiveSubscription("org-i1"))!;
    expect(sub.state).toBe("suspended");
    expect(sub.suspensionSource).toBe("refund");

    await expect(fx.billing.adminReactivate(sub.id, "admin-1")).rejects.toThrow(/financial reconciliation/);
    expect((await fx.billing.getSubscription(sub.id)).state).toBe("suspended");

    // Explicit reconciliation assertion + valid period → allowed.
    await fx.billing.adminReactivate(sub.id, "admin-1", { financialReconciled: true });
    expect((await fx.billing.getSubscription(sub.id)).state).toBe("active");

    // Admin suspension (non-financial source) reactivates generically.
    await fx.billing.adminSuspend(sub.id, "admin-1", "abuse_review");
    await fx.billing.adminReactivate(sub.id, "admin-1");
    expect((await fx.billing.getSubscription(sub.id)).state).toBe("active");
  });

  it("financial reconciliation cannot restore an expired paid period", async () => {
    const fx = await fakeFixture();
    const session = await checkoutSession(fx.billing, fx.providerName, "org-i2", fx.catalog.productIds.plus!, fx.catalog.activePlanVersionIds.plus!, 2000);
    await fx.billing.handleProviderWebhook(fx.providerName, ...spread(signedBody(fx.secret, {
      eventId: "evt_i2",
      type: "checkout.completed",
      subjectRef: session.providerRef,
      checkoutSessionId: session.id,
      occurredAt: new Date().toISOString(),
      amountMinor: 2000,
      currency: "USD",
    })));
    await fx.billing.handleProviderWebhook(fx.providerName, ...spread(signedBody(fx.secret, {
      eventId: "evt_i2_refund",
      type: "payment.refunded",
      subjectRef: session.providerRef,
      occurredAt: new Date().toISOString(),
      amountMinor: 2000,
      currency: "USD",
    })));
    const sub = (await fx.billing.getActiveSubscription("org-i2"))!;
    sub.currentPeriodEnd = new Date(Date.now() - DAY).toISOString();
    await fx.billing.store.updateSubscription(sub);

    await expect(fx.billing.adminReactivate(sub.id, "admin-1", { financialReconciled: true })).rejects.toThrow(/period is no longer valid/);
    expect((await fx.billing.getSubscription(sub.id)).state).toBe("suspended");
  });
});
