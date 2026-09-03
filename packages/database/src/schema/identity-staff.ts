import {
  boolean,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations, users } from "./identity-users.js";

/**
 * Platform-staff identity surface (Prompt 01: authentication, auth URLs and
 * surface isolation).
 *
 * This is a SEPARATE, durable, server-authoritative model from customer
 * organization memberships. A customer `owner`/`admin` org role NEVER implies
 * Mox platform-admin or Mox-support authority. Staff bindings reference the
 * canonical `users.id` and can be disabled/revoked independently.
 *
 * Capabilities are calculated server-side only and are never accepted from
 * the client.
 */

/** Staff capability bindings (superset of the legacy config roles). */
export const staffRole = pgEnum("staff_role", [
  "superadmin",
  "platform_admin",
  "support_manager",
  "support_agent",
]);

/**
 * A durable platform-staff membership bound to a real user id. Supports at
 * least superadmin / platform_admin / support_manager / support_agent and can
 * be disabled/revoked.
 */
export const platformStaffMemberships = pgTable(
  "platform_staff_memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: staffRole("role").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    grantedByUserId: uuid("granted_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revoked_at: timestamp("revoked_at", { withTimezone: true }),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("platform_staff_memberships_user_role_key").on(t.userId, t.role),
    index("platform_staff_memberships_user_idx").on(t.userId),
  ],
);

/**
 * Durable staff invitations for invite-only Admin and Support signup.
 * Only the hash of the token is stored; the plaintext token is shown to the
 * authorized invite creator exactly once and never returned by list APIs.
 */
export const staffInvitations = pgTable(
  "staff_invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenHash: text("token_hash").notNull(),
    email: text("email").notNull(),
    role: staffRole("role").notNull(),
    /** intended surface: 'admin' | 'support' | 'both' */
    surface: text("surface").notNull(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("staff_invitations_token_hash_key").on(t.tokenHash),
    index("staff_invitations_email_idx").on(t.email),
  ],
);

/** Durable one-use password reset tokens. Hash only; expiry + consume flags. */
export const passwordResets = pgTable(
  "password_resets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("password_resets_token_hash_key").on(t.tokenHash),
    index("password_resets_user_idx").on(t.userId),
  ],
);

/** Support escalation statuses. */
export const escalationStatus = pgEnum("escalation_status", [
  "open",
  "acknowledged",
  "investigating",
  "resolved",
  "closed",
]);

/** Durable support escalations (Phase 06). */
export const supportEscalations = pgTable(
  "support_escalations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    assignedUserId: uuid("assigned_user_id").references(() => users.id, { onDelete: "set null" }),
    severity: text("severity").notNull().default("medium"),
    category: text("category").notNull().default("general"),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    status: escalationStatus("status").notNull().default("open"),
    resolutionNote: text("resolution_note"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("support_escalations_org_idx").on(t.orgId),
    index("support_escalations_status_idx").on(t.status),
  ],
);
