import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Platform operations schema (Prompt 12): usage limits, cost ledger entries
 * and incidents. Notification preferences/templates/dispatch state live in
 * schema/notifications.ts (Prompt 00 §C) as their durable authority.
 */

/** Per-org usage limits feeding hard/soft enforcement. */
export const usageLimits = pgTable(
  "usage_limits",
  {
    orgId: text("org_id").notNull(),
    planVersionId: text("plan_version_id").notNull().default("*"),
    kind: text("kind").notNull(),
    includedQuantity: integer("included_quantity").notNull().default(-1),
    softLimitQuantity: integer("soft_limit_quantity"),
    hardLimitQuantity: integer("hard_limit_quantity"),
    overagePriceRef: text("overage_price_ref"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("usage_limits_key").on(t.orgId, t.kind, t.planVersionId)],
);

/** Internal wholesale cost ledger; never exposed to customers directly. */
export const costLedgerEntries = pgTable(
  "cost_ledger_entries",
  {
    entryId: text("entry_id").primaryKey(),
    kind: text("kind").notNull(), // cost | revenue
    category: text("category"),
    amountMinor: text("amount_minor").notNull(),
    currency: text("currency").notNull().default("USD"),
    recurring: boolean("recurring").notNull().default(false),
    orgId: text("org_id"),
    planTier: text("plan_tier"),
    regionCode: text("region_code"),
    providerName: text("provider_name"),
    at: timestamp("at", { withTimezone: true }).notNull(),
  },
  (t) => [index("cost_ledger_kind_at_idx").on(t.kind, t.at), index("cost_ledger_org_idx").on(t.orgId)],
);

export const incidents = pgTable(
  "incidents",
  {
    incidentId: text("incident_id").primaryKey(),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    severity: text("severity").notNull(),
    status: text("status").notNull().default("investigating"),
    affectedScope: text("affected_scope").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    updates: jsonb("updates").notNull().default([]),
  },
  (t) => [index("incidents_status_idx").on(t.status, t.startedAt)],
);
