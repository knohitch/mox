import { describe, expect, it } from "vitest";
import { FakeComputeProvider, ProviderError } from "@mox/compute-providers";
import { ComputeOrchestrator, QuotaExceededError } from "../src/service.js";
import { InMemoryOrchestratorStore } from "../src/store.js";

class CancelScriptProvider extends FakeComputeProvider {
  cancelCalls = 0;
  failCancel = false;

  override async cancel(providerInstanceId: string) {
    this.cancelCalls += 1;
    if (this.failCancel) {
      throw new ProviderError("simulated cancel failure", { retryable: false });
    }
    return super.cancel(providerInstanceId);
  }
}

class CancelRaceStore extends InMemoryOrchestratorStore {
  finishOnCancelling = false;

  override async updateOrder(
    order: Parameters<InMemoryOrchestratorStore["updateOrder"]>[0],
  ): Promise<void> {
    await super.updateOrder(order);
    if (!this.finishOnCancelling || order.state !== "cancelling") return;
    this.finishOnCancelling = false;
    const op = await this.getOperation(order.id, "cancel", `${order.id}:cancel`);
    if (op) await super.updateOperation({ ...op, state: "succeeded" });
  }
}

async function fixture(store: InMemoryOrchestratorStore = new InMemoryOrchestratorStore()) {
  const orch = new ComputeOrchestrator(store, {
    retryBaseMs: 1,
    maxAttempts: 1,
    retentionDays: 1,
    controlPlaneUrl: "https://control-plane.test",
  });
  const provider = new CancelScriptProvider();
  orch.registerProvider(provider);
  await orch.registerProviderAccount({
    providerName: provider.name,
    accountLabel: "repair-07",
    commercialStatus: "active",
    healthScore: 100,
    enabled: true,
  });
  await orch.configureComputeClass({
    code: "R07_SMALL",
    displayName: "Repair 07 Small",
    minVcpu: 2,
    minRamGb: 4,
    skuMap: [{ providerName: provider.name, regionCode: "fsn1", providerSku: "CX22" }],
    active: true,
  });
  return { orch, store, provider };
}

async function runningOrder(fx: Awaited<ReturnType<typeof fixture>>, orgId: string, key: string, maxServers?: number) {
  const created = await fx.orch.orderServer({
    orgId,
    computeClassCode: "R07_SMALL",
    hostname: `host-${key}`,
    idempotencyKey: key,
    maxServers,
  });
  await fx.orch.reconcile(new Date(Date.now() + 60_000).toISOString());
  expect((await fx.orch.getOrder(created.order.id)).state).toBe("running");
  return created.order;
}

async function abandonCancel(fx: Awaited<ReturnType<typeof fixture>>, orderId: string) {
  fx.provider.failCancel = true;
  await fx.orch.cancelOrder(orderId);
  const result = await fx.orch.reconcile(new Date(Date.now() + 120_000).toISOString());
  expect(result.abandoned).toBe(1);
  expect((await fx.orch.getOrder(orderId)).state).toBe("error");
  const op = await fx.store.getOperation(orderId, "cancel", `${orderId}:cancel`);
  expect(op?.state).toBe("abandoned");
  return op!;
}

describe("Security Repair 07 — abandoned cancellation retry", () => {
  it("C1: cancel → abandon → error → retry creates runnable durable authority", async () => {
    const fx = await fixture();
    const order = await runningOrder(fx, "org-c1", "c1");
    const abandoned = await abandonCancel(fx, order.id);

    fx.provider.failCancel = false;
    await fx.orch.cancelOrder(order.id);
    const revived = await fx.store.getOperation(order.id, "cancel", `${order.id}:cancel`);
    expect(revived?.id).toBe(abandoned.id);
    expect(revived?.state).toBe("queued");
    expect(revived?.attempts).toBe(0);
    expect((await fx.orch.getOrder(order.id)).state).toBe("cancelling");
  });

  it("C2: successful retry progresses to retention and cannot strand cancelling", async () => {
    const fx = await fixture();
    const order = await runningOrder(fx, "org-c2", "c2");
    await abandonCancel(fx, order.id);
    fx.provider.failCancel = false;
    await fx.orch.cancelOrder(order.id);
    const result = await fx.orch.reconcile(new Date(Date.now() + 180_000).toISOString());
    expect(result.succeeded).toBe(1);
    expect((await fx.orch.getOrder(order.id)).state).toBe("retention");
    expect((await fx.store.getOperation(order.id, "cancel", `${order.id}:cancel`))?.state).toBe("succeeded");
  });

  it("C3: replaying the same retry/double click is idempotent", async () => {
    const fx = await fixture();
    const order = await runningOrder(fx, "org-c3", "c3");
    const abandoned = await abandonCancel(fx, order.id);
    fx.provider.failCancel = false;

    await Promise.all([fx.orch.cancelOrder(order.id), fx.orch.cancelOrder(order.id)]);
    const revived = await fx.store.getOperation(order.id, "cancel", `${order.id}:cancel`);
    expect(revived?.id).toBe(abandoned.id);
    expect(revived?.state).toBe("queued");
    const callsBeforeReconcile = fx.provider.cancelCalls;
    await fx.orch.reconcile(new Date(Date.now() + 180_000).toISOString());
    expect(fx.provider.cancelCalls - callsBeforeReconcile).toBe(1);
    expect((await fx.orch.getOrder(order.id)).state).toBe("retention");
  });

  it("C3a: a stale duplicate retry cannot overwrite completed authority back to cancelling", async () => {
    const store = new CancelRaceStore();
    const fx = await fixture(store);
    const order = await runningOrder(fx, "org-c3a", "c3a");
    await abandonCancel(fx, order.id);
    fx.provider.failCancel = false;

    store.finishOnCancelling = true;
    await fx.orch.cancelOrder(order.id);

    expect((await fx.store.getOperation(order.id, "cancel", `${order.id}:cancel`))?.state).toBe("succeeded");
    expect((await fx.orch.getOrder(order.id)).state).toBe("retention");
  });

  it("C3b: provider 404 after a prior successful delete converges as idempotent cancellation success", async () => {
    const fx = await fixture();
    const order = await runningOrder(fx, "org-c3b", "c3b");
    const persisted = await fx.orch.getOrder(order.id);
    expect(persisted.providerInstanceId).toBeTruthy();

    // Simulate the provider delete having completed before the worker crashed
    // and persisted the Mox cancellation operation/order transition.
    fx.provider.instances.delete(persisted.providerInstanceId!);
    await fx.orch.cancelOrder(order.id);
    const result = await fx.orch.reconcile(new Date(Date.now() + 180_000).toISOString());

    expect(result.succeeded).toBe(1);
    expect((await fx.orch.getOrder(order.id)).state).toBe("retention");
    expect((await fx.store.getOperation(order.id, "cancel", `${order.id}:cancel`))?.state).toBe("succeeded");
  });

  it("C4: a genuinely later retry can revive the same historical authority again", async () => {
    const fx = await fixture();
    const order = await runningOrder(fx, "org-c4", "c4");
    await abandonCancel(fx, order.id);

    // First intentional retry also fails and becomes abandoned again.
    await fx.orch.cancelOrder(order.id);
    await fx.orch.reconcile(new Date(Date.now() + 180_000).toISOString());
    expect((await fx.store.getOperation(order.id, "cancel", `${order.id}:cancel`))?.state).toBe("abandoned");
    expect((await fx.orch.getOrder(order.id)).state).toBe("error");

    // A later user retry is legitimate new work even though history remains.
    fx.provider.failCancel = false;
    await fx.orch.cancelOrder(order.id);
    expect((await fx.store.getOperation(order.id, "cancel", `${order.id}:cancel`))?.state).toBe("queued");
    await fx.orch.reconcile(new Date(Date.now() + 240_000).toISOString());
    expect((await fx.orch.getOrder(order.id)).state).toBe("retention");
  });

  it("C5: canceled/destroyed/retention duplicate cancellation is a no-op", async () => {
    for (const state of ["canceled", "destroyed", "retention"] as const) {
      const fx = await fixture();
      const { order } = await fx.orch.orderServer({
        orgId: `org-c5-${state}`,
        computeClassCode: "R07_SMALL",
        hostname: `host-${state}`,
        idempotencyKey: `c5-${state}`,
      });
      await fx.store.updateOrder({ ...order, state });
      await fx.orch.cancelOrder(order.id);
      expect((await fx.orch.getOrder(order.id)).state).toBe(state);
      expect(await fx.store.getOperation(order.id, "cancel", `${order.id}:cancel`)).toBeUndefined();
    }
  });

  it("C6: quota=1 is released after a retried cancellation reaches retention", async () => {
    const fx = await fixture();
    const order = await runningOrder(fx, "org-c6", "c6-primary", 1);
    await abandonCancel(fx, order.id);
    fx.provider.failCancel = false;
    await fx.orch.cancelOrder(order.id);

    await expect(fx.orch.orderServer({
      orgId: "org-c6",
      computeClassCode: "R07_SMALL",
      hostname: "host-c6-blocked",
      idempotencyKey: "c6-blocked",
      maxServers: 1,
    })).rejects.toBeInstanceOf(QuotaExceededError);

    await fx.orch.reconcile(new Date(Date.now() + 180_000).toISOString());
    expect((await fx.orch.getOrder(order.id)).state).toBe("retention");
    const replacement = await fx.orch.orderServer({
      orgId: "org-c6",
      computeClassCode: "R07_SMALL",
      hostname: "host-c6-replacement",
      idempotencyKey: "c6-replacement",
      maxServers: 1,
    });
    expect(replacement.created).toBe(true);
  });
});
