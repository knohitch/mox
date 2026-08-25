/**
 * Security Repair 05B — real PostgreSQL race/fencing tests (finding A/B/H/I).
 * Skipped unless MOX_TEST_DATABASE_URL points at a migrated database; the
 * disposable-cluster script runs this file.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  createDb,
  PgBillingStore,
  PgNotificationStore,
  PgOrchestratorStore,
} from "@mox/database";
import { ComputeOrchestrator, type ServerOperation } from "@mox/compute-orchestrator";
import { FakeComputeProvider } from "@mox/compute-providers";
import { BillingService, FakeBillingProvider } from "@mox/billing";
import { NotificationService } from "@mox/notification-service";
import { ClusterSseAdmission, SseAdmissionDeniedError } from "../src/sse-admission.js";
import { DurableRateLimiter } from "../src/rate-limit.js";

const pgUrl = process.env["MOX_TEST_DATABASE_URL"];

describe.skipIf(!pgUrl)("Security Repair 05B — distributed hardening over PostgreSQL", () => {
  const ORG = randomUUID();
  let db: ReturnType<typeof createDb>["db"];
  let pool: ReturnType<typeof createDb>["pool"];

  beforeAll(async () => {
    const created = createDb({ connectionString: pgUrl! });
    db = created.db;
    pool = created.pool;
    await pool.query(
      `insert into organizations (id, slug, display_name) values ($1, $2, '05B Test') on conflict do nothing`,
      [ORG, `org-05b-${ORG.slice(0, 8)}`],
    );
    await pool.query(
      `insert into compute_classes (code, display_name, min_vcpu, min_ram_gb, sku_map, active)
       values ('COMPUTE_05B_PG', '05B', 1, 1, '[]'::jsonb, true) on conflict do nothing`,
    );
  });

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
  });

  it("A: stale compute worker cannot overwrite a reclaimer's success (provision/cancel/reboot)", async () => {
    for (const kind of ["provision", "cancel", "reboot"] as const) {
      const store = new PgOrchestratorStore(db);
      const orderId = randomUUID();
      await store.insertOrder({
        id: orderId,
        orgId: ORG,
        computeClassCode: "COMPUTE_05B_PG",
        state: "running",
        providerName: "fake-compute",
        providerInstanceId: `inst-${randomUUID()}`,
        hostname: `ws-race-${randomUUID().slice(0, 6)}`,
        idempotencyKey: `race-${randomUUID()}`,
        attemptCount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await store.upsertOperation({
        id: randomUUID(),
        orderId,
        kind,
        state: "queued",
        idempotencyKey: `${orderId}:${kind}`,
        attempts: 0,
        maxAttempts: 5,
        nextAttemptAt: new Date(Date.now() - 1000).toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      // Worker A claims.
      const [a] = await store.claimDueOperations(new Date().toISOString(), "worker-a", 500, 10);
      expect(a).toBeDefined();
      // Force lease expiry, then worker B reclaims (version bumps).
      await db.execute(sql`UPDATE server_operations SET lease_expires_at = now() - interval '1 second' WHERE id = ${a!.id}`);
      const [b] = await store.claimDueOperations(new Date().toISOString(), "worker-b", 60_000, 10);
      expect(b).toBeDefined();
      expect(b!.leaseVersion).toBeGreaterThan(a!.leaseVersion ?? 0);

      // B succeeds (fenced).
      const bOp: ServerOperation = { ...b!, state: "succeeded", leaseOwner: "worker-b" };
      expect(await store.updateOperationFenced(bOp, b!.leaseVersion ?? 0)).toBe(true);

      // A (stale) attempts a failure writeback: zero rows affected, no
      // order-state regression, no stale business event.
      const aOp: ServerOperation = { ...a!, state: "abandoned", lastError: "stale worker failure", leaseOwner: "worker-a" };
      expect(await store.updateOperationFenced(aOp, a!.leaseVersion ?? 0)).toBe(false);

      const final = await store.getOperation(orderId, kind, `${orderId}:${kind}`);
      expect(final?.state).toBe("succeeded");
      expect(final?.leaseOwner).toBeUndefined();
      const orderRow = await store.getOrder(orderId);
      expect(orderRow?.state).toBe("running");
    }
  });

  it("A: stale billing renewal worker cannot regress a reclaimer's period write", async () => {
    const billing = new BillingService(new PgBillingStore(db));
    billing.registerProvider(new FakeBillingProvider("fw-05b", "05b-secret"));
    const product = await billing.createProduct({ code: `05b-${randomUUID().slice(0, 8)}`, tier: "plus", displayName: "05B" });
    const version = await billing.createPlanVersion(product.id, 1);
    await billing.activatePlanVersion(version.id);
    await billing.definePricingRegion({ code: "05B", displayName: "05B", chargeCurrency: "USD", displayCurrency: "USD" });
    const book = await billing.upsertPriceBook({ productId: product.id, pricingRegionCode: "05B", mode: "fixed" });
    const price = await billing.addFixedPriceVersion(book.id, 1999n, "USD");
    const sub = await billing.store.createSubscription({
      id: randomUUID(),
      orgId: ORG,
      planVersionId: version.id,
      priceVersionId: price.id,
      state: "active",
      providerName: "fw-05b",
      providerRef: `fw-05b:sub_${randomUUID()}`,
      providerEnvironment: "test",
      currentPeriodStart: new Date(Date.now() - 30 * 24 * 3600_000).toISOString(),
      currentPeriodEnd: new Date(Date.now() - 1000).toISOString(),
      failedRenewals: 0,
      cancelAtPeriodEnd: false,
      createdAt: new Date().toISOString(),
    });

    const due = sub.currentPeriodEnd!;
    const a = await billing.store.claimSubscriptionRenewal(sub.id, due, "worker-a", new Date(Date.now() + 500).toISOString(), new Date().toISOString());
    expect(a).toBeDefined();
    await db.execute(sql`UPDATE subscriptions SET renewal_claim_expires_at = now() - interval '1 second' WHERE id = ${sub.id}`);
    const b = await billing.store.claimSubscriptionRenewal(sub.id, due, "worker-b", new Date(Date.now() + 60_000).toISOString(), new Date().toISOString());
    expect(b).toBeDefined();
    expect(b!.renewalClaimVersion).toBeGreaterThan(a!.renewalClaimVersion ?? 0);

    const bPeriodEnd = new Date(Date.now() + 30 * 24 * 3600_000).toISOString();
    expect(await billing.store.completeSubscriptionRenewal({ ...b!, currentPeriodEnd: bPeriodEnd }, b!.renewalClaimVersion ?? 0)).toBe(true);
    // Stale A write is fenced off.
    expect(await billing.store.completeSubscriptionRenewal({ ...a!, currentPeriodEnd: new Date(Date.now() - 1000).toISOString() }, a!.renewalClaimVersion ?? 0)).toBe(false);

    const final = await billing.store.getSubscription(sub.id);
    expect(final?.currentPeriodEnd).toBe(bPeriodEnd);
  });

  it("A: stale notification finalizer cannot regress a reclaimer's job", async () => {
    const notifications = new NotificationService(new PgNotificationStore(db));
    const key = `job-05b-${randomUUID()}`;
    await notifications.createJob({
      idempotencyKey: key,
      createdBy: "admin-05b",
      audience: { type: "user", userIds: [randomUUID()] },
      payload: { title: "05B", body: "05B" },
      scheduledAt: new Date(Date.now() - 1000).toISOString(),
    });

    const [a] = await notifications.store.claimDueJobs(new Date().toISOString(), "worker-a", 500, 10);
    expect(a).toBeDefined();
    await db.execute(sql`UPDATE notification_jobs SET claim_expires_at = now() - interval '1 second' WHERE id = ${a!.id}`);
    const [b] = await notifications.store.claimDueJobs(new Date().toISOString(), "worker-b", 60_000, 10);
    expect(b).toBeDefined();
    expect(b!.claimVersion).toBeGreaterThan(a!.claimVersion ?? 0);

    expect(await notifications.store.updateJobFenced({ ...b!, status: "completed", completedAt: new Date().toISOString(), claimOwner: "worker-b" }, b!.claimVersion ?? 0)).toBe(true);
    expect(await notifications.store.updateJobFenced({ ...a!, status: "failed", error: "stale finalizer", claimOwner: "worker-a" }, a!.claimVersion ?? 0)).toBe(false);

    const final = await notifications.store.getJobByIdempotencyKey("admin-05b", key);
    expect(final?.status).toBe("completed");
  });

  it("B: quota=1 with two distinct concurrent PG keys yields exactly one order", async () => {
    // Dedicated org: earlier fencing tests left running orders on ORG.
    const quotaOrg = randomUUID();
    await pool!.query(
      `insert into organizations (id, slug, display_name) values ($1, $2, '05B Quota') on conflict do nothing`,
      [quotaOrg, `org-q-${quotaOrg.slice(0, 8)}`],
    );
    const one = new ComputeOrchestrator(new PgOrchestratorStore(db), { controlPlaneUrl: "https://control-plane.test" });
    const two = new ComputeOrchestrator(new PgOrchestratorStore(db), { controlPlaneUrl: "https://control-plane.test" });
    const fake = new FakeComputeProvider();
    one.registerProvider(fake);
    two.registerProvider(fake);
    await one.registerProviderAccount({ providerName: "fake-compute", accountLabel: `primary-05b-${randomUUID().slice(0, 6)}`, commercialStatus: "active", healthScore: 100, enabled: true });

    const results = await Promise.allSettled([
      one.orderServer({ orgId: quotaOrg, computeClassCode: "COMPUTE_05B_PG", hostname: "q1", idempotencyKey: `q-${randomUUID()}`, maxServers: 1 }),
      two.orderServer({ orgId: quotaOrg, computeClassCode: "COMPUTE_05B_PG", hostname: "q2", idempotencyKey: `q-${randomUUID()}`, maxServers: 1 }),
    ]);
    const created = results.filter((r) => r.status === "fulfilled" && (r as PromiseFulfilledResult<{ created: boolean }>).value.created);
    const denied = results.filter((r) => r.status === "rejected" && String((r as PromiseRejectedResult).reason).includes("quota"));
    expect(created).toHaveLength(1);
    expect(denied).toHaveLength(1);
    const orders = (await one.store.listOrdersForOrg(quotaOrg)).filter((o) =>
      ["requested", "provisioning", "running"].includes(o.state),
    );
    expect(orders).toHaveLength(1);
  });

  it("H: simultaneous first bucket creation cannot bypass the durable limiter", async () => {
    const limiter = new DurableRateLimiter(db);
    const key = `fresh-${randomUUID()}`;
    const [r1, r2] = await Promise.all([
      limiter.check({ scope: "05b:race", bucketKey: key, limit: 1, windowMs: 60_000, lockMs: 60_000 }),
      limiter.check({ scope: "05b:race", bucketKey: key, limit: 1, windowMs: 60_000, lockMs: 60_000 }),
    ]);
    expect([r1.allowed, r2.allowed].filter(Boolean)).toHaveLength(1);
    await db.execute(sql`DELETE FROM auth_rate_limits WHERE scope = '05b:race'`);
  });

  it("I: cluster-wide SSE admission shares caps across instances and releases on close/crash", async () => {
    const limits = { perUser: 5, perIp: 100, global: 100, leaseTtlMs: 60_000 };
    const instanceA = new ClusterSseAdmission(db, limits);
    const instanceB = new ClusterSseAdmission(db, limits);
    const user = randomUUID();

    const handles: Array<Awaited<ReturnType<ClusterSseAdmission["admit"]>>> = [];
    for (let i = 0; i < 5; i += 1) handles.push(await instanceA.admit(user, "203.0.113.9"));
    // The SIXTH stream, opened on the OTHER instance, is denied — the cap is
    // cluster-wide, not process-local.
    await expect(instanceB.admit(user, "203.0.113.9")).rejects.toBeInstanceOf(SseAdmissionDeniedError);

    // Normal close releases capacity cluster-wide.
    await handles[0]!.release();
    const reopened = await instanceB.admit(user, "203.0.113.9");
    expect(reopened.connectionId).toBeTruthy();
    await reopened.release();
    for (const handle of handles.slice(1)) await handle.release();

    // Crash semantics: an unreleased lease expires and the sweep reclaims.
    const short = new ClusterSseAdmission(db, { perUser: 5, perIp: 100, global: 100, leaseTtlMs: 50 });
    await short.admit(user, "203.0.113.10");
    await new Promise((resolve) => setTimeout(resolve, 150));
    const reclaimed = await short.sweep(new Date().toISOString());
    expect(reclaimed).toBeGreaterThanOrEqual(3); // user + ip + global leases
    await expect(short.admit(user, "203.0.113.10")).resolves.toBeTruthy();
  });
});
