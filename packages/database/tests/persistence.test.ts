import { describe, expect, it } from "vitest";
import { EventId, OrgId, type SessionEvent } from "@mox/contracts";
import {
  InMemoryMemoryStore,
  InMemoryMessageStore,
  InMemorySessionEventStore,
  InMemoryThreadStore,
  MemoryService,
  TenantScopeError,
  proposeMemories,
  type TenantContext,
} from "../src/index.js";

const ORG_A: TenantContext = { orgId: OrgId.parse("11111111-1111-1111-1111-111111111111") };
const ORG_B: TenantContext = { orgId: OrgId.parse("22222222-2222-2222-2222-222222222222") };

let n = 0;
function event(overrides: Partial<SessionEvent> & { orgId?: string }): SessionEvent {
  n += 1;
  return {
    eventId: EventId.parse(`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`),
    type: "user.message",
    orgId: ORG_A.orgId,
    threadId: "t1",
    correlationId: "corr-1",
    messageId: `m${n}`,
    text: `hello ${n}`,
    at: new Date(Date.UTC(2026, 0, 1)).toISOString(),
    ...overrides,
  } as SessionEvent;
}

describe("session event store (append-oriented, idempotent)", () => {
  it("appends with increasing seq and replays in order", async () => {
    const store = new InMemorySessionEventStore();
    const subject = { kind: "thread" as const, id: "t1" };
    const r1 = await store.append(ORG_A, subject, event({}));
    const r2 = await store.append(ORG_A, subject, event({}));
    expect(r1.duplicate).toBe(false);
    expect(r2.seq).toBeGreaterThan(r1.seq);
    const replayed = await store.replay(ORG_A, subject);
    expect(replayed.map((r) => (r.event as { text?: string }).text)).toEqual(["hello 1", "hello 2"]);
  });

  it("duplicate eventId appends are idempotent (no duplicate rows)", async () => {
    const store = new InMemorySessionEventStore();
    const subject = { kind: "thread" as const, id: "t1" };
    const e = event({});
    await store.append(ORG_A, subject, e);
    const retry = await store.append(ORG_A, subject, e); // reconnect/retry
    expect(retry.duplicate).toBe(true);
    expect(await store.replay(ORG_A, subject)).toHaveLength(1);
  });

  it("refuses cross-tenant appends and never leaks rows across orgs", async () => {
    const store = new InMemorySessionEventStore();
    const subject = { kind: "thread" as const, id: "t1" };
    await store.append(ORG_A, subject, event({}));
    await expect(store.append(ORG_B, subject, event({}))).rejects.toBeInstanceOf(TenantScopeError);
    expect(await store.replay(ORG_B, subject)).toHaveLength(0);
  });

  it("replays by correlation for run reconstruction", async () => {
    const store = new InMemorySessionEventStore();
    const subject = { kind: "thread" as const, id: "t1" };
    await store.append(ORG_A, subject, event({ correlationId: "run-A" }));
    await store.append(ORG_A, subject, event({ correlationId: "run-B" }));
    const a = await store.replayCorrelation(ORG_A, "run-A");
    expect(a).toHaveLength(1);
    expect(a[0]?.correlationId).toBe("run-A");
  });
});

describe("threads & messages", () => {
  it("threads are tenant-scoped; foreign orgs see nothing", async () => {
    const threads = new InMemoryThreadStore();
    await threads.create(ORG_A, { threadId: "t1", agentId: "a1" });
    expect((await threads.get(ORG_B, "t1"))).toBeUndefined();
    expect(await threads.listForAgent(ORG_B, "a1")).toHaveLength(0);
  });

  it("message stores enforce thread-org binding on read and write", async () => {
    const messages = new InMemoryMessageStore();
    messages.bindThreadOrg("t1", ORG_A.orgId);
    await messages.append(ORG_A, { messageId: "m1", threadId: "t1", authorKind: "user", authorId: "u1", text: "hi" });
    await expect(
      messages.append(ORG_B, { messageId: "m2", threadId: "t1", authorKind: "agent", authorId: "a1", text: "ho" }),
    ).rejects.toBeInstanceOf(TenantScopeError);
    expect(await messages.list(ORG_B, "t1")).toHaveLength(0);
  });
});

describe("memory ownership (explicit writes only)", () => {
  const svc = () => new MemoryService(new InMemoryMemoryStore());

  it("messages are never auto-persisted; only explicit remember() lands", async () => {
    // proposeMemories returns candidates; nothing is stored until remember().
    const proposals = proposeMemories([
      event({ text: "always reply in German" }),
      event({ text: "casual chat" }),
    ]);
    expect(proposals.length).toBeGreaterThanOrEqual(1);
    const store = new InMemoryMemoryStore();
    const ctxSvc = new MemoryService(store);
    expect(await store.list(ORG_A, "thread", "t1")).toHaveLength(0);
    const res = await ctxSvc.remember(ORG_A, {
      scope: "thread",
      subjectId: "t1",
      kind: "preference",
      content: "always reply in German",
      salience: 3,
    });
    expect(res.stored).toBe(true);
    expect(await store.list(ORG_A, "thread", "t1")).toHaveLength(1);
  });

  it("salience below policy minimum is refused", async () => {
    const s = svc();
    const low = await s.remember(ORG_A, { scope: "agent", subjectId: "a1", kind: "fact", content: "x", salience: 1 });
    expect(low.stored).toBe(false);
  });

  it("dedupes identical content and evicts lowest salience at capacity", async () => {
    const policySvc = new MemoryService(new InMemoryMemoryStore(), {
      minSalience: 1,
      maxItemsPerSubject: 2,
    });
    await policySvc.remember(ORG_A, { scope: "org", subjectId: "o", kind: "fact", content: "a", salience: 5 });
    await policySvc.remember(ORG_A, { scope: "org", subjectId: "o", kind: "fact", content: "b", salience: 2 });
    const dupe = await policySvc.remember(ORG_A, { scope: "org", subjectId: "o", kind: "fact", content: "a", salience: 9 });
    expect(dupe.item?.content).toBe("a");
    const third = await policySvc.remember(ORG_A, { scope: "org", subjectId: "o", kind: "fact", content: "c", salience: 4 });
    expect(third.stored).toBe(true); // evicts "b" (salience 2)
    const after = await policySvc.store.list(ORG_A, "org", "o");
    expect(after.map((m) => m.content).sort()).toEqual(["a", "c"]);
  });

  it("forget removes an item within the same tenant only", async () => {
    const s = svc();
    const res = await s.remember(ORG_A, { scope: "agent", subjectId: "a1", kind: "fact", content: "secret", salience: 4 });
    // Foreign tenants can neither delete nor detect the row.
    expect(await s.store.forget(ORG_B, res.item?.id ?? "")).toBe(false);
    expect(await s.store.forget(ORG_A, res.item?.id ?? "")).toBe(true);
  });
});
