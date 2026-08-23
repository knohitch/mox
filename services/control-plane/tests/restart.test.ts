/**
 * Restart / idempotency conformance suite (Prompt 00 §G).
 *
 * Proves that authoritative state survives a process restart by driving two
 * independent service instances over ONE store instance (the store models
 * the durable tier; a new service instance models the restarted process):
 *
 *   billing survives restart · pending VPS operation survives restart ·
 *   node expected-token state survives restart · notification survives
 *   restart · duplicate webhook stays deduped after restart · cancel →
 *   resubscribe preserves history.
 *
 * Variants:
 * - default  : InMemory* stores (service-level idempotency semantics).
 * - postgres : MOX_TEST_DATABASE_URL set → Pg* stores over real PostgreSQL,
 *              proving physical durability. Skipped when unset.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { BillingService, FakeBillingProvider, InMemoryBillingStore, type BillingStore } from "@mox/billing";
import {
  ComputeOrchestrator,
  InMemoryOrchestratorStore,
  type OrchestratorStore,
} from "@mox/compute-orchestrator";
import { FakeComputeProvider } from "@mox/compute-providers";
import {
  InMemoryNotificationStore,
  NotificationService,
  type NotificationStore,
} from "@mox/notification-service";
import { signPayload } from "@mox/billing";

const ORG = randomUUID();

interface Harness {
  kind: string;
  makeBillingStores(): Promise<{ first: BillingStore; second: BillingStore }>;
  makeOrchestratorStores(): Promise<{ first: OrchestratorStore; second: OrchestratorStore }>;
  makeNotificationStores(): Promise<{ first: NotificationStore; second: NotificationStore }>;
}

// ---- Local variant -----------------------------------------------------------

const localHarness: Harness = {
  kind: "inmemory",
  async makeBillingStores() {
    // One backing store instance shared by both "processes".
    const shared = new InMemoryBillingStore();
    return { first: shared, second: shared };
  },
  async makeOrchestratorStores() {
    const shared = new InMemoryOrchestratorStore();
    return { first: shared, second: shared };
  },
  async makeNotificationStores() {
    const shared = new InMemoryNotificationStore();
    return { first: shared, second: shared };
  },
};

function defineRestartSuite(harness: Harness): void {
  it("billing survives restart: subscription + invoices visible to a fresh service", async () => {
    const { first, second } = await harness.makeBillingStores();
    const provider = new FakeBillingProvider();
    const boot = new BillingService(first);
    boot.registerProvider(provider);
    const product = await boot.createProduct({ code: "plus", tier: "plus", displayName: "Mox Plus" });
    const version = await boot.createPlanVersion(product.id, 1);
    await boot.setPlanEntitlementValues(version.id, { max_agents: 5 });
    await boot.activatePlanVersion(version.id);
    await boot.definePricingRegion({ code: "US", displayName: "United States", chargeCurrency: "USD", displayCurrency: "USD" });
    const book = await boot.upsertPriceBook({ productId: product.id, pricingRegionCode: "US", mode: "fixed" });
    const price = await boot.addFixedPriceVersion(book.id, 1999n, "USD");
    void price;

    const { session } = await boot.createCheckout({
      orgId: ORG,
      productId: product.id,
      planVersionId: version.id,
      pricingRegionCode: "US",
      successUrl: "https://app.example/success",
      cancelUrl: "https://app.example/cancel",
      providerName: provider.name,
    });

    const body = JSON.stringify({
      eventId: "evt_restart_1",
      type: "checkout.completed",
      subjectRef: session.providerRef!,
    });
    const stamp = new Date().toISOString();
    const headers = { "x-mox-timestamp": stamp, "x-mox-signature": signPayload("test-webhook-secret", body, stamp) };
    expect((await boot.handleProviderWebhook(provider.name, headers, body)).applied).toBe(true);

    // RESTART: brand-new service instance over the same durable tier.
    const restarted = new BillingService(second);
    restarted.registerProvider(provider);
    const sub = await restarted.getActiveSubscription(ORG);
    expect(sub).toBeDefined();
    expect(sub!.providerRef).toBe(session.providerRef);
    expect(await restarted.listInvoices(sub!.id)).toHaveLength(0);
    // Entitlement values are read from the durable tier, not process memory.
    expect(await restarted.getPlanEntitlementValues(version.id)).toEqual({ max_agents: 5 });
    // Provider-ref lookup persists across the restart (§D2).
    expect((await restarted.store.findCheckoutSessionByProviderRef(session.providerRef!))?.id).toBe(session.id);
  });

  it("duplicate webhook remains deduped after restart", async () => {
    const { first, second } = await harness.makeBillingStores();
    const provider = new FakeBillingProvider();
    const boot = new BillingService(first);
    boot.registerProvider(provider);
    const product = await boot.createProduct({ code: "pro", tier: "pro", displayName: "Mox Pro" });
    const version = await boot.createPlanVersion(product.id, 1);
    await boot.activatePlanVersion(version.id);
    await boot.definePricingRegion({ code: "EU", displayName: "EU", chargeCurrency: "USD", displayCurrency: "USD" });
    const book = await boot.upsertPriceBook({ productId: product.id, pricingRegionCode: "EU", mode: "fixed" });
    await boot.addFixedPriceVersion(book.id, 2999n, "USD");

    const { session } = await boot.createCheckout({
      orgId: ORG,
      productId: product.id,
      planVersionId: version.id,
      pricingRegionCode: "EU",
      successUrl: "https://app.example/success",
      cancelUrl: "https://app.example/cancel",
      providerName: provider.name,
    });
    const body = JSON.stringify({ eventId: "evt_dedupe_1", type: "checkout.completed", subjectRef: session.providerRef! });
    const stamp = new Date().toISOString();
    const headers = { "x-mox-timestamp": stamp, "x-mox-signature": signPayload("test-webhook-secret", body, stamp) };
    expect((await boot.handleProviderWebhook(provider.name, headers, body)).applied).toBe(true);

    // Redelivery AFTER restart must stay a no-op (no second subscription).
    const restarted = new BillingService(second);
    restarted.registerProvider(provider);
    const replay = await restarted.handleProviderWebhook(provider.name, headers, body);
    expect(replay.applied).toBe(false);
    expect(replay.duplicate).toBe(true);
  });

  it("subscription history is preserved across cancel → resubscribe", async () => {
    const { first } = await harness.makeBillingStores();
    const provider = new FakeBillingProvider();
    const svc = new BillingService(first);
    svc.registerProvider(provider);
    const product = await svc.createProduct({ code: "max", tier: "max", displayName: "Mox Max" });
    const version = await svc.createPlanVersion(product.id, 1);
    await svc.activatePlanVersion(version.id);
    await svc.definePricingRegion({ code: "GLOBAL", displayName: "Global", chargeCurrency: "USD", displayCurrency: "USD" });
    const book = await svc.upsertPriceBook({ productId: product.id, pricingRegionCode: "GLOBAL", mode: "fixed" });
    await svc.addFixedPriceVersion(book.id, 4999n, "USD");

    const checkout = () =>
      svc.createCheckout({
        orgId: ORG,
        productId: product.id,
        planVersionId: version.id,
        pricingRegionCode: "GLOBAL",
        successUrl: "https://app.example/success",
        cancelUrl: "https://app.example/cancel",
        providerName: provider.name,
      });

    const firstCheckout = await checkout();
    const complete = async (ref: string, eventId: string) => {
      const body = JSON.stringify({ eventId, type: "checkout.completed", subjectRef: ref });
      const stamp = new Date().toISOString();
      return svc.handleProviderWebhook(provider.name, { "x-mox-timestamp": stamp, "x-mox-signature": signPayload("test-webhook-secret", body, stamp) }, body);
    };
    await complete(firstCheckout.session.providerRef!, "evt_resub_1");
    const sub1 = await svc.getActiveSubscription(ORG);
    expect(sub1).toBeDefined();

    await svc.cancelSubscription(sub1!.id);
    expect(await svc.getActiveSubscription(ORG)).toBeUndefined();

    // Resubscribe creates a NEW history row instead of colliding (§D1).
    const secondCheckout = await checkout();
    await complete(secondCheckout.session.providerRef!, "evt_resub_2");
    const sub2 = await svc.getActiveSubscription(ORG);
    expect(sub2).toBeDefined();
    expect(sub2!.id).not.toBe(sub1!.id);

    const all = await first.listSubscriptionsInState(["canceled", "active"]);
    expect(all.filter((s) => s.orgId === ORG)).toHaveLength(2);
  });

  it("pending VPS operation survives restart and reconciles exactly once", async () => {
    const { first, second } = await harness.makeOrchestratorStores();
    const fake = new FakeComputeProvider();
    const boot = new ComputeOrchestrator(first, { retryBaseMs: 1, controlPlaneUrl: "https://control-plane.test" });
    boot.registerProvider(fake);
    await boot.registerProviderAccount({ providerName: "fake-compute", accountLabel: "primary", commercialStatus: "active", healthScore: 100, enabled: true });
    await boot.configureComputeClass({
      code: "COMPUTE_SMALL",
      displayName: "Small",
      minVcpu: 2,
      minRamGb: 4,
      skuMap: [{ providerName: "fake-compute", regionCode: "fsn1", providerSku: "CX22" }],
      active: true,
    });
    const { order } = await boot.orderServer({
      orgId: ORG,
      computeClassCode: "COMPUTE_SMALL",
      hostname: "ws-restart",
      idempotencyKey: "restart-op-1",
    });

    // RESTART before the operation ran.
    const restarted = new ComputeOrchestrator(second, { retryBaseMs: 1, controlPlaneUrl: "https://control-plane.test" });
    restarted.registerProvider(fake);
    await restarted.reconcile(new Date(Date.now() + 60_000).toISOString());
    expect((await restarted.getOrder(order.id)).state).toBe("running");
    expect(fake.provisionCalls.filter((c) => c.idempotencyKey === `${order.id}:provision`)).toHaveLength(1);
  });

  it("node expected-token state survives restart; enrollment consumes atomically", async () => {
    const { first, second } = await harness.makeOrchestratorStores();
    const fake = new FakeComputeProvider();
    const boot = new ComputeOrchestrator(first, { retryBaseMs: 1, controlPlaneUrl: "https://control-plane.test" });
    boot.registerProvider(fake);
    await boot.registerProviderAccount({ providerName: "fake-compute", accountLabel: "primary", commercialStatus: "active", healthScore: 100, enabled: true });
    await boot.configureComputeClass({
      code: "COMPUTE_SMALL",
      displayName: "Small",
      minVcpu: 2,
      minRamGb: 4,
      skuMap: [{ providerName: "fake-compute", regionCode: "fsn1", providerSku: "CX22" }],
      active: true,
    });
    const { order } = await boot.orderServer({ orgId: ORG, computeClassCode: "COMPUTE_SMALL", hostname: "ws-node", idempotencyKey: "node-1" });
    await boot.reconcile(new Date(Date.now() + 60_000).toISOString());
    const secret = [...fake.provisionCalls.at(-1)!.cloudInitUserData.matchAll(/MOX_ENROLL_TOKEN=(\S+)/g)][0]![1]!;

    // RESTART: the pre-persisted expectation lives in the durable tier, so a
    // fresh orchestrator validates the very same bootstrap secret.
    const restarted = new ComputeOrchestrator(second, { retryBaseMs: 1, controlPlaneUrl: "https://control-plane.test" });
    const enrollInput = { orgId: ORG, orderId: order.id, nodeId: "node-restart", enrollToken: secret };
    const firstEnroll = await restarted.enrollNode(enrollInput);
    expect(firstEnroll.node.agentTokenHash).toBeTruthy();

    // Heartbeat authenticates with the DURABLE agent token post-restart.
    const third = new ComputeOrchestrator(second, { retryBaseMs: 1, controlPlaneUrl: "https://control-plane.test" });
    await expect(
      third.heartbeat("node-restart", { cpu: 5 }, { agentToken: firstEnroll.agentToken }, { now: new Date().toISOString() }),
    ).resolves.toBeUndefined();

    // Replay after restart still fails.
    await expect(restarted.enrollNode({ ...enrollInput, nodeId: "node-other" })).rejects.toThrow(/already used/);
  });

  it("two simultaneous enrollments cannot both succeed", async () => {
    const { first } = await harness.makeOrchestratorStores();
    const fake = new FakeComputeProvider();
    const orch = new ComputeOrchestrator(first, { retryBaseMs: 1, controlPlaneUrl: "https://control-plane.test" });
    orch.registerProvider(fake);
    await orch.registerProviderAccount({ providerName: "fake-compute", accountLabel: "primary", commercialStatus: "active", healthScore: 100, enabled: true });
    await orch.configureComputeClass({
      code: "COMPUTE_SMALL",
      displayName: "Small",
      minVcpu: 2,
      minRamGb: 4,
      skuMap: [{ providerName: "fake-compute", regionCode: "fsn1", providerSku: "CX22" }],
      active: true,
    });
    const { order } = await orch.orderServer({ orgId: ORG, computeClassCode: "COMPUTE_SMALL", hostname: "ws-race", idempotencyKey: "race-1" });
    await orch.reconcile(new Date(Date.now() + 60_000).toISOString());
    const secret = [...fake.provisionCalls.at(-1)!.cloudInitUserData.matchAll(/MOX_ENROLL_TOKEN=(\S+)/g)][0]![1]!;

    const results = await Promise.allSettled([
      orch.enrollNode({ orgId: ORG, orderId: order.id, nodeId: "node-a", enrollToken: secret }),
      orch.enrollNode({ orgId: ORG, orderId: order.id, nodeId: "node-b", enrollToken: secret }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const reason = (rejected[0] as PromiseRejectedResult).reason as Error;
    expect(String(reason.message ?? reason)).toMatch(/already used|token/i);
  });

  it("notifications survive restart and dedupe holds after restart", async () => {
    const { first, second } = await harness.makeNotificationStores();
    const boot = new NotificationService(first);
    const event = {
      eventId: `pe_${randomUUID()}`,
      type: "server.provisioned" as const,
      orgId: ORG,
      severity: "info" as const,
      templateVars: {},
      at: new Date().toISOString(),
    };
    const firstResult = await boot.consume(event);
    expect(firstResult.duplicate).toBe(false);

    const restarted = new NotificationService(second);
    const replay = await restarted.consume(event);
    expect(replay.duplicate).toBe(true);
    const list = await restarted.store.list(ORG);
    expect(list).toHaveLength(1);
    expect(list[0]!.eventType).toBe("server.provisioned");
  });
}

describe("restart/idempotency conformance (in-memory tier)", () => {
  defineRestartSuite(localHarness);
});

// ---- PostgreSQL variant ------------------------------------------------------

const pgUrl = process.env["MOX_TEST_DATABASE_URL"];

describe.skipIf(!pgUrl)("restart/idempotency conformance (PostgreSQL tier)", () => {
  beforeAll(async () => {
    // The durable schema enforces foreign keys; seed the shared test org.
    const { createDb } = await import("@mox/database");
    const { pool } = createDb({ connectionString: pgUrl! });
    try {
      await pool.query(
        `insert into organizations (id, slug, display_name)
         values ($1, 'restart-test', 'Restart Test')
         on conflict do nothing`,
        [ORG],
      );
      // The durable billing store validates entitlement keys against the
      // definitions table (Prompt 00B §E); seed what the suites use.
      await pool.query(
        `insert into entitlement_definitions (key, value_type, description, default_value)
         values ('max_agents', 'integer', 'Max agents', '3'::jsonb)
         on conflict (key) do nothing`,
      );
    } finally {
      await pool.end().catch(() => undefined);
    }
  });

  defineRestartSuite({
    kind: "postgres",
    async makeBillingStores() {
      const { createDb, PgBillingStore } = await import("@mox/database");
      const { db } = createDb({ connectionString: pgUrl! });
      // Two instances over the same durable tier model the restarted process.
      return { first: new PgBillingStore(db), second: new PgBillingStore(db) };
    },
    async makeOrchestratorStores() {
      const { createDb, PgOrchestratorStore } = await import("@mox/database");
      const { db } = createDb({ connectionString: pgUrl! });
      return { first: new PgOrchestratorStore(db), second: new PgOrchestratorStore(db) };
    },
    async makeNotificationStores() {
      const { createDb, PgNotificationStore } = await import("@mox/database");
      const { db } = createDb({ connectionString: pgUrl! });
      return { first: new PgNotificationStore(db), second: new PgNotificationStore(db) };
    },
  });
});
