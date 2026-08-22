import { 
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
 */ 
 
export const providerKind = pgEnum("provider_kind", ["api", "cli-proxy", "local"]); 
 
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
    credentialRefId: uuid("credential_ref_id"), 
    baseUrl: text("base_url"), 
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), 
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(), 
  }, 
  (t) => [index("model_connections_org_idx").on(t.orgId, t.providerId)], 
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
