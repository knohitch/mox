import { describe, expect, it } from "vitest";
import type { Envelope } from "@mox/events";
import { InMemoryRealtimeBus, newRealtimeCorrelationId, type RealtimeTopic } from "../src/index.js";

const ORG_A = "org-a";
const ORG_B = "org-b";

describe("InMemoryRealtimeBus (transport-agnostic Mox realtime)", () => {
  it("fans out one publish to all subscribers of the topic", async () => {
    const bus = new InMemoryRealtimeBus();
    const topic: RealtimeTopic = `thread:${ORG_A}:t1`;
    const got: string[] = [];
    bus.subscribe(topic, (e) => void got.push(String((e.payload as { delta?: string }).delta)), { orgId: ORG_A });
    bus.subscribe(topic, () => {
      throw new Error("subscriber crash must not break fanout");
    }, { orgId: ORG_A });
    const sub3 = bus.subscribe(topic, (e) => void got.push(`b:${String((e.payload as { delta?: string }).delta)}`), { orgId: ORG_A });

    await bus.publish({ topic, correlationId: newRealtimeCorrelationId(), payload: { delta: "he" } });
    await bus.publish({ topic, correlationId: newRealtimeCorrelationId(), payload: { delta: "llo" } });
    // Per publish, subscribers run in subscription order.
    expect(got).toEqual(["he", "b:he", "llo", "b:llo"]);

    sub3.unsubscribe();
    await bus.publish({ topic, correlationId: newRealtimeCorrelationId(), payload: { delta: "!" } });
    expect(got.filter((g) => g.startsWith("b:"))).toHaveLength(2);
  });

  it("enforces tenant isolation at delivery time", async () => {
    const bus = new InMemoryRealtimeBus();
    const orgATopic: RealtimeTopic = `approvals:${ORG_A}`;
    const leaked: unknown[] = [];
    bus.subscribe(orgATopic, (e) => void leaked.push(e), { orgId: ORG_B });

    // A subscriber bound to org B cannot receive org A's approvals even if it
    // somehow subscribes to the same channel id.
    await bus.publish({ topic: orgATopic, payload: { approvalId: "x" } });
    expect(leaked).toHaveLength(0);
  });

  it("carries canonical envelopes with scope + correlation", async () => {
    const bus = new InMemoryRealtimeBus();
    let received: Envelope<unknown> | undefined;
    const topic: RealtimeTopic = `deployment:${ORG_A}:d1`;
    bus.subscribe(topic, (e) => {
      received = e;
    }, { orgId: ORG_A });
    const corr = newRealtimeCorrelationId();
    await bus.publish({ topic, correlationId: corr, causationId: "evt-1", payload: { state: "provisioning" } });
    expect(received?.scope.orgId).toBe(ORG_A);
    expect(received?.correlationId).toBe(corr);
    expect(received?.causationId).toBe("evt-1");
    expect(received?.type).toBe("realtime.message");
  });

  it("no-subscriber topics are a silent no-op", async () => {
    const bus = new InMemoryRealtimeBus();
    await expect(
      bus.publish({ topic: `presence:${ORG_B}`, payload: { agentId: "a1", status: "working" } }),
    ).resolves.toBeDefined();
  });
});
