/**
 * Prompt 00B §H(6): upgrade drill from the pre-0006 schema to current.
 *
 * Creates a fresh database, applies migrations 0000–0005 (pre-foundation),
 * inserts LEGACY-shaped rows (a canceled subscription, a price book with a
 * legacy jsonb fx_rate, an issued-style enrollment-less node row), then
 * applies 0006 + 0007 and proves legitimate history survived:
 *   - the canceled subscription row still exists (history-preserving
 *     uniqueness replaced the one-row-per-org index);
 *   - a NEW live subscription for the same org can be created afterwards;
 *   - legacy fx_rate jsonb migrated into fx_rate_scaled;
 *   - new auth/enrollment objects exist.
 */

import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import url from "node:url";
import pg from "pg";

const base = process.env.UPGRADE_BASE_URL;
if (!base) {
  console.error("UPGRADE_BASE_URL is required (e.g. postgresql://postgres@127.0.0.1:5433)");
  process.exit(1);
}

const here = path.dirname(url.fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, "..", "..", "..", "packages", "database", "migrations");

const client = new pg.Client({ connectionString: `${base}/postgres` });
await client.connect();

const dbName = `mox_upgrade_${Date.now()}`;
async function run(sql) {
  await client.query(sql);
}

try {
  await run(`DROP DATABASE IF EXISTS ${dbName}`);
  await run(`CREATE DATABASE ${dbName}`);

  const target = new pg.Client({ connectionString: `${base}/${dbName}` });
  await target.connect();

  // Same tracking table shape as packages/database/scripts/migrate.mjs.
  await target.query(
    "CREATE TABLE IF NOT EXISTS mox_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
  );

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  const apply = async (file) => {
    const sqlText = await readFile(path.join(migrationsDir, file), "utf8");
    const checksum = createHash("sha256").update(sqlText).digest("hex");
    await target.query("BEGIN");
    try {
      // Split on drizzle breakpoints; plain split is safe for these files.
      for (const stmt of sqlText.split("--> statement-breakpoint")) {
        if (!stmt.trim()) continue;
        await target.query(stmt);
      }
      await target.query(
        "INSERT INTO mox_migrations (name, checksum) VALUES ($1, $2)" +
          " ON CONFLICT (name) DO UPDATE SET checksum = EXCLUDED.checksum",
        [file, checksum],
      );
      await target.query("COMMIT");
    } catch (error) {
      await target.query("ROLLBACK");
      throw error;
    }
  };

  console.log("== pre-0006 baseline (0000–0005) ==");
  for (const file of files.filter((f) => f < "0006")) await apply(file);

  const orgId = "11111111-1111-4111-8111-00000000abcd";
  const subOld = "22222222-2222-4222-8222-00000000abcd";
  const pvId = "33333333-3333-4333-8333-00000000abcd";
  const prId = "44444444-4444-4444-8444-00000000abcd";
  const prodId = "55555555-5555-4555-8555-00000000abcd";
  const region = "LEGACY";
  const bookId = "66666666-6666-4666-8666-00000000abcd";

  // Legacy-shaped rows under the OLD schema (jsonb fx_rate; one-sub-per-org).
  await target.query(
    `INSERT INTO organizations (id, slug, display_name) VALUES ($1,'legacy','Legacy Org')`,
    [orgId],
  );
  await target.query(`INSERT INTO products (id, code, tier, display_name) VALUES ($1,'legacy_plus','plus','Legacy Plus')`, [prodId]);
  await target.query(
    `INSERT INTO plan_versions (id, product_id, version, status) VALUES ($1,$2,1,'active')`,
    [pvId, prodId],
  );
  await target.query(
    `INSERT INTO currencies (code, exponent, display_name) VALUES ('USD',2,'US Dollar') ON CONFLICT DO NOTHING`,
  );
  await target.query(
    `INSERT INTO pricing_regions (code, display_name, charge_currency, display_currency)
     VALUES ($1,'Legacy','USD','USD') ON CONFLICT DO NOTHING`,
    [region],
  );
  await target.query(
    `INSERT INTO price_books (id, product_id, pricing_region, mode, base_currency, fx_rate)
     VALUES ($1,$2,$3,'fx_derived','USD','1.25'::jsonb)`,
    [bookId, prodId, region],
  );
  await target.query(
    `INSERT INTO price_versions (id, price_book_id, version, amount_minor, currency)
     VALUES ($1,$2,1,1999,'USD')`,
    [prId, bookId],
  );
  await target.query(
    `INSERT INTO subscriptions
       (id, org_id, plan_version_id, price_version_id, state, provider_ref,
        current_period_start, current_period_end, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'canceled','legacy-gateway:sub_old', now(), now(), now(), now())`,
    [subOld, orgId, pvId, prId],
  );
  console.log("legacy rows inserted (canceled subscription + jsonb fx_rate)");

  console.log("== upgrading 0006 → 0007 ==");
  for (const file of files.filter((f) => f >= "0006")) await apply(file);

  // ---- Assertions -----------------------------------------------------------
  const history = await target.query(
    `SELECT state FROM subscriptions WHERE org_id = $1 AND id = $2`,
    [orgId, subOld],
  );
  if (history.rowCount !== 1 || history.rows[0].state !== "canceled") {
    throw new Error("FAIL: historical subscription did not survive the upgrade");
  }

  // Resubscribe must succeed under the NEW partial unique index.
  await target.query(
    `INSERT INTO subscriptions
       (id, org_id, plan_version_id, price_version_id, state, provider_ref,
        current_period_start, current_period_end, created_at, updated_at)
     VALUES ('77777777-7777-4777-8777-00000000abcd',$1,$2,$3,'active','legacy-gateway:sub_new',
             now(), now(), now(), now())`,
    [orgId, pvId, prId],
  );
  const both = await target.query(`SELECT count(*)::int AS n FROM subscriptions WHERE org_id = $1`, [orgId]);
  if (both.rows[0].n !== 2) throw new Error("FAIL: expected 2 subscription rows (history + resubscribe)");

  const fx = await target.query(`SELECT fx_rate_scaled FROM price_books WHERE id = $1`, [bookId]);
  if (BigInt(fx.rows[0].fx_rate_scaled) !== 1250000000n) {
    throw new Error(`FAIL: fx_rate migration wrong: ${fx.rows[0].fx_rate_scaled}`);
  }

  for (const object of [
    "SELECT 1 FROM auth_credentials LIMIT 1",
    "SELECT 1 FROM platform_setup LIMIT 1",
    "SELECT 1 FROM node_enrollment_tokens LIMIT 1",
    "SELECT 1 FROM in_app_notifications LIMIT 1",
    "SELECT 1 FROM mox_nodes WHERE agent_token_hash IS NULL LIMIT 1",
  ]) {
    await target.query(object); // existence of relations/columns is the check
  }

  const idx = await target.query(
    `SELECT indexname FROM pg_indexes WHERE tablename='node_enrollment_tokens' AND indexname='node_enrollment_tokens_one_issued_per_order'`,
  );
  if (idx.rowCount !== 1) throw new Error("FAIL: one-issued-per-order partial index missing");

  console.log("PASS: upgrade drill — history preserved, resubscribe works, FX migrated, new objects present.");
  await target.end();
} finally {
  await run(`DROP DATABASE IF EXISTS ${dbName}`).catch(() => undefined);
  await client.end().catch(() => undefined);
}
