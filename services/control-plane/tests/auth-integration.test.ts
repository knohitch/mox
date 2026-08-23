/**
 * HTTP-level auth + security integration tests over REAL PostgreSQL
 * (Prompt 00B §B–§I). Skipped unless MOX_TEST_DATABASE_URL points at an
 * empty, migrated database — the repair prompt mandates real verification,
 * and scripts/run-postgres-verification.cmd provisions a disposable cluster.
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

describe.skipIf(!databaseUrl)("control plane auth + security over PostgreSQL", () => {
  const setupToken = `setup_${randomUUID()}`;

  beforeAll(async () => {
    const config: ControlPlaneConfig = {
      env: "test",
      port: 0,
      databaseUrl: databaseUrl!,
      publicUrl: "http://127.0.0.1:0",
      setupToken,
      sessionTtlMs: 60 * 60_000,
      corsOrigins: [],
    };
    const services = await composeControlPlane(config);
    const running = await startControlPlane(services);
    server = { base: `http://127.0.0.1:${running.port}`, services, running };
  });

  afterAll(async () => {
    if (server) await server.running.close();
  });

  it("healthz passes with real PostgreSQL", async () => {
    const res = await call("/healthz");
    expect(res.status).toBe(200);
  });

  it("one-time platform bootstrap creates the designated owner then closes permanently (§A)", async () => {
    // Missing credential → honest refusal, not a shortcut.
    const noToken = await call("/api/setup/bootstrap", {
      method: "POST",
      headers: CSRF,
      body: JSON.stringify({ ownerEmail: "x@y.z", ownerPassword: "password123", orgSlug: "nope" }),
    });
    expect(noToken.status).toBe(403);

    const ok = await call("/api/setup/bootstrap", {
      method: "POST",
      headers: CSRF,
      body: JSON.stringify({
        setupToken,
        ownerEmail: "owner@mox.test",
        ownerPassword: "owner-password-1",
        orgSlug: "mox-platform",
      }),
    });
    expect(ok.status).toBe(200);

    // Setup is now closed forever — even with the correct token.
    const again = await call("/api/setup/bootstrap", {
      method: "POST",
      headers: CSRF,
      body: JSON.stringify({
        setupToken,
        ownerEmail: "other@mox.test",
        ownerPassword: "owner-password-2",
        orgSlug: "second",
      }),
    });
    expect(again.status).toBe(403);
    expect(JSON.stringify(again.body)).toContain("closed");

    // The owner can log in with their OWN password (not the setup token).
    const login = await call("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@mox.test", password: "owner-password-1" }),
    });
    expect(login.status).toBe(200);
    const me = await call("/api/me", { headers: { cookie: cookieFrom(login.headers) } });
    expect(me.status).toBe(200);
    expect((me.body as { email: string }).email).toBe("owner@mox.test");

    // The setup token itself is NOT a login credential.
    const badLogin = await call("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@mox.test", password: setupToken }),
    });
    expect(badLogin.status).toBe(401);
  });

  let userACookie = "";
  let userAId = "";

  it("signup issues an HttpOnly cookie session bound to the actual user (§B/§I)", async () => {
    const res = await call("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `${randomUUID()}@mox.test`, password: "user-a-password" }),
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    userACookie = cookieFrom(res.headers);
    const me = await call("/api/me", { headers: { cookie: userACookie } });
    const body = me.body as { userId: string; email: string; orgs: unknown[] };
    expect(me.status).toBe(200);
    expect(body.orgs.length).toBe(1);
    userAId = body.userId;
  });

  it("login session belongs to the authenticated user, never 'first user' (§I)", async () => {
    const email = `${randomUUID()}@mox.test`;
    await call("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "user-b-password" }),
    });
    const login = await call("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "user-b-password" }),
    });
    expect(login.status).toBe(200);
    const me = await call("/api/me", { headers: { cookie: cookieFrom(login.headers) } });
    expect((me.body as { userId: string }).userId).not.toBe(userAId);
    expect((me.body as { email: string }).email).toBe(email);
  });

  it("logout revokes the session; expired sessions fail (§I)", async () => {
    const email = `${randomUUID()}@mox.test`;
    const signup = await call("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "logout-test-pass" }),
    });
    const cookie = cookieFrom(signup.headers);
    expect((await call("/api/me", { headers: { cookie } })).status).toBe(200);

    const logoutRes = await call("/api/auth/logout", { method: "POST", headers: { ...CSRF, cookie } });
    expect(logoutRes.status).toBe(200);
    expect((await call("/api/me", { headers: { cookie } })).status).toBe(401);

    // Directly expire a fresh session to prove expiry enforcement.
    const signup2 = await call("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `${randomUUID()}@mox.test`, password: "expiry-test-pass" }),
    });
    const tokenHash = (await import("node:crypto")).createHash("sha256").update(cookieFrom(signup2.headers).split("=")[1]!).digest("hex");
    await server.services.db.execute(
      (await import("drizzle-orm")).sql`UPDATE auth_sessions SET expires_at = now() - interval '1 minute' WHERE token_hash = ${tokenHash}`,
    );
    expect((await call("/api/me", { headers: { cookie: cookieFrom(signup2.headers) } })).status).toBe(401);
  });

  it("multi-org switching is membership-checked; cross-org ids are rejected (§C)", async () => {
    const email = `${randomUUID()}@mox.test`;
    const signup = await call("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "org-switch-pass" }),
    });
    const cookie = cookieFrom(signup.headers);
    const meBody = (await (await call("/api/me", { headers: { cookie } })).body) as { userId: string; orgId: string };

    // Foreign org (not a member) → rejected.
    const foreignOrgId = randomUUID();
    const denied = await call("/api/auth/orgs/select", {
      method: "POST",
      headers: { ...CSRF, cookie },
      body: JSON.stringify({ orgId: foreignOrgId }),
    });
    expect(denied.status).toBe(403);

    // Seed a second membership for this user directly.
    const secondOrg = (
      await server.services.db.execute(
        (await import("drizzle-orm")).sql`
          WITH o AS (
            INSERT INTO organizations (slug, display_name)
            VALUES (${`second-${randomUUID()}`}, 'Second Org') RETURNING id
          ), m AS (
            INSERT INTO memberships (org_id, user_id, role)
            SELECT o.id, ${meBody.userId}, 'admin' FROM o RETURNING org_id
          )
          SELECT org_id AS id FROM m
        `,
      )
    ).rows as Array<{ id: string }>;
    const secondOrgId = secondOrg[0]!.id;

    const switched = await call("/api/auth/orgs/select", {
      method: "POST",
      headers: { ...CSRF, cookie },
      body: JSON.stringify({ orgId: secondOrgId }),
    });
    expect(switched.status).toBe(200);
    expect((switched.body as { identity?: { orgId?: string } }).identity?.orgId ?? (switched.body as { orgId?: string }).orgId).toBe(secondOrgId);

    // Requests derive org from session context afterwards.
    const meAfter = (await (await call("/api/me", { headers: { cookie } })).body) as { orgId: string };
    expect(meAfter.orgId).toBe(secondOrgId);
    void meBody;
  });

  it("cookie-authenticated mutations require the CSRF header (§B/§I)", async () => {
    const email = `${randomUUID()}@mox.test`;
    const signup = await call("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "csrf-test-pass" }),
    });
    const cookie = cookieFrom(signup.headers);

    const withoutHeader = await call("/api/auth/logout", { method: "POST", headers: { "content-type": "application/json", cookie } });
    expect(withoutHeader.status).toBe(403);
    expect(JSON.stringify(withoutHeader.body)).toContain("csrf_required");

    // Bearer channel is exempt (non-browser clients use the SEPARATE
    // programmatic contract, Prompt 00C §B).
    const tokenLogin = await call("/api/auth/token-login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "csrf-test-pass", name: "csrf-test" }),
    });
    expect(tokenLogin.status).toBe(200);
    const bearer = (tokenLogin.body as { token: string }).token;
    const viaBearer = await fetch(`${server.base}/api/auth/orgs/select`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ orgId: randomUUID() }),
    });
    // Authenticated fine (403 = not a member, NOT csrf_required).
    expect(viaBearer.status).toBe(403);
    expect(JSON.stringify(await viaBearer.json())).not.toContain("csrf_required");
  });

  it("SSE rejects tokens in URLs and accepts the cookie channel (§D/§I)", async () => {
    const email = `${randomUUID()}@mox.test`;
    const signup = await call("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "sse-test-pass" }),
    });
    const cookie = cookieFrom(signup.headers);
    const token = cookie.split("=")[1]!;

    const urlToken = await fetch(`${server.base}/api/streams/org-events?token=${encodeURIComponent(token)}`);
    expect(urlToken.status).toBe(400);
    expect(JSON.stringify(await urlToken.json())).toContain("no_token_in_url");

    const viaCookie = await fetch(`${server.base}/api/streams/org-events?sinceSeq=0`, { headers: { cookie } });
    expect(viaCookie.status).toBe(200);
    expect(viaCookie.headers.get("content-type")).toContain("text/event-stream");
    await viaCookie.body?.cancel();

    // Authorization header also works for non-browser clients via the
    // SEPARATE programmatic token contract (Prompt 00C §B).
    const tokenLogin = await call("/api/auth/token-login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "sse-test-pass", name: "sse-test" }),
    });
    const bearer = (tokenLogin.body as { token: string }).token;
    const viaHeader = await fetch(`${server.base}/api/streams/org-events?sinceSeq=0`, {
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(viaHeader.status).toBe(200);
    await viaHeader.body?.cancel();
  });

  it("request logs contain pathname only — never query secrets or auth headers (§D/§I)", async () => {
    const writes: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const secret = `leaky_token_${randomUUID()}`;
      await fetch(`${server.base}/healthz?token=${encodeURIComponent(secret)}`, {
        headers: { authorization: `Bearer ${secret}` },
      });
      const all = writes.join("");
      expect(all).toContain("/healthz");
      expect(all).not.toContain(secret);
      expect(all.toLowerCase()).not.toContain("bearer");
    } finally {
      process.stdout.write = original;
    }
  });

  it("entitlement replacement is transactional: invalid input leaves old values intact (§E)", async () => {
    const { PgBillingStore, PgEntitlementStore } = await import("@mox/database");
    const billingStore = new PgBillingStore(server.services.db);
    const entitlementStore = new PgEntitlementStore(server.services.db);

    const product = await billingStore.createProduct({
      id: randomUUID(),
      code: `tx-${randomUUID().slice(0, 8)}`,
      tier: "plus",
      displayName: "TX Plan",
    });
    const version = await billingStore.createPlanVersion({
      id: randomUUID(),
      productId: product.id,
      version: 1,
      status: "draft",
      createdAt: new Date().toISOString(),
    });
    await entitlementStore.upsertDefinition({
      key: "max_agents",
      valueType: "integer",
      description: "",
      defaultValue: 1,
    });

    await billingStore.setPlanEntitlementValues(version.id, { max_agents: 5 });
    expect(await billingStore.getPlanEntitlementValues(version.id)).toEqual({ max_agents: 5 });

    // Unknown key → pre-validated failure, old values untouched.
    await expect(
      billingStore.setPlanEntitlementValues(version.id, { max_agents: 9, bogus_key: true } as Record<string, boolean | number | string>),
    ).rejects.toThrow(/unknown entitlement key/);
    expect(await billingStore.getPlanEntitlementValues(version.id)).toEqual({ max_agents: 5 });

    // Wrong type → rejected, old values untouched.
    await expect(
      billingStore.setPlanEntitlementValues(version.id, { max_agents: "five" }),
    ).rejects.toThrow(/expects integer/);
    expect(await billingStore.getPlanEntitlementValues(version.id)).toEqual({ max_agents: 5 });

    // Same contract through EntitlementService's store seam.
    await expect(entitlementStore.setPlanValues(version.id, { max_agents: "five" })).rejects.toThrow(/expects integer/);
    expect(await entitlementStore.getPlanValues(version.id)).toEqual({ max_agents: 5 });
  });

  // ==== Prompt 00C ===========================================================

  it("browser login/signup JSON contains NO session token (§A, tests 1–3)", async () => {
    const email = `${randomUUID()}@mox.test`;
    const signup = await call("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "cookie-only-pass" }),
    });
    expect(signup.status).toBe(200);
    const signupBody = JSON.stringify(signup.body);
    expect(signupBody).not.toContain("sessionToken");
    expect(signupBody).not.toMatch(/mox_pat_|Bearer /);

    const login = await call("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "cookie-only-pass" }),
    });
    const loginBody = JSON.stringify(login.body);
    expect(loginBody).not.toContain("sessionToken");
    expect((login.body as { expiresAt: string }).expiresAt).toBeTruthy();

    // The HttpOnly cookie alone authenticates /api/me.
    const me = await call("/api/me", { headers: { cookie: cookieFrom(login.headers) } });
    expect(me.status).toBe(200);
    expect((me.body as { email: string }).email).toBe(email);
  });

  it("org switch response also carries no bearer material (§A)", async () => {
    const email = `${randomUUID()}@mox.test`;
    const signup = await call("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "switch-shape-pass" }),
    });
    const cookie = cookieFrom(signup.headers);
    const res = await call("/api/auth/orgs/select", {
      method: "POST",
      headers: { ...CSRF, cookie },
      body: JSON.stringify({ orgId: (signup.body as { orgId: string }).orgId }),
    });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain("token");
  });

  it("programmatic auth is a separate contract: token-login + scoped PATs (§B, test 5)", async () => {
    const email = `${randomUUID()}@mox.test`;
    await call("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "pat-owner-pass" }),
    });

    // Password → bearer WITHOUT any session/cookie involvement.
    const tokenLogin = await call("/api/auth/token-login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "pat-owner-pass", name: "ci", scopes: ["agents", "servers"] }),
    });
    expect(tokenLogin.status).toBe(200);
    const { token, scopes } = tokenLogin.body as { token: string; tokenId: string; scopes: string[] };
    expect(token.startsWith("mox_pat_")).toBe(true);
    expect(scopes).toEqual(["agents", "servers"]);

    // The PAT authenticates API calls.
    const me = await fetch(`${server.base}/api/me`, { headers: { authorization: `Bearer ${token}` } });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { email: string }).email).toBe(email);

    // Management endpoints list and revoke.
    const listRes = await call("/api/auth/tokens", { headers: { authorization: `Bearer ${token}` } });
    const listed = listRes.body as Array<{ name: string; id: string }>;
    expect(listed.some((t) => t.name === "ci")).toBe(true);

    const revokeRes = await call(`/api/auth/tokens/${(tokenLogin.body as { tokenId: string }).tokenId}`, {
      method: "DELETE",
      headers: { ...CSRF, authorization: `Bearer ${token}` },
    });
    expect(revokeRes.status).toBe(200);
    const revokedMe = await fetch(`${server.base}/api/me`, { headers: { authorization: `Bearer ${token}` } });
    expect(revokedMe.status).toBe(401);
  });

  it("allowlisted origins get credentialed CORS; unlisted origins are denied (§C, tests 6–7)", async () => {
    const config = server.services.config;
    const allowed = `https://app.${randomUUID()}.test`;
    config.corsOrigins.push(allowed);

    try {
      const email = `${randomUUID()}@mox.test`;
      const signup = await call("/api/auth/signup", {
        method: "POST",
        headers: { "content-type": "application/json", origin: allowed },
        body: JSON.stringify({ email, password: "cors-login-pass" }),
      });
      expect(signup.status).toBe(200);

      const login = await call("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", origin: allowed },
        body: JSON.stringify({ email, password: "cors-login-pass" }),
      });
      expect(login.status, `login ${login.status}: ${JSON.stringify(login.body)}`).toBe(200);
      expect(login.headers.get("access-control-allow-origin")).toBe(allowed);
      expect(login.headers.get("access-control-allow-credentials")).toBe("true");
      expect(login.headers.get("vary")).toContain("Origin");
      // Browser contract stays token-free even cross-origin (00C §A).
      expect(JSON.stringify(login.body)).not.toContain("sessionToken");

      const setCookie =
        typeof (login.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === "function"
          ? (login.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()[0] ?? ""
          : login.headers.get("set-cookie") ?? "";
      const cookie = setCookie.split(";")[0]!;
      expect(cookie).toContain("mox_session=");
      const me = await fetch(`${server.base}/api/me`, { headers: { origin: allowed, cookie } });
      expect(me.status).toBe(200);
      expect(me.headers.get("access-control-allow-credentials")).toBe("true");
      const sse = await fetch(`${server.base}/api/streams/org-events?sinceSeq=0`, {
        headers: { origin: allowed, cookie },
      });
      expect(sse.status).toBe(200);
      await sse.body?.cancel();

      // Unlisted origin → no CORS grant at all.
      const stranger = await fetch(`${server.base}/api/me`, {
        headers: { origin: `https://evil.${randomUUID()}.test`, cookie },
      });
      expect(stranger.headers.get("access-control-allow-origin")).toBeNull();
      expect(stranger.headers.get("access-control-allow-credentials")).toBeNull();
      expect(stranger.status).toBe(200); // request executes; browser blocks the read
    } finally {
      config.corsOrigins.splice(config.corsOrigins.indexOf(allowed), 1);
    }
  });

  it("billing webhook verification receives the EXACT raw bytes (§D, test 9)", async () => {
    const { FakeBillingProvider, signPayload } = await import("@mox/billing");
    const provider = new FakeBillingProvider(`raw-${randomUUID().slice(0, 8)}`);
    server.services.billing.registerProvider(provider);

    // Whitespace + escaping chosen so re-serialization would differ.
    const raw = `{  "eventId" : "evt_raw_1" ,  "type":"checkout.completed",\n\t"subjectRef": "co\\u0072aw" , "padding":"aaaaaaaaaaaaaaaaaaaaaaaaaa"}`;
    const stamp = new Date().toISOString();
    const signature = signPayload("test-webhook-secret", raw, stamp);
    const res = await call("/webhooks/billing/" + provider.name, {
      method: "POST",
      headers: { "content-type": "application/json", "x-mox-timestamp": stamp, "x-mox-signature": signature },
      rawBody: raw,
    });
    // HMAC over the untouched bytes VERIFIES — the handler then honestly
    // rejects the business event (unknown session ref), proving the exact
    // raw payload reached signature verification intact.
    expect(res.status).toBe(200);
    const firstBody = JSON.stringify(res.body);
    expect(firstBody).toContain('"rejected":true');
    expect(firstBody).toContain("unknown session");

    // Prove reserialization would NOT verify: sign the stringify'd form,
    // deliver the original raw bytes → signature mismatch.
    const parsed = JSON.parse(raw);
    const reserialized = JSON.stringify(parsed);
    expect(reserialized).not.toBe(raw);
    const tampered = await call("/webhooks/billing/" + provider.name, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mox-timestamp": stamp,
        "x-mox-signature": signPayload("test-webhook-secret", reserialized, stamp),
      },
      rawBody: raw,
    });
    expect(tampered.status).toBe(200);
    const tamperedBody = JSON.stringify(tampered.body);
    expect(tamperedBody).toContain('"rejected":true');
    expect(tamperedBody.toLowerCase()).toContain("signature");
  });

  it("node command polling requires that node's durable agent token (§E, test 10)", async () => {
    const fake = new (await import("@mox/compute-providers")).FakeComputeProvider();
    const orch = server.services.orchestrator;
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
    const ownerLogin = await call("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@mox.test", password: "owner-password-1" }),
    });
    const ownerCookie = cookieFrom(ownerLogin.headers);
    const orderRes = await call("/api/servers/orders", {
      method: "POST",
      headers: { ...CSRF, cookie: ownerCookie },
      body: JSON.stringify({ computeClassCode: "COMPUTE_SMALL", hostname: "ws-cmd" }),
    });
    expect(orderRes.status).toBe(200);
    const orderId = (orderRes.body as { id: string }).id;
    await orch.reconcile(new Date(Date.now() + 60_000).toISOString());

    const secretOf = (callIndex: number): string =>
      [...fake.provisionCalls[callIndex]!.cloudInitUserData.matchAll(/MOX_ENROLL_TOKEN=(\S+)/g)][0]![1]!;
    const secret = secretOf(fake.provisionCalls.length - 1);
    const orgRow = (await server.services.db.execute(
      (await import("drizzle-orm")).sql`SELECT org_id FROM server_orders WHERE id = ${orderId}`,
    )).rows[0] as { org_id: string };

    const enroll = await call("/node/enroll", {
      method: "POST",
      headers: { "content-type": "application/json", "x-mox-org-id": orgRow.org_id },
      body: JSON.stringify({ enrollToken: secret, orderId, nodeId: `node-cmd-${randomUUID()}` }),
    });
    expect(enroll.status).toBe(200);
    const { nodeId, agentToken } = enroll.body as { nodeId: string; agentToken: string };

    // No token → 401. Wrong token → 403.
    const none = await fetch(`${server.base}/node/${nodeId}/commands`);
    expect(none.status).toBe(401);
    const wrong = await call(`/node/${nodeId}/commands`, { headers: { authorization: "Bearer not-the-token" } });
    expect(wrong.status).toBe(403);

    // A DIFFERENT node's token cannot poll this node.
    const orderRes2 = await call("/api/servers/orders", {
      method: "POST",
      headers: { ...CSRF, cookie: ownerCookie },
      body: JSON.stringify({ computeClassCode: "COMPUTE_SMALL", hostname: "ws-cmd-2" }),
    });
    expect(orderRes2.status).toBe(200);
    const orderId2 = (orderRes2.body as { id: string }).id;
    await orch.reconcile(new Date(Date.now() + 120_000).toISOString());
    const enroll2 = await call("/node/enroll", {
      method: "POST",
      headers: { "content-type": "application/json", "x-mox-org-id": orgRow.org_id },
      body: JSON.stringify({ enrollToken: secretOf(fake.provisionCalls.length - 1), orderId: orderId2, nodeId: `node-cmd-${randomUUID()}` }),
    });
    expect(enroll2.status).toBe(200);
    const otherToken = (enroll2.body as { agentToken: string }).agentToken;
    const crossNode = await call(`/node/${nodeId}/commands`, {
      headers: { authorization: `Bearer ${otherToken}` },
    });
    // Node A's token is simply invalid FOR node B — 403 node_auth_failed.
    expect(crossNode.status).toBe(403);
    expect(JSON.stringify(crossNode.body)).toContain("node_auth_failed");

    // Correct node token → authenticated honest empty queue.
    const okPoll = await call(`/node/${nodeId}/commands`, { headers: { authorization: `Bearer ${agentToken}` } });
    expect(okPoll.status).toBe(200);
    expect(okPoll.body).toEqual([]);
  });

  it("duplicate workspace names allocate distinct slugs safely (§F, test 11)", async () => {
    const orgName = `Duplicate Workspace ${randomUUID().slice(0, 6)}`;
    const first = await call("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `${randomUUID()}@mox.test`, password: "slug-collide-pass", orgName }),
    });
    expect(first.status).toBe(200);
    const second = await call("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `${randomUUID()}@mox.test`, password: "slug-collide-pass", orgName }),
    });
    expect(second.status).toBe(200);

    const slugFor = async (cookie: string) =>
      ((await (await call("/api/me", { headers: { cookie } })).body) as { orgSlug: string }).orgSlug;
    const slugA = await slugFor(cookieFrom(first.headers));
    const slugB = await slugFor(cookieFrom(second.headers));
    expect(slugA).not.toBe(slugB);
    // Memberships remain correctly isolated: each user sees exactly one org.
    const meA = (await (await call("/api/me", { headers: { cookie: cookieFrom(first.headers) } })).body) as { orgs: unknown[] };
    const meB = (await (await call("/api/me", { headers: { cookie: cookieFrom(second.headers) } })).body) as { orgs: unknown[] };
    expect(meA.orgs).toHaveLength(1);
    expect(meB.orgs).toHaveLength(1);
  });
});
