/**
 * Phase 03 §A–§G web seam tests.
 *
 * Covers the demo provider's parity behavior for the commerce + connection
 * surface (billing, BYOK/model connections, integrations & tool grants,
 * channels, personal API tokens) plus the pure domain derivations the views
 * use. Every assertion here encodes a customer-safe contract:
 *   - amounts are integer minor units (never floats in the money text path);
 *   - secrets are accepted once and never echoed;
 *   - credentials are required for channels/integrations that need them;
 *   - grants exist only for connected integrations.
 */

import { describe, expect, it } from "vitest";
import { DemoMoxApi } from "../src/api/demo-api.js";
import { bestPlanPrice, commercialStatus, moneyMinorToDisplay } from "../src/domain/billing.js";
import { channelState, integrationState, modelConnectionState, stateLabel } from "../src/domain/connections.js";

describe("Phase 03 model connections (§B/§G)", () => {
  it("seeds a connected BYOK provider and exposes only the connection projection", async () => {
    const api = new DemoMoxApi();
    const rows = await api.listModelConnections();
    const anthropic = rows.find((r) => r.providerId === "anthropic");
    expect(anthropic?.connected).toBe(true);
    expect(anthropic?.credentialConfigured).toBe(true);
    // Values never appear on the catalog — only readiness.
    for (const r of rows) {
      expect(Object.keys(r)).not.toContain("apiKey");
      expect(Object.keys(r)).not.toContain("secret");
    }
  });

  it("connects an unconfigured provider and persists the bound endpoint", async () => {
    const api = new DemoMoxApi();
    const next = await api.connectModelConnection("gemini", { apiKey: "sk-test-123", baseUrl: "https://generativelanguage.example" });
    expect(next.connected).toBe(true);
    expect(next.credentialConfigured).toBe(true);
    expect(next.baseUrl).toBe("https://generativelanguage.example");
    const again = (await api.listModelConnections()).find((r) => r.providerId === "gemini");
    expect(again?.connected).toBe(true);
    // The apiKey itself is never stored on the row.
    expect((again as unknown as Record<string, unknown>)?.apiKey).toBeUndefined();
  });

  it("rotate keeps the connection alive; disconnect clears it", async () => {
    const api = new DemoMoxApi();
    await api.rotateModelConnection("anthropic", { apiKey: "sk-rotated" });
    expect((await api.listModelConnections()).find((r) => r.providerId === "anthropic")?.connected).toBe(true);
    await api.disconnectModelConnection("anthropic");
    const row = (await api.listModelConnections()).find((r) => r.providerId === "anthropic");
    expect(row?.connected).toBe(false);
    expect(row?.credentialConfigured).toBe(false);
  });

  it("derives the same state the view badges use", () => {
    expect(stateLabel(modelConnectionState({ status: "configured", credentialConfigured: true } as never))).toBe("Connected");
    expect(stateLabel(modelConnectionState({ status: "configured", credentialConfigured: false } as never))).toBe("Needs attention");
    expect(stateLabel(modelConnectionState({ status: "unconfigured" } as never))).toBe("Not configured");
    expect(stateLabel(modelConnectionState({ status: "error" } as never))).toBe("Needs attention");
  });
});

describe("Phase 03 integrations + tool grants (§C)", () => {
  it("seeds connected integrations and requires secrets to connect others", async () => {
    const api = new DemoMoxApi();
    const rows = await api.listIntegrations();
    expect(rows.find((r) => r.integrationId === "github")?.connected).toBe(true);
    expect(rows.find((r) => r.integrationId === "n8n")?.connected).toBe(true);

    await expect(api.connectIntegration("notion", { secrets: { integrationToken: "  " } })).rejects.toThrow(/required/);
    const connected = await api.connectIntegration("notion", { secrets: { integrationToken: "nt-abc" } });
    expect(connected.connected).toBe(true);
    const notion = (await api.listIntegrations()).find((r) => r.integrationId === "notion");
    expect(notion?.credentialConfigured).toBe(true);
    // Secret values never surface on the row.
    expect((notion as unknown as Record<string, unknown>)?.integrationToken).toBeUndefined();
  });

  it("grants only apply to connected integrations and round-trip", async () => {
    const api = new DemoMoxApi();
    await expect(api.grantIntegrationTool("notion", { agentId: "a_code", toolPattern: "notion.read" })).rejects.toThrow(/connect/);

    const { grantId } = await api.grantIntegrationTool("github", { agentId: "a_code", toolPattern: "github.issues.read" });
    expect(grantId).toBeTruthy();
    const grants = await api.listIntegrationGrants("github");
    expect(grants).toHaveLength(1);
    expect(grants[0]?.agentName).toBeTruthy();
    // Idempotent re-grant returns the same grant row.
    const again = await api.grantIntegrationTool("github", { agentId: "a_code", toolPattern: "github.issues.read" });
    expect(again.grantId).toBe(grantId);

    await api.revokeIntegrationGrant("github", grantId);
    expect(await api.listIntegrationGrants("github")).toEqual([]);
  });

  it("special-cases a web hook that needs no manual secret", () => {
    const web = { status: "active", connected: true } as never;
    expect(channelState(web)).toBe("connected");
    expect(stateLabel(integrationState({ status: "active", connected: true } as never))).toBe("Connected");
    expect(stateLabel(integrationState({ status: "disconnected" } as never))).toBe("Disconnected");
  });
});

describe("Phase 03 channels (§D)", () => {
  it("web channels connect without credentials and bind an agent", async () => {
    const api = new DemoMoxApi();
    const res = await api.connectChannel("web", { agentId: "a_writer" });
    expect(res.connected).toBe(true);
    const web = (await api.listChannels()).find((c) => c.channelId === "web");
    expect(web?.boundAgentId).toBe("a_writer");
    expect(web?.connectionId).toBeTruthy();
    // No secret was required, and the test probe answers from the web path.
    expect((await api.testChannel(web!.connectionId!)).ok).toBe(true);
  });

  it("credentialed channels require credentials and store them binding-wise", async () => {
    const api = new DemoMoxApi();
    await expect(api.connectChannel("telegram", { agentId: "a_writer" })).rejects.toThrow(/credentials/);
    const res = await api.connectChannel("telegram", { agentId: "a_writer", secrets: { botToken: "123:ABC" } });
    expect(res.connected).toBe(true);
    const tg = (await api.listChannels()).find((c) => c.channelId === "telegram");
    expect(tg?.status).toBe("active");
    expect((tg as unknown as Record<string, unknown>)?.botToken).toBeUndefined();

    // Reconnect with new credentials; a wrong (empty) secret set is rejected.
    await expect(api.reconnectChannel(tg!.connectionId!, {})).rejects.toThrow(/credentials/);
    const rc = await api.reconnectChannel(tg!.connectionId!, { secrets: { botToken: "456:DEF" } });
    expect(rc.connected).toBe(true);

    await api.disconnectChannel(tg!.connectionId!);
    const after = (await api.listChannels()).find((c) => c.channelId === "telegram");
    expect(after?.connected).toBe(false);
    expect(after?.boundAgentId).toBeNull();
  });

  it("a non-web channel reports honest probe unavailability", async () => {
    const api = new DemoMoxApi();
    await api.connectChannel("telegram", { agentId: "a_writer", secrets: { botToken: "123:ABC" } });
    const tg = (await api.listChannels()).find((c) => c.channelId === "telegram");
    const r = await api.testChannel(tg!.connectionId!);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("not-configured");
  });
});

describe("Phase 03 billing self-service (§A)", () => {
  it("publishes a customer-safe plan catalog with regional pricing", async () => {
    const api = new DemoMoxApi();
    const plans = await api.listPlans();
    expect(plans.some((p) => p.tier === "plus" && p.available)).toBe(true);
    const moneyPlans = plans.filter((p) => p.available);
    for (const p of moneyPlans) {
      for (const r of p.pricingRegions) {
        if (r.available) {
          expect(r.currency).toBeTruthy();
          expect(typeof r.amountMinor).toBe("number");
        }
      }
    }
    // Unavailable plans/regions carry no price firming.
    const ent = plans.find((p) => p.tier === "enterprise");
    expect(ent?.available).toBe(false);
    expect(ent?.pricingRegions.every((r) => r.amountMinor === null)).toBe(true);
  });

  it("formats integer minor units without float math", () => {
    expect(moneyMinorToDisplay(2_500, "USD")).toBe("$25.00");
    expect(moneyMinorToDisplay(8_900, "USD")).toBe("$89.00");
    expect(moneyMinorToDisplay(5_000, "NGN")).toMatch(/50\.00/);
    expect(moneyMinorToDisplay(250, "JPY")).toBe("¥250");
  });

  it("picks the cheapest available region for a plan", () => {
    const plan = {
      pricingRegions: [
        { pricingRegionCode: "GLOBAL", displayName: "Global", available: true, currency: "USD", amountMinor: 8_900 },
        { pricingRegionCode: "EUR", displayName: "Eurozone", available: true, currency: "EUR", amountMinor: 8_200 },
      ],
    };
    const best = bestPlanPrice(plan as never);
    expect(best?.pricingRegionCode).toBe("EUR");
    expect(best?.amountMinor).toBe(8_200);
  });

  it("exposes subscription + commercial access and honors checkout/cancel/reconcile", async () => {
    const api = new DemoMoxApi();
    const sub = await api.getSubscription();
    expect(sub?.plan?.name).toBe("Pro");
    expect(sub?.commercialAccess.entitled).toBe(true);
    expect(commercialStatus(sub)).toBe("active");

    const providers = await api.listBillingProviders();
    expect(providers.find((p) => p.providerName === "paystack")?.available).toBe(false);

    await expect(
      api.startCheckout({ planVersionId: "pv_plus", pricingRegionCode: "GLOBAL", providerName: "paystack", successUrl: "https://x/s", cancelUrl: "https://x/c" }),
    ).rejects.toThrow(/not enabled/);
    const session = await api.startCheckout({ planVersionId: "pv_plus", pricingRegionCode: "GLOBAL", providerName: "stripe", successUrl: "https://x/s", cancelUrl: "https://x/c" });
    expect(session.sessionId).toBeTruthy();

    await expect(api.reconcileCheckout({})).rejects.toThrow(/sessionId/);
    expect((await api.reconcileCheckout({ sessionId: session.sessionId })).state).toBe("resolved");

    await api.cancelSubscription();
    const after = await api.getSubscription();
    expect(after?.cancelAtPeriodEnd).toBe(true);

    expect(commercialStatus({ state: "active", cancelAtPeriodEnd: true, commercialAccess: { entitled: true } } as never)).toBe("canceled");
    expect(commercialStatus(null)).toBe("none");
  });
});

describe("Phase 03 personal API tokens (§E)", () => {
  it("reveals plaintext once, then only the row", async () => {
    const api = new DemoMoxApi();
    let created: { token: string; tokenId: string; scopes: string[] } | undefined;
    try {
      created = await api.createApiToken({ name: "ci" });
    } catch {
      // demo supports token creation
    }
    expect(created!.token).toMatch(/^mox_demo_/);
    expect(created!.tokenId).toBeTruthy();
    expect(created!.scopes.join(",")).toBe("agents:read");

    const rows = await api.listApiTokens();
    const row = rows.find((t) => t.tokenId === created!.tokenId);
    expect(row?.name).toBe("ci");
    expect(row?.revoked).toBe(false);
    // The plaintext is never retained on the row.
    expect((row as unknown as Record<string, unknown>)?.token).toBeUndefined();

    await api.revokeApiToken(created!.tokenId);
    expect((await api.listApiTokens()).find((t) => t.tokenId === created!.tokenId)?.revoked).toBe(true);
  });
});