import { 
  index, 
  jsonb, 
  pgTable, 
  text, 
  timestamp, 
  uniqueIndex, 
  uuid, 
} from "drizzle-orm/pg-core"; 
import { agents } from "./agents-core.js";
import { organizations } from "./identity-users.js";
 
/** 
 * Integrations domain: external tool providers (MCP etc.), connections, 
 * tool grants. Adapted from OpenBot mcp/connector credential kinds with 
 * org scoping; secrets live only in @mox/credentials storage. 
 */ 
 
export const integrationProviders = pgTable( 
  "integration_providers", 
  { 
    id: uuid("id").primaryKey().defaultRandom(), 
    orgId: uuid("org_id") 
      .notNull() 
      .references(() => organizations.id, { onDelete: "cascade" }), 
    slug: text("slug").notNull(), 
    displayName: text("display_name").notNull(), 
    kind: text("kind").notNull(), 
    config: jsonb("config").notNull(), 
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), 
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(), 
  }, 
  (t) => [uniqueIndex("integration_providers_org_slug_key").on(t.orgId, t.slug)], 
); 
 
export const integrationConnections = pgTable( 
  "integration_connections", 
  { 
    id: uuid("id").primaryKey().defaultRandom(), 
    orgId: uuid("org_id") 
      .notNull() 
      .references(() => organizations.id, { onDelete: "cascade" }), 
    providerId: uuid("provider_id") 
      .notNull() 
      .references(() => integrationProviders.id, { onDelete: "cascade" }), 
    credentialRefId: uuid("credential_ref_id"), 
    status: text("status").notNull().default("active"), 
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), 
  }, 
  (t) => [index("integration_connections_org_idx").on(t.orgId, t.providerId)], 
); 
 
/** Per-agent tool grant; the authority for what an agent may call. */ 
export const toolGrants = pgTable( 
  "tool_grants", 
  { 
    id: uuid("id").primaryKey().defaultRandom(), 
    orgId: uuid("org_id") 
      .notNull() 
      .references(() => organizations.id, { onDelete: "cascade" }), 
    agentId: uuid("agent_id") 
      .notNull() 
      .references(() => agents.id, { onDelete: "cascade" }), 
    connectionId: uuid("connection_id") 
      .notNull() 
      .references(() => integrationConnections.id, { onDelete: "cascade" }), 
    toolPattern: text("tool_pattern").notNull().default("*"), 
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), 
  }, 
  (t) => [uniqueIndex("tool_grants_key").on(t.agentId, t.connectionId, t.toolPattern)], 
); 
