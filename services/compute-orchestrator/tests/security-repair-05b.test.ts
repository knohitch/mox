/**
 * Security Repair 05B regression tests (finding A/B/J) at the orchestrator
 * level over the in-memory tier. The PostgreSQL race variants live in
 * services/control-plane/tests/security-repair-05b.test.ts (PG-gated).
 */

import { describe, expect, it } from "vitest";
import { FakeComputeProvider, ProviderError } from "@mox/compute-providers";
import {
  ComputeOrchestrator,
  InMemoryOrchestratorStore,
  QuotaExceededError,
  type ServerOperation,
} from "../src/index.js";

async function orchestrator() {
  const orch = new ComputeOrchestrator(new InMemoryOrchestratorStore(), {
    retryBaseMs: 1,
    controlPlaneUrl: "https://control-plane.test",
  });
  const fake = new FakeComputeProvider();
  orch.registerProvider(fake);
  await orch.registerProviderAccount({ providerName: "fake-compute", accountLabel: "primary", commercialStatus: "active", healthScore: 100, enabled: true });
  await orch.configureComputeClass({
    code: "COMPUTE_SMALL_05B",
    displayName: "Small",
    minVcpu: 2,
    minRamGb: 4,
    skuMap: [{ providerName: "fake-compute", regionCode: "fsn1", providerSku: "CX22" }],
    active: true,
  });
  return { orch, fake };
}

const ORDER_OPTS = { computeClassCode: "COMPUTE_SMALL_05B", hostname: "ws-05b" };

describe("Security Repair 05B — server-order lifecycle (finding J)", () => {
  it("duplicate cancel in terminal states is a no-op (retention/destroyed)", async () => {
    const { orch } = await orchestrator();
    const { order } = await orch.orderServer({ orgId: "org-j1", idempotencyKey: "j1", ...ORDER_OPTS });
    await orch.reconcile(new Date(Date.now() + 60_000).toISOString());
    expect((await orch.getOrder(order.id)).state).toBe("running");

    await orch.cancelOrder(order.id);
    await orch.reconcile(new Date(Date.now() + 60_000).toISOString());
    const retention = await orch.getOrder(order.id);
    expect(retention.state).toBe("retention");

    // Duplicate cancel in retention: idempotent no-op — no second cancel op.
    await orch.cancelOrder(order.id);
    const ops = await orch.store.dueOperations("2099-01-01T00:00:00Z");
    expect(ops.filter((op) => op.orderId === order.id && op.kind === "cancel")).toHaveLength(0);

    // Destroyed is terminal too.
    await orch.runRetentionSweep(new Date(Date.now() + 20 * 24 * 3600_000).toISOString());
    expect((await orch.getOrder(order.id)).state).toBe("destroyed");
    await orch.cancelOrder(order.id); // must not throw or enqueue
    expect((await orch.getOrder(order.id)).state).toBe("destroyed");
  });

  it("an abandoned cancel reaches a visible reconciliable state, not cancelling limbo", async () => {
    const { orch, fake } = await orchestrator();
    const { order } = await orch.orderServer({ orgId: "org-j2", idempotencyKey: "j2", ...ORDER_OPTS });
    await orch.reconcile(new Date(Date.now() + 60_000).toISOString());
    expect((await orch.getOrder(order.id)).state).toBe("running");

    // Genuine provider failure: 404 is intentionally treated as already absent
    // for cancellation, so use a retryable 503 and exhaust the durable retries.
    fake.cancel = async () => {
      throw new ProviderError("simulated provider unavailable", { retryable: true, httpStatus: 503 });
    };
    await orch.cancelOrder(order.id);
    const retryBase = Date.now() + 60_000;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await orch.reconcile(new Date(retryBase + attempt * 1_000).toISOString());
    }
    const after = await orch.getOrder(order.id);
    expect(after.state).toBe("error");
    expect(after.lastError).toMatch(/cancel abandoned/);
    // The operation itself is abandoned (visible), never queued forever.
    const op = await orch.store.getOperation(order.id, "cancel", `${order.id}:cancel`);
    expect(op?.state).toBe("abandoned");
  });

  it("reboots use request identities: replay dedupes, a new request creates a new operation", async () => {
    const { orch } = await orchestrator();
    const { order } = await orch.orderServer({ orgId: "org-j3", idempotencyKey: "j3", ...ORDER_OPTS });
    await orch.reconcile(new Date(Date.now() + 60_000).toISOString());

    const first = await orch.requestReboot(order.id, "req-r1");
    await orch.reconcile(new Date(Date.now() + 60_000).toISOString());
    expect((await orch.store.getOperation(order.id, "reboot", `${order.id}:reboot:req-r1`))!.state).toBe("succeeded");

    // Replay of the SAME request identity: idempotent (same terminal op).
    const replay = await orch.requestReboot(order.id, "req-r1");
    expect(replay.id).toBe(first.id);

    // A NEW request identity creates a NEW reboot operation — reboots are
    // repeatable server actions, never permanently deduped per order.
    const second = await orch.requestReboot(order.id, "req-r2");
    expect(second.id).not.toBe(first.id);
    await orch.reconcile(new Date(Date.now() + 60_000).toISOString());
    expect((await orch.store.getOperation(order.id, "reboot", `${order.id}:reboot:req-r2`))!.state).toBe("succeeded");
  });
});

describe("Security Repair 05B — atomic quota (finding B, in-memory mirror)", () => {
  it("quota=1 with two distinct concurrent keys yields exactly one order", async () => {
    const { orch } = await orchestrator();
    const results = await Promise.allSettled([
      orch.orderServer({ orgId: "org-q1", idempotencyKey: "q1a", maxServers: 1, ...ORDER_OPTS }),
      orch.orderServer({ orgId: "org-q1", idempotencyKey: "q1b", maxServers: 1, ...ORDER_OPTS }),
    ]);
    const created = results.filter((r) => r.status === "fulfilled" && (r as PromiseFulfilledResult<{ created: boolean }>).value.created);
    const denied = results.filter((r) => r.status === "rejected" && (r as PromiseRejectedResult).reason instanceof QuotaExceededError);
    expect(created).toHaveLength(1);
    expect(denied).toHaveLength(1);
    const orders = await orch.listOrders("org-q1");
    expect(orders.filter((o) => ["requested", "provisioning", "running"].includes(o.state))).toHaveLength(1);
  });

  it("quota=2 with three distinct concurrent keys yields exactly two orders", async () => {
    const { orch } = await orchestrator();
    const results = await Promise.allSettled([
      orch.orderServer({ orgId: "org-q2", idempotencyKey: "q2a", maxServers: 2, ...ORDER_OPTS }),
      orch.orderServer({ orgId: "org-q2", idempotencyKey: "q2b", maxServers: 2, ...ORDER_OPTS }),
      orch.orderServer({ orgId: "org-q2", idempotencyKey: "q2c", maxServers: 2, ...ORDER_OPTS }),
    ]);
    const created = results.filter((r) => r.status === "fulfilled" && (r as PromiseFulfilledResult<{ created: boolean }>).value.created);
    expect(created).toHaveLength(2);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });

  it("same-key replay remains one order even under the reservation path", async () => {
    const { orch } = await orchestrator();
    const first = await orch.orderServer({ orgId: "org-q3", idempotencyKey: "q3", maxServers: 2, ...ORDER_OPTS });
    expect(first.created).toBe(true);
    const replay = await orch.orderServer({ orgId: "org-q3", idempotencyKey: "q3", maxServers: 2, ...ORDER_OPTS });
    expect(replay.created).toBe(false);
    expect(replay.order.id).toBe(first.order.id);
    expect((await orch.listOrders("org-q3")).filter((o) => ["requested", "provisioning", "running"].includes(o.state))).toHaveLength(1);
  });
});

describe("Security Repair 05B — lease fencing semantics (finding A, in-memory mirror)", () => {
  it("a stale worker cannot overwrite a reclaimer's terminal operation", async () => {
    const { orch } = await orchestrator();
    const { order } = await orch.orderServer({ orgId: "org-f1", idempotencyKey: "f1", ...ORDER_OPTS });

    // A claims the provision op.
    const [aClaim] = await orch.store.claimDueOperations(new Date().toISOString(), "worker-a", 5, 10);
    expect(aClaim).toBeDefined();
    expect(aClaim!.leaseOwner).toBe("worker-a");
    // Lease expires; B reclaims the same op (version bumps).
    const [bClaim] = await orch.store.claimDueOperations(new Date(Date.now() + 60_000).toISOString(), "worker-b", 60_000, 10);
    expect(bClaim).toBeDefined();
    expect(bClaim!.leaseVersion).toBeGreaterThan(aClaim!.leaseVersion ?? 0);

    // B succeeds.
    const bOp: ServerOperation = { ...bClaim!, state: "succeeded", leaseOwner: "worker-b" };
    expect(await orch.store.updateOperationFenced(bOp, bClaim!.leaseVersion ?? 0)).toBe(true);

    // A (stale) tries to write failure over B's success: zero effect.
    const aOp: ServerOperation = { ...aClaim!, state: "abandoned", lastError: "stale failure", leaseOwner: "worker-a" };
    expect(await orch.store.updateOperationFenced(aOp, aClaim!.leaseVersion ?? 0)).toBe(false);

    const op = await orch.store.getOperation(order.id, "provision", `${order.id}:provision`);
    expect(op?.state).toBe("succeeded");
    expect(op?.leaseOwner).toBeUndefined();
  });

  it("terminal operations can never be overwritten (state gate)", async () => {
    const { orch } = await orchestrator();
    const { order } = await orch.orderServer({ orgId: "org-f2", idempotencyKey: "f2", ...ORDER_OPTS });
    const [claim] = await orch.store.claimDueOperations(new Date().toISOString(), "worker-a", 60_000, 10);
    expect(claim).toBeDefined();
    const success: ServerOperation = { ...claim!, state: "succeeded", leaseOwner: "worker-a" };
    await orch.store.updateOperationFenced(success, claim!.leaseVersion ?? 0);
    // Even a matching owner+version cannot move a terminal op.
    const regress: ServerOperation = { ...success, state: "failed", leaseOwner: "worker-a" };
    expect(await orch.store.updateOperationFenced(regress, claim!.leaseVersion ?? 0)).toBe(false);
    expect((await orch.store.getOperation(order.id, "provision", `${order.id}:provision`))?.state).toBe("succeeded");
  });
});
