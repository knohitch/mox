import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./identity-users.js";

/**
 * Billing/commerce domain: plans, immutable plan versions, entitlement
 * definitions/values, prices, subscriptions, checkout sessions, invoices and
 * verified provider events. Money is always bigint minor units.
 */
export const planTier = pgEnum("plan_tier", ["plus", "pro", "max", "enterprise"]);
export const planVersionStatus = pgEnum("plan_version_status", ["draft", "active", "retired"]);
export const subscriptionState = pgEnum("subscription_state", [
  "trial",
  "active",
  "past_due",
  "grace_period",
  "suspended",
  "canceled",
  "retention",
  "deleted",
]);
export const priceBookMode = pgEnum("price_book_mode", ["fixed", "fx_derived", "disabled"]);
export const checkoutState = pgEnum("checkout_state", ["created", "redirected", "completed", "expired"]);
export const webhookStatus = pgEnum("webhook_status", ["received", "verified", "applied", "rejected"]);
export const itemKind = pgEnum("subscription_item_kind", ["base", "addon"]);
export const invoiceStatus = pgEnum("invoice_status", ["open", "paid", "failed", "void"]);

export const entitlementDefinitions = pgTable("entitlement_definitions", {
  key: text("key").primaryKey(),
  valueType: text("value_type").notNull(),
  description: text("description").notNull().default(""),
  defaultValue: jsonb("default_value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const products = pgTable(
  "products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    tier: planTier("tier").notNull(),
    displayName: text("display_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("products_code_key").on(t.code)],
);

/** Immutable once activated; changes ship as a new version. */
export const planVersions = pgTable(
  "plan_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    status: planVersionStatus("status").notNull().default("draft"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("plan_versions_product_version_key").on(t.productId, t.version)],
);

/** Per-plan-version entitlement values; this is durable billing catalog state. */
export const planEntitlementValues = pgTable(
  "plan_entitlement_values",
  {
    planVersionId: uuid("plan_version_id")
      .notNull()
      .references(() => planVersions.id, { onDelete: "cascade" }),
    key: text("key")
      .notNull()
      .references(() => entitlementDefinitions.key, { onDelete: "restrict" }),
    value: jsonb("value").notNull(),
  },
  (t) => [uniqueIndex("plan_entitlement_values_key").on(t.planVersionId, t.key)],
);

export const currencies = pgTable("currencies", {
  code: text("code").primaryKey(),
  exponent: integer("exponent").notNull(),
  displayName: text("display_name").notNull(),
});

export const pricingRegions = pgTable("pricing_regions", {
  code: text("code").primaryKey(),
  displayName: text("display_name").notNull(),
  chargeCurrency: text("charge_currency")
    .notNull()
    .references(() => currencies.code),
  displayCurrency: text("display_currency")
    .notNull()
    .references(() => currencies.code),
});

export const priceBooks = pgTable(
  "price_books",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    pricingRegion: text("pricing_region")
      .notNull()
      .references(() => pricingRegions.code),
    mode: priceBookMode("mode").notNull().default("fixed"),
    baseCurrency: text("base_currency").references(() => currencies.code),
    /** Required with baseCurrency/fxRate when mode is fx_derived. */
    baseAmountMinor: bigint("base_amount_minor", { mode: "bigint" }),
    fxRate: jsonb("fx_rate"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("price_books_product_region_key").on(t.productId, t.pricingRegion)],
);

export const priceVersions = pgTable(
  "price_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    priceBookId: uuid("price_book_id")
      .notNull()
      .references(() => priceBooks.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    currency: text("currency")
      .notNull()
      .references(() => currencies.code),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("price_versions_book_version_key").on(t.priceBookId, t.version)],
);

export const addonDefinitions = pgTable("addon_definitions", {
  code: text("code").primaryKey(),
  displayName: text("display_name").notNull(),
  consumable: boolean("consumable").notNull().default(false),
  unit: text("unit").notNull().default("count"),
});

/**
 * Provider customer ids are nullable until a real gateway returns one. Mox
 * never fabricates provider identifiers just to satisfy a local schema.
 */
export const billingCustomers = pgTable(
  "billing_customers",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    providerName: text("provider_name").notNull(),
    providerCustomerId: text("provider_customer_id"),
    billingRegion: text("billing_region").notNull().default("GLOBAL"),
    defaultDisplayCurrency: text("default_display_currency").references(() => currencies.code),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("billing_customers_org_provider_key").on(t.orgId, t.providerName)],
);

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    planVersionId: uuid("plan_version_id")
      .notNull()
      .references(() => planVersions.id, { onDelete: "restrict" }),
    priceVersionId: uuid("price_version_id")
      .notNull()
      .references(() => priceVersions.id, { onDelete: "restrict" }),
    state: subscriptionState("state").notNull().default("trial"),
    /** Explicit gateway identity; never inferred by parsing a provider ref. */
    providerName: text("provider_name"),
    providerRef: text("provider_ref"),
    currentPeriodStart: timestamp("current_period_start", { withTimezone: true }),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
    graceEndsAt: timestamp("grace_ends_at", { withTimezone: true }),
    retentionUntil: timestamp("retention_until", { withTimezone: true }),
    failedRenewals: integer("failed_renewals").notNull().default(0),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    canceledAt: timestamp("canceled_at", { withTimezone: true }),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    /** Cross-process renewal worker lease. */
    renewalLeaseUntil: timestamp("renewal_lease_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("subscriptions_org_live_key")
      .on(t.orgId)
      .where(sql`${t.state} in ('trial','active','past_due','grace_period','suspended')`),
    uniqueIndex("subscriptions_provider_ref_key")
      .on(t.providerName, t.providerRef)
      .where(sql`${t.providerName} is not null and ${t.providerRef} is not null`),
    index("subscriptions_state_idx").on(t.state),
    index("subscriptions_renewal_lease_idx").on(t.state, t.renewalLeaseUntil),
  ],
);

export const subscriptionItems = pgTable(
  "subscription_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => subscriptions.id, { onDelete: "cascade" }),
    kind: itemKind("kind").notNull().default("base"),
    addonCode: text("addon_code").references(() => addonDefinitions.code),
    quantity: integer("quantity").notNull().default(1),
    priceVersionId: uuid("price_version_id").references(() => priceVersions.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("subscription_items_sub_idx").on(t.subscriptionId)],
);

/** One-time checkout; redirect alone never grants paid state. */
export const checkoutSessions = pgTable(
  "checkout_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    planVersionId: uuid("plan_version_id")
      .notNull()
      .references(() => planVersions.id, { onDelete: "restrict" }),
    priceVersionId: uuid("price_version_id")
      .notNull()
      .references(() => priceVersions.id, { onDelete: "restrict" }),
    state: checkoutState("state").notNull().default("created"),
    providerName: text("provider_name").notNull(),
    providerRef: text("provider_ref"),
    redirectUrl: text("redirect_url"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** Cross-process webhook application lease. */
    applyLeaseUntil: timestamp("apply_lease_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("checkout_sessions_org_idx").on(t.orgId, t.state),
    uniqueIndex("checkout_sessions_provider_ref_key")
      .on(t.providerName, t.providerRef)
      .where(sql`${t.providerRef} is not null`),
    index("checkout_sessions_apply_lease_idx").on(t.state, t.applyLeaseUntil),
  ],
);

export const invoices = pgTable(
  "invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => subscriptions.id, { onDelete: "cascade" }),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    currency: text("currency")
      .notNull()
      .references(() => currencies.code),
    status: invoiceStatus("status").notNull().default("open"),
    providerInvoiceRef: text("provider_invoice_ref"),
    attempt: integer("attempt").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    paidAt: timestamp("paid_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("invoices_sub_period_attempt_key").on(t.subscriptionId, t.periodStart, t.attempt)],
);

export const verifiedWebhookEvents = pgTable(
  "verified_webhook_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerName: text("provider_name").notNull(),
    externalEventId: text("external_event_id").notNull(),
    type: text("type").notNull(),
    sequence: integer("sequence"),
    payloadDigest: text("payload_digest").notNull(),
    status: webhookStatus("status").notNull().default("received"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    rejectionReason: text("rejection_reason"),
  },
  (t) => [uniqueIndex("verified_webhook_events_provider_external_key").on(t.providerName, t.externalEventId)],
);

export const subscriptionTransitions = pgTable(
  "subscription_transitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => subscriptions.id, { onDelete: "cascade" }),
    fromState: subscriptionState("from_state"),
    toState: subscriptionState("to_state").notNull(),
    reason: text("reason").notNull(),
    actorType: text("actor_type").notNull().default("system"),
    actorId: text("actor_id"),
    idempotencyKey: text("idempotency_key"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("subscription_transitions_idem_key").on(t.subscriptionId, t.idempotencyKey)],
);

export const entitlementOverrides = pgTable(
  "entitlement_overrides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: jsonb("value").notNull(),
    grantedBy: text("granted_by").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("entitlement_overrides_org_key").on(t.orgId, t.key)],
);

export const customContracts = pgTable(
  "custom_contracts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    contractRef: text("contract_ref").notNull(),
    values: jsonb("values").notNull(),
    active: boolean("active").notNull().default(true),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
    effectiveUntil: timestamp("effective_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("custom_contracts_ref_key").on(t.contractRef)],
);
