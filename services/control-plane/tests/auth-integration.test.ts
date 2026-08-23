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

    // Bearer channel is exempt (non-browser clients).
    const bearerLogin = await call("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "csrf-test-pass" }),
    });
    const bearer = (bearerLogin.body as { sessionToken: string }).sessionToken;
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

    // Authorization header also works for non-browser clients.
    const login = await call("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "sse-test-pass" }),
    });
    const bearer = (login.body as { sessionToken: string }).sessionToken;
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
});
