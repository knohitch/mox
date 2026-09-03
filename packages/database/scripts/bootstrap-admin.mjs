// Secure first-superadmin bootstrap for Mox operators (PRODUCT_COMPLETION_01).
//
// Grants the durable `superadmin` platform-staff role to an EXISTING Mox
// account so `/admin/login` works without manually editing PostgreSQL. This is
// a local/server-side operator CLI — never a public web endpoint.
//
// Usage:
//   pnpm mox:bootstrap-admin -- --email owner@example.com
//   pnpm mox:bootstrap-admin -- --user-id 11111111-1111-1111-1111-111111111111
//
// Environment:
//   DATABASE_URL  PostgreSQL connection string (same variable the control
//                 plane uses; the script never asks for or prints secrets).
//
// Behavior (fail-closed):
//   - resolves the account by email or user id; NEVER creates a user;
//   - grants only while NO active superadmin membership exists (initial
//     bootstrap) or when the target already is the active superadmin
//     (idempotent re-run);
//   - refuses once any other active superadmin exists — later staff are
//     managed through Admin → Staff & Access by a superadmin. Break-glass
//     for lost superadmin access remains the documented deployment-config
//     mechanism (MOX_PLATFORM_ADMIN_USER_IDS / roles / capabilities);
//   - audits the grant on the canonical audit_events table;
//   - logs no credentials or tokens (there are none — no password reset,
//     no secret minting, only a durable membership row).

import pg from "pg";

const USAGE = `mox:bootstrap-admin — grant the durable superadmin staff role to an existing Mox account.

Usage:
  pnpm mox:bootstrap-admin -- --email <email>
  pnpm mox:bootstrap-admin -- --user-id <uuid>

Options:
  --email <email>    Existing Mox account email (case-insensitive).
  --user-id <uuid>   Existing Mox account id.
  --help             Show this help.

The account must already exist (sign up through the product first). The
superadmin can then sign in via /admin/login and manage all later staff
through Staff & Access.`;

function parseArgs(argv) {
  const args = { email: undefined, userId: undefined, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--email") {
      args.email = argv[i + 1];
      i += 1;
    } else if (arg === "--user-id") {
      args.userId = argv[i + 1];
      i += 1;
    } else if (arg === "--email=" || arg === "--user-id=") {
      throw new Error(`missing value for ${arg}`);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Grants the durable superadmin staff role. Exported for the PG-gated test
 * suite; the CLI entry point below is the only operational caller.
 *
 * @returns {Promise<{ outcome: "granted" | "already_active" | "refused", userId?: string, email?: string, reason?: string }>}
 */
export async function bootstrapSuperadmin({ connectionString, email, userId }) {
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const target = email ? email.trim().toLowerCase() : undefined;
  const id = userId?.trim();
  if (!target && !id) throw new Error("identify the account with --email <email> or --user-id <uuid>");
  if (target && id) throw new Error("pass either --email or --user-id, not both");
  if (id && !UUID_RE.test(id)) throw new Error(`--user-id must be a uuid (got ${id})`);

  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query("BEGIN");
    // Lock the staff rows so two concurrent bootstraps cannot both succeed.
    const activeSuperadmins = await client.query(
      "SELECT user_id, enabled FROM platform_staff_memberships WHERE role = 'superadmin' AND revoked_at IS NULL FOR UPDATE",
    );

    const account = target
      ? await client.query("SELECT id, email, display_name, disabled_at FROM users WHERE email = $1", [target])
      : await client.query("SELECT id, email, display_name, disabled_at FROM users WHERE id = $1::uuid", [id]);
    const user = account.rows[0];
    if (!user) {
      throw new Error(
        target
          ? `no existing Mox account with email ${target}. Sign up through the product first — this tool never creates users.`
          : `no existing Mox account with id ${id}. This tool never creates users.`,
      );
    }
    if (user.disabled_at) {
      throw new Error(`account ${user.email} is disabled; re-enable it through product support before bootstrapping`);
    }

    const mine = activeSuperadmins.rows.find((row) => row.user_id === user.id);
    if (mine && mine.enabled) {
      await client.query("COMMIT");
      return { outcome: "already_active", userId: user.id, email: user.email };
    }
    if (mine && !mine.enabled) {
      // Disabled/re-enabled state is Staff & Access authority, not bootstrap.
      throw new Error(
        `account ${user.email} already holds a superadmin membership that is disabled; a superadmin must re-enable it through Admin → Staff & Access`,
      );
    }
    if (activeSuperadmins.rows.length > 0) {
      throw new Error(
        "an active superadmin already exists — bootstrap is closed. Manage later staff through Admin → Staff & Access. " +
          "If all superadmin access was lost, use the documented deployment-config break-glass (MOX_PLATFORM_ADMIN_USER_IDS).",
      );
    }

    const granted = await client.query(
      `INSERT INTO platform_staff_memberships (user_id, role, enabled, granted_by_user_id)
       VALUES ($1::uuid, 'superadmin', true, NULL)
       ON CONFLICT (user_id, role) DO UPDATE
         SET enabled = true, revoked_at = NULL, granted_by_user_id = NULL, updated_at = now()
       RETURNING id`,
      [user.id],
    );
    // Canonical audit trail (org NULL = platform-level action).
    await client.query(
      `INSERT INTO audit_events (org_id, actor_type, actor_id, action, resource_type, resource_id, result, after)
       VALUES (NULL, 'system', 'mox:bootstrap-admin', 'staff.bootstrap_grant', 'staff_membership', $1, 'success', $2::jsonb)`,
      [user.id, JSON.stringify({ role: "superadmin", via: "bootstrap-cli", email: user.email })],
    );
    await client.query("COMMIT");
    return { outcome: "granted", userId: user.id, email: user.email, membershipId: granted.rows[0]?.id };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error));
    console.error(USAGE);
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL is required (the same PostgreSQL the control plane uses)");
    return 2;
  }
  try {
    const result = await bootstrapSuperadmin({ connectionString, email: args.email, userId: args.userId });
    if (result.outcome === "already_active") {
      console.log(`OK: ${result.email} (${result.userId}) already holds an active superadmin membership — nothing changed.`);
    } else {
      console.log(`OK: granted durable superadmin to ${result.email} (${result.userId}).`);
      console.log("Next: sign in via /admin/login, then manage all later staff through Admin → Staff & Access.");
    }
    return 0;
  } catch (error) {
    console.error(`REFUSED: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

// Run the CLI only when executed directly (tests import the exported function).
const isDirectRun =
  typeof process.argv[1] === "string" &&
  import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  process.exit(await main());
}
