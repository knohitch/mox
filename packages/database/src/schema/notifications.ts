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
 * Notification domain (Prompt 12, durable wiring Prompt 00 §C): preferences,
 * templates, in-app notifications and the outbound dispatch log. In-app
 * records are business truth and must survive restarts; dedupe is enforced
 * by unique (org, dedupe_key).
 */

export const notificationPreferences = pgTable(
  "notification_preferences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Null row = org-level defaults; user rows take precedence. */
    userId: uuid("user_id"),
    routes: jsonb("routes").notNull().default({}),
    mutedEventTypes: jsonb("muted_event_types").notNull().default([]),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("notification_prefs_org_user_idx").on(t.orgId, t.userId)],
);

export const messageTemplates = pgTable(
  "message_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventType: text("event_type").notNull(),
    locale: text("locale").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("message_templates_event_locale_idx").on(t.eventType, t.locale)],
);

export const inAppNotifications = pgTable(
  "in_app_notifications",
  {
    /** Opaque service-generated id (e.g. ntf_...); never a raw uuid. */
    id: text("id").primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id"),
    eventType: text("event_type").notNull(),
    severity: text("severity").notNull().default("info"),
    title: text("title").notNull(),
    body: text("body").notNull(),
    resourceType: text("resource_type"),
    resourceId: text("resource_id"),
    dedupeKey: text("dedupe_key"),
    /** user | org | broadcast (Prompt 02 §Audience). */
    audienceType: text("audience_type").notNull().default("user"),
    /** system | billing | servers | agents | security (UI filters). */
    category: text("category").notNull().default("system"),
    createdBy: text("created_by"),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    /** draft | scheduled | ready | sent | failed. */
    deliveryState: text("delivery_state").notNull().default("ready"),
    readAt: timestamp("read_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("in_app_notifications_org_dedupe_key")
      .on(t.orgId, t.dedupeKey),
    index("in_app_notifications_org_created_idx").on(t.orgId, t.createdAt),
  ],
);

export const dispatchedMessages = pgTable(
  "dispatched_messages",
  {
    /** Opaque service-generated id (e.g. msg_...); never a raw uuid. */
    id: text("id").primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id"),
    eventType: text("event_type").notNull(),
    route: text("route").notNull(),
    recipient: text("recipient").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("dispatched_messages_org_idx").on(t.orgId)],
);


/** Draft/scheduled/broadcast job state machine (Prompt 02). */
export const notificationJobs = pgTable(
  "notification_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** null = platform-wide job. */
    orgId: uuid("org_id").references(() => organizations.id, { onDelete: "cascade" }),
    /** user | users | org | plan | region | all. */
    audienceType: text("audience_type").notNull(),
    audiencePayload: jsonb("audience_payload").notNull().default({}),
    title: text("title").notNull(),
    body: text("body").notNull(),
    severity: text("severity").notNull().default("info"),
    category: text("category").notNull().default("system"),
    resourceType: text("resource_type"),
    resourceId: text("resource_id"),
    /** draft | scheduled | running | completed | canceled | failed */
    status: text("status").notNull().default("draft"),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    fanoutTotal: integer("fanout_total").notNull().default(0),
    fanoutDone: integer("fanout_done").notNull().default(0),
    error: text("error"),
    createdBy: text("created_by").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("notification_jobs_idem_key").on(t.idempotencyKey),
    index("notification_jobs_status_idx").on(t.status, t.scheduledAt),
  ],
);
