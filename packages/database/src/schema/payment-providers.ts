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
import { priceVersions, products } from "./billing.js";

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

// Prompt 01 §Durable-mapping columns on existing billing rows.
export const subscriptionsProviderColumns = sql`
  ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS provider_environment text;
  ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS last_event_at timestamptz;
  ALTER TABLE checkout_sessions ADD COLUMN IF NOT EXISTS environment text;
`;
