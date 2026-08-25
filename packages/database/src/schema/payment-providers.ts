import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations } from "./identity-users.js";
import { priceVersions, products, subscriptions } from "./billing.js";

/**
 * Payment-provider integration domain (Prompt 01): durable, admin-
 * configurable provider configuration, data-driven plan/price mappings and
 * the normalized provider-payment ledger. Provider identifiers are business
 * truth — never process memory. Secrets live only as vault/env REFS here.
 */

export const billingProviderConfigs = pgTable(
  "billing_provider_configs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerName: text("provider_name").notNull(),
    environment: text("environment").notNull().default("test"),
    enabled: boolean("enabled").notNull().default(false),
    displayName: text("display_name").notNull(),
    /** Safe, customer-visible metadata (methods, regions). No secrets. */
    publicConfig: jsonb("public_config").notNull().default({}),
    /** Vault/env REFERENCE for the API secret — never the secret itself. */
    secretRef: text("secret_ref"),
    /** Vault/env REFERENCE for the webhook signing secret. */
    webhookSecretRef: text("webhook_secret_ref"),
    supportedCurrencies: jsonb("supported_currencies").notNull().default([]),
    supportedRegions: jsonb("supported_regions").notNull().default([]),
    priority: integer("priority").notNull().default(100),
    maintenanceMode: boolean("maintenance_mode").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("billing_provider_configs_name_key").on(t.providerName)],
);

/** Data-driven mapping from a Mox price version to a provider plan/price id. */
export const providerPlanMappings = pgTable(
  "provider_plan_mappings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerName: text("provider_name").notNull(),
    environment: text("environment").notNull().default("test"),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    moxPriceVersionId: uuid("mox_price_version_id")
      .notNull()
      .references(() => priceVersions.id, { onDelete: "cascade" }),
    /** Paystack plan code / Stripe price id / PayPal plan id etc. */
    providerPlanRef: text("provider_plan_ref").notNull(),
    currency: text("currency").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("provider_plan_mappings_key").on(
      t.providerName,
      t.environment,
      t.moxPriceVersionId,
    ),
  ],
);

export const providerCustomers = pgTable(
  "provider_customers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerName: text("provider_name").notNull(),
    environment: text("environment").notNull().default("test"),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    providerCustomerId: text("provider_customer_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("provider_customers_key").on(t.providerName, t.environment, t.orgId),
  ],
);

/**
 * Normalized provider payment/event ledger: every verified provider event
 * lands here exactly once with its money in integer minor units and safe
 * metadata only (digests, refs) — never secrets or full raw payloads.
 */
export const providerPayments = pgTable(
  "provider_payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerName: text("provider_name").notNull(),
    environment: text("environment").notNull().default("test"),
    externalEventId: text("external_event_id").notNull(),
    eventType: text("event_type").notNull(),
    orgId: uuid("org_id").references(() => organizations.id, { onDelete: "set null" }),
    providerSubscriptionRef: text("provider_subscription_ref"),
    checkoutSessionRef: text("checkout_session_ref"),
    providerTransactionRef: text("provider_transaction_ref"),
    invoiceRef: text("invoice_ref"),
    providerPaymentIntentRef: text("provider_payment_intent_ref"),
    providerChargeRef: text("provider_charge_ref"),
    providerCustomerRef: text("provider_customer_ref"),
    /** Provider invoice/sale identity used for business-effect idempotency. */
    billingIdentity: text("billing_identity"),
    state: text("state").notNull(),
    currency: text("currency"),
    amountMinor: bigint("amount_minor", { mode: "bigint" }),
    payloadDigest: text("payload_digest").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("provider_payments_event_key").on(t.providerName, t.externalEventId),
    index("provider_payments_org_idx").on(t.orgId, t.receivedAt),
    index("provider_payments_sub_idx").on(t.providerSubscriptionRef),
  ],
);

/**
 * Durable typed provider-object mappings (Security Repair 05A §A). Refunds
 * and disputes commonly reference a charge (ch_), payment intent (pi_) or
 * invoice (in_) while subscriptions store sub_/checkout refs. Each typed ref
 * has its own column and partial unique index, so resolution never guesses
 * from ID prefixes. Rows merge additional refs as events arrive; conflicts
 * that cannot be merged become resolution_state = 'reconciliation_required'.
 */
export const providerObjectMappings = pgTable(
  "provider_object_mappings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerName: text("provider_name").notNull(),
    environment: text("environment").notNull().default("test"),
    orgId: uuid("org_id").references(() => organizations.id, { onDelete: "set null" }),
    subscriptionId: uuid("subscription_id").references(() => subscriptions.id, { onDelete: "set null" }),
    providerCustomerRef: text("provider_customer_ref"),
    checkoutSessionRef: text("checkout_session_ref"),
    providerSubscriptionRef: text("provider_subscription_ref"),
    providerInvoiceRef: text("provider_invoice_ref"),
    providerPaymentRef: text("provider_payment_ref"),
    providerPaymentIntentRef: text("provider_payment_intent_ref"),
    providerChargeRef: text("provider_charge_ref"),
    resolutionState: text("resolution_state").notNull().default("resolved"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("provider_object_mappings_checkout_key")
      .on(t.providerName, t.environment, t.checkoutSessionRef)
      .where(sql`${t.checkoutSessionRef} IS NOT NULL`),
    uniqueIndex("provider_object_mappings_subscription_key")
      .on(t.providerName, t.environment, t.providerSubscriptionRef)
      .where(sql`${t.providerSubscriptionRef} IS NOT NULL`),
    uniqueIndex("provider_object_mappings_invoice_key")
      .on(t.providerName, t.environment, t.providerInvoiceRef)
      .where(sql`${t.providerInvoiceRef} IS NOT NULL`),
    uniqueIndex("provider_object_mappings_payment_key")
      .on(t.providerName, t.environment, t.providerPaymentRef)
      .where(sql`${t.providerPaymentRef} IS NOT NULL`),
    uniqueIndex("provider_object_mappings_pi_key")
      .on(t.providerName, t.environment, t.providerPaymentIntentRef)
      .where(sql`${t.providerPaymentIntentRef} IS NOT NULL`),
    uniqueIndex("provider_object_mappings_charge_key")
      .on(t.providerName, t.environment, t.providerChargeRef)
      .where(sql`${t.providerChargeRef} IS NOT NULL`),
    index("provider_object_mappings_sub_idx").on(t.subscriptionId),
  ],
);

/**
 * Durable business-effect idempotency (Security Repair 05A §B), distinct
 * from webhook-event dedupe: many webhook event ids may refer to the SAME
 * provider invoice/sale, but exactly one local period-extension (or other
 * financial effect) may ever be applied. Identity = provider invoice ref /
 * sale id / charge id per provider; never the external event id alone.
 */
export const providerBillingEffects = pgTable(
  "provider_billing_effects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerName: text("provider_name").notNull(),
    environment: text("environment").notNull().default("test"),
    billingIdentity: text("billing_identity").notNull(),
    effectType: text("effect_type").notNull(),
    subscriptionId: uuid("subscription_id").references(() => subscriptions.id, { onDelete: "set null" }),
    outcome: text("outcome").notNull().default("applied"),
    externalEventId: text("external_event_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("provider_billing_effects_identity_key").on(
      t.providerName,
      t.environment,
      t.billingIdentity,
      t.effectType,
    ),
    index("provider_billing_effects_sub_idx").on(t.subscriptionId, t.createdAt),
  ],
);

// Prompt 01 §Durable-mapping columns on existing billing rows.
export const subscriptionsProviderColumns = sql`
  ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS provider_environment text;
  ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS last_event_at timestamptz;
  ALTER TABLE checkout_sessions ADD COLUMN IF NOT EXISTS environment text;
`;
