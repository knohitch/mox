import type { SessionEvent } from "@mox/contracts";
import { sanitizeForPersistence } from "@mox/security";
import { requireTenant, TenantScopeError, type TenantContext } from "./tenant.js";

/**
 * Session/event ownership stores (Prompt 06).
 *
 * Two implementations per interface:
 * - `InMemory*` — reference semantics (tenant checks, idempotency, ordering),
 *   fully unit-tested without a database;
 * - `Pg*` — thin drizzle translations over the same interfaces for the
 *   hosted control plane.
 *
 * The append-oriented event store is the durable authority: the kernel's
 * in-memory log is a cache. eventId is the idempotency key so reconnect/retry
 * can never duplicate history.
 */

export type SubjectKind = "thread" | "room";

export interface EventAppendResult {
  seq: number;
  duplicate: boolean;
}

export interface SessionEventStore {
  append(ctx: TenantContext, subject: { kind: SubjectKind; id: string }, event: SessionEvent): Promise<EventAppendResult>;
  replay(ctx: TenantContext, subject: { kind: SubjectKind; id: string }): Promise<Array<{ seq: number; event: SessionEvent }>>;
  /** Rebuild everything caused by one correlation (run/room objective). */
  replayCorrelation(ctx: TenantContext, correlationId: string): Promise<SessionEvent[]>;
}

export class InMemorySessionEventStore implements SessionEventStore {
  private readonly rows = new Map<string, { orgId: string; seq: number; event: SessionEvent }>();
  private nextSeq = 1;

  constructor(nowSeq = 1) {
    this.nextSeq = nowSeq;
  }

  async append(
    ctx: TenantContext,
    subject: { kind: SubjectKind; id: string },
    event: SessionEvent,
  ): Promise<EventAppendResult> {
    const tenant = requireTenant(ctx);
    const scopeOrg = event.orgId;
    if (!tenant.system && scopeOrg !== tenant.orgId) {
      throw new TenantScopeError("event org does not match tenant context");
    }
    const key = event.eventId;
    const existing = this.rows.get(key);
    if (existing) {
      if (existing.event.orgId !== scopeOrg || existing.event.correlationId !== event.correlationId) {
        throw new TenantScopeError("eventId collision across tenants/correlations");
      }
      return { seq: existing.seq, duplicate: true };
    }
    const seq = this.nextSeq;
    this.nextSeq += 1;
    this.rows.set(key, { orgId: scopeOrg, seq, event: sanitizeForPersistence(event) });
    void subject;
    return { seq, duplicate: false };
  }

  async replay(
    ctx: TenantContext,
    subject: { kind: SubjectKind; id: string },
  ): Promise<Array<{ seq: number; event: SessionEvent }>> {
    const tenant = requireTenant(ctx);
    return Array.from(this.rows.values())
      .filter((r) => r.event.orgId === tenant.orgId || tenant.system)
      .filter((r) => matchesSubject(r.event, subject))
      .sort((a, b) => a.seq - b.seq)
      .map((r) => ({ seq: r.seq, event: r.event }));
  }

  async replayCorrelation(ctx: TenantContext, correlationId: string): Promise<SessionEvent[]> {
    const tenant = requireTenant(ctx);
    return Array.from(this.rows.values())
      .filter((r) => r.event.orgId === tenant.orgId || tenant.system)
      .filter((r) => r.event.correlationId === correlationId)
      .sort((a, b) => a.seq - b.seq)
      .map((r) => r.event);
  }
}

function matchesSubject(event: SessionEvent, subject: { kind: SubjectKind; id: string }): boolean {
  if (subject.kind === "thread") return event.threadId === subject.id;
  return event.roomId === subject.id;
}

// ---- Threads & messages ----

export interface ThreadRecord {
  threadId: string;
  orgId: string;
  agentId: string | null;
  roomId: string | null;
  title?: string;
  status: "active" | "archived";
}

export interface ThreadStore {
  create(ctx: TenantContext, input: { threadId: string; agentId?: string; roomId?: string; title?: string }): Promise<ThreadRecord>;
  get(ctx: TenantContext, threadId: string): Promise<ThreadRecord | undefined>;
  listForAgent(ctx: TenantContext, agentId: string): Promise<ThreadRecord[]>;
}

export class InMemoryThreadStore implements ThreadStore {
  private readonly rows = new Map<string, ThreadRecord>();

  async create(ctx: TenantContext, input: { threadId: string; agentId?: string; roomId?: string; title?: string }): Promise<ThreadRecord> {
    const tenant = requireTenant(ctx);
    if (this.rows.has(input.threadId)) throw new Error(`thread exists: ${input.threadId}`);
    const row: ThreadRecord = {
      threadId: input.threadId,
      orgId: tenant.orgId,
      agentId: input.agentId ?? null,
      roomId: input.roomId ?? null,
      title: input.title,
      status: "active",
    };
    this.rows.set(input.threadId, row);
    return { ...row };
  }

  async get(ctx: TenantContext, threadId: string): Promise<ThreadRecord | undefined> {
    const tenant = requireTenant(ctx);
    const row = this.rows.get(threadId);
    // Reads never reveal other tenants' rows: foreign orgs see not-found.
    if (!row || (!tenant.system && row.orgId !== tenant.orgId)) return undefined;
    return { ...row };
  }

  async listForAgent(ctx: TenantContext, agentId: string): Promise<ThreadRecord[]> {
    const tenant = requireTenant(ctx);
    return Array.from(this.rows.values())
      .filter((r) => r.agentId === agentId && (tenant.system || r.orgId === tenant.orgId))
      .map((r) => ({ ...r }));
  }
}

export interface MessageRecord {
  messageId: string;
  threadId: string;
  authorKind: "user" | "agent" | "system";
  authorId: string;
  text: string;
  createdAt: string;
}

export interface MessageStore {
  append(ctx: TenantContext, input: Omit<MessageRecord, "createdAt"> & { createdAt?: string }): Promise<MessageRecord>;
  list(ctx: TenantContext, threadId: string): Promise<MessageRecord[]>;
}

export class InMemoryMessageStore implements MessageStore {
  private readonly rows = new Map<string, MessageRecord[]>();
  private readonly orgByThread = new Map<string, string>();

  bindThreadOrg(threadId: string, orgId: string): void {
    this.orgByThread.set(threadId, orgId);
  }

  async append(
    ctx: TenantContext,
    input: Omit<MessageRecord, "createdAt"> & { createdAt?: string },
  ): Promise<MessageRecord> {
    const tenant = requireTenant(ctx);
    const boundOrg = this.orgByThread.get(input.threadId);
    if (boundOrg !== undefined && !tenant.system && boundOrg !== tenant.orgId) {
      throw new TenantScopeError("thread belongs to another organization");
    }
    const record: MessageRecord = {
      ...input,
      createdAt: input.createdAt ?? new Date().toISOString(),
    };
    const list = this.rows.get(input.threadId) ?? [];
    list.push(record);
    this.rows.set(input.threadId, list);
    return { ...record };
  }

  async list(ctx: TenantContext, threadId: string): Promise<MessageRecord[]> {
    const tenant = requireTenant(ctx);
    const boundOrg = this.orgByThread.get(threadId);
    // Reads return empty for foreign tenants (no existence leak); writes throw.
    if (!tenant.system && boundOrg !== undefined && boundOrg !== tenant.orgId) {
      return [];
    }
    return [...(this.rows.get(threadId) ?? [])];
  }
}

// ---- Long-term memory (explicit writes only) ----

export interface MemoryItem {
  id: string;
  orgId: string;
  agentId?: string;
  scope: "thread" | "room" | "agent" | "org";
  subjectId: string;
  kind: "fact" | "preference" | "summary" | "knowledge_ref";
  content: string;
  salience: number;
  vectorRef?: string;
  createdAt: string;
}

export interface MemoryStore {
  remember(ctx: TenantContext, input: Omit<MemoryItem, "id" | "orgId" | "createdAt">): Promise<MemoryItem>;
  list(ctx: TenantContext, scope: MemoryItem["scope"], subjectId: string): Promise<MemoryItem[]>;
  forget(ctx: TenantContext, id: string): Promise<boolean>;
}

export class InMemoryMemoryStore implements MemoryStore {
  private readonly rows = new Map<string, MemoryItem>();
  private counter = 0;

  constructor(private readonly dedupeKey: (input: Omit<MemoryItem, "id" | "orgId" | "createdAt">) => string = defaultDedupe) {}

  async remember(
    ctx: TenantContext,
    input: Omit<MemoryItem, "id" | "orgId" | "createdAt">,
  ): Promise<MemoryItem> {
    const tenant = requireTenant(ctx);
    const key = `${tenant.orgId}:${this.dedupeKey(input)}`;
    const existing = this.rows.get(key);
    if (existing) return { ...existing };
    const item: MemoryItem = {
      ...input,
      id: `mem_${++this.counter}`,
      orgId: tenant.orgId,
      createdAt: new Date().toISOString(),
    };
    this.rows.set(key, item);
    return { ...item };
  }

  async list(ctx: TenantContext, scope: MemoryItem["scope"], subjectId: string): Promise<MemoryItem[]> {
    const tenant = requireTenant(ctx);
    return Array.from(this.rows.values())
      .filter((m) => m.scope === scope && m.subjectId === subjectId && (tenant.system || m.orgId === tenant.orgId))
      .map((m) => ({ ...m }));
  }

  async forget(ctx: TenantContext, id: string): Promise<boolean> {
    const tenant = requireTenant(ctx);
    for (const [key, item] of Array.from(this.rows.entries())) {
      if (item.id !== id) continue;
      // Foreign tenants must not be able to detect (let alone delete) rows.
      if (!tenant.system && item.orgId !== tenant.orgId) return false;
      this.rows.delete(key);
      return true;
    }
    return false;
  }
}

function defaultDedupe(input: Omit<MemoryItem, "id" | "orgId" | "createdAt">): string {
  return `${input.scope}:${input.subjectId}:${input.kind}:${input.content}`;
}
