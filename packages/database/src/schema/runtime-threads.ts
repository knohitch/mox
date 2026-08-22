import { 
  index, 
  jsonb, 
  pgEnum, 
  pgTable, 
  text, 
  timestamp, 
  uuid, 
} from "drizzle-orm/pg-core"; 
import { agents } from "./agents-core.js";
import { organizations } from "./identity-users.js";
 
/** 
 * Runtime domain, part 1: threads and session event metadata. The event 
 * stream itself lives in the runtime kernel; these rows are durable 
 * metadata for sessions, queries and audit joins. 
 */ 
 
export const threadStatus = pgEnum("thread_status", ["active", "archived"]); 
 
export const threads = pgTable( 
  "threads", 
  { 
    id: uuid("id").primaryKey().defaultRandom(), 
    orgId: uuid("org_id") 
      .notNull() 
      .references(() => organizations.id, { onDelete: "cascade" }), 
    agentId: uuid("agent_id") 
      .notNull() 
      .references(() => agents.id, { onDelete: "cascade" }), 
    title: text("title"), 
    status: threadStatus("status").notNull().default("active"), 
    createdByUserId: uuid("created_by_user_id"), 
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), 
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(), 
  }, 
  (t) => [index("threads_org_agent_idx").on(t.orgId, t.agentId)], 
); 
 
export const sessionEventMeta = pgTable( 
  "session_event_meta", 
  { 
    eventId: text("event_id").primaryKey(), 
    orgId: uuid("org_id") 
      .notNull() 
      .references(() => organizations.id, { onDelete: "cascade" }), 
    threadId: uuid("thread_id") 
      .notNull() 
      .references(() => threads.id, { onDelete: "cascade" }), 
    kind: text("kind").notNull(), 
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(), 
    meta: jsonb("meta"), 
  }, 
  (t) => [index("session_event_meta_thread_idx").on(t.threadId, t.at)], 
); 
