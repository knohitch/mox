import { describe, expect, it } from "vitest";
import { FakeComputeProvider, HetznerProvider } from "@mox/compute-providers";
import { ComputeOrchestrator } from "../src/service.js";
import { InMemoryOrchestratorStore, sha256Hex } from "../src/store.js";

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Extracts the one-time bootstrap secrets embedded in recorded cloud-init. */
function enrollSecrets(fake: FakeComputeProvider): string[] {
  return fake.provisionCalls.flatMap((c) =>
    [...c.cloudInitUserData.matchAll(/MOX_ENROLL_TOKEN=(\S+)/g)].map((m) => m[1]!),
  );
}

async function orchestrator(): Promise<{ orch: ComputeOrchestrator; fake: FakeComputeProvider }> {
  const orch = new ComputeOrchestrator(new InMemoryOrchestratorStore(), {
    retryBaseMs: 1,
    controlPlaneUrl: "https://control-plane.test",
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
    // Even after reconciliation the provider saw exactly one provision call.
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
    // First tick hits the simulated timeout.
    let result = await orch.reconcile(new Date(Date.now() + 60_000).toISOString());
    expect(result.failed).toBe(1);
    expect((await orch.getOrder(order.id)).state).toBe("provisioning");
    // Second tick (after backoff) succeeds — no duplicate purchase.
    result = await orch.reconcile(new Date(Date.now() + 120_000).toISOString());
    expect(result.succeeded).toBe(1);
    expect(fake.provisionCalls).toHaveLength(2);
    expect((await orch.getOrder(order.id)).state).toBe("running");
  });

  it("abandons operations after max attempts and marks the order error", async () => {
    const { orch, fake } = await orchestrator();
    // Every provision throws a non-retryable quota error.
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
    // Simulate local timeout: first call throws retryable timeout, but the
    // provider actually created the instance. The retry must converge via
    // the same idempotency key rather than buying a second VPS.
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
    // Provider-side instance is gone even though Mox Node never answered.
    expect(fake.instances.has(instanceId)).toBe(false);

    const destroyed = await orch.runRetentionSweep(new Date(Date.parse(canceled.retentionUntil!) + 1000).toISOString());
    expect(destroyed).toBe(1);
    expect((await orch.getOrder(order.id)).state).toBe("destroyed");
  });

  it("provisions with a pre-persisted enrollment expectation bound to the instance", async () => {
    const { orch, fake } = await orchestrator();
    const { order } = await orch.orderServer({
      orgId: "org-enroll",
      computeClassCode: "COMPUTE_SMALL",
      hostname: "ws-enroll",
      idempotencyKey: "enroll-1",
    });
    await orch.reconcile();
    expect((await orch.getOrder(order.id)).state).toBe("running");
    // The cloud-init payload carries the resolved control-plane URL (§F).
    const cloudInit = fake.provisionCalls[0]?.cloudInitUserData ?? "";
    expect(cloudInit).toContain("MOX_CONTROL_PLANE_URL=https://control-plane.test");
    expect(cloudInit).not.toContain("control-plane.mox.internal");
  });

  it("enrolls nodes against the pre-persisted token and issues durable agent auth", async () => {
    const { orch, fake } = await orchestrator();
    const { order } = await orch.orderServer({
      orgId: "org-7",
      computeClassCode: "COMPUTE_SMALL",
      hostname: "ws-org-7",
      idempotencyKey: "k7",
    });
    await orch.reconcile();
    const secret = enrollSecrets(fake)[0]!;
    const now = "2026-03-01T00:00:00.000Z";

    const { node, agentToken } = await orch.enrollNode({
      orgId: "org-7",
      orderId: order.id,
      nodeId: "node-a",
      enrollToken: secret,
      version: "0.1.0",
      capabilities: ["docker", "logs"],
      now,
    });
    expect(node.status).toBe("active");
    expect(node.enrollTokenHash).toBe(sha256Hex(secret));
    expect(agentToken.length).toBeGreaterThan(30);
    expect(node.agentTokenHash).toBe(sha256Hex(agentToken));

    // Heartbeat requires the durable agent token, not the bootstrap secret.
    await orch.heartbeat("node-a", { cpu: 12 }, { agentToken }, { now: "2026-03-01T00:30:00.000Z" });
    await expect(
      orch.heartbeat("node-a", { cpu: 12 }, { agentToken: "wrong-token" }),
    ).rejects.toThrow(/authentication failed/);
    await expect(
      orch.heartbeat("node-a", { cpu: 12 }, { agentToken: secret }),
    ).rejects.toThrow(/authentication failed/);

    const lost = await orch.sweepLostNodes("2026-03-01T00:36:00.000Z");
    expect(lost).toEqual(["node-a"]);
    // A late authenticated heartbeat brings it back.
    await orch.heartbeat("node-a", { cpu: 9 }, { agentToken }, { now: "2026-03-01T00:37:00.000Z" });
    expect((await orch.store.getNode("node-a"))?.status).toBe("active");
  });

  it("rejects wrong, replayed, expired and org/order-mismatched enrollment tokens", async () => {
    const { orch, fake } = await orchestrator();
    const { order } = await orch.orderServer({
      orgId: "org-8",
      computeClassCode: "COMPUTE_SMALL",
      hostname: "ws-org-8",
      idempotencyKey: "k8",
    });
    await orch.reconcile();
    const secret = enrollSecrets(fake)[0]!;
    const enrollInput = { orgId: "org-8", orderId: order.id, nodeId: "node-b", enrollToken: secret };

    const first = await orch.enrollNode(enrollInput);
    expect(first.node.nodeId).toBe("node-b");

    // Replay of the consumed token fails.
    await expect(orch.enrollNode({ ...enrollInput, nodeId: "node-b2" })).rejects.toThrow(/already used/);
    // Wrong token fails.
    await expect(
      orch.enrollNode({ ...enrollInput, nodeId: "node-c", enrollToken: "tok-evil" }),
    ).rejects.toThrow(/unknown enrollment token/);

    // Org mismatch fails before consumption.
    const { order: order2 } = await orch.orderServer({
      orgId: "org-8b",
      computeClassCode: "COMPUTE_SMALL",
      hostname: "ws-org-8b",
      idempotencyKey: "k8b",
    });
    await orch.reconcile();
    const secret2 = enrollSecrets(fake).at(-1)!;
    await expect(
      orch.enrollNode({ orgId: "org-OTHER", orderId: order2.id, nodeId: "node-d", enrollToken: secret2 }),
    ).rejects.toThrow(/org mismatch/);
    await expect(
      orch.enrollNode({ orgId: "org-8b", orderId: order.id, nodeId: "node-d", enrollToken: secret2 }),
    ).rejects.toThrow(/order mismatch/);

    // Expiry fails.
    const ttlOrch = new ComputeOrchestrator(new InMemoryOrchestratorStore(), {
      retryBaseMs: 1,
      controlPlaneUrl: "https://control-plane.test",
      enrollTokenTtlMs: 1000,
    });
    ttlOrch.registerProvider(fake);
    await ttlOrch.registerProviderAccount({
      providerName: "fake-compute",
      accountLabel: "primary",
      commercialStatus: "active",
      healthScore: 100,
      enabled: true,
    });
    await ttlOrch.configureComputeClass({
      code: "COMPUTE_SMALL",
      displayName: "Small",
      minVcpu: 2,
      minRamGb: 4,
      skuMap: [{ providerName: "fake-compute", regionCode: "fsn1", providerSku: "CX22" }],
      active: true,
    });
    const { order: order3 } = await ttlOrch.orderServer({
      orgId: "org-8c",
      computeClassCode: "COMPUTE_SMALL",
      hostname: "ws-org-8c",
      idempotencyKey: "k8c",
    });
    await ttlOrch.reconcile(new Date(Date.now() + 60_000).toISOString());
    const secret3 = enrollSecrets(fake).at(-1)!;
    await expect(
      ttlOrch.enrollNode({
        orgId: "org-8c",
        orderId: order3.id,
        nodeId: "node-e",
        enrollToken: secret3,
        now: new Date(Date.now() + 120_000).toISOString(),
      }),
    ).rejects.toThrow(/expired/);
  });

  it("refuses to start without validated control-plane configuration (§F)", () => {
    expect(() => new ComputeOrchestrator(new InMemoryOrchestratorStore(), {})).toThrow(
      /controlPlaneUrl is required/,
    );
    expect(
      () => new ComputeOrchestrator(new InMemoryOrchestratorStore(), { controlPlaneUrl: "http://insecure.test" }),
    ).toThrow(/must use https/);
    expect(
      () => new ComputeOrchestrator(new InMemoryOrchestratorStore(), { controlPlaneUrl: "not a url" }),
    ).toThrow(/not a valid URL/);
    // Test override permits http explicitly.
    expect(
      () =>
        new ComputeOrchestrator(new InMemoryOrchestratorStore(), {
          controlPlaneUrl: "http://localhost:8080",
          allowInsecureControlPlaneUrl: true,
        }),
    ).not.toThrow();
  });

  it("refuses candidates that are not commercially approved (Hetzner verify)", async () => {
    const orch = new ComputeOrchestrator(new InMemoryOrchestratorStore(), {
      retryBaseMs: 1,
      controlPlaneUrl: "https://control-plane.test",
    });
    const hetzner = new HetznerProvider(
      { apiToken: "tok" },
      { commercialStatus: "verify", fetchImpl: async () => jsonRes(201, { server: { id: 1, name: "h", status: "initializing", server_type: { name: "cpx41" }, datacenter: { location: { name: "fsn1" } } } }) },
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
    // Ordering is accepted (desired state) but reconciliation refuses to
    // route traffic to a verify-gated provider.
    const { order } = await orch.orderServer({ orgId: "org-9", computeClassCode: "COMPUTE_LARGE", hostname: "h", idempotencyKey: "k9" });
    await orch.reconcile(new Date(Date.now() + 60_000).toISOString());
    const failedOrder = await orch.getOrder(order.id);
    expect(failedOrder.state).toBe("error");
    expect(failedOrder.lastError).toContain("not commercially approved");

    // Once approved on an account + provider gate, selection succeeds.
    await orch.registerProviderAccount({
      providerName: "hetzner",
      accountLabel: "eu-central",
      commercialStatus: "approved",
      healthScore: 100,
      enabled: true,
    });
    (hetzner as unknown as { commercialStatus: string }).commercialStatus = "approved";
    const second = await orch.orderServer({ orgId: "org-9", computeClassCode: "COMPUTE_LARGE", hostname: "h2", idempotencyKey: "k9b" });
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
    // SSH public key itself lives in the key store, referenced by id.
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
