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
import { agents } from "./agents-core.js";
import { organizations } from "./identity-users.js";

/**
 * Memory ownership (Prompt 06): conversational history (session_events /
 * thread_messages) is separate from long-term memory, which is written
 * EXPLICITLY through the memory service policy — messages are never dumped
 * here wholesale. Vector/semantic indexes are referenced by pointer so the
 * store stays portable (pgvector arrives with the knowledge prompt).
 */

export const memoryScope = pgEnum("memory_scope", ["thread", "room", "agent", "org"]);
export const memoryKind = pgEnum("memory_kind", ["fact", "preference", "summary", "knowledge_ref"]);

export const longTermMemories = pgTable(
  "long_term_memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" }),
    scope: memoryScope("scope").notNull(),
    /** threads.id | agent_rooms.id | agents.id | organizations.id per scope. */
    subjectId: text("subject_id").notNull(),
    kind: memoryKind("kind").notNull(),
    content: text("content").notNull(),
    salience: integer("salience").notNull().default(1),
    sourceEventId: text("source_event_id"),
    vectorRef: text("vector_ref"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("long_term_memories_scope_idx").on(t.orgId, t.scope, t.subjectId),
    uniqueIndex("long_term_memories_dedupe").on(t.orgId, t.scope, t.subjectId, t.kind, t.content),
  ],
);
