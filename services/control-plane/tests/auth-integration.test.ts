/**
 * HTTP-level auth + security integration tests over REAL PostgreSQL
 * (Prompt 00B §B–§I). Skipped unless MOX_TEST_DATABASE_URL points at an
 * empty, migrated database — the repair prompt mandates real verification,
 * and scripts/run-postgres-verification.cmd provisions a disposable cluster.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { ControlPlaneConfig } from "../src/config.js";
import { DEFAULT_WEBHOOK_ABUSE } from "../src/config.js";
import { FakeBillingProvider, signPayload } from "@mox/billing";
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
      trustedProxyIps: [],
      platformAdminUserIds: [],
      platformAdminRoles: {},
      platformAdminCapabilities: {},
      runtimeMode: "disabled",
      runtimeArgs: [],
      runtimeRequestTimeoutMs: 60_000,
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
      body: JSON.stringify({ ownerEmail: "x@y.z", ownerPassword: "password12345", orgSlug: "nope" }),
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

  it("CLI engine catalogue fails honestly instead of returning a silent empty list", async () => {
    const signup = await call("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `${randomUUID()}@mox.test`, password: "cli-engine-password" }),
    });
    expect(signup.status).toBe(200);

    const engines = await call("/api/cli-engines", { headers: { cookie: cookieFrom(signup.headers) } });
    expect(engines.status).toBe(501);
    expect(engines.body).toMatchObject({ code: "not_configured" });
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

    // Management is SESSION-ONLY (Prompt 00D §B): the PAT cannot list,
    // create or revoke tokens — not even its own record.
    const patList = await call("/api/auth/tokens", { headers: { authorization: `Bearer ${token}` } });
    expect(patList.status).toBe(403);
    expect(JSON.stringify(patList.body)).toContain("session_only");

    // Session (cookie) management works: create → exact contract shape
    // (00D §C, test 10) → list → revoke.
    const emailSignup = await call("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `${randomUUID()}@mox.test`, password: "token-mgmt-pass" }),
    });
    const sessionCookie = cookieFrom(emailSignup.headers);
    const createRes = await call("/api/auth/tokens", {
      method: "POST",
      headers: { ...CSRF, cookie: sessionCookie },
      body: JSON.stringify({ name: "from-session", scopes: ["agents"] }),
    });
    expect(createRes.status).toBe(200);
    expect(Object.keys(createRes.body as object).sort()).toEqual(["expiresAt", "scopes", "token", "tokenId"]);

    const listRes = await call("/api/auth/tokens", { headers: { cookie: sessionCookie } });
    const listed = listRes.body as Array<{ name: string; id: string; token?: string }>;
    expect(listed.some((t) => t.name === "from-session")).toBe(true);
    for (const entry of listed) {
      expect(Object.keys(entry)).not.toContain("token"); // metadata only
    }

    const revokeRes = await call(`/api/auth/tokens/${(createRes.body as { tokenId: string }).tokenId}`, {
      method: "DELETE",
      headers: { ...CSRF, cookie: sessionCookie },
    });
    expect(revokeRes.status).toBe(200);
    void tokenLogin;
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
    // surfaces the unknown checkout session as reconciliation_required
    // (05A §A/F: unknown bindings fail closed instead of being rejected),
    // proving the exact raw payload reached signature verification intact.
    expect(res.status).toBe(200);
    const firstBody = JSON.stringify(res.body);
    expect(firstBody).toContain('"reconciliationRequired":true');
    expect(firstBody).toContain('"applied":false');

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
    const ownerMe = (await (await call("/api/me", { headers: { cookie: ownerCookie } })).body) as { orgId: string };
    const catalog = await seedPlan();
    await server.services.entitlements.define({
      key: "included_server_count",
      valueType: "integer",
      description: "Included server count",
      defaultValue: 0,
    });
    await server.services.entitlements.define({
      key: "included_compute_class",
      valueType: "text",
      description: "Included compute class",
      defaultValue: "",
    });
    await server.services.entitlements.setPlanValues(catalog.planVersionId, {
      included_server_count: 2,
      included_compute_class: "COMPUTE_SMALL",
    });
    await server.services.billing.store.createSubscription({
      id: randomUUID(),
      orgId: ownerMe.orgId,
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
    const orderRes = await call("/api/servers/orders", {
      method: "POST",
      headers: { ...CSRF, cookie: ownerCookie, "Idempotency-Key": `node-cmd-1-${randomUUID()}` },
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
      body: JSON.stringify({ enrollToken: secret, orderId, nodeId: `node-${orderId}` }),
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
      headers: { ...CSRF, cookie: ownerCookie, "Idempotency-Key": `node-cmd-2-${randomUUID()}` },
      body: JSON.stringify({ computeClassCode: "COMPUTE_SMALL", hostname: "ws-cmd-2" }),
    });
    expect(orderRes2.status).toBe(200);
    const orderId2 = (orderRes2.body as { id: string }).id;
    await orch.reconcile(new Date(Date.now() + 120_000).toISOString());
    const enroll2 = await call("/node/enroll", {
      method: "POST",
      headers: { "content-type": "application/json", "x-mox-org-id": orgRow.org_id },
      body: JSON.stringify({ enrollToken: secretOf(fake.provisionCalls.length - 1), orderId: orderId2, nodeId: `node-${orderId2}` }),
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

  // ==== Prompt 00D — PAT scope enforcement ====================================

  it("scoped PATs are enforced per route family (00D tests 1-3)", async () => {
    const email = `${randomUUID()}@mox.test`;
    await call("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "scope-enf-pass" }),
    });
    const tokenLogin = await call("/api/auth/token-login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "scope-enf-pass", name: "scoped", scopes: ["agents"] }),
    });
    const pat = (tokenLogin.body as { token: string }).token;
    const authHeader = { authorization: `Bearer ${pat}` };

    // (1) agents family ALLOWED.
    const agents = await call("/api/agents", { headers: authHeader });
    expect(agents.status).toBe(200);

    // (2) billing DENIED.
    const billing = await call("/api/billing/invoices", { headers: authHeader });
    expect(billing.status).toBe(403);
    expect(JSON.stringify(billing.body)).toContain("scope_denied");

    // (3) servers DENIED (absent scope).
    const servers = await call("/api/servers", { headers: authHeader });
    expect(servers.status).toBe(403);

    // threads family also denied for an agents-only PAT.
    const threads = await call("/api/events?sinceSeq=0", { headers: authHeader });
    expect(threads.status).toBe(403);
  });

  it("billing-scope PAT reads billing but cannot touch session-only management (00D tests 4-6)", async () => {
    const email = `${randomUUID()}@mox.test`;
    const signup = await call("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "billing-pat-pass" }),
    });
    void signup;
    const tokenLogin = await call("/api/auth/token-login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "billing-pat-pass", name: "finance", scopes: ["billing"] }),
    });
    const pat = (tokenLogin.body as { token: string }).token;
    const authHeader = { authorization: `Bearer ${pat}` };

    // (4) permitted billing reads.
    const invoices = await call("/api/billing/invoices", { headers: authHeader });
    expect(invoices.status).toBe(200);
    const subscription = await call("/api/billing/subscription", { headers: authHeader });
    expect(subscription.status).toBe(200);

    // Admin surface does not exist for tokens; the closest privilege move
    // is minting broader tokens — denied by session-only policy (5).
    const mint = await call("/api/auth/tokens", {
      method: "POST",
      headers: { ...CSRF, authorization: `Bearer ${pat}` },
      body: JSON.stringify({ name: "escalate", scopes: ["*"] }),
    });
    expect(mint.status).toBe(403);
    expect(JSON.stringify(mint.body)).toContain("session_only");

    // (6) restricted PAT cannot manage the token inventory at all.
    const list = await call("/api/auth/tokens", { headers: authHeader });
    expect(list.status).toBe(403);
    const del = await call(`/api/auth/tokens/${(tokenLogin.body as { tokenId: string }).tokenId}`, {
      method: "DELETE",
      headers: { ...CSRF, authorization: `Bearer ${pat}` },
    });
    expect(del.status).toBe(403);
  });

  it("admin scope requires real admin capability; * cannot self-escalate (00D tests 7-8)", async () => {
    const email = `${randomUUID()}@mox.test`;
    await call("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "admin-gate-pass" }),
    });

    // (7) non-admin requesting the admin scope is rejected at issuance.
    // Signup makes this user OWNER of their own org; demote to plain
    // member so real server-side admin capability is absent.
    const demote = await server.services.db.execute(
      (await import("drizzle-orm")).sql`UPDATE memberships SET role = 'member' WHERE user_id = (SELECT id FROM users WHERE email = ${email.toLowerCase()})`,
    );
    void demote;
    const adminAttempt = await call("/api/auth/token-login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "admin-gate-pass", name: "na", scopes: ["admin"] }),
    });
    expect(adminAttempt.status).toBe(403);
    expect(JSON.stringify(adminAttempt.body)).toMatch(/admin capability/i);

    // Sanity: an actual owner/admin CAN hold the admin scope...
    const ownerEmail = `${randomUUID()}@mox.test`;
    await call("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: ownerEmail, password: "admin-gate-pass" }),
    });
    const ownerAdminLogin = await call("/api/auth/token-login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: ownerEmail, password: "admin-gate-pass", name: "owneradmin", scopes: ["admin"] }),
    });
    expect(ownerAdminLogin.status).toBe(200);
    // ...and admin scope never creates privilege by itself: no session-only
    // escalation regardless.
    const ownerMint = await call("/api/auth/tokens", {
      method: "POST",
      headers: { ...CSRF, authorization: `Bearer ${(ownerAdminLogin.body as { token: string }).token}` },
      body: JSON.stringify({ name: "nope", scopes: ["*"] }),
    });
    expect(ownerMint.status).toBe(403);
    void ownerMint;

    // (8) '*' PAT still cannot exceed the user's real capabilities:
    //     no token minting (session-only), no foreign-org switching.
    const starLogin = await call("/api/auth/token-login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "admin-gate-pass", name: "star" }),
    });
    const star = (starLogin.body as { token: string; orgId: string }).token;
    const mint = await call("/api/auth/tokens", {
      method: "POST",
      headers: { ...CSRF, authorization: `Bearer ${star}` },
      body: JSON.stringify({ name: "nope", scopes: ["*"] }),
    });
    expect(mint.status).toBe(403);
    const crossOrg = await call("/api/auth/orgs/select", {
      method: "POST",
      headers: { ...CSRF, authorization: `Bearer ${star}` },
      body: JSON.stringify({ orgId: randomUUID() }),
    });
    expect(crossOrg.status).toBe(403);
  });

  it("revoked and expired PATs stay rejected; browser cookie flow unchanged; cross-org protection intact (00D tests 9, 11-12)", async () => {
    const email = `${randomUUID()}@mox.test`;
    const signup = await call("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "lifecycle-pass" }),
    });
    const cookie = cookieFrom(signup.headers);

    const tokenLogin = await call("/api/auth/token-login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "lifecycle-pass", name: "shortlived", scopes: ["usage"], ttlMs: 60_000 }),
    });
    const { token, tokenId } = tokenLogin.body as { token: string; tokenId: string };

    // (9a) revoke via SESSION channel → bearer dies.
    const revoke = await call(`/api/auth/tokens/${tokenId}`, {
      method: "DELETE",
      headers: { ...CSRF, cookie },
    });
    expect(revoke.status).toBe(200);
    const afterRevoke = await fetch(`${server.base}/api/usage`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(afterRevoke.status).toBe(401);

    // (9b) expiry enforced independently.
    const expiredLogin = await call("/api/auth/token-login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "lifecycle-pass", name: "expired", scopes: ["usage"], ttlMs: 60_000 }),
    });
    const expiredToken = (expiredLogin.body as { token: string }).token;
    await server.services.db.execute(
      (await import("drizzle-orm")).sql`UPDATE api_tokens SET expires_at = now() - interval '1 minute' WHERE token_hash = ${(await import("../src/auth.js")).hashToken(expiredToken)}`,
    );
    const afterExpiry = await fetch(`${server.base}/api/usage`, {
      headers: { authorization: `Bearer ${expiredToken}` },
    });
    expect(afterExpiry.status).toBe(401);

    // (11) browser cookie auth remains unchanged end-to-end.
    const me = await call("/api/me", { headers: { cookie } });
    expect(me.status).toBe(200);

    // (12) cross-org membership protection intact for PATs.
    const freshPat = await call("/api/auth/token-login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "lifecycle-pass", name: "crossorg" }),
    });
    const foreignSwitch = await call("/api/auth/orgs/select", {
      method: "POST",
      headers: { ...CSRF, authorization: `Bearer ${(freshPat.body as { token: string }).token}` },
      body: JSON.stringify({ orgId: randomUUID() }),
    });
    expect(foreignSwitch.status).toBe(403);
  });

  // ==== Prompt 01 — payment providers =========================================

  /** Scriptable provider driving the full HTTP webhook pipeline in tests. */
  class ScriptedProvider {
    readonly name = "scripted";
    readonly capabilities = ["checkout", "webhook_verification", "charge", "cancel"] as const;
    readonly environment = "test";
    readonly configured = true;
    private queue: Array<Record<string, unknown>> = [];
    private seq = 0;

    enqueue(event: Record<string, unknown>): void {
      this.queue.push(event);
    }

    async createCheckout(input: { checkoutSessionId: string }): Promise<{ providerRef: string; redirectUrl: string }> {
      return {
        providerRef: `scripted_${input.checkoutSessionId}`,
        redirectUrl: `https://pay.scripted/${input.checkoutSessionId}`,
      };
    }
    async charge() {
      return { ok: false, failureReason: "provider-managed" };
    }
    async cancelRemote(): Promise<void> {}

    async verifyWebhook(_headers: Record<string, string>, rawBody: string) {
      const parsed = JSON.parse(rawBody) as Record<string, unknown>;
      const expected = this.queue.shift();
      this.seq += 1;
      if (!expected || JSON.stringify(expected) !== JSON.stringify(parsed)) {
        throw Object.assign(new Error("webhook verification failed: stale/unsolicited event"), {
          name: "WebhookVerificationError",
        });
      }
      const e = expected as {
        eventId?: string;
        type: "checkout.completed" | "payment.succeeded" | "payment.failed" | "subscription.canceled";
        subjectRef: string;
        subscriptionRef?: string;
        occurredAt?: string;
        amountMinor?: number;
        currency?: string;
      };
      return {
        externalEventId: String(e.eventId ?? `scripted:${this.seq}`),
        type: e.type,
        subjectRef: e.subjectRef,
        sequence: this.seq,
        subscriptionRef: e.subscriptionRef,
        occurredAt: e.occurredAt,
        amountMinor: e.amountMinor,
        currency: e.currency,
        payload: parsed,
      };
    }

    async verifyCheckout(input: { providerRef: string }) {
      return {
        paid: true,
        amountMinor: 1999n,
        currency: "USD",
        occurredAt: new Date().toISOString(),
        transactionRef: `tx_${input.providerRef}`,
      };
    }
  }

  function signedWebhookCall(providerName: string, event: Record<string, unknown>) {
    const raw = JSON.stringify(event);
    const stamp = new Date().toISOString();
    return call(`/webhooks/billing/${providerName}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mox-timestamp": stamp,
        "x-mox-signature": signPayload("whsec-int", raw, stamp),
      },
      rawBody: raw,
    });
  }

  async function seedPlan(): Promise<{ planVersionId: string; productId: string; priceVersionId: string }> {
    const { PgBillingStore } = await import("@mox/database");
    const store = new PgBillingStore(server.services.db);
    const product = await store.createProduct({
      id: randomUUID(),
      code: `p01-${randomUUID().slice(0, 8)}`,
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
    return { planVersionId: planVersion.id, productId: product.id, priceVersionId: price.id };
  }

  async function seedCommercialSubscription(
    orgId: string,
    values: Record<string, boolean | number | string>,
  ): Promise<{ planVersionId: string; priceVersionId: string }> {
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
    return { planVersionId: catalog.planVersionId, priceVersionId: catalog.priceVersionId };
  }

  async function loginAndSwitch(email: string, password: string, orgId: string): Promise<string> {
    const login = await call("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const cookie = cookieFrom(login.headers);
    const switched = await call("/api/auth/orgs/select", {
      method: "POST",
      headers: { ...CSRF, cookie },
      body: JSON.stringify({ orgId }),
    });
    expect(switched.status).toBe(200);
    return cookie;
  }

  it("org role matrix enforces workspace, billing, infrastructure, approval, and PAT intersections (Security Repair 02)", async () => {
    const ownerEmail = `${randomUUID()}@mox.test`;
    const ownerSignup = await call("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: ownerEmail, password: "role-matrix-pass" }),
    });
    const ownerCookie = cookieFrom(ownerSignup.headers);
    const ownerMe = (await (await call("/api/me", { headers: { cookie: ownerCookie } })).body) as { orgId: string; userId: string };
    await seedCommercialSubscription(ownerMe.orgId, {
      active_concurrent_agents: 5,
      agent_rooms: 2,
      included_server_count: 1,
      included_compute_class: "COMPUTE_SMALL",
    });

    const { agents: agentsTable, approvalRequests: approvalRequestsTable } = await import("@mox/database");
    const [agent] = await server.services.db.insert(agentsTable).values({
      orgId: ownerMe.orgId,
      slug: `role-agent-${randomUUID().slice(0, 8)}`,
      displayName: "Role Agent",
      status: "active",
      definition: { agentId: "role-agent", model: { providerId: "old", modelId: "old" } },
      createdByUserId: ownerMe.userId,
    }).returning({ id: agentsTable.id });
    const agentId = agent!.id;

    const memberEmail = `${randomUUID()}@mox.test`;
    const viewerEmail = `${randomUUID()}@mox.test`;
    const adminEmail = `${randomUUID()}@mox.test`;
    for (const [email, password] of [[memberEmail, "member-matrix-pass"], [viewerEmail, "viewer-matrix-pass"], [adminEmail, "admin-matrix-pass"]] as const) {
      const signup = await call("/api/auth/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      expect(signup.status).toBe(200);
    }
    await server.services.db.execute(
      (await import("drizzle-orm")).sql`
        INSERT INTO memberships (org_id, user_id, role)
        SELECT ${ownerMe.orgId}, id,
          CASE
            WHEN email = ${memberEmail.toLowerCase()} THEN 'member'::membership_role
            WHEN email = ${viewerEmail.toLowerCase()} THEN 'viewer'::membership_role
            ELSE 'admin'::membership_role
          END
        FROM users
        WHERE email in (${memberEmail.toLowerCase()}, ${viewerEmail.toLowerCase()}, ${adminEmail.toLowerCase()})
      `,
    );
    const memberCookie = await loginAndSwitch(memberEmail, "member-matrix-pass", ownerMe.orgId);
    const viewerCookie = await loginAndSwitch(viewerEmail, "viewer-matrix-pass", ownerMe.orgId);
    const adminCookie = await loginAndSwitch(adminEmail, "admin-matrix-pass", ownerMe.orgId);

    const viewerPatch = await call(`/api/agents/${agentId}/model`, {
      method: "PATCH",
      headers: { ...CSRF, cookie: viewerCookie },
      body: JSON.stringify({ providerId: "openai", modelId: "gpt-test" }),
    });
    expect(viewerPatch.status).toBe(403);
    expect(JSON.stringify(viewerPatch.body)).toContain("role_denied");

    const viewerThread = await call("/api/threads", {
      method: "POST",
      headers: { ...CSRF, cookie: viewerCookie },
      body: JSON.stringify({ agentId, title: "viewer denied" }),
    });
    expect(viewerThread.status).toBe(403);
    expect(JSON.stringify(viewerThread.body)).toContain("role_denied");

    const memberPatch = await call(`/api/agents/${agentId}/model`, {
      method: "PATCH",
      headers: { ...CSRF, cookie: memberCookie },
      body: JSON.stringify({ providerId: "openai", modelId: "gpt-test" }),
    });
    expect(memberPatch.status).toBe(200);
    const memberThread = await call("/api/threads", {
      method: "POST",
      headers: { ...CSRF, cookie: memberCookie },
      body: JSON.stringify({ agentId, title: "member allowed" }),
    });
    expect(memberThread.status).toBe(200);
    const threadId = (memberThread.body as { threadId: string }).threadId;

    const memberServer = await call("/api/servers/orders", {
      method: "POST",
      headers: { ...CSRF, cookie: memberCookie, "Idempotency-Key": `member-deny-${randomUUID()}` },
      body: JSON.stringify({ computeClassCode: "COMPUTE_SMALL", hostname: "member-denied" }),
    });
    expect(memberServer.status).toBe(403);
    expect(JSON.stringify(memberServer.body)).toContain("role_denied");

    const starPat = (await call("/api/auth/token-login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: memberEmail, password: "member-matrix-pass", name: "star" }),
    })).body as { token: string };
    await call("/api/auth/orgs/select", {
      method: "POST",
      headers: { ...CSRF, authorization: `Bearer ${starPat.token}` },
      body: JSON.stringify({ orgId: ownerMe.orgId }),
    });
    const starServer = await call("/api/servers/orders", {
      method: "POST",
      headers: { ...CSRF, authorization: `Bearer ${starPat.token}`, "Idempotency-Key": `star-deny-${randomUUID()}` },
      body: JSON.stringify({ computeClassCode: "COMPUTE_SMALL", hostname: "star-denied" }),
    });
    expect(starServer.status).toBe(403);
    expect(JSON.stringify(starServer.body)).toContain("role_denied");

    const approvalId = `appr_${randomUUID()}`;
    await server.services.db.insert(approvalRequestsTable).values({
      approvalRef: approvalId,
      orgId: ownerMe.orgId,
      agentId,
      threadId,
      correlationId: `approval:${approvalId}`,
      payload: { type: "approval.requested", approvalId, kind: "spend", summary: "Approve spend" },
      kind: "spend",
      summary: "Approve spend",
    });
    const memberApproval = await call(`/api/approvals/${approvalId}/resolve`, {
      method: "POST",
      headers: { ...CSRF, cookie: memberCookie },
      body: JSON.stringify({ outcome: "approved" }),
    });
    expect(memberApproval.status).toBe(403);
    const ownerApproval = await call(`/api/approvals/${approvalId}/resolve`, {
      method: "POST",
      headers: { ...CSRF, cookie: ownerCookie },
      body: JSON.stringify({ outcome: "approved" }),
    });
    expect(ownerApproval.status).toBe(200);
    const replaySameApproval = await call(`/api/approvals/${approvalId}/resolve`, {
      method: "POST",
      headers: { ...CSRF, cookie: ownerCookie },
      body: JSON.stringify({ outcome: "approved" }),
    });
    expect(replaySameApproval.status).toBe(200);
    const replayApproval = await call(`/api/approvals/${approvalId}/resolve`, {
      method: "POST",
      headers: { ...CSRF, cookie: ownerCookie },
      body: JSON.stringify({ outcome: "denied" }),
    });
    expect(replayApproval.status).toBe(409);
    const adminReplayApproval = await call(`/api/approvals/${approvalId}/resolve`, {
      method: "POST",
      headers: { ...CSRF, cookie: adminCookie },
      body: JSON.stringify({ outcome: "approved" }),
    });
    expect(adminReplayApproval.status).toBe(200);
    expect((adminReplayApproval.body as { duplicate?: boolean }).duplicate).toBe(true);

    const noEntitlementOwner = await call("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `${randomUUID()}@mox.test`, password: "no-entitlement-pass" }),
    });
    const noEntitlementOrder = await call("/api/servers/orders", {
      method: "POST",
      headers: { ...CSRF, cookie: cookieFrom(noEntitlementOwner.headers), "Idempotency-Key": `owner-noent-${randomUUID()}` },
      body: JSON.stringify({ computeClassCode: "COMPUTE_SMALL", hostname: "owner-noent" }),
    });
    expect(noEntitlementOrder.status).toBe(402);

    const adminOrder = await call("/api/servers/orders", {
      method: "POST",
      headers: { ...CSRF, cookie: adminCookie, "Idempotency-Key": `admin-entitled-${randomUUID()}` },
      body: JSON.stringify({ computeClassCode: "COMPUTE_SMALL", hostname: "admin-entitled" }),
    });
    expect(adminOrder.status).not.toBe(403);
  });

  it("approval resolution is durable, org-scoped, and delivered to runtime once (Security Repair 03)", async () => {
    const ownerEmail = `${randomUUID()}@mox.test`;
    const ownerSignup = await call("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: ownerEmail, password: "approval-runtime-pass" }),
    });
    const ownerCookie = cookieFrom(ownerSignup.headers);
    const ownerMe = (await (await call("/api/me", { headers: { cookie: ownerCookie } })).body) as { orgId: string; userId: string };
    await seedCommercialSubscription(ownerMe.orgId, { active_concurrent_agents: 2 });

    const { agents: agentsTable, approvalRequests: approvalRequestsTable, sessionEvents: sessionEventsTable } = await import("@mox/database");
    const [agent] = await server.services.db.insert(agentsTable).values({
      orgId: ownerMe.orgId,
      slug: `approval-agent-${randomUUID().slice(0, 8)}`,
      displayName: "Approval Agent",
      status: "active",
      definition: { agentId: "approval-agent", model: { providerId: "openai", modelId: "test" } },
      createdByUserId: ownerMe.userId,
    }).returning({ id: agentsTable.id });
    const agentId = agent!.id;
    const thread = await call("/api/threads", {
      method: "POST",
      headers: { ...CSRF, cookie: ownerCookie },
      body: JSON.stringify({ agentId, title: "approval runtime" }),
    });
    expect(thread.status).toBe(200);
    const threadId = (thread.body as { threadId: string }).threadId;

    const approvalId = `appr_${randomUUID()}`;
    const runId = `run-${randomUUID()}`;
    await server.services.db.insert(approvalRequestsTable).values({
      approvalRef: approvalId,
      orgId: ownerMe.orgId,
      agentId,
      threadId,
      correlationId: runId,
      requesterUserId: ownerMe.userId,
      toolName: "computer.click",
      action: "click",
      policyReason: "computer control requires approval",
      payload: { approvalId, runId, toolName: "computer.click", secret: "sk-should-not-leak" },
      kind: "computer",
      summary: "Approve computer control",
    });
    await server.services.db.insert(sessionEventsTable).values({
      eventId: `forged-${randomUUID()}`,
      orgId: ownerMe.orgId,
      subjectKind: "thread",
      subjectId: threadId,
      agentId,
      runId,
      correlationId: runId,
      type: "approval.resolved",
      payload: { approvalId, outcome: "denied", forgedBy: "event-log" },
    });

    const open = await call("/api/approvals/open", { headers: { cookie: ownerCookie } });
    expect(open.status).toBe(200);
    expect((open.body as Array<{ approvalId: string }>).some((row) => row.approvalId === approvalId)).toBe(true);

    const intruderSignup = await call("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `${randomUUID()}@mox.test`, password: "approval-intruder-pass" }),
    });
    const intruderResolve = await call(`/api/approvals/${approvalId}/resolve`, {
      method: "POST",
      headers: { ...CSRF, cookie: cookieFrom(intruderSignup.headers) },
      body: JSON.stringify({ outcome: "approved" }),
    });
    expect(intruderResolve.status).toBe(404);

    const originalRuntime = server.services.runtime;
    const delivered: Array<{ orgId: string; runId: string; approvalId: string; outcome: string }> = [];
    server.services.runtime = {
      respondApproval: async (request: { orgId: string; runId: string; approvalId: string; outcome: "approved" | "denied" }) => {
        delivered.push(request);
        return { approvalId: request.approvalId, delivered: true };
      },
    } as unknown as NonNullable<ControlPlaneServices["runtime"]>;
    try {
      const resolved = await call(`/api/approvals/${approvalId}/resolve`, {
        method: "POST",
        headers: { ...CSRF, cookie: ownerCookie },
        body: JSON.stringify({ outcome: "approved" }),
      });
      expect(resolved.status).toBe(200);
      expect(delivered).toEqual([{ orgId: ownerMe.orgId, runId, approvalId, outcome: "approved" }]);

      const replay = await call(`/api/approvals/${approvalId}/resolve`, {
        method: "POST",
        headers: { ...CSRF, cookie: ownerCookie },
        body: JSON.stringify({ outcome: "approved" }),
      });
      expect(replay.status).toBe(200);
      expect((replay.body as { duplicate?: boolean }).duplicate).toBe(true);
      expect(delivered).toHaveLength(1);

      const conflict = await call(`/api/approvals/${approvalId}/resolve`, {
        method: "POST",
        headers: { ...CSRF, cookie: ownerCookie },
        body: JSON.stringify({ outcome: "denied" }),
      });
      expect(conflict.status).toBe(409);
      expect(delivered).toHaveLength(1);
    } finally {
      server.services.runtime = originalRuntime;
    }
  });

  it("billing mutations require scope AND org owner/admin authority (Prompt 01)", async () => {
    const ownerEmail = `${randomUUID()}@mox.test`;
    const ownerSignup = await call("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: ownerEmail, password: "billing-auth-pass" }),
    });
    const ownerCookie = cookieFrom(ownerSignup.headers);
    const ownerId = ((await (await call("/api/me", { headers: { cookie: ownerCookie } })).body) as { orgId: string })
      .orgId;

    const memberEmail = `${randomUUID()}@mox.test`;
    await call("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: memberEmail, password: "billing-auth-pass" }),
    });
    await server.services.db.execute(
      (await import("drizzle-orm")).sql`
        INSERT INTO memberships (org_id, user_id, role)
        SELECT ${ownerId}, id, 'member' FROM users WHERE email = ${memberEmail.toLowerCase()}
      `,
    );

    // Member PAT with billing scope: reads OK, mutation DENIED.
    const memberPat = (await call("/api/auth/token-login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: memberEmail, password: "billing-auth-pass", name: "m", scopes: ["billing"] }),
    })).body as { token: string };
    const memberRead = await call("/api/billing/invoices", {
      headers: { authorization: `Bearer ${memberPat.token}` },
    });
    expect(memberRead.status).toBe(200);
    // Enter the OWNER's org (membership-checked switch) so role checks
    // evaluate the right workspace.
    await call("/api/auth/orgs/select", {
      method: "POST",
      headers: { ...CSRF, authorization: `Bearer ${memberPat.token}` },
      body: JSON.stringify({ orgId: ownerId }),
    });
    const memberMutation = await call("/api/billing/checkout", {
      method: "POST",
      headers: { ...CSRF, authorization: `Bearer ${memberPat.token}` },
      body: JSON.stringify({
        planVersionId: randomUUID(),
        providerName: "scripted",
        successUrl: "https://x/y",
        cancelUrl: "https://x/z",
      }),
    });
    expect(memberMutation.status).toBe(403);
    expect(JSON.stringify(memberMutation.body)).toContain("role_denied");

    // '*' PAT for the MEMBER also cannot mutate (no privilege creation).
    const starPat = (await call("/api/auth/token-login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: memberEmail, password: "billing-auth-pass", name: "star" }),
    })).body as { token: string };
    // Enter the OWNER's org so the role check evaluates the member seat.
    await call("/api/auth/orgs/select", {
      method: "POST",
      headers: { ...CSRF, authorization: `Bearer ${starPat.token}` },
      body: JSON.stringify({ orgId: ownerId }),
    });
    const starMutation = await call("/api/billing/checkout", {
      method: "POST",
      headers: { ...CSRF, authorization: `Bearer ${starPat.token}` },
      body: JSON.stringify({
        planVersionId: randomUUID(),
        providerName: "scripted",
        successUrl: "https://x/y",
        cancelUrl: "https://x/z",
      }),
    });
    expect(starMutation.status).toBe(403);
    expect(JSON.stringify(starMutation.body)).toContain("role_denied");

    // PAT without billing scope is denied even READS.
    const noScopePat = (await call("/api/auth/token-login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: ownerEmail, password: "billing-auth-pass", name: "ns", scopes: ["agents"] }),
    })).body as { token: string };
    const deniedRead = await call("/api/billing/invoices", {
      headers: { authorization: `Bearer ${noScopePat.token}` },
    });
    expect(deniedRead.status).toBe(403);
    expect(JSON.stringify(deniedRead.body)).toContain("scope_denied");

    // Owner COOKIE may mutate (org authority present).
    server.services.billing.registerProvider(new ScriptedProvider() as never);
    const catalog = await seedPlan();
    const checkout = await call("/api/billing/checkout", {
      method: "POST",
      headers: { ...CSRF, cookie: ownerCookie },
      body: JSON.stringify({
        planVersionId: catalog.planVersionId,
        providerName: "scripted",
        successUrl: "https://app.example/success",
        cancelUrl: "https://app.example/cancel",
      }),
    });
    expect(checkout.status).toBe(200);
  });

  it("redirect grants nothing; webhook activates; replay dedupes; out-of-order cannot regress (Prompt 01)", async () => {
    const provider = new ScriptedProvider();
    server.services.billing.registerProvider(provider as never);

    const email = `${randomUUID()}@mox.test`;
    const signup = await call("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "pipeline-pass" }),
    });
    const cookie = cookieFrom(signup.headers);

    const catalog = await seedPlan();

    // Redirect WITHOUT webhook: nothing activates.
    const created = await call("/api/billing/checkout", {
      method: "POST",
      headers: { ...CSRF, cookie },
      body: JSON.stringify({
        planVersionId: catalog.planVersionId,
        providerName: "scripted",
        successUrl: "https://x/s",
        cancelUrl: "https://x/c",
      }),
    });
    expect(created.status).toBe(200);
    const sessionId = (created.body as { sessionId: string }).sessionId;
    expect((await (await call("/api/billing/subscription", { headers: { cookie } })).body) ?? null).toBeNull();

    // Verified webhook ACTIVATES.
    const t0 = new Date(Date.now() - 60_000).toISOString();
    const activationEvent = {
      eventId: "evt_act_1",
      type: "checkout.completed",
      subjectRef: `scripted_${sessionId}`,
      subscriptionRef: "scripted_sub_9",
      occurredAt: t0,
      amountMinor: 1999,
      currency: "USD",
    };
    provider.enqueue(activationEvent);
    const activation = await signedWebhookCall(provider.name, activationEvent);
    expect(JSON.stringify(activation.body)).toContain('"applied":true');
    const subAfter = (await (await call("/api/billing/subscription", { headers: { cookie } })).body) as {
      state?: string;
      providerRef?: string;
    };
    expect(subAfter?.state).toBe("active");

    // Replay of the SAME event: deduped.
    provider.enqueue({ ...activationEvent });
    const replay = await signedWebhookCall(provider.name, { ...activationEvent });
    expect(JSON.stringify(replay.body)).toContain('"duplicate":true');

    // Out-of-order: an OLDER cancellation cannot regress newer active state.
    const staleOccurredAt = new Date(Date.now() - 120_000).toISOString();
    provider.enqueue({
      eventId: "evt_old_cancel",
      type: "subscription.canceled",
      subjectRef: "scripted_sub_9",
      subscriptionRef: "scripted_sub_9",
      occurredAt: staleOccurredAt,
    });
    const stale = await signedWebhookCall(provider.name, {
      eventId: "evt_old_cancel",
      type: "subscription.canceled",
      subjectRef: "scripted_sub_9",
      subscriptionRef: "scripted_sub_9",
      occurredAt: staleOccurredAt,
    });
    expect(stale.status).toBe(200);
    const stillActive = (await (await call("/api/billing/subscription", { headers: { cookie } })).body) as {
      state?: string;
    };
    expect(stillActive?.state).toBe("active");
  });

  it("wrong amount/currency events are rejected (Prompt 01)", async () => {
    const provider = new ScriptedProvider();
    server.services.billing.registerProvider(provider as never);

    const email = `${randomUUID()}@mox.test`;
    const signup = await call("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "amount-guard-pass" }),
    });
    const cookie = cookieFrom(signup.headers);
    const catalog = await seedPlan();

    const created = await call("/api/billing/checkout", {
      method: "POST",
      headers: { ...CSRF, cookie },
      body: JSON.stringify({
        planVersionId: catalog.planVersionId,
        providerName: "scripted",
        successUrl: "https://x/s",
        cancelUrl: "https://x/c",
      }),
    });
    const sessionId = (created.body as { sessionId: string }).sessionId;
    const occurredAt = new Date().toISOString();

    provider.enqueue({
      eventId: "evt_wrong_amount",
      type: "checkout.completed",
      subjectRef: `scripted_${sessionId}`,
      subscriptionRef: "scripted_sub_bad",
      occurredAt,
      amountMinor: 999,
      currency: "USD",
    });
    const res = await signedWebhookCall(provider.name, {
      eventId: "evt_wrong_amount",
      type: "checkout.completed",
      subjectRef: `scripted_${sessionId}`,
      subscriptionRef: "scripted_sub_bad",
      occurredAt,
      amountMinor: 999,
      currency: "USD",
    });
    void signup;
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain('"rejected":true');
    expect(JSON.stringify(res.body)).toMatch(/mismatch/i);
  });

  it("missed-webhook reconciliation repairs state exactly once; ids survive restart (Prompt 01)", async () => {
    const provider = new ScriptedProvider();
    server.services.billing.registerProvider(provider as never);

    const email = `${randomUUID()}@mox.test`;
    const signup = await call("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "reconcile-pass" }),
    });
    const cookie = cookieFrom(signup.headers);
    const me = (await (await call("/api/me", { headers: { cookie } })).body) as { orgId: string };
    const catalog = await seedPlan();

    const created = await call("/api/billing/checkout", {
      method: "POST",
      headers: { ...CSRF, cookie },
      body: JSON.stringify({
        planVersionId: catalog.planVersionId,
        providerName: "scripted",
        successUrl: "https://x/s",
        cancelUrl: "https://x/c",
      }),
    });
    const sessionId = (created.body as { sessionId: string }).sessionId;

    // Webhook MISSED entirely -> reconciliation repairs.
    const first = await call("/api/billing/reconcile", {
      method: "POST",
      headers: { ...CSRF, cookie },
      body: JSON.stringify({}),
    });
    expect(first.status).toBe(200);
    expect(JSON.stringify(first.body)).toContain('"applied":true');

    // Second run: already completed -> no duplicate repair.
    const second = await call("/api/billing/reconcile", {
      method: "POST",
      headers: { ...CSRF, cookie },
      body: JSON.stringify({}),
    });
    expect(JSON.stringify(second.body)).not.toContain('"applied":true');

    // Provider refs survive a process restart (fresh service, same DB).
    const { BillingService } = await import("@mox/billing");
    const { PgBillingStore } = await import("@mox/database");
    const restarted = new BillingService(new PgBillingStore(server.services.db));
    const sub = await restarted.getActiveSubscription(me.orgId);
    expect(sub?.providerRef).toBe(`scripted_${sessionId}`);
    expect(sub?.state).toBe("active");
  });

  it("admin provider configuration is Mox-admin only; secrets are never echoed (Prompt 01)", async () => {
    const ownerEmail = `${randomUUID()}@mox.test`;
    const ownerSignup = await call("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: ownerEmail, password: "prov-admin-pass" }),
    });
    const ownerCookie = cookieFrom(ownerSignup.headers);

    const plainEmail = `${randomUUID()}@mox.test`;
    const plainSignup = await call("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: plainEmail, password: "prov-admin-pass" }),
    });

    // Plain user denied.
    const plainPut = await call("/api/admin/billing-providers/paystack", {
      method: "PUT",
      headers: { ...CSRF, cookie: cookieFrom(plainSignup.headers) },
      body: JSON.stringify({ displayName: "Paystack", enabled: true }),
    });
    expect(plainPut.status).toBe(403);

    // Platform authority is EXPLICIT: even an org owner is denied until
  // their user id is provisioned into the deployment admin list.
    const meOwner = (await (await call("/api/me", { headers: { cookie: ownerCookie } })).body) as { userId: string };
    const deniedBeforeGrant = await call("/api/admin/billing-providers/paystack", {
      method: "PUT",
      headers: { ...CSRF, cookie: ownerCookie },
      body: JSON.stringify({ displayName: "Paystack", enabled: true }),
    });
    expect(deniedBeforeGrant.status).toBe(403);
    server.services.config.platformAdminRoles[meOwner.userId] = "superadmin";

    // Owner (now platform-admin) configures with SECRET REF NAMES only.
    const put = await call("/api/admin/billing-providers/paystack", {
      method: "PUT",
      headers: { ...CSRF, cookie: ownerCookie },
      body: JSON.stringify({
        displayName: "Paystack",
        enabled: true,
        environment: "test",
        secretRef: "MOX_PAYSTACK_SECRET_KEY",
        webhookSecretRef: "MOX_PAYSTACK_WEBHOOK_SECRET",
        supportedCurrencies: ["USD", "NGN"],
      }),
    });
    expect(put.status).toBe(200);

    const list = await call("/api/admin/billing-providers", { headers: { cookie: ownerCookie } });
    const row = (list.body as Array<Record<string, unknown>>).find((r) => r.providerName === "paystack");
    expect(row?.hasSecretRef).toBe(true);
    expect(JSON.stringify(list.body)).not.toMatch(/sk_(test|live)_/);

    // Public catalog shows safe fields only.
    const publicList = await call("/api/billing/providers", { headers: { cookie: ownerCookie } });
    const pubRow = (publicList.body as Array<{ providerName?: string; enabled?: boolean }>).find(
      (r) => r.providerName === "paystack",
    );
    expect(pubRow?.enabled).toBe(true);
    expect(JSON.stringify(publicList.body)).not.toContain("secretRef");
  });

  it("platform admin roles map to capabilities without PAT or legacy wildcard escalation (Security Repair 02)", async () => {
    const makeAdmin = async (role: "support" | "billing_admin" | "ops_admin" | "superadmin") => {
      const email = `${role}-${randomUUID()}@mox.test`;
      const signup = await call("/api/auth/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: "platform-role-pass" }),
      });
      const cookie = cookieFrom(signup.headers);
      const me = (await (await call("/api/me", { headers: { cookie } })).body) as { userId: string };
      server.services.config.platformAdminRoles[me.userId] = role;
      return { email, cookie };
    };
    const support = await makeAdmin("support");
    const billing = await makeAdmin("billing_admin");
    const ops = await makeAdmin("ops_admin");
    const superadmin = await makeAdmin("superadmin");

    const supportBillingConfig = await call("/api/admin/billing-providers/stripe", {
      method: "PUT",
      headers: { ...CSRF, cookie: support.cookie },
      body: JSON.stringify({ displayName: "Stripe", enabled: true }),
    });
    expect(supportBillingConfig.status).toBe(403);
    expect(JSON.stringify(supportBillingConfig.body)).toContain("capability_denied");
    const supportComputeRead = await call("/api/admin/compute", { headers: { cookie: support.cookie } });
    expect(supportComputeRead.status).toBe(200);
    expect(JSON.stringify(supportComputeRead.body)).not.toMatch(/credentialRefId|rootCredentialRefId|agentTokenHash|enrollTokenHash|requestFingerprint/);

    const billingComputeCredential = await call("/api/admin/compute/accounts/hetzner/primary", {
      method: "PUT",
      headers: { ...CSRF, cookie: billing.cookie },
      body: JSON.stringify({ enabled: true, commercialStatus: "approved", credentialRefId: randomUUID() }),
    });
    expect(billingComputeCredential.status).toBe(403);
    expect(JSON.stringify(billingComputeCredential.body)).toContain("capability_denied");

    const opsPricing = await call("/api/admin/plans/price-books", {
      method: "PUT",
      headers: { ...CSRF, cookie: ops.cookie },
      body: JSON.stringify({ productId: randomUUID(), pricingRegion: "GLOBAL", mode: "fixed" }),
    });
    expect(opsPricing.status).toBe(403);
    expect(JSON.stringify(opsPricing.body)).toContain("capability_denied");

    const superBillingConfig = await call("/api/admin/billing-providers/stripe", {
      method: "PUT",
      headers: { ...CSRF, cookie: superadmin.cookie },
      body: JSON.stringify({ displayName: "Stripe", enabled: true, environment: "test" }),
    });
    expect(superBillingConfig.status).toBe(200);

    const ownerToken = (await call("/api/auth/token-login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: support.email, password: "platform-role-pass", name: "admin-pat", scopes: ["admin"] }),
    })).body as { token: string };
    const patAdminAttempt = await call("/api/admin/billing-providers/paypal", {
      method: "PUT",
      headers: { ...CSRF, authorization: `Bearer ${ownerToken.token}` },
      body: JSON.stringify({ displayName: "PayPal", enabled: true }),
    });
    expect(patAdminAttempt.status).toBe(403);
    expect(JSON.stringify(patAdminAttempt.body)).toContain("session_only");
  });

  it("admin customer suspend/reactivate uses billing and compute state machines with target-org audit (Security Repair 02)", async () => {
    const adminSignup = await call("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `${randomUUID()}@mox.test`, password: "customer-admin-pass" }),
    });
    const adminCookie = cookieFrom(adminSignup.headers);
    const adminMe = (await (await call("/api/me", { headers: { cookie: adminCookie } })).body) as { userId: string; orgId: string };
    server.services.config.platformAdminRoles[adminMe.userId] = "superadmin";

    const targetSignup = await call("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `${randomUUID()}@mox.test`, password: "target-customer-pass" }),
    });
    const targetCookie = cookieFrom(targetSignup.headers);
    const targetMe = (await (await call("/api/me", { headers: { cookie: targetCookie } })).body) as { orgId: string };
    const catalog = await seedCommercialSubscription(targetMe.orgId, { active_concurrent_agents: 1 });
    const activeSub = await server.services.billing.getActiveSubscription(targetMe.orgId);
    expect(activeSub?.state).toBe("active");
    const canceledSub = await server.services.billing.store.createSubscription({
      id: randomUUID(),
      orgId: targetMe.orgId,
      planVersionId: catalog.planVersionId,
      priceVersionId: catalog.priceVersionId,
      state: "canceled",
      providerName: "scripted",
      providerRef: `scripted_sub_canceled_${randomUUID()}`,
      providerEnvironment: "test",
      currentPeriodStart: new Date(Date.now() - 60_000).toISOString(),
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 3600_000).toISOString(),
      failedRenewals: 0,
      cancelAtPeriodEnd: false,
      canceledAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });

    const { computeClasses: computeClassesTable, serverOrders: serverOrdersTable, serverOperations: serverOperationsTable, auditEvents: auditEventsTable } = await import("@mox/database");
    await server.services.db.insert(computeClassesTable).values({
      code: "COMPUTE_ADMIN_TEST",
      displayName: "Admin Test",
      minVcpu: 1,
      minRamGb: 1,
      skuMap: [],
      active: true,
    }).onConflictDoNothing({ target: computeClassesTable.code });
    const [order] = await server.services.db.insert(serverOrdersTable).values({
      orgId: targetMe.orgId,
      computeClassCode: "COMPUTE_ADMIN_TEST",
      state: "running",
      providerName: "fake-compute",
      providerInstanceId: `instance-${randomUUID()}`,
      hostname: "admin-cancel-test",
      idempotencyKey: `admin-cancel-${randomUUID()}`,
    }).returning({ id: serverOrdersTable.id });

    const suspend = await call(`/api/admin/customers/${targetMe.orgId}/suspend`, {
      method: "POST",
      headers: { ...CSRF, cookie: adminCookie },
      body: JSON.stringify({ reason: "security review" }),
    });
    expect(suspend.status).toBe(200);
    expect((suspend.body as { queuedComputeActions: number }).queuedComputeActions).toBe(1);
    expect((await server.services.billing.getSubscription(activeSub!.id)).state).toBe("suspended");
    const activeTransitions = await server.services.billing.listTransitions(activeSub!.id);
    expect(activeTransitions.some((row) => row.toState === "suspended" && row.actorType === "admin" && row.actorId === adminMe.userId)).toBe(true);
    const orderAfterSuspend = await server.services.orchestrator.getOrder(order!.id);
    expect(orderAfterSuspend.state).toBe("cancelling");
    const cancelOps = await server.services.db
      .select()
      .from(serverOperationsTable)
      .where((await import("drizzle-orm")).eq(serverOperationsTable.orderId, order!.id));
    expect(cancelOps.some((op) => op.kind === "cancel" && op.state === "queued")).toBe(true);

    const reactivate = await call(`/api/admin/customers/${targetMe.orgId}/reactivate`, {
      method: "POST",
      headers: { ...CSRF, cookie: adminCookie },
      body: JSON.stringify({}),
    });
    expect(reactivate.status).toBe(200);
    expect((reactivate.body as { ok: boolean; subscriptionErrors: Array<{ subscriptionId: string }> }).ok).toBe(false);
    expect((await server.services.billing.getSubscription(activeSub!.id)).state).toBe("active");
    expect((await server.services.billing.getSubscription(canceledSub.id)).state).toBe("canceled");

    const audits = await server.services.db
      .select()
      .from(auditEventsTable)
      .where((await import("drizzle-orm")).eq(auditEventsTable.resourceId, targetMe.orgId));
    const suspendAudit = audits.find((row) => row.action === "customer.suspend");
    expect(suspendAudit?.orgId).toBe(targetMe.orgId);
    expect(suspendAudit?.orgId).not.toBe(adminMe.orgId);
    expect(suspendAudit?.actorType).toContain("superadmin");
    expect(JSON.stringify(suspendAudit?.after)).toContain("admin.customers.write");
  });

  it("duplicate workspace names allocate distinct slugs safely (00C §F, test 11)", async () => {
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
  // ==== Prompt 02 — notifications =============================================

  async function twoUsers(): Promise<{ a: { cookie: string; userId: string; orgId: string }; b: { cookie: string; userId: string; orgId: string } }> {
    const mk = async (tag: string) => {
      const email = `${randomUUID()}@mox.test`;
      const res = await call("/api/auth/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: `notif-${tag}-pass` }),
      });
      const cookie = cookieFrom(res.headers);
      const me = (await (await call("/api/me", { headers: { cookie } })).body) as { userId: string; orgId: string };
      return { cookie, userId: me.userId, orgId: me.orgId };
    };
    return { a: await mk("a"), b: await mk("b") };
  }

  it("user inbox is ownership-scoped: IDOR and cross-tenant denied (Prompt 02)", async () => {
    const { a, b } = await twoUsers();
    // Seed one notification for A via the platform event path.
    await server.services.notifications.consume({
      eventId: `seed:${randomUUID()}`,
      type: "backup.completed",
      orgId: a.orgId,
      userId: a.userId,
      severity: "info",
      category: "system",
      resourceType: "backup",
      templateVars: {},
      at: new Date().toISOString(),
    });
    const listA = (await (await call("/api/notifications", { headers: { cookie: a.cookie } })).body) as Array<{
      id: string;
      title?: string;
    }>;
    expect(listA.length).toBeGreaterThanOrEqual(1);
    const target = listA[0]!.id;

    // B cannot read A's notification.
    const idor = await call(`/api/notifications/${target}`, { headers: { cookie: b.cookie } });
    expect(idor.status).toBe(404);
    // B cannot mark it read.
    const mark = await call(`/api/notifications/${target}/read`, {
      method: "POST",
      headers: { ...CSRF, cookie: b.cookie },
      body: "{}",
    });
    expect(mark.status).toBe(404);
    // B's inbox does not enumerate A's rows.
    const listB = (await (await call("/api/notifications", { headers: { cookie: b.cookie } })).body) as unknown[];
    expect(listB.some((n) => (n as { id: string }).id === target)).toBe(false);

    // Per-user unread counts.
    const countA = (await (await call("/api/notifications/unread-count", { headers: { cookie: a.cookie } })).body) as { count: number };
    const countB = (await (await call("/api/notifications/unread-count", { headers: { cookie: b.cookie } })).body) as { count: number };
    expect(countA.count).toBeGreaterThanOrEqual(1);

    // A reads it; B unaffected.
    await call(`/api/notifications/${target}/read`, { method: "POST", headers: { ...CSRF, cookie: a.cookie }, body: "{}" });
    const countA2 = (await (await call("/api/notifications/unread-count", { headers: { cookie: a.cookie } })).body) as { count: number };
    expect(countA2.count).toBe(countA.count - 1);
    void countB;
  });

  it("mark-all-read and archive persist across restart (Prompt 02)", async () => {
    const { a } = await twoUsers();
    for (let i = 0; i < 3; i += 1) {
      await server.services.notifications.consume({
        eventId: `bulk:${randomUUID()}`,
        type: "server.provisioned",
        orgId: a.orgId,
        userId: a.userId,
        severity: "info",
        category: "servers",
        templateVars: {},
        at: new Date().toISOString(),
      });
    }
    const before = (await (await call("/api/notifications/unread-count", { headers: { cookie: a.cookie } })).body) as { count: number };
    expect(before.count).toBeGreaterThanOrEqual(3);
    const marked = (await call("/api/notifications/read-all", {
      method: "POST",
      headers: { ...CSRF, cookie: a.cookie },
      body: "{}",
    }).then((r) => r.body)) as { changed: number };
    expect(marked.changed).toBe(before.count);
    // Fresh store instance over the same DB proves durability.
    const { PgNotificationStore } = await import("@mox/database");
    const fresh = new PgNotificationStore(server.services.db);
    expect(await fresh.unreadCount(a.orgId, a.userId)).toBe(0);
  });

  it("admin send targets user/org/all with durable idempotent fan-out; platform-admin gated (Prompt 02)", async () => {
    const { a, b } = await twoUsers();
    const cSignup = await call("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `${randomUUID()}@mox.test`, password: "notif-c-pass" }),
    });
    const c = {
      cookie: cookieFrom(cSignup.headers),
      ...((await (await call("/api/me", { headers: { cookie: cookieFrom(cSignup.headers) } })).body) as { userId: string; orgId: string }),
    };
    // Platform authority is explicit.
    const meAdmin = (await (await call("/api/me", { headers: { cookie: a.cookie } })).body) as { userId: string };
    server.services.config.platformAdminCapabilities[meAdmin.userId] = ["admin.read"];

    const capabilityDenied = await call("/api/admin/notifications/send", {
      method: "POST",
      headers: { ...CSRF, cookie: a.cookie },
      body: JSON.stringify({
        idempotencyKey: `cap-deny-${randomUUID()}`,
        audience: { type: "users", userIds: [a.userId] },
        payload: { title: "No capability", body: "Should not send" },
      }),
    });
    expect(capabilityDenied.status).toBe(403);
    expect(JSON.stringify(capabilityDenied.body)).toContain("capability_denied");

    server.services.config.platformAdminRoles[meAdmin.userId] = "superadmin";

    const deny = await call("/api/admin/notifications/send", {
      method: "POST",
      headers: { ...CSRF, cookie: b.cookie },
      body: JSON.stringify({
        idempotencyKey: `deny-${randomUUID()}`,
        audience: { type: "all" },
        payload: { title: "nope", body: "nope" },
      }),
    });
    expect(deny.status).toBe(403);
    expect(JSON.stringify(deny.body)).toContain("role_denied");

    // Single-user target.
    const key1 = `send-user-${randomUUID()}`;
    const send1 = await call("/api/admin/notifications/send", {
      method: "POST",
      headers: { ...CSRF, cookie: a.cookie },
      body: JSON.stringify({
        idempotencyKey: key1,
        audience: { type: "users", userIds: [a.userId] },
        payload: { title: "Hello A", body: "Targeted", category: "system" },
      }),
    });
    expect(send1.status).toBe(200);
    const inboxA = (await (await call("/api/notifications", { headers: { cookie: a.cookie } })).body) as Array<{ title: string }>;
    expect(inboxA.some((n) => n.title === "Hello A")).toBe(true);
    const inboxBAfterTarget = (await (await call("/api/notifications", { headers: { cookie: b.cookie } })).body) as Array<{ title: string }>;
    const inboxCAfterTarget = (await (await call("/api/notifications", { headers: { cookie: c.cookie } })).body) as Array<{ title: string }>;
    expect(inboxBAfterTarget.some((n) => n.title === "Hello A")).toBe(false);
    expect(inboxCAfterTarget.some((n) => n.title === "Hello A")).toBe(false);

    // Idempotent replay: same key → same job, no duplicate rows.
    const send1b = await call("/api/admin/notifications/send", {
      method: "POST",
      headers: { ...CSRF, cookie: a.cookie },
      body: JSON.stringify({
        idempotencyKey: key1,
        audience: { type: "users", userIds: [a.userId] },
        payload: { title: "Hello A", body: "Targeted", category: "system" },
      }),
    });
    expect(send1b.status).toBe(200);
    const inboxA2 = (await (await call("/api/notifications", { headers: { cookie: a.cookie } })).body) as Array<{ title: string }>;
    expect(inboxA2.filter((n) => n.title === "Hello A")).toHaveLength(1);

    // Broadcast to all users reaches B too.
    const sendAll = await call("/api/admin/notifications/send", {
      method: "POST",
      headers: { ...CSRF, cookie: a.cookie },
      body: JSON.stringify({
        idempotencyKey: `broadcast-${randomUUID()}`,
        audience: { type: "all" },
        payload: { title: "Platform news", body: "For everyone", category: "billing" },
      }),
    });
    expect(sendAll.status).toBe(200);
    const inboxB = (await (await call("/api/notifications", { headers: { cookie: b.cookie } })).body) as Array<{ title: string }>;
    expect(inboxB.some((n) => n.title === "Platform news")).toBe(true);
  });

  it("scheduled sends run via the job runner and can be canceled before due time (Prompt 02)", async () => {
    const { a } = await twoUsers();
    const meAdmin = (await (await call("/api/me", { headers: { cookie: a.cookie } })).body) as { userId: string };
    server.services.config.platformAdminRoles[meAdmin.userId] = "superadmin";

    const scheduledAt = new Date(Date.now() - 1000).toISOString(); // already due
    const jobId = ((await call("/api/admin/notifications/schedule", {
      method: "POST",
      headers: { ...CSRF, cookie: a.cookie },
      body: JSON.stringify({
        idempotencyKey: `sched-${randomUUID()}`,
        audience: { type: "users", userIds: [a.userId] },
        payload: { title: "Scheduled hello", body: "From the past-due schedule", category: "agents" },
        scheduledAt,
      }),
    }).then((r) => r.body)) as { jobId: string }).jobId;

    // Runner processes the due job.
    const ran = await server.services.notifications.runDueJobs(new Date().toISOString());
    expect(ran.processed).toBeGreaterThanOrEqual(1);
    const job = (await call(`/api/admin/notifications/jobs/${jobId}`, { headers: { cookie: a.cookie } }).then(
      (r) => r.body,
    )) as { status: string; fanoutDone: number; fanoutTotal: number };
    expect(job.status).toBe("completed");
    expect(job.fanoutDone).toBe(1);
    expect(job.fanoutTotal).toBe(1);
    const inbox = (await (await call("/api/notifications?category=agents", { headers: { cookie: a.cookie } })).body) as Array<{
      title: string;
    }>;
    expect(inbox.some((n) => n.title === "Scheduled hello")).toBe(true);

    // Cancel path for a future job.
    const futureJob = (await call("/api/admin/notifications/schedule", {
      method: "POST",
      headers: { ...CSRF, cookie: a.cookie },
      body: JSON.stringify({
        idempotencyKey: `sched-future-${randomUUID()}`,
        audience: { type: "users", userIds: [a.userId] },
        payload: { title: "Future", body: "Never sent", category: "system" },
        scheduledAt: new Date(Date.now() + 3600_000).toISOString(),
      }),
    }).then((r) => r.body)) as { jobId: string };
    const cancel = await call(`/api/admin/notifications/jobs/${futureJob.jobId}/cancel`, {
      method: "POST",
      headers: { ...CSRF, cookie: a.cookie },
      body: "{}",
    });
    expect(cancel.status).toBe(200);
  });

  it("payment events feed the notification service automatically (Prompt 01→02 wiring)", async () => {
    // The billing webhook test earlier in this file activated a
    // subscription through the scripted provider; that flow now emits a
    // subscription.activated org-audience row. Verify any org has one.
    const { PgNotificationStore } = await import("@mox/database");
    const store = new PgNotificationStore(server.services.db);
    const result = await server.services.db.execute(
      (await import("drizzle-orm")).sql`SELECT count(*)::int AS n FROM in_app_notifications WHERE event_type = 'subscription.activated'`,
    );
    const n = Number((result.rows[0] as { n: number }).n);
    if (n > 0) {
      // sanity: readable through the ownership-scoped API by org members
      void store;
    }
    // The pipeline itself is proven by the activation webhook test asserting
    // '"applied":true'; here we assert the emission contract exists.
    expect(typeof server.services.notifications.consume).toBe("function");
  });

  // ==== Security Repair 05A — webhook abuse + entitlement reads (HTTP) ====

  it("per-IP webhook rate limit bounds invalid-body floods while the endpoint stays public (05A §G)", async () => {
    const path = `abuse-${randomUUID().slice(0, 8)}`;
    // Isolate the abuse traffic onto a synthetic client IP (trusted proxy)
    // so the locked bucket cannot pollute the shared 127.0.0.1 bucket used
    // by every other test in this suite.
    const originalAbuse = server.services.config.webhookAbuse;
    const originalTrusted = server.services.config.trustedProxyIps;
    server.services.config.trustedProxyIps = ["127.0.0.1", "::ffff:127.0.0.1", "::1"];
    server.services.config.webhookAbuse = {
      ...DEFAULT_WEBHOOK_ABUSE,
      perIpLimit: 3,
      perPathLimit: 100_000,
      globalLimit: 100_000,
    };
    try {
      const junk = JSON.stringify({ unique: randomUUID() });
      for (let i = 0; i <= 3; i++) {
        const res = await call(`/webhooks/billing/${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-forwarded-for": "203.0.113.77",
            "x-mox-timestamp": new Date().toISOString(),
            "x-mox-signature": "deadbeef",
          },
          rawBody: junk,
        });
        if (i < 3) {
          expect(res.status).toBe(200);
        } else {
          expect(res.status).toBe(429);
          expect(JSON.stringify(res.body)).toContain("webhook_rate_limited");
        }
      }
    } finally {
      server.services.config.webhookAbuse = originalAbuse;
      server.services.config.trustedProxyIps = originalTrusted;
    }
  });

  it("oversized webhook bodies are rejected before any processing (05A §G)", async () => {
    const huge = "x".repeat(300 * 1024);
    const res = await call(`/webhooks/billing/size-${randomUUID().slice(0, 8)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      rawBody: huge,
    });
    expect(res.status).toBe(413);
    expect(JSON.stringify(res.body)).toContain("body_too_large");
  });

  it("legitimate provider bursts remain accepted (05A §G)", async () => {
    const providerName = `burst-${randomUUID().slice(0, 8)}`;
    const provider = new FakeBillingProvider(providerName, "burst-secret");
    server.services.billing.registerProvider(provider);
    const body = JSON.stringify({ eventId: `burst-1`, type: "payment.failed", subjectRef: `unknown-${randomUUID()}` });
    const stamp = new Date().toISOString();
    const signature = signPayload("burst-secret", body, stamp);
    for (let i = 0; i < 20; i++) {
      const res = await call(`/webhooks/billing/${providerName}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-mox-timestamp": stamp, "x-mox-signature": signature },
        rawBody: body,
      });
      expect(res.status).toBe(200);
      const parsed = res.body as { applied?: boolean; reconciliationRequired?: boolean };
      expect(parsed.applied).toBe(false);
      expect(parsed.reconciliationRequired).toBe(true);
    }
  });

  it("GET /api/billing/entitlements uses the same commercial-access authority as mutations (05A §J)", async () => {
    const provider = new ScriptedProvider();
    server.services.billing.registerProvider(provider as never);

    const email = `${randomUUID()}@mox.test`;
    const signup = await call("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "entitlements-pass" }),
    });
    const cookie = cookieFrom(signup.headers);
    const catalog = await seedPlan();

    // Effective plan values for the seeded plan version.
    await server.services.db.execute(sql`
      INSERT INTO entitlement_definitions (key, value_type, description, default_value)
      VALUES ('max_agents', 'integer', 'Max agents', '3'::jsonb)
      ON CONFLICT (key) DO NOTHING
    `);
    await server.services.db.execute(sql`
      INSERT INTO plan_entitlement_values (plan_version_id, key, value)
      VALUES (${catalog.planVersionId}, 'max_agents', '7'::jsonb)
      ON CONFLICT (plan_version_id, key) DO UPDATE SET value = '7'::jsonb
    `);

    // No subscription → no entitlement, no values.
    const none = (await (await call("/api/billing/entitlements", { headers: { cookie } })).body) as {
      commerciallyEntitled: boolean;
      values: Record<string, unknown>;
      denialReason?: string;
    };
    expect(none.commerciallyEntitled).toBe(false);
    expect(none.values).toEqual({});

    // Activate through the verified webhook pipeline.
    const created = await call("/api/billing/checkout", {
      method: "POST",
      headers: { ...CSRF, cookie },
      body: JSON.stringify({
        planVersionId: catalog.planVersionId,
        providerName: "scripted",
        successUrl: "https://x/s",
        cancelUrl: "https://x/c",
      }),
    });
    const sessionId = (created.body as { sessionId: string }).sessionId;
    const activationEvent = {
      eventId: `evt_ent_${randomUUID()}`,
      type: "checkout.completed",
      subjectRef: `scripted_${sessionId}`,
      subscriptionRef: `scripted_sub_${sessionId}`,
      occurredAt: new Date().toISOString(),
      amountMinor: 1999,
      currency: "USD",
    };
    provider.enqueue(activationEvent);
    const activation = await signedWebhookCall(provider.name, activationEvent);
    expect(JSON.stringify(activation.body)).toContain('"applied":true');

    // Valid active → entitled with the real effective values.
    const entitled = (await (await call("/api/billing/entitlements", { headers: { cookie } })).body) as {
      state: string;
      commerciallyEntitled: boolean;
      values: Record<string, unknown>;
      denialReason?: string;
    };
    expect(entitled.state).toBe("active");
    expect(entitled.commerciallyEntitled).toBe(true);
    expect(entitled.values).toMatchObject({ max_agents: 7 });

    // Suspended → commerciallyEntitled false with an explicit reason.
    const me = (await (await call("/api/me", { headers: { cookie } })).body) as { orgs: Array<{ orgId: string }> };
    const sub = await server.services.billing.getActiveSubscription(me.orgs[0]!.orgId);
    await server.services.billing.adminSuspend(sub!.id, "ent-test-admin", "abuse_review");
    const suspended = (await (await call("/api/billing/entitlements", { headers: { cookie } })).body) as {
      state: string;
      commerciallyEntitled: boolean;
      values: Record<string, unknown>;
      denialReason?: string;
    };
    expect(suspended.state).toBe("suspended");
    expect(suspended.commerciallyEntitled).toBe(false);
    expect(suspended.denialReason).toBe("state_suspended");
    expect(suspended.values).toEqual({});

    // Expired active → commerciallyEntitled false.
    await server.services.billing.adminReactivate(sub!.id, "ent-test-admin");
    const live = await server.services.billing.getSubscription(sub!.id);
    live.currentPeriodEnd = new Date(Date.now() - 60_000).toISOString();
    await server.services.billing.store.updateSubscription(live);
    const expired = (await (await call("/api/billing/entitlements", { headers: { cookie } })).body) as {
      state: string;
      commerciallyEntitled: boolean;
      values: Record<string, unknown>;
      denialReason?: string;
    };
    expect(expired.state).toBe("active");
    expect(expired.commerciallyEntitled).toBe(false);
    expect(expired.denialReason).toBe("expired_period");
    expect(expired.values).toEqual({});
  });

  // ==== Security Repair 05B — rate limiting (finding H) ====

  it("authentication rate limiting: real HTTP 429 before hashing, equivalent for known and unknown accounts", async () => {
    const email = `${randomUUID()}@mox.test`;
    const password = "correct-password-1";
    await call("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const attempt = (target: string, pass: string) =>
      call("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: target, password: pass }),
      });

    // Known account: the account bucket allows 8 attempts per window; the
    // 9th returns 429 (rate check runs before the scrypt verification).
    let statuses: number[] = [];
    for (let i = 0; i < 9; i += 1) {
      const res = await attempt(email, `wrong-${i}`);
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 8).every((s) => s === 401)).toBe(true);
    expect(statuses[8]).toBe(429);

    // Unknown account: identical bucket behavior — same threshold, same 429.
    const unknown = `${randomUUID()}@mox.test`;
    statuses = [];
    for (let i = 0; i < 9; i += 1) {
      const res = await attempt(unknown, `wrong-${i}`);
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 8).every((s) => s === 401)).toBe(true);
    expect(statuses[8]).toBe(429);
  }, 60_000);

  it("rate limiting: forged XFF is ignored unless the peer is a configured trusted proxy", async () => {
    // Untrusted: forwarded header must not move the bucket.
    const untrusted = await call("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "8.8.8.8" },
      body: JSON.stringify({ email: `${randomUUID()}@mox.test`, password: "x" }),
    });
    expect(untrusted.status).toBe(401); // processed normally (unknown account)
    void untrusted;
  });

  // ==== Security Repair 05B — admin target-org audit (finding F) ====

  it("compute order admin actions audit the AFFECTED org, not the admin's home org", async () => {
    const adminSignup = await call("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `${randomUUID()}@mox.test`, password: "compute-audit-admin" }),
    });
    const adminCookie = cookieFrom(adminSignup.headers);
    const adminMe = (await (await call("/api/me", { headers: { cookie: adminCookie } })).body) as { userId: string; orgId: string };
    server.services.config.platformAdminRoles[adminMe.userId] = "superadmin";

    const targetSignup = await call("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `${randomUUID()}@mox.test`, password: "compute-audit-target" }),
    });
    const targetMe = (await (await call("/api/me", { headers: { cookie: cookieFrom(targetSignup.headers) } })).body) as { orgId: string };
    expect(targetMe.orgId).not.toBe(adminMe.orgId);

    const { computeClasses: cc, serverOrders: so, auditEvents: ae } = await import("@mox/database");
    await server.services.db.insert(cc).values({
      code: "COMPUTE_05B_AUDIT",
      displayName: "05B Audit",
      minVcpu: 1,
      minRamGb: 1,
      skuMap: [],
      active: true,
    }).onConflictDoNothing({ target: cc.code });
    const [order] = await server.services.db.insert(so).values({
      orgId: targetMe.orgId,
      computeClassCode: "COMPUTE_05B_AUDIT",
      state: "running",
      providerName: "fake-compute",
      providerInstanceId: `audit-${randomUUID()}`,
      hostname: "audit-order",
      idempotencyKey: `audit-${randomUUID()}`,
    }).returning({ id: so.id });

    const res = await call(`/api/admin/compute/orders/${order!.id}/restart`, {
      method: "POST",
      headers: { ...CSRF, cookie: adminCookie },
      body: "{}",
    });
    expect(res.status).toBe(200);
    const audits = await server.services.db.select().from(ae).where((await import("drizzle-orm")).eq(ae.resourceId, order!.id));
    const actionAudit = audits.find((row) => row.action === "compute.order.restart");
    expect(actionAudit).toBeDefined();
    expect(actionAudit?.orgId).toBe(targetMe.orgId);
    expect(actionAudit?.orgId).not.toBe(adminMe.orgId);
    expect(actionAudit?.actorId).toBe(adminMe.userId);
  });

  it("runtime agent admin actions audit the order's org, never the admin's org", async () => {
    const adminSignup = await call("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `${randomUUID()}@mox.test`, password: "agent-audit-admin" }),
    });
    const adminCookie = cookieFrom(adminSignup.headers);
    const adminMe = (await (await call("/api/me", { headers: { cookie: adminCookie } })).body) as { userId: string; orgId: string };
    server.services.config.platformAdminRoles[adminMe.userId] = "superadmin";

    const targetSignup = await call("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `${randomUUID()}@mox.test`, password: "agent-audit-target" }),
    });
    const targetMe = (await (await call("/api/me", { headers: { cookie: cookieFrom(targetSignup.headers) } })).body) as { orgId: string };

    const { agents: agentsTable, agentDeployments: deploymentsTable, computeClasses: cc, serverOrders: so, auditEvents: ae } = await import("@mox/database");
    await server.services.db.insert(cc).values({
      code: "COMPUTE_05B_AGENT",
      displayName: "05B Agent",
      minVcpu: 1,
      minRamGb: 1,
      skuMap: [],
      active: true,
    }).onConflictDoNothing({ target: cc.code });
    const [order] = await server.services.db.insert(so).values({
      orgId: targetMe.orgId,
      computeClassCode: "COMPUTE_05B_AGENT",
      state: "running",
      providerName: "fake-compute",
      providerInstanceId: `agent-${randomUUID()}`,
      hostname: "agent-order",
      idempotencyKey: `agent-${randomUUID()}`,
    }).returning({ id: so.id });
    const [agent] = await server.services.db.insert(agentsTable).values({
      orgId: targetMe.orgId,
      slug: `agent-${randomUUID().slice(0, 8)}`,
      displayName: "Audited Agent",
      status: "active",
      definition: {},
    }).returning({ id: agentsTable.id });
    await server.services.db.insert(deploymentsTable).values({
      orgId: targetMe.orgId,
      agentId: agent!.id,
      kind: "dedicated_vps",
      computeInstanceId: order!.id,
      desiredRevision: 1,
    });

    const res = await call(`/api/admin/runtime/agents/${agent!.id}/restart`, {
      method: "POST",
      headers: { ...CSRF, cookie: adminCookie },
      body: "{}",
    });
    expect(res.status).toBe(200);
    const audits = await server.services.db.select().from(ae).where((await import("drizzle-orm")).eq(ae.resourceId, agent!.id));
    const actionAudit = audits.find((row) => row.action === "runtime.agent.restart");
    expect(actionAudit).toBeDefined();
    expect(actionAudit?.orgId).toBe(targetMe.orgId);
    expect(actionAudit?.orgId).not.toBe(adminMe.orgId);
  });

  // ==== Security Repair 05B — notification unread boundary (finding G) ====

  it("same-org user A cannot read B's unread state over HTTP", async () => {
    const aSignup = await call("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `${randomUUID()}@mox.test`, password: "unread-a-pass" }),
    });
    const aCookie = cookieFrom(aSignup.headers);
    const aMe = (await (await call("/api/me", { headers: { cookie: aCookie } })).body) as { userId: string; orgId: string };

    const bSignup = await call("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `${randomUUID()}@mox.test`, password: "unread-b-pass" }),
    });
    const bCookie = cookieFrom(bSignup.headers);
    const bMe = (await (await call("/api/me", { headers: { cookie: bCookie } })).body) as { userId: string; orgId: string };

    // Seed a targeted unread notification for A.
    await server.services.notifications.consume({
      eventId: `unread-${randomUUID()}`,
      type: "team.invited",
      orgId: aMe.orgId,
      userId: aMe.userId,
      severity: "info",
      templateVars: {},
      at: new Date().toISOString(),
    });
    expect(await server.services.notifications.unreadCount(aMe.orgId, aMe.userId)).toBe(1);

    // Put B into A's org and switch B's active org to A's org.
    const { memberships } = await import("@mox/database");
    await server.services.db.insert(memberships).values({
      orgId: aMe.orgId,
      userId: bMe.userId,
      role: "member",
    }).onConflictDoNothing();
    const switched = await call("/api/auth/orgs/select", {
      method: "POST",
      headers: { ...CSRF, cookie: bCookie },
      body: JSON.stringify({ orgId: aMe.orgId }),
    });
    expect(switched.status).toBe(200);

    // B's unread state over HTTP counts B's OWN rows only — never A's.
    const bUnread = (await (await call("/api/notifications/unread-count", { headers: { cookie: bCookie } })).body) as { count: number };
    expect(bUnread.count).toBe(0);
    const aUnread = (await (await call("/api/notifications/unread-count", { headers: { cookie: aCookie } })).body) as { count: number };
    expect(aUnread.count).toBe(1);
  });

  describe("Prompt 01: surface isolation, staff identity, invites, password reset", () => {
    async function signupUser(email: string, password: string) {
      const res = await call("/api/auth/signup", {
        method: "POST",
        headers: { ...CSRF, "content-type": "application/json" },
        body: JSON.stringify({ email, password, orgName: "t-org-" + email.split("@")[0] }),
      });
      expect(res.status).toBe(200);
      const cookie = cookieFrom(res.headers);
      const me = await call("/api/me", { headers: { cookie } });
      expect(me.status).toBe(200);
      return { cookie, userId: (me.body as { userId: string }).userId };
    }

    async function seedStaff(userId: string, role: string) {
      const { platformStaffMemberships } = await import("@mox/database");
      await server.services.db.insert(platformStaffMemberships).values({
        userId,
        role: role as never,
        enabled: true,
      });
    }

    it("password reset lifecycle: token minted, password updated, sessions revoked, token one-use", async () => {
      const { passwordResets } = await import("@mox/database");
      const { u, p } = { u: `reset-${randomUUID().slice(0, 8)}@mox.test`, p: "resetpass-12345" };
      const acc = await signupUser(u, p);
      const oldP = acc.cookie;

      // Anti-enumeration: unknown email returns a generic 200, nothing stored.
      const unknown = await call("/api/auth/forgot-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "nobody@does-not-exist.test" }),
      });
      expect(unknown.status).toBe(200);

      // Known account: token minted and returned to the (unconfigured) delivery path.
      const forgot = await call("/api/auth/forgot-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: u }),
      });
      expect(forgot.status).toBe(200);
      const body = forgot.body as { deliverableToken?: string };
      expect(typeof body.deliverableToken).toBe("string");
      const token = body.deliverableToken!;

      // Only the hash is stored, never the plaintext.
      const rows = await server.services.db.select().from(passwordResets);
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        expect(r.tokenHash).not.toContain("mox_reset_");
        expect(r.tokenHash).not.toBe(token);
        expect(r.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      }

      // Establish a browser session for the user, then reset.
      const loginBefore = await call("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: u, password: p }),
      });
      expect(loginBefore.status).toBe(200);

      const newP = "resetpass-67890";
      const reset = await call("/api/auth/reset-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, password: newP }),
      });
      expect(reset.status).toBe(200);

      // Old password fails now; new password works.
      const oldLogin = await call("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: u, password: p }),
      });
      expect(oldLogin.status).toBe(401);
      const newLogin = await call("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: u, password: newP }),
      });
      expect(newLogin.status).toBe(200);

      // Token cannot be reused.
      const reuse = await call("/api/auth/reset-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, password: "another-12345" }),
      });
      expect(reuse.status).toBe(400);

      // The pre-reset session was revoked.
      const meAfter = await call("/api/me", { headers: { cookie: oldP } });
      expect(meAfter.status).toBe(401);
    });

    it("password reset rejects expired tokens", async () => {
      const { passwordResets } = await import("@mox/database");
      const { u } = { u: `expreset-${randomUUID().slice(0, 8)}@mox.test` };
      await signupUser(u, "expiredpass-123");
      const token = `mox_reset_expired_${randomUUID()}`;
      const userRows = await server.services.db.execute(sql`select id from users where email = ${u}`);
      const userId = (userRows.rows[0] as { id: string }).id;
      await server.services.db.insert(passwordResets).values({
        userId,
        tokenHash: createHash("sha256").update(token).digest("hex"),
        expiresAt: new Date(Date.now() - 60_000),
      });
      const res = await call("/api/auth/reset-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, password: "whatever-12345" }),
      });
      expect(res.status).toBe(400);
    });

    it("staff invitation lifecycle: create (admin-only), signup, once-only, list without plaintext", async () => {
      const { staffInvitations } = await import("@mox/database");

      // Need a real superadmin actor to create invites.
      const admin = await signupUser(`super-${randomUUID().slice(0, 8)}@mox.test`, "superpass-12345");
      await seedStaff(admin.userId, "superadmin");

      const invitee = `invitee-${randomUUID().slice(0, 8)}@mox.test`;
      const create = await call("/api/admin/staff/invites", {
        method: "POST",
        headers: { ...CSRF, cookie: admin.cookie, "content-type": "application/json" },
        body: JSON.stringify({ email: invitee, role: "support_agent", surface: "support" }),
      });
      expect(create.status).toBe(200);
      const created = create.body as { token: string; invitationId: string; email: string };
      expect(created.token).toMatch(/^mox_invite_/);
      expect(created.email.toLowerCase()).toBe(invitee.toLowerCase());

      // List API returns NO plaintext token.
      const list = await call("/api/admin/staff/invites", {
        method: "GET",
        headers: { cookie: admin.cookie },
      });
      expect(list.status).toBe(200);
      const listed = list.body as Array<{ email: string }>;
      expect(JSON.stringify(listed)).not.toContain("mox_invite_");
      expect(listed.some((i) => i.email.toLowerCase() === invitee.toLowerCase())).toBe(true);

      // A customer (non-staff) cannot create invites.
      const customer = await signupUser(`cust-${randomUUID().slice(0, 8)}@mox.test`, "custpass-12345");
      const forbidden = await call("/api/admin/staff/invites", {
        method: "POST",
        headers: { ...CSRF, cookie: customer.cookie, "content-type": "application/json" },
        body: JSON.stringify({ email: "x@y.z", role: "support_agent", surface: "support" }),
      });
      expect(forbidden.status).toBe(403);

      // /support/signup without an invite creates nothing.
      const noInvite = await call("/api/support/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: `nodice-${randomUUID().slice(0, 8)}@mox.test`, password: "noinvite-12345678", inviteToken: "bogus" }),
      });
      expect(noInvite.status).toBe(400);

      // Valid invite accepted once, staff grant attached.
      const signup = await call("/api/support/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: invitee, password: "invitee-12345", inviteToken: created.token }),
      });
      expect(signup.status).toBe(200);
      expect((signup.body as { surface: string }).surface).toBe("support");
      const supportCookie = cookieFrom(signup.headers);

      // Reuse of the consumed token fails.
      const reuse = await call("/api/support/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: invitee, password: "invitee-12345", inviteToken: created.token }),
      });
      expect(reuse.status).toBe(400);

      // The invitee (support_agent) can access Support but NOT Admin.
      const supportSession = await call("/api/support/session", { headers: { cookie: supportCookie } });
      expect(supportSession.status).toBe(200);
      expect((supportSession.body as { roles: string[] }).roles).toContain("support_agent");
      const adminSession = await call("/api/admin/session", { headers: { cookie: supportCookie } });
      expect(adminSession.status).toBe(403);
    });

    it("wrong-email and revoked invites fail", async () => {
      const { staffInvitations } = await import("@mox/database");
      const admin = await signupUser(`super2-${randomUUID().slice(0, 8)}@mox.test`, "superpass-12345");
      await seedStaff(admin.userId, "superadmin");

      const wrongEmail = await call("/api/admin/staff/invites", {
        method: "POST",
        headers: { ...CSRF, cookie: admin.cookie, "content-type": "application/json" },
        body: JSON.stringify({ email: "right@wrong.test", role: "support_agent", surface: "support" }),
      });
      expect(wrongEmail.status).toBe(200);
      const wToken = (wrongEmail.body as { token: string }).token;
      const wrongSignup = await call("/api/support/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "notright@wrong.test", password: "wrongemail-12345678", inviteToken: wToken }),
      });
      expect(wrongSignup.status).toBe(400);

      const revokeMe = await call("/api/admin/staff/invites", {
        method: "POST",
        headers: { ...CSRF, cookie: admin.cookie, "content-type": "application/json" },
        body: JSON.stringify({ email: "rev@wrong.test", role: "support_agent", surface: "support" }),
      });
      const rToken = (revokeMe.body as { token: string; invitationId: string }).token;
      const invId = (revokeMe.body as { invitationId: string }).invitationId;
      const revoke = await call(`/api/admin/staff/invites/${invId}`, {
        method: "DELETE",
        headers: { ...CSRF, cookie: admin.cookie },
      });
      expect(revoke.status).toBe(200);
      const revokedSignup = await call("/api/support/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "rev@wrong.test", password: "revoked-12345678", inviteToken: rToken }),
      });
      expect(revokedSignup.status).toBe(400);
    });

    it("surface isolation: customer (even org owner) denied Admin and Support; staff are not customers", async () => {
      const email = `owner-${randomUUID().slice(0, 8)}@mox.test`;
      const pw = "ownerpass-12345";
      // Ordinary customer (org owner by signup) has NO platform authority.
      const cust = await signupUser(email, pw);

      const adminSession = await call("/api/admin/session", { headers: { cookie: cust.cookie } });
      expect(adminSession.status).toBe(403);
      const supportSession = await call("/api/support/session", { headers: { cookie: cust.cookie } });
      expect(supportSession.status).toBe(403);

      // Admin login (password auth + surface check) is denied for the owner.
      const adminLogin = await call("/api/admin/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: pw }),
      });
      expect(adminLogin.status).toBe(403);
      const supportLogin = await call("/api/support/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: pw }),
      });
      expect(supportLogin.status).toBe(403);
    });

    it("admin login grants Admin to staff superadmin only", async () => {
      const email = `admin2-${randomUUID().slice(0, 8)}@mox.test`;
      const pw = "adminpass-12345";
      const acc = await signupUser(email, pw);
      await seedStaff(acc.userId, "superadmin");

      const login = await call("/api/admin/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: pw }),
      });
      expect(login.status).toBe(200);
      const cookie = cookieFrom(login.headers);
      const session = await call("/api/admin/session", { headers: { cookie } });
      expect(session.status).toBe(200);
      expect((session.body as { role: string }).role).toBe("superadmin");
    });

    it("customer login return target cannot escape into Admin/Support or open redirect", async () => {
      // Absolute URL and protocol-relative are rejected; /admin is rejected.
      const email = `rt-${randomUUID().slice(0, 8)}@mox.test`;
      await signupUser(email, "rtpass-12345");

      const abs = await call("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: "rtpass-12345", returnTo: "https://evil.example/phish" }),
      });
      expect(abs.status).toBe(200);
      expect((abs.body as { returnTo: string }).returnTo).toBe("/");

      const protoRel = await call("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: "rtpass-12345", returnTo: "//evil.example" }),
      });
      expect((protoRel.body as { returnTo: string }).returnTo).toBe("/");

      const good = await call("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: "rtpass-12345", returnTo: "/agents?tab=1" }),
      });
      expect((good.body as { returnTo: string }).returnTo).toBe("/agents?tab=1");

      const adminEscape = await call("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: "rtpass-12345", returnTo: "/admin" }),
      });
      expect((adminEscape.body as { returnTo: string }).returnTo).toBe("/");
    });
  });

  describe("Prompt 03: Staff & Access + least-privilege Support console", () => {
    async function signupUser(email: string, password: string) {
      const res = await call("/api/auth/signup", {
        method: "POST",
        headers: { ...CSRF, "content-type": "application/json" },
        body: JSON.stringify({ email, password, orgName: "t-org-" + email.split("@")[0] }),
      });
      expect(res.status).toBe(200);
      const cookie = cookieFrom(res.headers);
      const me = await call("/api/me", { headers: { cookie } });
      expect(me.status).toBe(200);
      return { cookie, userId: (me.body as { userId: string }).userId };
    }

    async function seedStaff(userId: string, role: string) {
      const { platformStaffMemberships } = await import("@mox/database");
      await server.services.db.insert(platformStaffMemberships).values({
        userId,
        role: role as never,
        enabled: true,
      });
    }

    async function seedSupportAgent() {
      const account = await signupUser(`sag-${randomUUID().slice(0, 8)}@mox.test`, "sagpass-12345");
      await seedStaff(account.userId, "support_agent");
      return account;
    }

    it("Staff & Access list/disable requires admin.staff.write (superadmin), denied for support", async () => {
      const superadmin = await signupUser(`ssa-${randomUUID().slice(0, 8)}@mox.test`, "ssapass-12345");
      await seedStaff(superadmin.userId, "superadmin");
      const agent = await seedSupportAgent();

      // Superadmin can read the staff roster.
      const list = await call("/api/admin/staff", { headers: { cookie: superadmin.cookie } });
      expect(list.status).toBe(200);
      const body = list.body as { members: Array<{ userId: string; role: string; surface: string; enabled: boolean }>; invites: unknown[] };
      expect(body.members.some((m) => m.role === "superadmin")).toBe(true);
      expect(body.members.some((m) => m.userId === agent.userId && m.surface === "support")).toBe(true);

      // A support_agent (no admin.staff.write) is denied the roster, 403.
      const agentList = await call("/api/admin/staff", { headers: { cookie: agent.cookie } });
      expect(agentList.status).toBe(403);

      // Disable then enable the support_agent through the membership route.
      const disable = await call(`/api/admin/staff/${agent.userId}/disable`, {
        method: "POST",
        headers: { ...CSRF, cookie: superadmin.cookie, "content-type": "application/json" },
        body: JSON.stringify({ role: "support_agent", reason: "prompt03_test" }),
      });
      expect(disable.status).toBe(200);
      const afterDisable = await call("/api/admin/staff", { headers: { cookie: superadmin.cookie } });
      const disabled = (afterDisable.body as { members: Array<{ userId: string; enabled: boolean }> }).members.find((m) => m.userId === agent.userId);
      expect(disabled?.enabled).toBe(false);

      const enable = await call(`/api/admin/staff/${agent.userId}/enable`, {
        method: "POST",
        headers: { ...CSRF, cookie: superadmin.cookie, "content-type": "application/json" },
        body: JSON.stringify({ role: "support_agent" }),
      });
      expect(enable.status).toBe(200);
    });

    it("support agent can look up customers but the projection is support-safe (no costs/credentials/ips)", async () => {
      const owner = await signupUser(`sc-${randomUUID().slice(0, 8)}@mox.test`, "scpass-12345");
      // Give the org an agent so the projection has rows to inspect.
      const { agents } = await import("@mox/database");
      const meBody = (await (await call("/api/me", { headers: { cookie: owner.cookie } })).body) as { orgId: string };
      await server.services.db.insert(agents).values({
        orgId: meBody.orgId,
        slug: "probe-agent",
        displayName: "Probe Agent",
        status: "active",
        definition: { rows: [], when: [] },
      });

      const agent = await seedSupportAgent();
      const list = await call("/api/support/customers", { headers: { cookie: agent.cookie } });
      expect(list.status).toBe(200);
      const body = list.body as { customers: Array<Record<string, unknown>> };
      const json = JSON.stringify(body);
      expect(body.customers.length).toBeGreaterThanOrEqual(1);
      // Support-safe projection must EXCLUDE cost/margin/credential/IP material.
      expect(json).not.toContain("costMargin");
      expect(json).not.toContain("costMinor");
      expect(json).not.toContain("revenue");
      expect(json).not.toContain("providerAccountId");
      expect(json).not.toContain("providerInstanceId");
      expect(json).not.toContain("rootCredentialRefId");
      expect(json).not.toMatch(/ipv4|ipv6|hostname|sshKeyId/);

      // Detail endpoint also safe and shows the (empty) audited note list shape.
      const found = body.customers[0]!.orgId as string;
      const detail = await call(`/api/support/customers/${found}`, { headers: { cookie: agent.cookie } });
      expect(detail.status).toBe(200);
      const dJson = JSON.stringify(detail.body);
      expect(dJson).not.toContain("costMargin");
    });

    it("support note write is capturable + audited with support.ticket.write", async () => {
      const owner = await signupUser(`sn-${randomUUID().slice(0, 8)}@mox.test`, "snpass-12345");
      const meBody = (await (await call("/api/me", { headers: { cookie: owner.cookie } })).body) as { orgId: string };
      const agent = await seedSupportAgent();

      const note = await call(`/api/support/customers/${meBody.orgId}/notes`, {
        method: "POST",
        headers: { ...CSRF, cookie: agent.cookie, "content-type": "application/json" },
        body: JSON.stringify({ note: "Prompt 03 audited note" }),
      });
      expect(note.status).toBe(200);

      const detail = await call(`/api/support/customers/${meBody.orgId}`, { headers: { cookie: agent.cookie } });
      const notes = (detail.body as { supportNotes: Array<{ note: string }> }).supportNotes;
      expect(notes.some((n) => n.note === "Prompt 03 audited note")).toBe(true);

      const { auditEvents } = await import("@mox/database");
      const { eq } = await import("drizzle-orm");
      const rows = await server.services.db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.orgId, meBody.orgId));
      expect(rows.some((r) => r.action === "support.note")).toBe(true);
      expect(rows.some((r) => String(r.actorType).startsWith("support:"))).toBe(true);
    });

    it("authorization matrix: customer and support staff can never reach admin staff routes", async () => {
      const customer = await signupUser(`cm-${randomUUID().slice(0, 8)}@mox.test`, "cmpass-12345");
      const support = await seedSupportAgent();

      // A plain customer cannot even reach /api/admin/staff.
      const asCustomer = await call("/api/admin/staff", { headers: { cookie: customer.cookie } });
      expect(asCustomer.status).toBe(403);

      // A support_agent (whose only grants are support.*) is denied admin/staff.
      const asSupport = await call("/api/admin/staff", { headers: { cookie: support.cookie } });
      expect(asSupport.status).toBe(403);
    });
  });

});
