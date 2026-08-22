import { 
  index, 
  pgTable, 
  text, 
  timestamp, 
  uniqueIndex, 
  uuid, 
} from "drizzle-orm/pg-core"; 
import { agents } from "./agents-core.js";
import { organizations } from "./identity-users.js";
 
/** 
 * Channels domain: external messaging channels (telegram, discord, 
 * whatsapp), external conversations and messages. Adapted from OpenBot 
 * channel adapters with org scoping. 
 */ 
 
export const channelProviders = pgTable( 
  "channel_providers", 
  { 
    id: uuid("id").primaryKey().defaultRandom(), 
    orgId: uuid("org_id") 
      .notNull() 
      .references(() => organizations.id, { onDelete: "cascade" }), 
    slug: text("slug").notNull(), 
    displayName: text("display_name").notNull(), 
    kind: text("kind").notNull(), 
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), 
  }, 
  (t) => [uniqueIndex("channel_providers_org_slug_key").on(t.orgId, t.slug)], 
); 
 
export const channelConnections = pgTable( 
  "channel_connections", 
  { 
    id: uuid("id").primaryKey().defaultRandom(), 
    orgId: uuid("org_id") 
      .notNull() 
      .references(() => organizations.id, { onDelete: "cascade" }), 
    providerId: uuid("provider_id") 
      .notNull() 
      .references(() => channelProviders.id, { onDelete: "cascade" }), 
    agentId: uuid("agent_id") 
      .notNull() 
      .references(() => agents.id, { onDelete: "cascade" }), 
    credentialRefId: uuid("credential_ref_id"), 
    status: text("status").notNull().default("active"), 
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), 
  }, 
  (t) => [index("channel_connections_org_idx").on(t.orgId, t.providerId)], 
); 
 
export const externalConversations = pgTable( 
  "external_conversations", 
  { 
    id: uuid("id").primaryKey().defaultRandom(), 
    orgId: uuid("org_id") 
      .notNull() 
      .references(() => organizations.id, { onDelete: "cascade" }), 
    connectionId: uuid("connection_id") 
      .notNull() 
      .references(() => channelConnections.id, { onDelete: "cascade" }), 
    externalId: text("external_id").notNull(), 
    threadId: uuid("thread_id"), 
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), 
  }, 
  (t) => [uniqueIndex("external_conversations_key").on(t.connectionId, t.externalId)], 
); 
 
export const channelMessages = pgTable( 
  "channel_messages", 
  { 
    id: uuid("id").primaryKey().defaultRandom(), 
    orgId: uuid("org_id") 
      .notNull() 
      .references(() => organizations.id, { onDelete: "cascade" }), 
    conversationId: uuid("conversation_id") 
      .notNull() 
      .references(() => externalConversations.id, { onDelete: "cascade" }), 
    direction: text("direction").notNull(), 
    body: text("body").notNull(), 
    externalMessageId: text("external_message_id"), 
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(), 
  }, 
  (t) => [index("channel_messages_conversation_idx").on(t.conversationId, t.at)], 
); 
