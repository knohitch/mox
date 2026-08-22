import { describe, expect, it } from "vitest";
import { RuntimeClient, frame, newRunId, type RuntimeTransport } from "../src/client.js";
import { STREAM_NOTIFICATION } from "../src/protocol.js";

/** In-memory loopback transport for protocol behavior tests. */
class LoopbackTransport implements RuntimeTransport {
  sent: unknown[] = [];
  private handler: ((m: unknown) => void) | undefined;
  private closedResolvers: Array<(e: Error | undefined) => void> = [];

  async send(message: unknown): Promise<void> {
    this.sent.push(message);
  }
  onMessage(handler: (message: unknown) => void): void {
    this.handler = handler;
  }
  onClosed(): Promise<Error | undefined> {
    return new Promise((resolve) => this.closedResolvers.push(resolve));
  }
  async close(): Promise<void> {
    for (const r of this.closedResolvers) r(undefined);
  }
  /** Simulate the runtime pushing a message. */
  push(message: unknown): void {
    this.handler?.(JSON.parse(JSON.stringify(message)));
  }
  /** Simulate an abnormal termination. */
  crash(error: Error): void {
    for (const r of this.closedResolvers) r(error);
  }
}

describe("RuntimeClient over a loopback transport", () => {
  it("correlates responses to requests by id", async () => {
    const t = new LoopbackTransport();
    const client = new RuntimeClient(t);
    const pending = client.health();
    const request = t.sent[0] as { id: number; method: string };
    expect(request.method).toBe("runtime/health");
    t.push({ jsonrpc: "2.0", id: request.id, result: { ok: true, uptimeMs: 5, activeRuns: 0, version: "test" } });
    const health = await pending;
    expect(health.ok).toBe(true);
    await client.dispose();
  });

  it("rejects with the runtime error message on failure results", async () => {
    const t = new LoopbackTransport();
    const client = new RuntimeClient(t);
    const pending = client.startRun({
      runId: "r1",
      orgId: "o1",
      agentId: "a1",
      threadId: "t1",
      definition: validDefinition() as unknown as Parameters<typeof client.startRun>[0]["definition"],
      runtimeConfig: {},
    });
    const request = t.sent[0] as { id: number };
    t.push({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "kernel exploded" } });
    await expect(pending).rejects.toThrow("kernel exploded");
    await client.dispose();
  });

  it("delivers streamed canonical events to listeners", async () => {
    const t = new LoopbackTransport();
    const client = new RuntimeClient(t);
    const seen: string[] = [];
    client.onEvent((p) => seen.push(p.event.type));
    t.push({
      jsonrpc: "2.0",
      method: STREAM_NOTIFICATION,
      params: {
        runId: "r1",
        event: {
          eventId: crypto.randomUUID(),
          agentId: "a1",
          at: new Date().toISOString(),
          type: "tool.requested",
          toolName: "search",
          input: { q: "x" },
        },
      },
    });
    // Malformed stream events are dropped silently.
    t.push({ jsonrpc: "2.0", method: STREAM_NOTIFICATION, params: { runId: "r1", event: { nope: true } } });
    // Other notifications are ignored.
    t.push({ jsonrpc: "2.0", method: "other.notify", params: {} });
    expect(seen).toEqual(["tool.requested"]);
    await client.dispose();
  });

  it("times out requests that never receive a response", async () => {
    const t = new LoopbackTransport();
    const client = new RuntimeClient(t, { timeoutMs: 25 });
    await expect(client.health()).rejects.toThrow("timed out");
    await client.dispose();
  });

  it("fails all in-flight requests when the transport crashes", async () => {
    const t = new LoopbackTransport();
    const client = new RuntimeClient(t);
    let closedSeen: Error | undefined;
    client.onClosed((e) => {
      closedSeen = e;
    });
    const pending = client.listRuns();
    t.crash(new Error("segfault"));
    await expect(pending).rejects.toThrow("segfault");
    expect(closedSeen?.message).toBe("segfault");
  });

  it("frames messages as newline-delimited JSON and mints unique run ids", () => {
    const framed = frame({ jsonrpc: "2.0", id: 1, method: "x" });
    expect(framed.endsWith("\n")).toBe(true);
    expect(JSON.parse(framed)).toHaveProperty("method", "x");
    expect(newRunId()).not.toBe(newRunId());
  });
});

function validDefinition() {
  return {
    schemaVersion: 1 as const,
    agentId: "agent-1",
    orgId: "org-1",
    slug: "s",
    identity: { displayName: "A" },
    instructions: { text: "i" },
    model: { providerId: "p", modelId: "m" },
    tools: { toolNames: [], integrations: [] },
    skills: [],
    knowledge: [],
    computer: { enabled: false, allowBrowser: false, sandbox: "none" },
    voice: { enabled: false },
    channels: [],
    deployment: { kind: "sandbox" },
    permissions: { toolPolicy: "default" },
    memory: { enabled: false, scope: "thread" },
    schedules: [],
    workflows: [],
    subagents: [],
    authoring: { mode: "developer" },
    metadata: {},
    createdAt: "2026-08-21T12:00:00Z",
    updatedAt: "2026-08-21T12:00:00Z",
  };
}
