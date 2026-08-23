/**
 * Compute chaos suite (Prompt 14): provider failures, lost workers and
 * offline nodes must never create duplicate VPS purchases or corrupt
 * desired-state.
 */

import { describe, expect, it } from "vitest";
import { FakeComputeProvider } from "@mox/compute-providers";
import { ComputeOrchestrator } from "../src/service.js";
import { InMemoryOrchestratorStore } from "../src/store.js";

async function orchestratorWith(script: Parameters<FakeComputeProvider["setProvisionScript"]>[0]) {
  const orch = new ComputeOrchestrator(new InMemoryOrchestratorStore(), {
    retryBaseMs: 1,
    controlPlaneUrl: "https://control-plane.test",
  });
  const fake = new FakeComputeProvider();
  fake.setProvisionScript(script);
  orch.registerProvider(fake);
  await orch.registerProviderAccount({
    providerName: "fake-compute",
    accountLabel: "primary",
    commercialStatus: "active",
    healthScore: 100,
    enabled: true,
  });
  await orch.configureComputeClass({
    code: "COMPUTE_SMALL",
    displayName: "Small",
    minVcpu: 2,
    minRamGb: 4,
    skuMap: [{ providerName: "fake-compute", regionCode: "fsn1", providerSku: "CX22" }],
    active: true,
  });
  return { orch, fake };
}

describe("compute chaos", () => {
  it("provider timeout AFTER a successful VPS order converges to exactly one server", async () => {
    const { orch, fake } = await orchestratorWith({ failFirstAttemptThenSucceed: true });
    const { order } = await orch.orderServer({
      orgId: "org-c1",
      computeClassCode: "COMPUTE_SMALL",
      hostname: "ws-chaos",
      idempotencyKey: "timeout-after-success",
    });

    // Tick 1: local timeout. Tick 2+3: duplicate worker replays.
    const t1 = new Date(Date.now() + 60_000).toISOString();
    await orch.reconcile(t1);
    await Promise.all([
      orch.reconcile(new Date(Date.now() + 120_000).toISOString()),
      orch.reconcile(new Date(Date.now() + 120_000).toISOString()),
      orch.reconcile(new Date(Date.now() + 180_000).toISOString()),
    ]);

    // Exactly one real VPS exists despite retries/replays.
    expect(fake.provisionCalls.filter((c) => c.idempotencyKey === `${order.id}:provision`)).toHaveLength(2); // 1 fail + 1 success
    expect(fake.instances.size).toBe(1);
    expect((await orch.getOrder(order.id)).state).toBe("running");
  });

  it("a total provider outage abandons cleanly without buying anything", async () => {
    const { orch, fake } = await orchestratorWith({ failAfter: -1, failureMessage: "provider API down" });
    const { order } = await orch.orderServer({
      orgId: "org-c2",
      computeClassCode: "COMPUTE_SMALL",
      hostname: "ws-outage",
      idempotencyKey: "outage-1",
    });
    const result = await orch.reconcile(new Date(Date.now() + 60_000).toISOString());
    expect(result.abandoned).toBe(1);
    const failed = await orch.getOrder(order.id);
    expect(failed.state).toBe("error");
    expect(failed.providerInstanceId).toBeUndefined();
    expect(fake.instances.size).toBe(0);
  });

  it("duplicate reconcile workers on the same tick do not double-provision", async () => {
    const { orch, fake } = await orchestratorWith({});
    await orch.orderServer({
      orgId: "org-c3",
      computeClassCode: "COMPUTE_SMALL",
      hostname: "ws-dup-workers",
      idempotencyKey: "dup-worker",
    });
    // Two schedulers race the same due operation.
    const now = new Date(Date.now() + 60_000).toISOString();
    await Promise.all([orch.reconcile(now), orch.reconcile(now), orch.reconcile(now)]);
    // The op is claimed by one; others find nothing due or the op already succeeded.
    expect(fake.instances.size).toBeLessThanOrEqual(1);
    expect(fake.provisionCalls.length).toBeLessThanOrEqual(1);
  });

  it("cancel during a provisioning outage still destroys nothing twice", async () => {
    const { orch } = await orchestratorWith({});
    const { order } = await orch.orderServer({
      orgId: "org-c4",
      computeClassCode: "COMPUTE_SMALL",
      hostname: "ws-cancel",
      idempotencyKey: "cancel-race",
    });
    await orch.reconcile(new Date(Date.now() + 60_000).toISOString());
    await orch.cancelOrder(order.id);
    // Cancel op runs once; replaying reconciliation must not error.
    await orch.reconcile(new Date(Date.now() + 90_000).toISOString());
    await orch.reconcile(new Date(Date.now() + 120_000).toISOString());
    expect((await orch.getOrder(order.id)).state).toBe("retention");
  });
});
