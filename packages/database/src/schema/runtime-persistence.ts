import {
  bigserial,
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
import { agentRooms } from "./agents-deploy.js";
import { organizations } from "./identity-users.js";
import { threads } from "./runtime-threads.js";

/**
 * Runtime domain, part 3 (Prompt 06): durable conversation and event
 * ownership. Mox PostgreSQL is the SOURCE OF TRUTH for threads, messages and
 * the append-oriented session-event stream; the runtime kernel holds only
 * ephemeral state and rebuilds from here.
 *
 * `session_events.seq` (bigserial) gives a total order per insert; replay is
 * ordered by seq within (org, subjectKind, subjectId). eventId is the
 * idempotency key — retries after reconnect can never duplicate.
 */

export const subjectKind = pgEnum("event_subject_kind", ["thread", "room"]);
export const authorKind = pgEnum("message_author_kind", ["user", "agent", "system"]);

export const sessionEvents = pgTable(
  "session_events",
  {
    seq: bigserial("seq", { mode: "number" }).notNull(),
    eventId: text("event_id").primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    subjectKind: subjectKind("subject_kind").notNull(),
    /** threads.id or agent_rooms.id depending on subjectKind. */
    subjectId: uuid("subject_id").notNull(),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    runId: text("run_id"),
    turnId: text("turn_id"),
    correlationId: text("correlation_id").notNull(),
    causationId: text("causation_id"),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("session_events_subject_idx").on(t.orgId, t.subjectKind, t.subjectId, t.seq),
    index("session_events_correlation_idx").on(t.correlationId),
  ],
);

export const threadMessages = pgTable(
  "thread_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    authorKind: authorKind("author_kind").notNull(),
    authorId: text("author_id").notNull(),
    text: text("text").notNull(),
    replyToMessageId: uuid("reply_to_message_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("thread_messages_thread_idx").on(t.threadId, t.createdAt)],
);

export const threadParticipants = pgTable(
  "thread_participants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    principalKind: authorKind("principal_kind").notNull(),
    principalId: text("principal_id").notNull(),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("thread_participants_unique").on(t.threadId, t.principalKind, t.principalId)],
);

/** Room shared threads: rooms converse through the same event machinery. */
export const roomThreads = pgTable(
  "room_threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    roomId: uuid("room_id")
      .notNull()
      .references(() => agentRooms.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("room_threads_unique").on(t.roomId, t.threadId)],
);

export const attachmentsMeta = pgTable(
  "attachments_meta",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id").references(() => threads.id, { onDelete: "set null" }),
    messageId: uuid("message_id").references(() => threadMessages.id, { onDelete: "set null" }),
    filename: text("filename").notNull(),
    mime: text("mime").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    storageKey: text("storage_key").notNull(),
    checksum: text("checksum"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("attachments_meta_thread_idx").on(t.orgId, t.threadId)],
);

export const runtimeCheckpoints = pgTable(
  "runtime_checkpoints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    runId: text("run_id").notNull(),
    resumeToken: text("resume_token").notNull(),
    snapshot: jsonb("snapshot"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("runtime_checkpoints_run_latest").on(t.orgId, t.runId, t.createdAt)],
);
