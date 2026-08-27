import {
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
 * Models domain: providers, models, connections and credential references.
 * Adapted from OpenBot credential kinds (model/connector/agent/mcp) with
 * org scoping; secret material lives only in @mox/credentials storage.
 *
 * Authority separation: customer-owned credential state is organization
 * scoped, while Mox-owned platform credential/state tables deliberately carry
 * NO organization id so customer code cannot address platform secrets.
 */

export const providerKind = pgEnum("provider_kind", ["api", "cli-proxy", "local"]);

export const providerAuthMethod = pgEnum("provider_auth_method", ["api_key", "oauth", "device_login", "none"]);

export const modelProviders = pgTable(
  "model_providers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    displayName: text("display_name").notNull(),
    kind: providerKind("kind").notNull().default("api"),
    capabilities: jsonb("capabilities").notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("model_providers_org_slug_key").on(t.orgId, t.slug)],
);

export const models = pgTable(
  "models",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => modelProviders.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    displayName: text("display_name").notNull(),
    contextWindow: integer("context_window"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("models_provider_slug_key").on(t.providerId, t.slug)],
);

/** Pointer to @mox/credentials storage; holds no secret material itself. */
export const credentialRefs = pgTable(
  "credential_refs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(),
    externalId: text("external_id").notNull(),
    label: text("label"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("credential_refs_org_external_key").on(t.orgId, t.externalId)],
);

/** Encrypted customer secret payloads. A distinct master key is used by @mox/credentials. */
export const customerCredentialSecrets = pgTable(
  "customer_credential_secrets",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    sealed: text("sealed").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("customer_credential_secrets_key").on(t.orgId, t.externalId)],
);

/** A connection binds a provider to a credential reference (never the secret). */
export const modelConnections = pgTable(
  "model_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => modelProviders.id, { onDelete: "cascade" }),
    credentialRefId: uuid("credential_ref_id").references(() => credentialRefs.id, { onDelete: "set null" }),
    authMethod: providerAuthMethod("auth_method").notNull().default("api_key"),
    connectionStatus: text("connection_status").notNull().default("configured"),
    baseUrl: text("base_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("model_connections_org_idx").on(t.orgId, t.providerId)],
);

/**
 * Mox-owned credential metadata. No organization id exists in this table, so
 * customer-scoped services cannot accidentally construct an address into it.
 */
export const systemCredentialRefs = pgTable(
  "system_credential_refs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scope: text("scope").notNull(),
    externalId: text("external_id").notNull(),
    label: text("label"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("system_credential_refs_external_key").on(t.externalId)],
);

/** Encrypted Mox-owned secret payloads, isolated from all customer rows. */
export const systemCredentialSecrets = pgTable(
  "system_credential_secrets",
  {
    externalId: text("external_id").primaryKey(),
    sealed: text("sealed").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

/** Provider catalog for Mox-managed intelligence/platform functionality. */
export const systemModelProviders = pgTable(
  "system_model_providers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull(),
    displayName: text("display_name").notNull(),
    kind: providerKind("kind").notNull().default("api"),
    capabilities: jsonb("capabilities").notNull().default([]),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("system_model_providers_slug_key").on(t.slug)],
);

export const systemModels = pgTable(
  "system_models",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => systemModelProviders.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    displayName: text("display_name").notNull(),
    contextWindow: integer("context_window"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("system_models_provider_slug_key").on(t.providerId, t.slug)],
);

export const systemModelConnections = pgTable(
  "system_model_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => systemModelProviders.id, { onDelete: "cascade" }),
    credentialRefId: uuid("credential_ref_id").references(() => systemCredentialRefs.id, { onDelete: "set null" }),
    authMethod: providerAuthMethod("auth_method").notNull().default("api_key"),
    connectionStatus: text("connection_status").notNull().default("configured"),
    baseUrl: text("base_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("system_model_connections_provider_key").on(t.providerId)],
);

export const modelUsageRefs = pgTable(
  "model_usage_refs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    runId: uuid("run_id"),
    modelId: uuid("model_id")
      .notNull()
      .references(() => models.id, { onDelete: "cascade" }),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("model_usage_refs_org_idx").on(t.orgId, t.at)],
);