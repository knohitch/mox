/**
 * Security Repair 07 — PostgreSQL durability/restart coverage.
 * The disposable PostgreSQL verification script supplies MOX_TEST_DATABASE_URL.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, PgBillingStore, PgOrchestratorStore } from "@mox/database";
import { BillingService } from "@mox/billing";
import { ComputeOrchestrator } from "@mox/compute-orchestrator";
import { FakeComputeProvider, ProviderError } from "@mox/compute-providers";

const pgUrl = process.env["MOX_TEST_DATABASE_URL"];

class PgCancelScriptProvider extends FakeComputeProvider {
  failCancel = false;

  override async cancel(providerInstanceId: string) {
    if (this.failCancel) throw new ProviderError("simulated PostgreSQL cancel failure", { retryable: false });
    return super.cancel(providerInstanceId);
  }
}

describe.skipIf(!pgUrl)("Security Repair 07 — PostgreSQL durability", () => {
  const ORG_REFUND = randomUUID();
  const ORG_CANCEL = randomUUID();
  const suffix = randomUUID().slice(0, 8);
  let db: ReturnType<typeof createDb>["db"];
  let pool: ReturnType<typeof createDb>["pool"];

  beforeAll(async () => {
    const created = createDb({ connectionString: pgUrl! });
    db = created.db;
    pool = created.pool;
    await pool.query(
      `insert into organizations (id, slug, display_name) values ($1, $2, 'R07 Refund'), ($3, $4, 'R07 Cancel') on conflict do nothing`,
      [ORG_REFUND, `r07-refund-${suffix}`, ORG_CANCEL, `r07-cancel-${suffix}`],
    );
  });

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
  });

  it("B6: cumulative refund authority survives store restart and concurrent PostgreSQL workers", async () => {
    const firstStore = new PgBillingStore(db);
    const billing = new BillingService(firstStore);
    const product = await billing.createProduct({ code: `r07-pg-${suffix}`, tier: "plus", displayName: "R07 PG" });
    const plan = await billing.createPlanVersion(product.id, 1);
    await billing.activatePlanVersion(plan.id);
    const regionCode = `R07PG${suffix}`;
    await billing.definePricingRegion({ code: regionCode, displayName: "R07 PG", chargeCurrency: "USD", displayCurrency: "USD" });
    const book = await billing.upsertPriceBook({ productId: product.id, pricingRegionCode: regionCode, mode: "fixed" });
    const price = await billing.addFixedPriceVersion(book.id, 10_000n, "USD", "2020-01-01T00:00:00.000Z");
    const subscription = await firstStore.createSubscription({
      id: randomUUID(),
      orgId: ORG_REFUND,
      planVersionId: plan.id,
      priceVersionId: price.id,
      state: "active",
      providerName: "stripe",
      providerEnvironment: "test",
      providerRef: `sub-r07-${suffix}`,
      failedRenewals: 0,
      cancelAtPeriodEnd: false,
      createdAt: new Date().toISOString(),
    });
    const identity = `charge:ch-r07-${suffix}`;

    const first = await firstStore.advanceProviderRefundState({
      providerName: "stripe",
      environment: "test",
      billingIdentity: identity,
      subscriptionId: subscription.id,
      cumulativeAmountMinor: 3000n,
      externalEventId: `evt-r07-3-${suffix}`,
    });
    expect(first.advanced).toBe(true);

    // New store object models a restarted worker reading durable authority.
    const restartedStore = new PgBillingStore(db);
    const replay = await restartedStore.advanceProviderRefundState({
      providerName: "stripe",
      environment: "test",
      billingIdentity: identity,
      subscriptionId: subscription.id,
      cumulativeAmountMinor: 3000n,
      externalEventId: `evt-r07-3-replay-${suffix}`,
    });
    expect(replay.advanced).toBe(false);
    expect(replay.state.cumulativeAmountMinor).toBe(3000n);

    const secondWorker = new PgBillingStore(db);
    await Promise.all([
      restartedStore.advanceProviderRefundState({
        providerName: "stripe",
        environment: "test",
        billingIdentity: identity,
        subscriptionId: subscription.id,
        cumulativeAmountMinor: 6000n,
        externalEventId: `evt-r07-6-${suffix}`,
      }),
      secondWorker.advanceProviderRefundState({
        providerName: "stripe",
        environment: "test",
        billingIdentity: identity,
        subscriptionId: subscription.id,
        cumulativeAmountMinor: 10_000n,
        externalEventId: `evt-r07-10-${suffix}`,
      }),
    ]);
    const probe = await new PgBillingStore(db).advanceProviderRefundState({
      providerName: "stripe",
      environment: "test",
      billingIdentity: identity,
      subscriptionId: subscription.id,
      cumulativeAmountMinor: 1n,
      externalEventId: `evt-r07-probe-${suffix}`,
    });
    expect(probe.advanced).toBe(false);
    expect(probe.state.cumulativeAmountMinor).toBe(10_000n);
  });

  it("C7: abandoned cancellation revival survives PostgreSQL store/orchestrator restart", async () => {
    const provider = new PgCancelScriptProvider(`fake-r07-${suffix}`);
    const classCode = `R07_PG_${suffix}`;
    const storeOne = new PgOrchestratorStore(db);
    const orchOne = new ComputeOrchestrator(storeOne, {
      controlPlaneUrl: "https://control-plane.test",
      retryBaseMs: 1,
      maxAttempts: 1,
      retentionDays: 1,
    });
    orchOne.registerProvider(provider);
    await orchOne.registerProviderAccount({
      providerName: provider.name,
      accountLabel: `primary-${suffix}`,
      commercialStatus: "active",
      healthScore: 100,
      enabled: true,
    });
    await orchOne.configureComputeClass({
      code: classCode,
      displayName: "R07 PostgreSQL",
      minVcpu: 2,
      minRamGb: 4,
      skuMap: [{ providerName: provider.name, regionCode: "fsn1", providerSku: "CX22" }],
      active: true,
    });
    const { order } = await orchOne.orderServer({
      orgId: ORG_CANCEL,
      computeClassCode: classCode,
      hostname: `r07-${suffix}`,
      idempotencyKey: `order-r07-${suffix}`,
      maxServers: 1,
    });
    await orchOne.reconcile(new Date(Date.now() + 60_000).toISOString());
    expect((await orchOne.getOrder(order.id)).state).toBe("running");

    provider.failCancel = true;
    await orchOne.cancelOrder(order.id);
    await orchOne.reconcile(new Date(Date.now() + 120_000).toISOString());
    expect((await orchOne.getOrder(order.id)).state).toBe("error");
    expect((await storeOne.getOperation(order.id, "cancel", `${order.id}:cancel`))?.state).toBe("abandoned");

    // Restart boundary: fresh store + fresh orchestrator object.
    const storeTwo = new PgOrchestratorStore(db);
    const orchTwo = new ComputeOrchestrator(storeTwo, {
      controlPlaneUrl: "https://control-plane.test",
      retryBaseMs: 1,
      maxAttempts: 1,
      retentionDays: 1,
    });
    orchTwo.registerProvider(provider);
    provider.failCancel = false;
    await orchTwo.cancelOrder(order.id);
    expect((await storeTwo.getOperation(order.id, "cancel", `${order.id}:cancel`))?.state).toBe("queued");
    expect((await orchTwo.getOrder(order.id)).state).toBe("cancelling");

    await orchTwo.reconcile(new Date(Date.now() + 180_000).toISOString());
    expect((await orchTwo.getOrder(order.id)).state).toBe("retention");
    expect((await storeTwo.getOperation(order.id, "cancel", `${order.id}:cancel`))?.state).toBe("succeeded");
  });
});
