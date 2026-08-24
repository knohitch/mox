import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations, users } from "./identity-users.js";

/**
 * Identity domain, part 2: server-side auth sessions, password credentials
 * and external identities (Prompt 00B §B). Secret material never lands here
 * — password verifiers live in `auth_credentials` as salted modern-KDF
 * outputs; tokens are stored only as hashes.
 */

export const authSessions = pgTable(
  "auth_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    /**
     * Explicit active-org context (Prompt 00B §C): set only through the
     * membership-verified org-switch flow; never trusted from the client.
     */
    activeOrgId: uuid("active_org_id").references(() => organizations.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("auth_sessions_token_hash_key").on(t.tokenHash),
    index("auth_sessions_user_idx").on(t.userId),
  ],
);

/**
 * Password credential domain. `password_hash` is a scrypt (or stronger
 * modern KDF) verifier with a per-password random salt encoded in the
 * string; plaintext and reversible encodings are forbidden by contract.
 */
export const authCredentials = pgTable(
  "auth_credentials",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    passwordHash: text("password_hash").notNull(),
    algorithm: text("algorithm").notNull().default("scrypt"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

/**
 * One-time platform setup state (Prompt 00B §A): the deployment bootstrap
 * secret exists only server-side and ONLY until the designated owner is
 * provisioned; completion permanently closes setup.
 */
export const platformSetup = pgTable("platform_setup", {
  id: integer("id").primaryKey().default(1),
  /** Hash of the server-side setup credential while setup is open. */
  setupTokenHash: text("setup_token_hash"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Personal/API access tokens for CLI and programmatic clients
 * (Prompt 00C §B): a SEPARATE contract from browser cookie sessions.
 * Only the sha256 hash is stored; tokens carry scopes, an explicit expiry
 * and revocation, and never ride the browser login response.
 */
export const apiTokens = pgTable(
  "api_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    /** Wildcard "*" grants full user authority; otherwise exact strings. */
    scopes: jsonb("scopes").notNull().default(["*"]),
    activeOrgId: uuid("active_org_id").references(() => organizations.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("api_tokens_token_hash_key").on(t.tokenHash),
    index("api_tokens_user_idx").on(t.userId),
  ],
);

export const externalIdentities = pgTable(
  "external_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    subject: text("subject").notNull(),
    profile: jsonb("profile"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("external_identities_provider_subject_key").on(t.providerId, t.subject)],
);

/**
 * Durable abuse-control counters for auth and setup endpoints. These rows
 * are intentionally low-cardinality buckets, not raw credential telemetry.
 */
export const authRateLimits = pgTable(
  "auth_rate_limits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scope: text("scope").notNull(),
    bucketKey: text("bucket_key").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("auth_rate_limits_scope_bucket_key").on(t.scope, t.bucketKey),
    index("auth_rate_limits_locked_idx").on(t.lockedUntil),
  ],
);

export const securityEvents = pgTable(
  "security_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    scope: text("scope").notNull(),
    bucketKey: text("bucket_key").notNull(),
    requestIp: text("request_ip"),
    userAgent: text("user_agent"),
    detail: jsonb("detail").notNull().default({}),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("security_events_kind_at_idx").on(t.kind, t.at)],
);
