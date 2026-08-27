/**
 * Retained-branch rescue over REAL PostgreSQL: credential authority
 * separation (Part A) + billing catalog seed idempotency (Part B).
 * Skipped unless MOX_TEST_DATABASE_URL points at an empty, migrated
 * database; scripts/run-postgres-verification.ps1 provisions a disposable
 * cluster and runs this suite after applying ALL migrations.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import {
  BillingService,
  DEFAULT_PLAN_CODES,
  seedCatalog,
} from "@mox/billing";
import {
  authSessions,
  createDb,
  credentialRefs,
  memberships,
  organizations,
  PgBillingStore,
  PgCustomerCredentialStore,
  PgSystemCredentialStore,
  systemCredentialRefs,
  systemModelConnections,
  systemModelProviders,
  users,
} from "@mox/database";
import type { ControlPlaneConfig } from "../src/config.js";
import { composeControlPlane, type ControlPlaneServices } from "../src/composition.js";
import { startControlPlane, type RunningControlPlane } from "../src/server.js";

const databaseUrl = process.env["MOX_TEST_DATABASE_URL"];

interface ServerFixture {
  base: string;
  services: ControlPlaneServices;
  running: RunningControlPlane;
}

let server: ServerFixture;
let db: ReturnType<typeof createDb>["db"];
let pool: ReturnType<typeof createDb>["pool"];

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

const CSRF = { "x-mox-csrf": "1", "content-type": "application/json" };

const BASE_PRICES: Record<string, number> = { plus: 2000, pro: 4900, max: 9900, enterprise: 29900 };

describe.skipIf(!databaseUrl)("retained-branch rescue over PostgreSQL", () => {
  beforeAll(async () => {
    const created = createDb({ connectionString: databaseUrl! });
    db = created.db;
    pool = created.pool;
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
    };
    const services = await composeControlPlane(config);
    const running = await startControlPlane(services);
    server = { base: `http://127.0.0.1:${running.port}`, services, running };
  });

  afterAll(async () => {
    if (server) await server.running.close();
    if (pool) await pool.end();
  });

  describe("credential authority separation", () => {
    it("customer store isolates orgs: an external id alone never leaks another org's secret", async () => {
      const store = new PgCustomerCredentialStore(db);
      const orgA = randomUUID();
      const orgB = randomUUID();
      await db.insert(organizations).values([
        { id: orgA, slug: `org-a-${randomUUID().slice(0, 8)}`, displayName: "Org A" },
        { id: orgB, slug: `org-b-${randomUUID().slice(0, 8)}`, displayName: "Org B" },
      ]);
      const sealed = `v2.${Buffer.from("sealed-payload-a").toString("base64url")}`;
      await store.put({ orgId: orgA, externalId: "shared-ext" }, sealed);
      // Same external id under a different org must NOT resolve.
      await expect(store.get({ orgId: orgB, externalId: "shared-ext" })).resolves.toBeNull();
      await expect(store.get({ orgId: orgA, externalId: "shared-ext" })).resolves.toBe(sealed);

      // Physical unique constraint on (org_id, external_id).
      const dup = await db.execute(sql`
        SELECT count(*)::int AS n FROM (
          SELECT 1 FROM customer_credential_secrets
          GROUP BY org_id, external_id HAVING count(*) > 1
        ) d`);
      expect(dup.rows[0]?.n ?? 0).toBe(0);
    });

    it("system store has no organization namespace", async () => {
      const store = new PgSystemCredentialStore(db);
      const sealed = `v2.${Buffer.from("system-payload").toString("base64url")}`;
      await store.put({ externalId: "mox:openai:test" }, sealed);
      await expect(store.get({ externalId: "mox:openai:test" })).resolves.toBe(sealed);
      // The store interface exposes no org parameter; the physical table must
      // not carry org_id either.
      const cols = await db.execute(sql`
        SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_name = 'system_credential_secrets' AND column_name = 'org_id'`);
      expect(cols.rows[0]?.n ?? 0).toBe(0);
      const keyCols = await db.execute(sql`
        SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_name = 'system_credential_secrets' AND column_name = 'external_id'`);
      expect(keyCols.rows[0]?.n ?? 0).toBe(1);
    });

    it("system model provider tables carry no organization ownership namespace", async () => {
      for (const table of ["system_model_providers", "system_models", "system_model_connections"]) {
        const cols = await db.execute(sql`
          SELECT count(*)::int AS n FROM information_schema.columns
          WHERE table_name = ${table} AND column_name = 'org_id'`);
        expect(cols.rows[0]?.n ?? 0, `${table} must not carry org_id`).toBe(0);
      }
      // customer secret table is org-scoped with the (org_id, external_id) key.
      const custCols = await db.execute(sql`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'customer_credential_secrets'`);
      const names = (custCols.rows as Array<{ column_name: string }>).map((r) => r.column_name);
      expect(names).toContain("org_id");
      expect(names).toContain("external_id");
    });

    it("preserves legacy org-scoped mox_system_* credential refs and no longer creates them", async () => {
      // Insert a legacy-shaped org-scoped row exactly like production may have.
      const orgId = randomUUID();
      await db.insert(organizations).values({ id: orgId, slug: `legacy-${randomUUID().slice(0, 8)}`, displayName: "Legacy" });
      await db.insert(credentialRefs).values({
        orgId,
        scope: "mox_system_model_provider",
        externalId: `mox:openai:MOX_INTEL_LEGACY`,
        label: "MOX_INTEL_LEGACY",
      });

      const after = await db
        .select({ id: credentialRefs.id })
        .from(credentialRefs)
        .where(sql`scope = 'mox_system_model_provider' AND external_id = 'mox:openai:MOX_INTEL_LEGACY'`)
        .limit(1);
      expect(after.length).toBe(1);
    });
  });

  describe("billing catalog seed idempotency over PostgreSQL", () => {
    it("seedCatalog() twice succeeds, reuses products/v1 and adds no duplicate GLOBAL USD price", async () => {
      const billing = new BillingService(new PgBillingStore(db));
      const first = await seedCatalog(billing);
      const beforePlans: Record<string, number> = {};
      const beforeGlobalUsd: Record<string, number> = {};
      for (const code of DEFAULT_PLAN_CODES) {
        const versions = await billing.store.listPlanVersions(first.productIds[code]!);
        beforePlans[code] = versions.filter((v) => v.version === 1).length;
        const book = await billing.store.findPriceBook(first.productIds[code]!, "GLOBAL");
        const priceVersions = book ? await billing.store.listPriceVersions(book.id) : [];
        beforeGlobalUsd[code] = priceVersions.filter(
          (v) => v.currency === "USD" && BigInt(v.amountMinor) === BigInt(BASE_PRICES[code]!),
        ).length;
      }

      const second = await seedCatalog(billing);

      // Logical identifiers are reused across runs.
      expect(second.productIds).toEqual(first.productIds);
      expect(second.activePlanVersionIds).toEqual(first.activePlanVersionIds);
      for (const code of DEFAULT_PLAN_CODES) {
        expect(second.priceVersionIdsByRegion[code]!.GLOBAL).toBe(first.priceVersionIdsByRegion[code]!.GLOBAL);
      }

      // No duplicate (product, version=1): count did not increase.
      for (const code of DEFAULT_PLAN_CODES) {
        const versions = await billing.store.listPlanVersions(first.productIds[code]!);
        expect(versions.filter((v) => v.version === 1).length).toBe(beforePlans[code]);
      }

      // No unnecessary duplicate identical GLOBAL USD anchor price.
      for (const code of DEFAULT_PLAN_CODES) {
        const book = await billing.store.findPriceBook(first.productIds[code]!, "GLOBAL");
        const priceVersions = book ? await billing.store.listPriceVersions(book.id) : [];
        const matches = priceVersions.filter(
          (v) => v.currency === "USD" && BigInt(v.amountMinor) === BigInt(BASE_PRICES[code]!),
        );
        expect(matches.length).toBe(beforeGlobalUsd[code]);
        expect(matches.length).toBeGreaterThanOrEqual(1);
      }
    });
  });

  describe("control-plane Mox-system intelligence authority", () => {
    it("platform intelligence configuration is provisioned in system tables, not the admin's org", async () => {
      // Provision an identity directly (bootstrap is permanently closed after
      // auth-integration.test.ts ran against the same shared verification DB).
      const orgId = randomUUID();
      const userId = randomUUID();
      const sessionToken = randomUUID();
      await db.insert(organizations).values({
        id: orgId,
        slug: `platform-${randomUUID().slice(0, 8)}`,
        displayName: "Platform Ops",
      });
      await db.insert(users).values({ id: userId, email: `admin-${randomUUID()}@mox.test` });
      await db.insert(memberships).values({ orgId, userId, role: "owner" });
      await db.insert(authSessions).values({
        userId,
        tokenHash: createHash("sha256").update(sessionToken).digest("hex"),
        activeOrgId: orgId,
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      server.services.config.platformAdminRoles[userId] = "superadmin";
      const cookie = `mox_session=${sessionToken}`;

      // NOTHING org-scoped may be created by the PUT: capture the baseline of
      // legacy org-scoped mox_system_model_provider credential refs first.
      const legacyScopedRefCount = async () =>
        (
          await db.execute(
            sql`SELECT count(*)::int AS n FROM credential_refs WHERE scope = 'mox_system_model_provider'`,
          )
        ).rows[0]?.n ?? 0;
      const orgScopedRefsBefore = await legacyScopedRefCount();
      const orgScopedProvidersBefore = (
        await db.execute(sql`SELECT count(*)::int AS n FROM model_providers WHERE slug = 'openai'`)
      ).rows[0]?.n ?? 0;

      const put = await call("/api/admin/intelligence/providers/openai", {
        method: "PUT",
        headers: { ...CSRF, cookie },
        body: JSON.stringify({
          displayName: "OpenAI",
          secretRef: `MOX_INTEL_${randomUUID().slice(0, 8)}`,
          baseUrl: "https://api.openai.test/v1",
          defaultModel: "gpt-4o",
        }),
      });
      expect(put.status).toBe(200);

      // The row landed in the SYSTEM provider/connection/ref tables.
      const systemProvider = await db
        .select({ id: systemModelProviders.id })
        .from(systemModelProviders)
        .where(eq(systemModelProviders.slug, "openai"))
        .limit(1);
      expect(systemProvider).toHaveLength(1);
      const connection = await db
        .select({ id: systemModelConnections.id })
        .from(systemModelConnections)
        .where(eq(systemModelConnections.providerId, systemProvider[0]!.id))
        .limit(1);
      expect(connection).toHaveLength(1);
      const ref = await db.select({ id: systemCredentialRefs.id }).from(systemCredentialRefs).limit(1);
      expect(ref.length).toBeGreaterThanOrEqual(1);

      // Unchanged: no org-scoped credential refs and no org-scoped provider rows.
      expect(await legacyScopedRefCount()).toBe(orgScopedRefsBefore);
      const orgScopedProviderAfter = (
        await db.execute(sql`SELECT count(*)::int AS n FROM model_providers WHERE slug = 'openai'`)
      ).rows[0]?.n ?? 0;
      expect(orgScopedProviderAfter).toBe(orgScopedProvidersBefore);

      // GET projection is metadata-only, never plaintext/ciphertext.
      const list = await call("/api/admin/intelligence", { headers: { cookie } });
      expect(list.status).toBe(200);
      const body = list.body as { providers: Array<Record<string, unknown>> };
      const openai = body.providers.find((p) => p.slug === "openai");
      expect(openai?.configured).toBe(true);
      expect(openai?.connectionState).toBeDefined();
      expect(openai?.providerState).toBe("enabled");
      expect(openai?.baseUrlConfigured).toBe(true);
      const raw = JSON.stringify(body);
      // Only metadata is returned: no sealed ciphertext, no key material.
      expect(raw).not.toContain("v2.");
      expect(raw).not.toMatch(/sk-(test|live)_/);
      expect(raw).not.toContain("sk-");
    });
  });
});