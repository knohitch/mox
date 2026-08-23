/**
 * Cross-cutting security suite (Prompt 14): tenant isolation, node
 * impersonation, admin escalation, webhook replay and secret redaction.
 */

import { describe, expect, it } from "vitest";
import { EntitlementService, InMemoryEntitlementStore } from "@mox/entitlements";
import { AgentControlService } from "../../agent-control/src/service.js";
import { InMemoryAgentControlStore } from "../../agent-control/src/store.js";
import { CommandVerifier, signCommand } from "@mox/mox-node";
import { redactMetadata, scrubLogLine, verifyGatewayToken } from "@mox/security";
import { BillingService, FakeBillingProvider, InMemoryBillingStore, seedCatalog, signPayload } from "@mox/billing";

describe("tenant isolation", () => {
  it("terminal access is denied across tenants", async () => {
    const entitlements = new EntitlementService(new InMemoryEntitlementStore());
    await entitlements.setPlanValues("plan-version-current", { cli_sessions: true });
    const svc = new AgentControlService(new InMemoryAgentControlStore(), {
      entitlements,
      serverOwnership: {
        async ownerOf(id) {
          return id === "srv-a" ? "org-owner" : undefined;
        },
      },
    });
    await expect(
      svc.openTerminal({ orgId: "org-attacker", userId: "u-x", serverOrderId: "srv-a" }),
    ).rejects.toThrow(/owned by your organization/);
    // The victim's own access still works.
    await expect(
      svc.openTerminal({ orgId: "org-owner", userId: "u-victim", serverOrderId: "srv-a" }),
    ).resolves.toBeTruthy();
  });

  it("entitlement resolution never leaks overrides across orgs", async () => {
    const svc = new EntitlementService(new InMemoryEntitlementStore());
    await svc.setPlanValues("plan-v1", { max_agents: 2 });
    await svc.grantOverride({ orgId: "org-rich", key: "max_agents", value: 500, grantedBy: "admin" });
    // Another org on the SAME plan version sees only plan values.
    const attacker = await svc.resolve("org-poor", "max_agents", "plan-v1");
    expect(attacker.value).toBe(2);
  });

  it("admin role escalation is structurally rejected", async () => {
    const entitlements = new EntitlementService(new InMemoryEntitlementStore());
    const { AdminService } = await import("../../admin/src/service.js");
    const admin = new AdminService({
      entitlements,
      flags: new (await import("@mox/feature-flags")).FeatureFlagService(),
      costs: new (await import("@mox/cost-engine")).CostEngine(),
      enterprise: new (await import("../../admin/src/enterprise.js")).EnterpriseContractService(entitlements),
    });
    // A support-role actor cannot mint superadmin powers by passing another role.
    const supportActor = { userId: "u-support", role: "support" as const };
    await expect(
      admin.setSystemSetting(supportActor, { key: "anything", value: "x" }),
    ).rejects.toThrow(/settings.write/);
  });
});

describe("node impersonation", () => {
  it("a forged node identity cannot enroll without the pre-persisted bootstrap secret", async () => {
    const { ComputeOrchestrator } = await import("../../compute-orchestrator/src/service.js");
    const { InMemoryOrchestratorStore, sha256Hex } = await import("../../compute-orchestrator/src/store.js");
    const store = new InMemoryOrchestratorStore();
    const orch = new ComputeOrchestrator(store, { controlPlaneUrl: "https://control-plane.test" });
    // Provisioning pre-persists ONLY the expected hash bound to org+order (§E)
    // and anchors enrollment to a provisioned server order (00B §F).
    const orderId = "11111111-1111-4111-8111-111111111111";
    await store.insertOrder({
      id: orderId,
      orgId: "org-real",
      computeClassCode: "COMPUTE_SMALL",
      state: "running",
      hostname: "ws-victim",
      providerInstanceId: "inst-victim",
      idempotencyKey: "k-impersonation",
      attemptCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await store.createEnrollmentToken({
      id: "22222222-2222-4222-8222-222222222222",
      tokenHash: sha256Hex("real-secret"),
      orgId: "org-real",
      orderId,
      providerInstanceId: "inst-victim",
      state: "issued",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      createdAt: new Date().toISOString(),
    });
    // Forged token fails; forged org binding fails; nothing is created.
    await expect(
      orch.enrollNode({ orgId: "org-real", orderId, nodeId: "node-victim", enrollToken: "forged-token" }),
    ).rejects.toThrow(/unknown enrollment token/);
    await expect(
      orch.enrollNode({ orgId: "org-attacker", orderId, nodeId: "node-victim", enrollToken: "real-secret" }),
    ).rejects.toThrow(/does not own this order|org mismatch/);
    await expect(orch.store.getNode("node-victim")).resolves.toBeUndefined();
  });

  it("commands signed with the wrong secret are rejected; replay blocked", () => {
    const verifier = new CommandVerifier();
    const forged = signCommand("attacker-secret", {
      nonce: "n-forged",
      kind: "deployment.apply",
      payload: { spec: { name: "backdoor", image: "ghcr.io/evil/x" } },
      issuedAt: new Date().toISOString(),
    });
    expect(verifier.verify("control-plane-secret", forged).ok).toBe(false);

    const legit = signCommand("control-plane-secret", {
      nonce: "n-legit",
      kind: "workload.stop",
      payload: { name: "agent" },
      issuedAt: new Date().toISOString(),
    });
    expect(verifier.verify("control-plane-secret", legit).ok).toBe(true);
    expect(verifier.verify("control-plane-secret", legit).reason).toBe("replayed_nonce");
  });

  it("expired gateway tokens are rejected for direct browser-service access", () => {
    const past = new Date(Date.now() - 60_000);
    const token = `${Buffer.from(JSON.stringify({ exp: past.getTime() })).toString("base64url")}.${"a".repeat(64)}`;
    const result = verifyGatewayToken(token);
    expect(result.ok).toBe(false);
    void result;
  });
});

describe("secret hygiene", () => {
  it("redaction strips secret-shaped material from nested metadata and logs", () => {
    const metadata = {
      config: {
        apiKey: "sk-live-abc123",
        nested: [{ password: "hunter2" }, { safe: "value" }],
        authorization: "Bearer xyz",
      },
      note: "keep me",
    };
    const cleaned = JSON.stringify(redactMetadata(metadata));
    expect(cleaned).not.toContain("sk-live-abc123");
    expect(cleaned).not.toContain("hunter2");
    expect(cleaned).not.toContain("Bearer xyz");
    expect(cleaned).toContain("keep me");
    expect(cleaned).toContain("value");

    const line = scrubLogLine("user paid with card 4242-4242-4242-4242 using sk-proj-9abcdef");
    expect(line).not.toContain("4242-4242-4242-4242");
    expect(line).not.toContain("sk-proj-9abcdef");
  });

  it("billing webhook replay after application is a no-op", async () => {
    const billing = new BillingService(new InMemoryBillingStore());
    billing.registerProvider(new FakeBillingProvider("gw", "sec"));
    const catalog = await seedCatalog(billing);
    const { session } = await billing.createCheckout({
      orgId: "org-r",
      productId: catalog.productIds.plus!,
      planVersionId: catalog.activePlanVersionIds.plus!,
      pricingRegionCode: "GLOBAL",
      successUrl: "s",
      cancelUrl: "c",
      providerName: "gw",
    });
    const raw = JSON.stringify({ eventId: "rp-1", type: "checkout.completed", subjectRef: session.providerRef, checkoutSessionId: session.id });
    const ts = new Date().toISOString();
    const headers = { "x-mox-timestamp": ts, "x-mox-signature": signPayload("sec", raw, ts) };

    const first = await billing.handleProviderWebhook("gw", headers, raw);
    expect(first.applied).toBe(true);
    // Replay much later — same event id → duplicate, no second subscription.
    const replay = await billing.handleProviderWebhook("gw", headers, raw);
    expect(replay.duplicate).toBe(true);
    expect(await billing.getActiveSubscription("org-r")).toBeTruthy();
  });
});
