import { describe, expect, it } from "vitest";
import { FakeBillingProvider, signPayload } from "../src/provider.js";
import { BillingService } from "../src/service.js";
import { seedCatalog } from "../src/seed.js";
import { InMemoryBillingStore } from "../src/store.js";

const DAY = 24 * 3600 * 1000;

interface Fixture {
  billing: BillingService;
  secret: string;
  providerName: string;
  planVersionIds: Record<string, string>;
  productIds: Record<string, string>;
}

async function fixture(): Promise<Fixture> {
  const billing = new BillingService(new InMemoryBillingStore());
  const secret = "test-webhook-secret";
  const providerName = "fake-gateway";
  billing.registerProvider(new FakeBillingProvider(providerName, secret));
  const catalog = await seedCatalog(billing);
  return { billing, secret, providerName, planVersionIds: catalog.activePlanVersionIds, productIds: catalog.productIds };
}

function signedBody(secret: string, body: Record<string, unknown>): { headers: Record<string, string>; raw: string } {
  const raw = JSON.stringify(body);
  const ts = new Date().toISOString();
  return { headers: { "x-mox-timestamp": ts, "x-mox-signature": signPayload(secret, raw, ts) }, raw };
}

describe("billing", () => {
  it("never activates a plan from a browser redirect alone", async () => {
    const fx = await fixture();
    const { session } = await fx.billing.createCheckout({
      orgId: "org-1",
      productId: fx.productIds.pro!,
      planVersionId: fx.planVersionIds.pro!,
      pricingRegionCode: "GLOBAL",
      successUrl: "https://app.mox.test/welcome",
      cancelUrl: "https://app.mox.test/billing",
      providerName: fx.providerName,
    });
    // User completed the redirect flow in a browser…
    expect(session.redirectUrl).toContain("https://");
    expect(session.state).toBe("created");
    // …but no subscription exists without a verified webhook.
    expect(await fx.billing.getActiveSubscription("org-1")).toBeUndefined();
  });

  it("activates paid state only via verified webhook, idempotently for duplicates", async () => {
    const fx = await fixture();
    const { session } = await fx.billing.createCheckout({
      orgId: "org-1",
      productId: fx.productIds.max!,
      planVersionId: fx.planVersionIds.max!,
      pricingRegionCode: "GLOBAL",
      successUrl: "s",
      cancelUrl: "c",
      providerName: fx.providerName,
    });
    const { headers, raw } = signedBody(fx.secret, {
      eventId: "evt_1",
      type: "checkout.completed",
      subjectRef: session.providerRef,
      checkoutSessionId: session.id,
    });
    const first = await fx.billing.handleProviderWebhook(fx.providerName, headers, raw);
    expect(first.applied).toBe(true);
    const sub = await fx.billing.getActiveSubscription("org-1");
    expect(sub?.state).toBe("active");

    const dup = await fx.billing.handleProviderWebhook(fx.providerName, headers, raw);
    expect(dup.duplicate).toBe(true);
    expect(dup.applied).toBe(false);
    // State unchanged by replay.
    expect((await fx.billing.getActiveSubscription("org-1"))?.state).toBe("active");
  });

  it("rejects forged webhook signatures without touching state", async () => {
    const fx = await fixture();
    const { session } = await fx.billing.createCheckout({
      orgId: "org-1",
      productId: fx.productIds.plus!,
      planVersionId: fx.planVersionIds.plus!,
      pricingRegionCode: "GLOBAL",
      successUrl: "s",
      cancelUrl: "c",
      providerName: fx.providerName,
    });
    const raw = JSON.stringify({ eventId: "evt_x", type: "checkout.completed", subjectRef: session.providerRef, checkoutSessionId: session.id });
    const forged = { headers: { "x-mox-timestamp": new Date().toISOString(), "x-mox-signature": "deadbeef" }, raw };
    const result = await fx.billing.handleProviderWebhook(fx.providerName, forged.headers, forged.raw);
    expect(result.rejected).toBe(true);
    expect(await fx.billing.getActiveSubscription("org-1")).toBeUndefined();
  });

  it("converges under out-of-order webhook delivery", async () => {
    const fx = await fixture();
    const { session } = await fx.billing.createCheckout({
      orgId: "org-2",
      productId: fx.productIds.pro!,
      planVersionId: fx.planVersionIds.pro!,
      pricingRegionCode: "GLOBAL",
      successUrl: "s",
      cancelUrl: "c",
      providerName: fx.providerName,
    });
    // Payment failure arrives BEFORE the checkout.completed activation.
    const failBody = signedBody(fx.secret, {
      eventId: "evt_fail",
      type: "payment.failed",
      subjectRef: session.providerRef,
      sequence: 2,
    });
    const appliedFail = await fx.billing.handleProviderWebhook(fx.providerName, failBody.headers, failBody.raw);
    // Unknown subject yet: rejected, recorded honestly.
    expect(appliedFail.applied).toBe(false);

    const completeBody = signedBody(fx.secret, {
      eventId: "evt_complete",
      type: "checkout.completed",
      subjectRef: session.providerRef,
      checkoutSessionId: session.id,
      sequence: 1,
    });
    await fx.billing.handleProviderWebhook(fx.providerName, completeBody.headers, completeBody.raw);
    expect((await fx.billing.getActiveSubscription("org-2"))?.state).toBe("active");

    // Replaying the stale failure now applies cleanly without corrupting state.
    const staleFail = await fx.billing.handleProviderWebhook(fx.providerName, failBody.headers, failBody.raw);
    expect(staleFail.applied).toBe(true);
    const sub = await fx.billing.getActiveSubscription("org-2");
    expect(sub?.state).toBe("past_due");
    expect(sub?.failedRenewals).toBe(1);
  });

  it("walks active→past_due→grace_period on repeated renewal failures, then suspends after grace", async () => {
    const fx = await fixture();
    const { session } = await fx.billing.createCheckout({
      orgId: "org-3",
      productId: fx.productIds.plus!,
      planVersionId: fx.planVersionIds.plus!,
      pricingRegionCode: "GLOBAL",
      successUrl: "s",
      cancelUrl: "c",
      providerName: fx.providerName,
    });
    const complete = signedBody(fx.secret, { eventId: "e1", type: "checkout.completed", subjectRef: session.providerRef, checkoutSessionId: session.id });
    await fx.billing.handleProviderWebhook(fx.providerName, complete.headers, complete.raw);

    const fake = fx.billing.provider(fx.providerName) as FakeBillingProvider;
    fake.declineNextCharge();

    const sub0 = (await fx.billing.getActiveSubscription("org-3"))!;
    let t = new Date(new Date(sub0.currentPeriodEnd!).getTime() + DAY).toISOString();
    let result = await fx.billing.runRenewals(t);
    expect(result.failed).toBe(1);
    expect((await fx.billing.getActiveSubscription("org-3"))?.state).toBe("past_due");

    t = new Date(new Date(t).getTime() + 30 * DAY).toISOString();
    fake.declineNextCharge();
    result = await fx.billing.runRenewals(t);
    expect((await fx.billing.getActiveSubscription("org-3"))?.state).toBe("grace_period");

    // Grace window (7 days) lapses without payment (retry also declines).
    t = new Date(new Date(t).getTime() + 8 * DAY).toISOString();
    fake.declineNextCharge();
    result = await fx.billing.runRenewals(t);
    expect(result.suspended).toBe(1);
    expect((await fx.billing.getActiveSubscription("org-3"))?.state).toBe("suspended");

    // Recovery payment returns the subscription to active.
    const recover = signedBody(fx.secret, { eventId: "e2", type: "payment.succeeded", subjectRef: session.providerRef });
    await fx.billing.handleProviderWebhook(fx.providerName, recover.headers, recover.raw);
    expect((await fx.billing.getActiveSubscription("org-3"))?.state).toBe("active");
  });

  it("renews successfully when the charge succeeds", async () => {
    const fx = await fixture();
    const { session } = await fx.billing.createCheckout({
      orgId: "org-4",
      productId: fx.productIds.max!,
      planVersionId: fx.planVersionIds.max!,
      pricingRegionCode: "GLOBAL",
      successUrl: "s",
      cancelUrl: "c",
      providerName: fx.providerName,
    });
    const complete = signedBody(fx.secret, { eventId: "c1", type: "checkout.completed", subjectRef: session.providerRef, checkoutSessionId: session.id });
    await fx.billing.handleProviderWebhook(fx.providerName, complete.headers, complete.raw);
    const subBefore = (await fx.billing.getActiveSubscription("org-4"))!;
    const result = await fx.billing.runRenewals(new Date(new Date(subBefore.currentPeriodEnd!).getTime() + DAY).toISOString());    expect(result.renewed).toBe(1);
    const invoices = await fx.billing.listInvoices(subBefore.id);
    expect(invoices.at(-1)?.status).toBe("paid");
    // Invoice amount is exact integer minor units ($99.00 max anchor).
    expect(invoices[0]!.amount.amountMinor).toBe(9900n);
  });

  it("cancel flows into retention and finally deletion", async () => {
    const fx = await fixture();
    const { session } = await fx.billing.createCheckout({
      orgId: "org-5",
      productId: fx.productIds.plus!,
      planVersionId: fx.planVersionIds.plus!,
      pricingRegionCode: "GLOBAL",
      successUrl: "s",
      cancelUrl: "c",
      providerName: fx.providerName,
    });
    const complete = signedBody(fx.secret, { eventId: "cc1", type: "checkout.completed", subjectRef: session.providerRef, checkoutSessionId: session.id });
    await fx.billing.handleProviderWebhook(fx.providerName, complete.headers, complete.raw);
    const sub = (await fx.billing.getActiveSubscription("org-5"))!;

    await fx.billing.cancelSubscription(sub.id, { actorType: "user" });
    const canceledAt = new Date((await fx.billing.getSubscription(sub.id)).canceledAt!);
    await fx.billing.runRetentionSweep(new Date(canceledAt.getTime() + DAY).toISOString());
    expect((await fx.billing.getSubscription(sub.id)).state).toBe("retention");

    await fx.billing.runRetentionSweep(new Date(canceledAt.getTime() + 31 * DAY).toISOString());
    expect((await fx.billing.getSubscription(sub.id)).state).toBe("deleted");

    const transitions = await fx.billing.listTransitions(sub.id);
    expect(transitions.map((t) => t.toState)).toEqual(["active", "canceled", "retention", "deleted"]);
  });

  it("selects regional prices: fixed USD, FX-derived NGN/GHS/GBP, disabled regions unavailable", async () => {
    const fx = await fixture();
    const pro = fx.productIds.pro!;

    const usd = await fx.billing.resolvePrice(pro, "GLOBAL");
    expect(usd.mode).toBe("fixed");
    expect(usd.amount.currency).toBe("USD");
    expect(usd.amount.amountMinor).toBe(4900n);

    const ngn = await fx.billing.resolvePrice(pro, "NG");
    expect(ngn.mode).toBe("fx_derived");
    expect(ngn.amount.currency).toBe("NGN");
    expect(ngn.amount.amountMinor).toBe(4900n * 1550n);

    const ghs = await fx.billing.resolvePrice(pro, "GH");
    expect(ghs.amount.currency).toBe("GHS");

    // Disable a region: selection must report unavailability honestly.
    const book = await fx.billing.store.findPriceBook(pro, "UK");
    await fx.billing.upsertPriceBook({ ...book!, mode: "disabled" });
    await expect(fx.billing.resolvePrice(pro, "UK")).rejects.toThrow(/unavailable/);

    // Unknown region is unavailable, not a silent fallback.
    await expect(fx.billing.resolvePrice(pro, "ZZ")).rejects.toThrow(/region ZZ|price unavailable/i);
  });

  it("keeps plan versions immutable and pushes entitlement values to the authority once activated", async () => {
    const fx = await fixture();
    const v2 = await fx.billing.createPlanVersion(fx.productIds.plus!, 2);
    await fx.billing.setPlanEntitlementValues(v2.id, { max_agents: 3, developer_mode: false });
    await fx.billing.activatePlanVersion(v2.id);
    await expect(
      fx.billing.setPlanEntitlementValues(v2.id, { max_agents: 999 }),
    ).rejects.toThrow(/immutable/);
    await expect(fx.billing.activatePlanVersion(v2.id)).resolves.toBeTruthy(); // idempotent re-activation of active
    const retired = await fx.billing.retirePlanVersion(v2.id);
    expect(retired.status).toBe("retired");
    await expect(fx.billing.activatePlanVersion(v2.id)).rejects.toThrow(/retired/);
  });

  it("supports admin suspension/reactivation and audited transitions", async () => {
    const fx = await fixture();
    const { session } = await fx.billing.createCheckout({
      orgId: "org-6",
      productId: fx.productIds.enterprise!,
      planVersionId: fx.planVersionIds.enterprise!,
      pricingRegionCode: "GLOBAL",
      successUrl: "s",
      cancelUrl: "c",
      providerName: fx.providerName,
    });
    const complete = signedBody(fx.secret, { eventId: "en1", type: "checkout.completed", subjectRef: session.providerRef, checkoutSessionId: session.id });
    await fx.billing.handleProviderWebhook(fx.providerName, complete.headers, complete.raw);
    const sub = (await fx.billing.getActiveSubscription("org-6"))!;

    await fx.billing.adminSuspend(sub.id, "admin-9", "chargeback_review");
    expect((await fx.billing.getSubscription(sub.id)).state).toBe("suspended");
    await fx.billing.adminReactivate(sub.id, "admin-9");
    expect((await fx.billing.getSubscription(sub.id)).state).toBe("active");

    // Illegal move: deleted is terminal.
    await expect(fx.billing.transition(sub.id, "deleted", "nope")).rejects.toThrow(/not allowed/);
  });

  it("attaches recurring add-ons and rejects them on non-live subscriptions", async () => {
    const fx = await fixture();
    const { session } = await fx.billing.createCheckout({
      orgId: "org-7",
      productId: fx.productIds.pro!,
      planVersionId: fx.planVersionIds.pro!,
      pricingRegionCode: "GLOBAL",
      successUrl: "s",
      cancelUrl: "c",
      providerName: fx.providerName,
    });
    const complete = signedBody(fx.secret, { eventId: "ad1", type: "checkout.completed", subjectRef: session.providerRef, checkoutSessionId: session.id });
    await fx.billing.handleProviderWebhook(fx.providerName, complete.headers, complete.raw);
    const sub = (await fx.billing.getActiveSubscription("org-7"))!;
    await fx.billing.attachAddon(sub.id, "extra_vps", 2);
    await fx.billing.attachAddon(sub.id, "ai_credits_1k", 5);
    const items = await fx.billing.store.listItems(sub.id);
    expect(items.filter((i) => i.kind === "addon")).toHaveLength(1);

    await fx.billing.adminSuspend(sub.id, "admin-1", "test");
    await expect(fx.billing.attachAddon(sub.id, "extra_vps", 1)).rejects.toThrow(/suspended/);
  });

  it("reports unconfigured gateways honestly instead of mocking success", async () => {
    const fx = await fixture();
    fx.billing.registerBlockedProvider("stripe", "MOX_BILLING_STRIPE_SECRET missing");
    expect(() => fx.billing.requireConfiguredProvider("stripe")).toThrow(/not configured.*MOX_BILLING_STRIPE_SECRET/s);
    await expect(
      fx.billing.createCheckout({
        orgId: "org-8",
        productId: fx.productIds.plus!,
        planVersionId: fx.planVersionIds.plus!,
        pricingRegionCode: "GLOBAL",
        successUrl: "s",
        cancelUrl: "c",
        providerName: "stripe",
      }),
    ).rejects.toThrow(/not configured/);
  });
});
