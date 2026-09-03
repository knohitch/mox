/**
 * PRODUCT_COMPLETION_01 §B — secure first-superadmin bootstrap over REAL
 * PostgreSQL: the operator CLI (packages/database/scripts/bootstrap-admin.mjs)
 * grants the durable superadmin staff role to an EXISTING account; `/admin/login`
 * accepts the durable superadmin; org owners without staff authority stay
 * denied; re-runs are idempotent; a second grant is refused once a superadmin
 * exists; the grant is audited; no duplicate users are created.
 *
 * Skipped unless MOX_TEST_DATABASE_URL points at an empty, migrated database
 * (scripts/run-postgres-verification.ps1 provisions a disposable cluster).
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { ControlPlaneConfig } from "../src/config.js";
import { composeControlPlane, type ControlPlaneServices } from "../src/composition.js";
import { startControlPlane, type RunningControlPlane } from "../src/server.js";

const databaseUrl = process.env["MOX_TEST_DATABASE_URL"];
const scriptPath = fileURLToPath(
  new URL("../../../packages/database/scripts/bootstrap-admin.mjs", import.meta.url),
);

interface TestServer {
  base: string;
  services: ControlPlaneServices;
  running: RunningControlPlane;
}

let server: TestServer;

/** Email of the account bootstrapped by the first test (suite runs in order). */
let lastBootstrappedSuperadmin: string | undefined;

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

/** Runs the operator CLI exactly as an operator would (child process). */
function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [scriptPath, ...args], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

function expectCliStatus(result: { status: number; stdout: string; stderr: string }, expected: number): void {
  expect(
    result.status,
    `cli exit ${result.status} (expected ${expected})\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  ).toBe(expected);
}

async function superadminCount(): Promise<number> {
  const rows = await server.services.pool.query(
    "SELECT COUNT(*)::int AS n FROM platform_staff_memberships WHERE role = 'superadmin' AND revoked_at IS NULL",
  );
  return rows.rows[0].n as number;
}

describe.skipIf(!databaseUrl)("First-superadmin bootstrap CLI over PostgreSQL", () => {
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
      customerCredentialsKey: "bootstrap-admin-customer-credential-vault-passphrase",
    };
    const services = await composeControlPlane(config);
    const running = await startControlPlane(services);
    server = { base: `http://127.0.0.1:${running.port}`, services, running };
    // The disposable verification DB may carry staff rows seeded by the
    // earlier PG suites. First-admin bootstrap requires a no-active-superadmin
    // world, so retire any pre-existing superadmin memberships (this suite
    // runs after them, sequentially, per run-postgres-verification.ps1).
    await server.services.pool.query(
      "UPDATE platform_staff_memberships SET revoked_at = now(), enabled = false WHERE role = 'superadmin' AND revoked_at IS NULL",
    );
  });

  afterAll(async () => {
    if (server) await server.running.close();
  });

  async function signupCustomer(): Promise<{ email: string; password: string }> {
    const email = `${randomUUID().slice(0, 10)}-${Date.now()}@mox.test`;
    const res = await call("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "bootstrap-test-pass", orgName: "Bootstrap Co" }),
    });
    expect(res.status).toBe(200);
    return { email, password: "bootstrap-test-pass" };
  }

  it("denies an org owner without staff authority, then bootstraps that exact account into a durable superadmin", async () => {
    const owner = await signupCustomer();
    lastBootstrappedSuperadmin = owner.email;

    // Org owner (no platform staff grant) cannot enter Admin.
    const denied = await call("/api/admin/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: owner.email, password: owner.password }),
    });
    expect(denied.status).toBe(403);

    // Operator bootstraps the EXISTING account (no duplicate user).
    const usersBefore = await server.services.pool.query("SELECT COUNT(*)::int AS n FROM users");
    const grant = runCli(["--email", owner.email]);
    expectCliStatus(grant, 0);
    expect(grant.stdout).toContain("granted durable superadmin");
    expect(grant.stdout).toContain(owner.email);

    const usersAfter = await server.services.pool.query("SELECT COUNT(*)::int AS n FROM users");
    expect(usersAfter.rows[0].n).toBe(usersBefore.rows[0].n);

    // Exactly one durable, enabled membership.
    const memberships = await server.services.pool.query(
      "SELECT role, enabled FROM platform_staff_memberships WHERE user_id = (SELECT id FROM users WHERE email = $1)",
      [owner.email],
    );
    expect(memberships.rows).toEqual([{ role: "superadmin", enabled: true }]);

    // The durable superadmin can now log in through /admin/login.
    const accepted = await call("/api/admin/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: owner.email, password: owner.password }),
    });
    expect(accepted.status).toBe(200);
    const auth = accepted.body as { role?: string; capabilities?: string[] };
    expect(auth.role).toBe("superadmin");
    expect(auth.capabilities).toEqual(["*"]);

    // The grant is audited on the canonical audit_events table.
    const audit = await server.services.pool.query(
      "SELECT action, actor_type, resource_type, result FROM audit_events WHERE resource_type = 'staff_membership' AND action = 'staff.bootstrap_grant' AND resource_id = (SELECT id::text FROM users WHERE email = $1)",
      [owner.email],
    );
    expect(audit.rows.length).toBe(1);
    expect(audit.rows[0]).toMatchObject({ actor_type: "system", result: "success" });
  });

  it("re-running for the same active superadmin is an idempotent no-op", async () => {
    // Reuses the account bootstrapped above: the suite runs in order and one
    // active superadmin now exists by design.
    const before = await superadminCount();
    const again = runCli(["--email", lastBootstrappedSuperadmin!]);
    expectCliStatus(again, 0);
    expect(again.stdout).toContain("already holds an active superadmin membership");
    expect(await superadminCount()).toBe(before);
  });

  it("refuses to grant a second superadmin once one is active (fail closed)", async () => {
    const second = await signupCustomer();
    const refused = runCli(["--email", second.email]);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("an active superadmin already exists");

    const memberships = await server.services.pool.query(
      "SELECT COUNT(*)::int AS n FROM platform_staff_memberships WHERE user_id = (SELECT id FROM users WHERE email = $1)",
      [second.email],
    );
    expect(memberships.rows[0].n).toBe(0);
  });

  it("refuses unknown accounts without creating users", async () => {
    const ghost = `ghost-${randomUUID().slice(0, 10)}@mox.test`;
    const refused = runCli(["--email", ghost]);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("no existing Mox account");
    const rows = await server.services.pool.query("SELECT COUNT(*)::int AS n FROM users WHERE email = $1", [ghost]);
    expect(rows.rows[0].n).toBe(0);
  });
});
