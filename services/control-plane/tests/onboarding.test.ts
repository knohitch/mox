/**
 * Mandatory customer onboarding over REAL PostgreSQL: durable state, step
 * validation, completion gating, cross-org isolation, backfill of pre-existing
 * orgs, and audit emission. Skipped unless MOX_TEST_DATABASE_URL points at an
 * empty, migrated database (scripts/run-postgres-verification.ps1 provisions
 * a disposable cluster).
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

interface OnboardingOrg {
  cookie: string;
  orgId: string;
  userId: string;
  email: string;
}

describe.skipIf(!databaseUrl)("Mandatory customer onboarding over PostgreSQL", () => {
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
      customerCredentialsKey: "onboarding-customer-credential-vault-passphrase",
    };
    const services = await composeControlPlane(config);
    const running = await startControlPlane(services);
    server = { base: `http://127.0.0.1:${running.port}`, services, running };
  });

  afterAll(async () => {
    if (server) await server.running.close();
  });

  async function signup(): Promise<OnboardingOrg> {
    const email = `${randomUUID().slice(0, 10)}-${Date.now()}@mox.test`;
    const res = await call("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "onboarding-test-pass", orgName: "Onboard Co" }),
    });
    expect(res.status).toBe(200);
    const cookie = cookieFrom(res.headers);
    const me = (await (await call("/api/me", { headers: { cookie } })).body) as { orgId: string; userId: string };
    return { cookie, orgId: me.orgId, userId: me.userId, email };
  }

  it("new signups start as not_started and GET never creates a row", async () => {
    const org = await signup();
    const res = await call("/api/onboarding", { headers: { cookie: org.cookie } });
    expect(res.status).toBe(200);
    const state = res.body as { status: string; currentStep: number; missingRequiredSteps: number[] };
    expect(state.status).toBe("not_started");
    expect(state.currentStep).toBe(1);
    expect(state.missingRequiredSteps).toEqual([1, 2, 3, 4, 5, 6]);

    // Durable row was created by the signup authority (not_started).
    const rows = await server.services.pool.query("SELECT status FROM org_onboarding WHERE org_id = $1", [org.orgId]);
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0]).toMatchObject({ status: "not_started" });
  });

  it("step 1 records persona and really renames user + organization", async () => {
    const org = await signup();
    const patch = await call("/api/onboarding", {
      method: "PATCH",
      headers: { ...CSRF, cookie: org.cookie },
      body: JSON.stringify({
        step: 1,
        advanceTo: 2,
        persona: "founder",
        displayName: "Ada Onboarder",
        workspaceName: "Ada Robotics",
      }),
    });
    expect(patch.status).toBe(200);
    const state = patch.body as { status: string; currentStep: number; completedSteps: number[]; persona: string };
    expect(state.status).toBe("in_progress");
    expect(state.currentStep).toBe(2);
    expect(state.completedSteps).toEqual([1]);
    expect(state.persona).toBe("founder");

    const me = (await (await call("/api/me", { headers: { cookie: org.cookie } })).body) as {
      displayName: string;
      orgDisplayName: string;
    };
    expect(me.displayName).toBe("Ada Onboarder");
    expect(me.orgDisplayName).toBe("Ada Robotics");
  });

  it("PATCH rejects invalid values and cross-step fields and cannot set status", async () => {
    const org = await signup();

    const badPersona = await call("/api/onboarding", {
      method: "PATCH",
      headers: { ...CSRF, cookie: org.cookie },
      body: JSON.stringify({ step: 1, persona: "wizard" }),
    });
    expect(badPersona.status).toBe(400);

    const badGoal = await call("/api/onboarding", {
      method: "PATCH",
      headers: { ...CSRF, cookie: org.cookie },
      body: JSON.stringify({ step: 2, goals: ["grant-me-admin"] }),
    });
    expect(badGoal.status).toBe(400);

    const crossStep = await call("/api/onboarding", {
      method: "PATCH",
      headers: { ...CSRF, cookie: org.cookie },
      body: JSON.stringify({ step: 2, goals: [], modelSetupChoice: "deferred" }),
    });
    expect(crossStep.status).toBe(400);

    // An arbitrary PATCH can never mark the flow complete.
    const statusAttack = await call("/api/onboarding", {
      method: "PATCH",
      headers: { ...CSRF, cookie: org.cookie },
      body: JSON.stringify({ step: 1, persona: "developer", status: "completed" }),
    });
    expect(statusAttack.status).toBe(200);
    const after = (await (await call("/api/onboarding", { headers: { cookie: org.cookie } })).body) as { status: string };
    expect(after.status).not.toBe("completed");
  });

  it("completion is blocked until every required decision step is recorded", async () => {
    const org = await signup();
    const early = await call("/api/onboarding/complete", { method: "POST", headers: { ...CSRF, cookie: org.cookie } });
    expect(early.status).toBe(409);
    expect(early.body).toMatchObject({ code: "onboarding_incomplete" });

    await call("/api/onboarding", { method: "PATCH", headers: { ...CSRF, cookie: org.cookie }, body: JSON.stringify({ step: 1, persona: "developer" }) });
    const afterStep1 = await call("/api/onboarding/complete", { method: "POST", headers: { ...CSRF, cookie: org.cookie } });
    expect(afterStep1.status).toBe(409);
  });

  it("records real agent references only (created vs deferred are distinct)", async () => {
    const org = await signup();
    // A "created" decision requires a REAL agent in this org.
    const invented = await call("/api/onboarding", {
      method: "PATCH",
      headers: { ...CSRF, cookie: org.cookie },
      body: JSON.stringify({ step: 4, agentSetupChoice: "created", agentId: randomUUID() }),
    });
    expect(invented.status).toBe(400);
    expect(invented.body).toMatchObject({ code: "onboarding_agent_unknown" });

    // Insert a real agent row for the org (the canonical agents authority).
    await server.services.pool.query(
      `INSERT INTO agents (id, org_id, slug, display_name, definition)
       VALUES ($1, $2, 'onboard-agent', 'Onboard Agent', '{}')`,
      [randomUUID(), org.orgId],
    );
    const agentsRes = await call("/api/agents", { headers: { cookie: org.cookie } });
    expect(agentsRes.status).toBe(200);
    const agents = agentsRes.body as Array<{ agentId: string }>;
    expect(agents.length).toBe(1);

    const created = await call("/api/onboarding", {
      method: "PATCH",
      headers: { ...CSRF, cookie: org.cookie },
      body: JSON.stringify({ step: 4, agentSetupChoice: "created", agentId: agents[0]!.agentId }),
    });
    expect(created.status).toBe(200);
    const state = created.body as { agentSetupChoice: string; agentId: string | null };
    expect(state.agentSetupChoice).toBe("created");
    expect(state.agentId).toBe(agents[0]!.agentId);

    // Deferred stays distinct from created.
    const deferredOrg = await signup();
    const deferred = await call("/api/onboarding", {
      method: "PATCH",
      headers: { ...CSRF, cookie: deferredOrg.cookie },
      body: JSON.stringify({ step: 4, agentSetupChoice: "deferred" }),
    });
    expect(deferred.status).toBe(200);
    expect(deferred.body).toMatchObject({ agentSetupChoice: "deferred", agentId: null });
  });

  it("rejects invented server orders for provisioned choices", async () => {
    const org = await signup();
    const res = await call("/api/onboarding", {
      method: "PATCH",
      headers: { ...CSRF, cookie: org.cookie },
      body: JSON.stringify({ step: 5, infrastructureSetupChoice: "provisioned", serverOrderId: randomUUID() }),
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "onboarding_server_unknown" });

    const deferred = await call("/api/onboarding", {
      method: "PATCH",
      headers: { ...CSRF, cookie: org.cookie },
      body: JSON.stringify({ step: 5, infrastructureSetupChoice: "deferred" }),
    });
    expect(deferred.status).toBe(200);
    expect(deferred.body).toMatchObject({ infrastructureSetupChoice: "deferred", serverOrderId: null });
  });

  it("full flow: recorded decisions → idempotent completion + durable audit row", async () => {
    const org = await signup();
    const steps: Record<string, unknown>[] = [
      { step: 1, advanceTo: 2, persona: "operations", displayName: "Op Ops", workspaceName: "Ops Team" },
      { step: 2, advanceTo: 3, goals: ["build-ai-agents", "connect-messaging-channels"] },
      { step: 3, advanceTo: 4, modelSetupChoice: "deferred" },
      { step: 4, advanceTo: 5, agentSetupChoice: "deferred" },
      { step: 5, advanceTo: 6, infrastructureSetupChoice: "deferred" },
      { step: 6, connectionsSetupChoice: "configured" },
    ];
    for (const body of steps) {
      const res = await call("/api/onboarding", {
        method: "PATCH",
        headers: { ...CSRF, cookie: org.cookie },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(200);
    }
    const beforeFinish = (await (await call("/api/onboarding", { headers: { cookie: org.cookie } })).body) as {
      missingRequiredSteps: number[];
      status: string;
    };
    expect(beforeFinish.missingRequiredSteps).toEqual([]);
    expect(beforeFinish.status).toBe("in_progress");

    const finish = await call("/api/onboarding/complete", { method: "POST", headers: { ...CSRF, cookie: org.cookie } });
    expect(finish.status).toBe(200);
    const done = finish.body as { status: string; completedAt: string | null; goals: string[] };
    expect(done.status).toBe("completed");
    expect(done.completedAt).toBeTruthy();
    expect(done.goals).toEqual(["build-ai-agents", "connect-messaging-channels"]);

    // Idempotent completion.
    const again = await call("/api/onboarding/complete", { method: "POST", headers: { ...CSRF, cookie: org.cookie } });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ status: "completed" });

    // Durable audit row on the existing audit infrastructure.
    const audit = await server.services.pool.query(
      "SELECT action, result FROM audit_events WHERE org_id = $1 AND action = 'onboarding.completed'",
      [org.orgId],
    );
    expect(audit.rows.length).toBeGreaterThanOrEqual(1);
    expect(audit.rows[0]).toMatchObject({ result: "success" });

    // PATCH after completion is rejected.
    const patchAfter = await call("/api/onboarding", {
      method: "PATCH",
      headers: { ...CSRF, cookie: org.cookie },
      body: JSON.stringify({ step: 1, persona: "developer" }),
    });
    expect(patchAfter.status).toBe(409);
    expect(patchAfter.body).toMatchObject({ code: "onboarding_completed" });
  });

  it("onboarding state is isolated per org and survives logout/login", async () => {
    const orgA = await signup();
    const orgB = await signup();
    await call("/api/onboarding", { method: "PATCH", headers: { ...CSRF, cookie: orgA.cookie }, body: JSON.stringify({ step: 1, persona: "agency" }) });

    const b = (await (await call("/api/onboarding", { headers: { cookie: orgB.cookie } })).body) as { status: string; persona: string | null; orgId: string };
    expect(b.orgId).toBe(orgB.orgId);
    expect(b.status).toBe("not_started");
    expect(b.persona).toBeNull();

    // Login again (fresh session) — progress resumes from PostgreSQL.
    const login = await call("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: orgA.email, password: "onboarding-test-pass" }),
    });
    expect(login.status).toBe(200);
    const cookieA2 = cookieFrom(login.headers);
    const resumed = (await (await call("/api/onboarding", { headers: { cookie: cookieA2 } })).body) as {
      status: string;
      persona: string | null;
    };
    expect(resumed.status).toBe("in_progress");
    expect(resumed.persona).toBe("agency");
  });

  it("members below admin cannot mutate onboarding", async () => {
    const owner = await signup();
    const member = await signup();
    // Make the member a MEMBER of the owner's org and switch them onto it.
    await server.services.pool.query(
      "INSERT INTO memberships (id, org_id, user_id, role) VALUES ($1, $2, $3, 'member')",
      [randomUUID(), owner.orgId, member.userId],
    );
    const select = await call("/api/auth/orgs/select", {
      method: "POST",
      headers: { ...CSRF, cookie: member.cookie },
      body: JSON.stringify({ orgId: owner.orgId }),
    });
    expect(select.status).toBe(200);
    const patch = await call("/api/onboarding", {
      method: "PATCH",
      headers: { ...CSRF, cookie: member.cookie },
      body: JSON.stringify({ step: 1, persona: "developer" }),
    });
    expect(patch.status).toBe(403);
    expect(patch.body).toMatchObject({ code: "role_denied" });
  });

  it("requires authentication and replays the migration-0020 backfill for legacy orgs", async () => {
    const anon = await call("/api/onboarding");
    expect(anon.status).toBe(401);

    // Legacy org created BEFORE onboarding existed (no signup authority).
    const legacyId = randomUUID();
    await server.services.pool.query(
      "INSERT INTO organizations (id, slug, display_name) VALUES ($1, $2, $3)",
      [legacyId, `legacy-${randomUUID().slice(0, 8)}`, "Legacy Co"],
    );

    // Replay the exact backfill statement from 0020_org_onboarding_state.sql
    // (idempotent: ON CONFLICT DO NOTHING). Existing orgs must land completed.
    await server.services.pool.query(
      `INSERT INTO "org_onboarding"
              ("org_id", "status", "current_step", "completed_steps", "goals", "completed_at")
            SELECT o."id", 'completed', 6, '[1,2,3,4,5,6]'::jsonb, '[]'::jsonb, now()
            FROM "organizations" o
            ON CONFLICT ("org_id") DO NOTHING`,
    );

    const rows = await server.services.pool.query(
      "SELECT status, current_step, completed_steps FROM org_onboarding WHERE org_id = $1",
      [legacyId],
    );
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0]).toMatchObject({ status: "completed", current_step: 6 });
  });
});
