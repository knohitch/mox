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