import { describe, expect, it } from "vitest";
import { FakeComputeProvider, HetznerProvider } from "@mox/compute-providers";
import { ComputeOrchestrator } from "../src/service.js";
import { InMemoryOrchestratorStore } from "../src/store.js";

const NODE_ENROLLMENT_SECRET = "test-only-mox-node-enrollment-secret-32-bytes-minimum";

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function orchestrator(): Promise<{ orch: ComputeOrchestrator; fake: FakeComputeProvider }> {
  const orch = new ComputeOrchestrator(new InMemoryOrchestratorStore(), {
    retryBaseMs: 1,
    nodeEnrollmentSecret: NODE_ENROLLMENT_SECRET,
  });
  const fake = new FakeComputeProvider();
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
    displayName: "Small (>=2 vCPU / 4 GB)",
    minVcpu: 2,
    minRamGb: 4,
    skuMap: [{ providerName: "fake-compute", regionCode: "fsn1", providerSku: "CX22" }],
    active: true,
  });
  await orch.configureComputeClass({
    code: "COMPUTE_MEDIUM",
    displayName: "Medium (>=4 vCPU / 8 GB)",
    minVcpu: 4,
    minRamGb: 8,
    skuMap: [{ providerName: "fake-compute", regionCode: "fsn1", providerSku: "CX32" }],
    active: true,
  });
  return { orch, fake };
}

describe("compute orchestrator", () => {
  it("double-click ordering buys exactly one VPS", async () => {
    const { orch, fake } = await orchestrator();
    const input = {
      orgId: "org-1",
      computeClassCode: "COMPUTE_SMALL",
      hostname: "ws-org-1",
      idempotencyKey: "order-click-1",
    };
    const first = await orch.orderServer(input);
    const second = await orch.orderServer(input);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.order.id).toBe(first.order.id);
    await orch.reconcile();
    expect(fake.provisionCalls.filter((c) => c.idempotencyKey === `${first.order.id}:provision`)).toHaveLength(1);
    const order = await orch.getOrder(first.order.id);
    expect(order.state).toBe("running");
    expect(order.ipv4).toMatch(/^203\.0\.113\./);
  });

  it("retries retryable provider failures with backoff until success", async () => {
    const { orch, fake } = await orchestrator();
    fake.setProvisionScript({ failFirstAttemptThenSucceed: true });
    const { order } = await orch.orderServer({
      orgId: "org-2",
      computeClassCode: "COMPUTE_SMALL",
      hostname: "ws-org-2",
      idempotencyKey: "k",
    });
    let result = await orch.reconcile(new Date(Date.now() + 60_000).toISOString());
    expect(result.failed).toBe(1);
    expect((await orch.getOrder(order.id)).state).toBe("provisioning");
    result = await orch.reconcile(new Date(Date.now() + 120_000).toISOString());
    expect(result.succeeded).toBe(1);
    expect(fake.provisionCalls).toHaveLength(2);
    expect((await orch.getOrder(order.id)).state).toBe("running");
  });

  it("abandons operations after max attempts and marks the order error", async () => {
    const { orch, fake } = await orchestrator();
    fake.setProvisionScript({ failAfter: -1, failureMessage: "quota exhausted" });
    const { order } = await orch.orderServer({
      orgId: "org-3",
      computeClassCode: "COMPUTE_SMALL",
      hostname: "ws-org-3",
      idempotencyKey: "k3",
    });
    const result = await orch.reconcile(new Date(Date.now() + 60_000).toISOString());
    expect(result.abandoned).toBe(1);
    const failed = await orch.getOrder(order.id);
    expect(failed.state).toBe("error");
    expect(failed.lastError).toContain("quota exhausted");
  });

  it("handles provider success arriving after a local timeout", async () => {
    const { orch, fake } = await orchestrator();
    fake.setProvisionScript({ failFirstAttemptThenSucceed: true });
    const { order } = await orch.orderServer({
      orgId: "org-4",
      computeClassCode: "COMPUTE_SMALL",
      hostname: "ws-org-4",
      idempotencyKey: "late-success",
    });
    await orch.reconcile(new Date(Date.now() + 60_000).toISOString());
    const beforeCount = fake.instances.size;
    await orch.reconcile(new Date(Date.now() + 120_000).toISOString());
    expect(fake.instances.size).toBeGreaterThanOrEqual(beforeCount);
    expect((await orch.getOrder(order.id)).providerInstanceId).toBeTruthy();
  });

  it("reuses the same signed enrollment grant across a provider retry", async () => {
    const { orch, fake } = await orchestrator();
    fake.setProvisionScript({ failFirstAttemptThenSucceed: true });
    const { order } = await orch.orderServer({
      orgId: "org-retry-token",
      computeClassCode: "COMPUTE_SMALL",
      hostname: "ws-token",
      idempotencyKey: "token-retry",
    });
    const firstAt = new Date(Date.now() + 60_000).toISOString();
    await orch.reconcile(firstAt);
    const first = await orch.issueNodeEnrollment(order.id, { now: firstAt });
    const secondAt = new Date(Date.now() + 120_000).toISOString();
    await orch.reconcile(secondAt);
    const second = await orch.issueNodeEnrollment(order.id, { now: secondAt });
    expect(second.token).toBe(first.token);
  });

  it("resizes through the provider and updates desired SKU", async () => {
    const { orch } = await orchestrator();
    const { order } = await orch.orderServer({
      orgId: "org-5",
      computeClassCode: "COMPUTE_SMALL",
      hostname: "ws-org-5",
      idempotencyKey: "k5",
    });
    await orch.reconcile();
    expect((await orch.getOrder(order.id)).providerSku).toBe("CX22");

    await orch.requestResize(order.id, "COMPUTE_MEDIUM");
    await orch.reconcile();
    const resized = await orch.getOrder(order.id);
    expect(resized.providerSku).toBe("CX32");
    expect(resized.state).toBe("running");
  });

  it("cancel flows through the provider even offline, then retention destroys", async () => {
    const { orch, fake } = await orchestrator();
    const { order } = await orch.orderServer({
      orgId: "org-6",
      computeClassCode: "COMPUTE_SMALL",
      hostname: "ws-org-6",
      idempotencyKey: "k6",
    });
    await orch.reconcile();
    const instanceId = (await orch.getOrder(order.id)).providerInstanceId!;

    await orch.cancelOrder(order.id);
    await orch.reconcile();
    const canceled = await orch.getOrder(order.id);
    expect(canceled.state).toBe("retention");
    expect(fake.instances.has(instanceId)).toBe(false);

    const destroyed = await orch.runRetentionSweep(new Date(Date.parse(canceled.retentionUntil!) + 1000).toISOString());
    expect(destroyed).toBe(1);
    expect((await orch.getOrder(order.id)).state).toBe("destroyed");
  });

  it("derives node ownership only from a signed one-time server grant", async () => {
    const { orch } = await orchestrator();
    const { order } = await orch.orderServer({
      orgId: "org-7",
      computeClassCode: "COMPUTE_SMALL",
      hostname: "ws-org-7",
      idempotencyKey: "k7",
    });
    const enrollment = await orch.issueNodeEnrollment(order.id, { now: "2026-03-01T00:00:00.000Z" });
    const { node, agentToken } = await orch.enrollNode({
      nodeId: "node-a",
      enrollToken: enrollment.token,
      version: "0.1.0",
      capabilities: ["docker", "logs"],
      now: "2026-03-01T00:00:01.000Z",
    });
    expect(node.status).toBe("active");
    expect(node.orgId).toBe("org-7");
    expect(node.orderId).toBe(order.id);
    expect(node.agentTokenHash).toBeTruthy();
    expect(node.agentTokenHash).not.toBe(agentToken);

    await orch.heartbeat("node-a", agentToken, { cpu: 12, memPct: 40 }, undefined, "2026-03-01T00:30:00.000Z");
    const lost = await orch.sweepLostNodes("2026-03-01T00:36:00.000Z");
    expect(lost).toEqual(["node-a"]);

    await orch.heartbeat("node-a", agentToken, { cpu: 9 }, undefined, "2026-03-01T00:37:00.000Z");
    expect((await orch.store.getNode("node-a"))?.status).toBe("active");
  });

  it("rejects arbitrary, forged, reused and wrong node bearer tokens", async () => {
    const { orch } = await orchestrator();
    await expect(
      orch.enrollNode({ nodeId: "node-evil", enrollToken: "attacker-chosen-token" }),
    ).rejects.toThrow(/malformed|invalid/);

    const { order } = await orch.orderServer({
      orgId: "org-8",
      computeClassCode: "COMPUTE_SMALL",
      hostname: "ws-org-8",
      idempotencyKey: "k8",
    });
    const grant = await orch.issueNodeEnrollment(order.id);
    const enrolled = await orch.enrollNode({ nodeId: "node-b", enrollToken: grant.token });
    await expect(orch.enrollNode({ nodeId: "node-b", enrollToken: grant.token })).rejects.toThrow(/consumed/);
    await expect(orch.heartbeat("node-b", "wrong-bearer", { cpu: 1 })).rejects.toThrow(/bearer token/);
    await expect(orch.heartbeat("node-b", enrolled.agentToken, { cpu: 1 })).resolves.toBeUndefined();
  });

  it("refuses candidates that are not commercially approved (Hetzner verify)", async () => {
    const orch = new ComputeOrchestrator(new InMemoryOrchestratorStore(), {
      retryBaseMs: 1,
      nodeEnrollmentSecret: NODE_ENROLLMENT_SECRET,
    });
    const hetzner = new HetznerProvider(
      { apiToken: "tok" },
      {
        commercialStatus: "verify",
        fetchImpl: async () =>
          jsonRes(201, {
            server: {
              id: 1,
              name: "h",
              status: "initializing",
              server_type: { name: "cpx41" },
              datacenter: { location: { name: "fsn1" } },
            },
          }),
      },
    );
    orch.registerProvider(hetzner);
    await orch.configureComputeClass({
      code: "COMPUTE_LARGE",
      displayName: "Large",
      minVcpu: 8,
      minRamGb: 16,
      skuMap: [{ providerName: "hetzner", regionCode: "fsn1", providerSku: "cpx41" }],
      active: true,
    });
    const { order } = await orch.orderServer({
      orgId: "org-9",
      computeClassCode: "COMPUTE_LARGE",
      hostname: "h",
      idempotencyKey: "k9",
    });
    await orch.reconcile(new Date(Date.now() + 60_000).toISOString());
    const failedOrder = await orch.getOrder(order.id);
    expect(failedOrder.state).toBe("error");
    expect(failedOrder.lastError).toContain("not commercially approved");

    await orch.registerProviderAccount({
      providerName: "hetzner",
      accountLabel: "eu-central",
      commercialStatus: "approved",
      healthScore: 100,
      enabled: true,
    });
    (hetzner as unknown as { commercialStatus: string }).commercialStatus = "approved";
    const second = await orch.orderServer({
      orgId: "org-9",
      computeClassCode: "COMPUTE_LARGE",
      hostname: "h2",
      idempotencyKey: "k9b",
    });
    await orch.reconcile(new Date(Date.now() + 60_000).toISOString());
    expect((await orch.getOrder(second.order.id)).state).toBe("running");
  });

  it("never exposes root credentials in orders or errors", async () => {
    const { orch, fake } = await orchestrator();
    const key = await orch.addSshKey("org-10", "laptop", "ssh-ed25519 AAAATEST user@host");
    const { order } = await orch.orderServer({
      orgId: "org-10",
      computeClassCode: "COMPUTE_SMALL",
      hostname: "ws-org-10",
      idempotencyKey: "k10",
      sshKeyId: key.id,
    });
    await orch.reconcile();
    const stored = await orch.getOrder(order.id);
    const serialized = JSON.stringify(stored);
    expect(serialized).not.toContain("AAAATEST");
    expect(serialized).not.toMatch(/password/i);
    expect(await orch.store.getSshKey(key.id)).toBeTruthy();
    void fake;
  });

  it("reports provider health for configured providers only", async () => {
    const { orch } = await orchestrator();
    const reports = await orch.providerHealth();
    expect(reports).toHaveLength(1);
    expect(reports[0]?.report.state).toBe("healthy");
  });
});
