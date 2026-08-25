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
import { organizations } from "./identity-users.js"; 
 
/** 
 * Operations domain: audit events, usage/costs, compute desired state, 
 * notifications, backups, abuse cases and feature flags. Billing is a 
 * shell only - no pricing or invoicing logic in this step. 
 */ 
 
export const auditEvents = pgTable( 
  "audit_events", 
  { 
    id: uuid("id").primaryKey().defaultRandom(), 
    /** Affected tenant org. NULL for platform-level actions (Security
     *  Repair 05B §F): the admin's home org is never a default stand-in. */
    orgId: uuid("org_id") 
      .references(() => organizations.id, { onDelete: "cascade" }), 
    actorType: text("actor_type").notNull(), 
    actorId: text("actor_id"), 
    action: text("action").notNull(), 
    resourceType: text("resource_type"), 
    resourceId: text("resource_id"), 
    result: text("result").notNull(), 
    correlationId: text("correlation_id"), 
    /** Secret-safe before/after snapshots (already redacted upstream). */ 
    before: jsonb("before"), 
    after: jsonb("after"), 
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(), 
  }, 
  (t) => [ 
    index("audit_events_org_at_idx").on(t.orgId, t.at), 
    index("audit_events_correlation_idx").on(t.correlationId), 
  ], 
); 
 
export const usageEvents = pgTable( 
  "usage_events", 
  { 
    id: uuid("id").primaryKey().defaultRandom(), 
    orgId: uuid("org_id") 
      .notNull() 
      .references(() => organizations.id, { onDelete: "cascade" }), 
    kind: text("kind").notNull(), 
    quantity: integer("quantity").notNull().default(1), 
    idempotencyKey: text("idempotency_key").notNull(), 
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(), 
  }, 
  (t) => [uniqueIndex("usage_events_org_idem_key").on(t.orgId, t.idempotencyKey)], 
); 
 
export const costEvents = pgTable( 
  "cost_events", 
  { 
    id: uuid("id").primaryKey().defaultRandom(), 
    orgId: uuid("org_id") 
      .notNull() 
      .references(() => organizations.id, { onDelete: "cascade" }), 
    usageEventId: uuid("usage_event_id"), 
    currency: text("currency").notNull().default("USD"), 
    amountMicros: integer("amount_micros").notNull().default(0), 
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(), 
  }, 
  (t) => [index("cost_events_org_at_idx").on(t.orgId, t.at)], 
); 
 
/** Desired-state shell for compute; reconciliation logic comes later. */ 
export const computeInstances = pgTable( 
  "compute_instances", 
  { 
    id: uuid("id").primaryKey().defaultRandom(), 
    orgId: uuid("org_id") 
      .notNull() 
      .references(() => organizations.id, { onDelete: "cascade" }), 
    slug: text("slug").notNull(), 
    kind: text("kind").notNull().default("sandbox"), 
    desiredState: jsonb("desired_state").notNull(), 
    observedState: jsonb("observed_state"), 
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), 
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(), 
  }, 
  (t) => [uniqueIndex("compute_instances_org_slug_key").on(t.orgId, t.slug)], 
); 
 
export const notifications = pgTable( 
  "notifications", 
  { 
    id: uuid("id").primaryKey().defaultRandom(), 
    orgId: uuid("org_id") 
      .notNull() 
      .references(() => organizations.id, { onDelete: "cascade" }), 
    userId: uuid("user_id"), 
    kind: text("kind").notNull(), 
    payload: jsonb("payload").notNull(), 
    readAt: timestamp("read_at", { withTimezone: true }), 
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), 
  }, 
  (t) => [index("notifications_org_idx").on(t.orgId, t.createdAt)], 
); 
 
export const backups = pgTable( 
  "backups", 
  { 
    id: uuid("id").primaryKey().defaultRandom(), 
    orgId: uuid("org_id") 
      .notNull() 
      .references(() => organizations.id, { onDelete: "cascade" }), 
    kind: text("kind").notNull(), 
    location: text("location").notNull(), 
    sizeBytes: integer("size_bytes"), 
    completedAt: timestamp("completed_at", { withTimezone: true }), 
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), 
  }, 
  (t) => [index("backups_org_idx").on(t.orgId, t.createdAt)], 
); 
 
export const abuseCases = pgTable( 
  "abuse_cases", 
  { 
    id: uuid("id").primaryKey().defaultRandom(), 
    orgId: uuid("org_id") 
      .notNull() 
      .references(() => organizations.id, { onDelete: "cascade" }), 
    category: text("category").notNull(), 
    severity: text("severity").notNull().default("low"), 
    status: text("status").notNull().default("open"), 
    notes: jsonb("notes"), 
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), 
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(), 
  }, 
  (t) => [index("abuse_cases_org_idx").on(t.orgId, t.status)], 
); 
 
export const featureFlags = pgTable( 
  "feature_flags", 
  { 
    key: text("key").primaryKey(), 
    orgId: uuid("org_id") 
      .notNull() 
      .references(() => organizations.id, { onDelete: "cascade" }), 
    enabled: text("enabled").notNull().default("false"), 
    rollout: jsonb("rollout"), 
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(), 
  }, 
  (t) => [uniqueIndex("feature_flags_org_key").on(t.orgId, t.key)], 
); 
