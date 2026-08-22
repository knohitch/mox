import { and, asc, eq } from "drizzle-orm";
import type { SessionEvent } from "@mox/contracts";
import type { MoxDb } from "./client.js";
import { longTermMemories, sessionEvents, threadMessages, threads } from "./schema/index.js";
import { requireTenant, type TenantContext } from "./tenant.js";
import type {
  EventAppendResult,
  MemoryItem,
  MemoryStore,
  MessageRecord,
  MessageStore,
  SessionEventStore,
  SubjectKind,
  ThreadRecord,
  ThreadStore,
} from "./stores.js";

/**
 * PostgreSQL implementations (Prompt 06): thin, tenant-scoped translations
 * of the store interfaces onto the durable schema. `session_events.event_id`
 * is the primary key — ON CONFLICT DO NOTHING makes appends idempotent across
 * retries/reconnects; `seq` (bigserial) provides replay order.
 */

export class PgSessionEventStore implements SessionEventStore {
  constructor(private readonly db: MoxDb) {}

  async append(
    ctx: TenantContext,
    subject: { kind: SubjectKind; id: string },
    event: SessionEvent,
  ): Promise<EventAppendResult> {
    const tenant = requireTenant(ctx);
    if (!tenant.system && event.orgId !== tenant.orgId) {
      throw new Error("event org does not match tenant context");
    }
    // subject ids are UUIDs in the hosted schema; the demo/in-memory stores
    // accept opaque ids for tests.
    const inserted = await this.db
      .insert(sessionEvents)
      .values({
        eventId: event.eventId,
        orgId: tenant.orgId,
        subjectKind: subject.kind,
        subjectId: asUuid(subject.id),
        agentId: null,
        runId: event.runId ?? null,
        turnId: event.turnId ?? null,
        correlationId: event.correlationId,
        causationId: event.causationId ?? null,
        type: event.type,
        payload: event as unknown as object,
        at: new Date(event.at),
      })
      .onConflictDoNothing({ target: sessionEvents.eventId })
      .returning({ seq: sessionEvents.seq });
    const row = inserted[0];
    if (!row) {
      const [existing] = await this.db
        .select({ seq: sessionEvents.seq })
        .from(sessionEvents)
        .where(eq(sessionEvents.eventId, event.eventId))
        .limit(1);
      return { seq: existing?.seq ?? -1, duplicate: true };
    }
    return { seq: row.seq, duplicate: false };
  }

  async replay(
    ctx: TenantContext,
    subject: { kind: SubjectKind; id: string },
  ): Promise<Array<{ seq: number; event: SessionEvent }>> {
    const tenant = requireTenant(ctx);
    const rows = await this.db
      .select()
      .from(sessionEvents)
      .where(
        and(
          eq(sessionEvents.orgId, tenant.orgId),
          eq(sessionEvents.subjectKind, subject.kind),
          eq(sessionEvents.subjectId, asUuid(subject.id)),
        ),
      )
      .orderBy(asc(sessionEvents.seq));
    return rows.map((r) => ({ seq: r.seq, event: r.payload as unknown as SessionEvent }));
  }

  async replayCorrelation(ctx: TenantContext, correlationId: string): Promise<SessionEvent[]> {
    const tenant = requireTenant(ctx);
    const rows = await this.db
      .select()
      .from(sessionEvents)
      .where(and(eq(sessionEvents.orgId, tenant.orgId), eq(sessionEvents.correlationId, correlationId)))
      .orderBy(asc(sessionEvents.seq));
    return rows.map((r) => r.payload as unknown as SessionEvent);
  }
}

export class PgThreadStore implements ThreadStore {
  constructor(private readonly db: MoxDb) {}

  async create(
    ctx: TenantContext,
    input: { threadId?: string; agentId?: string; roomId?: string; title?: string },
  ): Promise<ThreadRecord> {
    const tenant = requireTenant(ctx);
    // Hosted thread ids are server-assigned UUIDs; `input.threadId` is
    // accepted for seam compatibility and ignored here.
    void input.threadId;
    if (!input.agentId) throw new Error("hosted threads require an owning agent");
    const inserted = await this.db
      .insert(threads)
      .values({
        orgId: tenant.orgId,
        agentId: asUuid(input.agentId),
        title: input.title,
      })
      .returning();
    const row = inserted[0];
    if (!row) throw new Error("insert thread returned no row");
    return {
      threadId: row.id,
      orgId: row.orgId,
      agentId: row.agentId,
      roomId: null,
      title: row.title ?? undefined,
      status: row.status,
    };
  }

  async get(ctx: TenantContext, threadId: string): Promise<ThreadRecord | undefined> {
    const tenant = requireTenant(ctx);
    const rows = await this.db.select().from(threads).where(eq(threads.id, asUuid(threadId))).limit(1);
    const row = rows[0];
    if (!row || row.orgId !== tenant.orgId) return undefined;
    return {
      threadId: row.id,
      orgId: row.orgId,
      agentId: row.agentId,
      roomId: null,
      title: row.title ?? undefined,
      status: row.status,
    };
  }

  async listForAgent(ctx: TenantContext, agentId: string): Promise<ThreadRecord[]> {
    const tenant = requireTenant(ctx);
    const rows = await this.db
      .select()
      .from(threads)
      .where(and(eq(threads.orgId, tenant.orgId), eq(threads.agentId, asUuid(agentId))));
    return rows.map((row) => ({
      threadId: row.id,
      orgId: row.orgId,
      agentId: row.agentId,
      roomId: null,
      title: row.title ?? undefined,
      status: row.status,
    }));
  }
}

export class PgMessageStore implements MessageStore {
  constructor(private readonly db: MoxDb) {}

  async append(
    ctx: TenantContext,
    input: Omit<MessageRecord, "createdAt"> & { createdAt?: string },
  ): Promise<MessageRecord> {
    const tenant = requireTenant(ctx);
    const inserted = await this.db
      .insert(threadMessages)
      .values({
        orgId: tenant.orgId,
        threadId: asUuid(input.threadId),
        authorKind: input.authorKind,
        authorId: input.authorId,
        text: input.text,
        createdAt: input.createdAt ? new Date(input.createdAt) : undefined,
      })
      .returning();
    const row = inserted[0];
    if (!row) throw new Error("insert message returned no row");
    return toMessageRecord(row);
  }

  async list(ctx: TenantContext, threadId: string): Promise<MessageRecord[]> {
    const tenant = requireTenant(ctx);
    const rows = await this.db
      .select()
      .from(threadMessages)
      .where(and(eq(threadMessages.orgId, tenant.orgId), eq(threadMessages.threadId, asUuid(threadId))))
      .orderBy(asc(threadMessages.createdAt));
    return rows.map(toMessageRecord);
  }
}

function toMessageRecord(row: typeof threadMessages.$inferSelect): MessageRecord {
  return {
    messageId: row.id,
    threadId: row.threadId,
    authorKind: row.authorKind,
    authorId: row.authorId,
    text: row.text,
    createdAt: row.createdAt.toISOString(),
  };
}

export class PgMemoryStore implements MemoryStore {
  constructor(private readonly db: MoxDb) {}

  async remember(
    ctx: TenantContext,
    input: Omit<MemoryItem, "id" | "orgId" | "createdAt">,
  ): Promise<MemoryItem> {
    const tenant = requireTenant(ctx);
    const inserted = await this.db
      .insert(longTermMemories)
      .values({
        orgId: tenant.orgId,
        agentId: null,
        scope: input.scope,
        subjectId: input.subjectId,
        kind: input.kind,
        content: input.content,
        salience: input.salience,
        vectorRef: input.vectorRef ?? null,
      })
      .onConflictDoNothing()
      .returning();
    const row = inserted[0];
    if (!row) {
      // Dedupe hit: return the canonical existing item.
      const existing = await this.list(ctx, input.scope, input.subjectId);
      const found = existing.find((m) => m.kind === input.kind && m.content === input.content);
      if (found) return found;
      throw new Error("memory insert conflicted but existing row not found");
    }
    return toMemoryItem(row);
  }

  async list(ctx: TenantContext, scope: MemoryItem["scope"], subjectId: string): Promise<MemoryItem[]> {
    const tenant = requireTenant(ctx);
    const rows = await this.db
      .select()
      .from(longTermMemories)
      .where(
        and(
          eq(longTermMemories.orgId, tenant.orgId),
          eq(longTermMemories.scope, scope),
          eq(longTermMemories.subjectId, subjectId),
        ),
      );
    return rows.map(toMemoryItem);
  }

  async forget(ctx: TenantContext, id: string): Promise<boolean> {
    const tenant = requireTenant(ctx);
    const deleted = await this.db
      .delete(longTermMemories)
      .where(and(eq(longTermMemories.orgId, tenant.orgId), eq(longTermMemories.id, asUuid(id))))
      .returning({ id: longTermMemories.id });
    return deleted.length > 0;
  }
}

function toMemoryItem(row: typeof longTermMemories.$inferSelect): MemoryItem {
  return {
    id: row.id,
    orgId: row.orgId,
    scope: row.scope,
    subjectId: row.subjectId,
    kind: row.kind,
    content: row.content,
    salience: row.salience,
    vectorRef: row.vectorRef ?? undefined,
    createdAt: row.createdAt.toISOString(),
  };
}

function asUuid(id: string): string {
  // Hosted identifiers are UUIDs; runtime-facing ids may be opaque. The
  // control plane resolves opaque → UUID before calling these stores.
  return id;
}
