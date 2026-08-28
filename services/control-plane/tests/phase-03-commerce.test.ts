/**
 * Phase 03 — customer commercial connections + developer surfaces over REAL
 * PostgreSQL: BYOK model credentials, integrations + tool grants, channels,
 * plans/subscription projection, and personal API tokens. Skipped unless
 * MOX_TEST_DATABASE_URL points at an empty, migrated database
 * (scripts/run-postgres-verification.cmd provisions a disposable cluster).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { ControlPlaneConfig } from "../src/config.js";
import { composeControlPlane, type ControlPlaneServices } from "../src/composition.js";
import { startControlPlane, type RunningControlPlane } from "../src/server.js";

const databaseUrl = process.env["MOX_TEST_DATABASE_URL"];

interface TestServer {
  base: string;
  services: ControlPlaneServices;
  running: RunningControlPlane;
}

let server: TestServer;

async function call(
  path: string,
  init: RequestInit & { rawBody?: string } = {},
): Promise<{ status: number; body: unknown; headers: Headers }> {
  const res = await fetch(`${server.base}${path}`, {
    method: init.method ?? "GET",
    headers: init.headers,
    body: init.rawBody ?? init.body,
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as unknown) : null, headers: res.headers };
}

function cookieFrom(headers: Headers): string {
  const setCookie = headers.get("set-cookie") ?? "";
  return setCookie.split(";")[0] ?? "";
}

const CSRF = { "x-mox-csrf": "1", "content-type": "application/json" };

interface Phase03Org {
  cookie: string;
  orgId: string;
  userId: string;
}

const AGENT_DEFINITION = { agentId: "phase03-agent", model: { providerId: "openai", modelId: "test" } };

describe.skipIf(!databaseUrl)("Phase 03 commercial connections + developer surfaces over PostgreSQL", () => {
  beforeAll(async () => {
    const config: ControlPlaneConfig = {
      env: "test",
      port: 0,
      databaseUrl: databaseUrl!,
      publicUrl: "http://127.0.0.1:0",
      setupToken: `setup_${randomUUID()}`,
      sessionTtlMs: 60 * 60_000,
      corsOrigins: [],
      trustedProxyIps: [],
      platformAdminUserIds: [],
      platformAdminRoles: {},
      platformAdminCapabilities: {},
      runtimeMode: "disabled",
      runtimeArgs: [],
      runtimeRequestTimeoutMs: 60_000,
      customerCredentialsKey: "phase-03-customer-credential-vault-passphrase",
    };
    const services = await composeControlPlane(config);
    const running = await startControlPlane(services);
    server = { base: `http://127.0.0.1:${running.port}`, services, running };
  });

  afterAll(async () => {
    if (server) await server.running.close();
  });

  async function signup(): Promise<Phase03Org> {
    const email = `${randomUUID().slice(0, 10)}-${Date.now()}@mox.test`;
    const res = await call("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "phase03-test-pass" }),
    });
    expect(res.status).toBe(200);
    const cookie = cookieFrom(res.headers);
    const me = (await (await call("/api/me", { headers: { cookie } })).body) as { orgId: string; userId: string };
    return { cookie, orgId: me.orgId, userId: me.userId };
  }

  async function createAgent(org: Phase03Org, slug: string): Promise<string> {
    const { agents: agentsTable } = await import("@mox/database");
    const [row] = await server.services.db.insert(agentsTable).values({
      orgId: org.orgId,
      slug,
      displayName: slug,
      status: "active",
      definition: AGENT_DEFINITION,
      createdByUserId: org.userId,
    }).returning({ id: agentsTable.id });
    return row!.id;
  }

  async function seedPlan(): Promise<{ productId: string; planVersionId: string; priceVersionId: string }> {
    const { PgBillingStore } = await import("@mox/database");
    const store = new PgBillingStore(server.services.db);
    const product = await store.createProduct({
      id: randomUUID(),
      code: `p03-${randomUUID().slice(0, 8)}`,
      tier: "pro",
      displayName: "Pro",
    });
    const planVersion = await store.createPlanVersion({
      id: randomUUID(),
      productId: product.id,
      version: 1,
      status: "active",
      createdAt: new Date().toISOString(),
    });
    await store.definePricingRegion({
      code: "GLOBAL",
      displayName: "Global",
      chargeCurrency: "USD",
      displayCurrency: "USD",
    });
    const book = await store.upsertPriceBook({ id: randomUUID(), productId: product.id, pricingRegionCode: "GLOBAL", mode: "fixed" });
    const price = await store.createPriceVersion({
      id: randomUUID(),
      priceBookId: book.id,
      version: 1,
      amountMinor: 1999n,
      currency: "USD",
      effectiveFrom: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });
    return { productId: product.id, planVersionId: planVersion.id, priceVersionId: price.id };
  }

  async function seedCommercialSubscription(orgId: string, values: Record<string, boolean | number | string>): Promise<{ planVersionId: string }> {
    const catalog = await seedPlan();
    for (const [key, value] of Object.entries(values)) {
      await server.services.entitlements.define({
        key: key as never,
        valueType: typeof value === "boolean" ? "boolean" : typeof value === "number" ? "integer" : "text",
        description: key,
        defaultValue: typeof value === "boolean" ? false : typeof value === "number" ? 0 : "",
      });
    }
    await server.services.entitlements.setPlanValues(catalog.planVersionId, values);
    await server.services.billing.store.createSubscription({
      id: randomUUID(),
      orgId,
      planVersionId: catalog.planVersionId,
      priceVersionId: catalog.priceVersionId,
      state: "active",
      providerName: "scripted",
      providerRef: `scripted_sub_${randomUUID()}`,
      providerEnvironment: "test",
      currentPeriodStart: new Date(Date.now() - 60_000).toISOString(),
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 3600_000).toISOString(),
      failedRenewals: 0,
      cancelAtPeriodEnd: false,
      createdAt: new Date().toISOString(),
    });
    return { planVersionId: catalog.planVersionId };
  }

  it("customer catalogs seed lazily and every projected surface is secret-free", async () => {
    const org = await signup();

    const modelConnections = await call("/api/model-connections", { headers: { cookie: org.cookie } });
    expect(modelConnections.status).toBe(200);
    const conns = modelConnections.body as Array<{ providerId: string; kind: string; baseUrlSupported: boolean }>;
    expect(conns.some((r) => r.providerId === "openai")).toBe(true);

    const integrations = await call("/api/integrations", { headers: { cookie: org.cookie } });
    expect(integrations.status).toBe(200);
    const ints = integrations.body as Array<{ integrationId: string; dangerous: boolean; configFields: unknown[] }>;
    expect(ints.some((r) => r.integrationId === "notion" && r.dangerous === false)).toBe(true);

    const channels = await call("/api/channels", { headers: { cookie: org.cookie } });
    expect(channels.status).toBe(200);
    const chans = channels.body as Array<{ channelId: string; kind: string; secretKeys: string[] }>;
    const web = chans.find((r) => r.channelId === "web")!;
    expect(web.kind).toBe("web");
    expect(web.secretKeys).toEqual([]);
    const telegram = chans.find((r) => r.channelId === "telegram")!;
    expect(telegram.secretKeys).toEqual(["botToken"]);

    // No surface echoes secret VALUES (only safe field metadata like `secret: true`).
    const blob = JSON.stringify([conns, ints, chans]);
    expect(blob).not.toMatch(/(sk-[A-Za-z0-9_-]{8,}|ht_[A-Za-z0-9]{20,}|xoxb-[A-Za-z0-9]+|bot\d{6,}:[A-Za-z0-9_-]{20,})/);
  });

  it("BYOK connect stores encrypted credentials; rotate + disconnect round-trip never leaks", async () => {
    const org = await signup();
    const mut = { headers: { ...CSRF, cookie: org.cookie } };

    const connect = await call("/api/model-connections/openai/connect", {
      method: "POST",
      ...mut,
      body: JSON.stringify({ apiKey: "sk-phase03-test-secret-123" }),
    });
    expect(connect.status).toBe(200);
    expect((connect.body as { credentialConfigured: boolean }).credentialConfigured).toBe(true);

    const afterConnect = await call("/api/model-connections", { headers: { cookie: org.cookie } });
    const openai = (afterConnect.body as any[]).find((r) => r.providerId === "openai")!;
    expect(openai.connected).toBe(true);
    expect(openai.credentialConfigured).toBe(true);
    expect(JSON.stringify(afterConnect.body)).not.toContain("sk-phase03-test-secret-123");

    const models = await call("/api/models", { headers: { cookie: org.cookie } });
    expect(models.status).toBe(200);
    const openaiModel = (models.body as any[]).find((r) => r.providerId === "openai")!;
    expect(openaiModel.byok).toBe(true);
    expect(openaiModel.available).toBe(true);

    const rotate = await call("/api/model-connections/openai/rotate", {
      method: "POST",
      ...mut,
      body: JSON.stringify({ apiKey: "sk-phase03-rotated-secret" }),
    });
    expect(rotate.status).toBe(200);
    const afterRotate = await call("/api/model-connections", { headers: { cookie: org.cookie } });
    expect(JSON.stringify(afterRotate.body)).not.toContain("sk-phase03-test-secret");
    expect(JSON.stringify(afterRotate.body)).not.toContain("sk-phase03-rotated-secret");

    // Vulnerability probes require a runtime gateway — honest 501, no fake ping.
    const probe = await call("/api/model-connections/openai/test", { method: "POST", ...mut });
    expect(probe.status).toBe(501);
    expect((probe.body as { code?: string }).code).toBe("not_configured");

    const disconnect = await call("/api/model-connections/openai", { method: "DELETE", ...mut });
    expect(disconnect.status).toBe(200);
    const afterDisconnect = await call("/api/model-connections", { headers: { cookie: org.cookie } });
    const openaiGone = (afterDisconnect.body as any[]).find((r) => r.providerId === "openai")!;
    expect(openaiGone.connected).toBe(false);
    expect(openaiGone.credentialConfigured).toBe(false);
  });

  it("channel connections: secret channels enforce credentials, web does not; probes stay honest", async () => {
    const org = await signup();
    const agentId = await createAgent(org, `channel-agent-${randomUUID().slice(0, 8)}`);
    const mut = { headers: { ...CSRF, cookie: org.cookie } };

    const missing = await call("/api/channels/telegram/connect", {
      method: "POST",
      ...mut,
      body: JSON.stringify({ agentId, secrets: {} }),
    });
    expect(missing.status).toBe(400);
    expect(JSON.stringify(missing.body)).toContain("requires credentials");

    const connect = await call("/api/channels/telegram/connect", {
      method: "POST",
      ...mut,
      body: JSON.stringify({ agentId, secrets: { botToken: "123456789:phase03-telegram-token" } }),
    });
    expect(connect.status).toBe(200);
    expect((connect.body as { connected: boolean }).connected).toBe(true);

    const list = await call("/api/channels", { headers: { cookie: org.cookie } });
    const tg = (list.body as any[]).find((r) => r.channelId === "telegram" && r.boundAgentId === agentId)!;
    expect(tg.connected).toBe(true);
    expect(tg.credentialConfigured).toBe(true);
    expect(tg.connectionId).toBeTruthy();
    expect(JSON.stringify(list.body)).not.toContain("123456789:phase03-telegram-token");

    // Health probe without a runtime gateway → honest 501.
    const probe = await call(`/api/channels/connections/${tg.connectionId}/test`, { method: "POST", ...mut });
    expect(probe.status).toBe(501);
    expect((probe.body as { code?: string }).code).toBe("not_configured");

    // Reconnect also demands credentials for non-web kinds.
    const emptyReconnect = await call(`/api/channels/connections/${tg.connectionId}/reconnect`, {
      method: "POST",
      ...mut,
      body: JSON.stringify({ secrets: {} }),
    });
    expect(emptyReconnect.status).toBe(400);
    const reconnect = await call(`/api/channels/connections/${tg.connectionId}/reconnect`, {
      method: "POST",
      ...mut,
      body: JSON.stringify({ secrets: { botToken: "987654321:phase03-rotated-token" } }),
    });
    expect(reconnect.status).toBe(200);

    // Web needs no credential and binds to an agent freely.
    const web = await call("/api/channels/web/connect", { method: "POST", ...mut, body: JSON.stringify({ agentId }) });
    expect(web.status).toBe(200);
    const afterWeb = await call("/api/channels", { headers: { cookie: org.cookie } });
    const webRow = (afterWeb.body as any[]).find((r) => r.channelId === "web" && r.boundAgentId === agentId)!;
    expect(webRow.connected).toBe(true);
    expect(webRow.credentialConfigured).toBe(false);

    const disconnect = await call(`/api/channels/connections/${tg.connectionId}/disconnect`, { method: "POST", ...mut });
    expect(disconnect.status).toBe(200);
    const afterDisconnect = await call("/api/channels", { headers: { cookie: org.cookie } });
    const tgGone = (afterDisconnect.body as any[]).find((r) => r.channelId === "telegram" && r.boundAgentId === agentId)!;
    expect(tgGone.connected).toBe(false);
    expect(tgGone.credentialConfigured).toBe(false);
  });

  it("integration connect stores secrets and tool grants remain agent-scoped + idempotent", async () => {
    const org = await signup();
    const agentA = await createAgent(org, `grant-agent-a-${randomUUID().slice(0, 8)}`);
    const agentB = await createAgent(org, `grant-agent-b-${randomUUID().slice(0, 8)}`);
    const mut = { headers: { ...CSRF, cookie: org.cookie } };

    // Before connect, grants are refused honestly.
    const early = await call("/api/integrations/notion/grants", {
      method: "POST",
      ...mut,
      body: JSON.stringify({ agentId: agentA, toolPattern: "notion.read" }),
    });
    expect(early.status).toBe(409);
    expect((early.body as { code?: string }).code).toBe("not_connected");

    // Required secret fields are enforced.
    const missingSecret = await call("/api/integrations/notion/connect", {
      method: "POST",
      ...mut,
      body: JSON.stringify({ secrets: {} }),
    });
    expect(missingSecret.status).toBe(400);

    const connect = await call("/api/integrations/notion/connect", {
      method: "POST",
      ...mut,
      body: JSON.stringify({ secrets: { integrationToken: "nt-phase03-secret-value" } }),
    });
    expect(connect.status).toBe(200);
    expect((connect.body as { connected: boolean }).connected).toBe(true);

    const list = await call("/api/integrations", { headers: { cookie: org.cookie } });
    const notion = (list.body as any[]).find((r) => r.integrationId === "notion")!;
    expect(notion.connected).toBe(true);
    expect(notion.credentialConfigured).toBe(true);
    expect(notion.connectionId).toBeTruthy();
    expect(JSON.stringify(list.body)).not.toContain("nt-phase03-secret-value");

    const grant = await call("/api/integrations/notion/grants", {
      method: "POST",
      ...mut,
      body: JSON.stringify({ agentId: agentA, toolPattern: "notion.read" }),
    });
    expect(grant.status).toBe(200);
    const grantId = (grant.body as { grantId: string }).grantId;

    // Idempotent re-grant returns the SAME grant (onConflictDoNothing).
    const again = await call("/api/integrations/notion/grants", {
      method: "POST",
      ...mut,
      body: JSON.stringify({ agentId: agentA, toolPattern: "notion.read" }),
    });
    expect((again.body as { grantId: string }).grantId).toBe(grantId);

    const grants = await call("/api/integrations/notion/grants", { headers: { cookie: org.cookie } });
    expect(grants.status).toBe(200);
    expect((grants.body as any[]).some((g) => g.grantId === grantId && g.agentId === agentA)).toBe(true);

    const revoke = await call(`/api/integrations/notion/grants/${grantId}`, { method: "DELETE", ...mut });
    expect(revoke.status).toBe(200);
    const afterRevoke = await call("/api/integrations/notion/grants", { headers: { cookie: org.cookie } });
    expect((afterRevoke.body as any[]).some((g) => g.grantId === grantId)).toBe(false);

    // Disconnect clears the credential ref; a fresh grant lane is refused until reconnect.
    const disconnect = await call("/api/integrations/notion/disconnect", { method: "POST", ...mut });
    expect((disconnect.body as { connected: boolean }).connected).toBe(false);
    const afterDisconnect = await call("/api/integrations", { headers: { cookie: org.cookie } });
    const notionGone = (afterDisconnect.body as any[]).find((r) => r.integrationId === "notion")!;
    expect(notionGone.connected).toBe(false);
    expect(notionGone.credentialConfigured).toBe(false);
    const postDisconnectGrant = await call("/api/integrations/notion/grants", {
      method: "POST",
      ...mut,
      body: JSON.stringify({ agentId: agentB, toolPattern: "notion.read" }),
    });
    expect(postDisconnectGrant.status).toBe(409);
  });

  it("personal API tokens are session-only, listable, and revocable", async () => {
    const org = await signup();
    const mut = { headers: { ...CSRF, cookie: org.cookie } };

    const create = await call("/api/auth/tokens", {
      method: "POST",
      ...mut,
      body: JSON.stringify({ name: "phase03-token", scopes: ["models", "integrations", "channels"] }),
    });
    expect(create.status).toBe(200);
    const body = create.body as { token: string; tokenId: string; scopes: string[] };
    expect(body.token).toMatch(/^mox_pat_/);
    expect(body.scopes).toEqual(["models", "integrations", "channels"]);

    // The bearer token works WITHOUT a cookie for reads.
    const listWithBearer = await call("/api/model-connections", { headers: { authorization: `Bearer ${body.token}` } });
    expect(listWithBearer.status).toBe(200);

    const list = await call("/api/auth/tokens", { headers: { cookie: org.cookie } });
    expect(list.status).toBe(200);
    expect((list.body as any[]).some((t) => t.id === body.tokenId)).toBe(true);
    // Full token is never re-issued.
    expect(JSON.stringify(list.body)).not.toContain(body.token);

    const revoke = await call(`/api/auth/tokens/${body.tokenId}`, { method: "DELETE", ...mut });
    expect(revoke.status).toBe(200);
    const afterRevoke = await call("/api/auth/tokens", { headers: { cookie: org.cookie } });
    expect((afterRevoke.body as any[]).some((t) => t.id === body.tokenId)).toBe(false);
  });

  it("plans + subscription projection stay customer-safe and cancellation honors the contract", async () => {
    const org = await signup();
    await seedCommercialSubscription(org.orgId, {
      active_concurrent_agents: 2,
      model_connections: 2,
      notion_integration: true,
    });
    const mut = { headers: { ...CSRF, cookie: org.cookie } };

    const plans = await call("/api/plans", { headers: { cookie: org.cookie } });
    expect(plans.status).toBe(200);
    const rows = plans.body as Array<{
      tier: string;
      name: string;
      available: boolean;
      features: Record<string, unknown>;
      pricingRegions: Array<{ pricingRegionCode: string; available: boolean; amountMinor: number | null }>;
    }>;
    const pro = rows.find((r) => r.tier === "pro")!;
    expect(pro).toBeTruthy();
    expect(pro.available).toBe(true);
    expect(pro.features.model_connections).toBe(2);
    const global = pro.pricingRegions.find((r) => r.pricingRegionCode === "GLOBAL")!;
    expect(global.available).toBe(true);
    expect(global.amountMinor).toBe(1999);

    const sub = await call("/api/billing/subscription", { headers: { cookie: org.cookie } });
    expect(sub.status).toBe(200);
    const subBody = sub.body as { plan: { name: string; tier: string } | null; commercialAccess: { entitled: boolean }; reconciliationRequired: boolean };
    expect(subBody.plan?.name).toBe("Pro");
    expect(subBody.plan?.tier).toBe("pro");
    expect(subBody.commercialAccess.entitled).toBe(true);
    expect(subBody.reconciliationRequired).toBe(false);

    const entitlements = await call("/api/billing/entitlements", { headers: { cookie: org.cookie } });
    expect(entitlements.status).toBe(200);
    const ent = entitlements.body as { commerciallyEntitled: boolean; values: Record<string, unknown> };
    expect(ent.commerciallyEntitled).toBe(true);
    expect(ent.values.notion_integration).toBe(true);

    // Reconciliation without a pending session resolves honestly, never fabricating.
    const reconcile = await call("/api/billing/reconcile", { method: "POST", ...mut, body: JSON.stringify({}) });
    expect(reconcile.status).toBe(200);
    expect((reconcile.body as { applied: boolean }).applied).toBe(false);

    const cancel = await call("/api/billing/cancel", { method: "POST", ...mut });
    expect(cancel.status).toBe(200);
    expect((cancel.body as { ok: boolean }).ok).toBe(true);
  });
});