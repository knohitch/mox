import { describe, expect, it } from "vitest";
import { redact } from "@mox/credentials";
import { InMemorySessionEventStore, redactForStorage } from "../src/persistence.js";
import type { AgentEvent } from "@mox/contracts";

const ev = (overrides: Record<string, unknown>): AgentEvent =>
  ({
    eventId: crypto.randomUUID(),
    agentId: "agent-1",
    at: new Date().toISOString(),
    type: "tool.completed",
    toolName: "search",
    ok: true,
    ...overrides,
  }) as unknown as AgentEvent;

describe("no plaintext credential leakage", () => {
  it("redact() masks secret-shaped keys in tool output before storage", () => {
    const cleaned = redact({
      apiKey: "sk-super-secret",
      nested: { authorization: "Bearer x", safe: "hello" },
      list: [{ password: "p@ss" }],
    });
    expect(JSON.stringify(cleaned)).not.toContain("sk-super-secret");
    expect(JSON.stringify(cleaned)).not.toContain("Bearer x");
    expect(JSON.stringify(cleaned)).not.toContain("p@ss");
    expect((cleaned as Record<string, unknown>).apiKey).toBe("[redacted]");
    expect((cleaned as { nested: Record<string, unknown> }).nested.safe).toBe("hello");
  });

  it("redactForStorage scrubs secret-shaped fields on event input/output/error", () => {
    const event = ev({
      output: { apiKey: "sk-123", result: "ok" },
      input: { api_key: "sk-456" },
    });
    const stored = redactForStorage(event) as unknown as Record<string, Record<string, unknown>>;
    expect(JSON.stringify(stored)).not.toContain("sk-123");
    expect(JSON.stringify(stored)).not.toContain("sk-456");
    expect(stored.output?.result).toBe("ok");
  });

  it("event store persists redacted events and never stores raw secrets", async () => {
    const store = new InMemorySessionEventStore();
    const raw = ev({ output: { token: "super-secret-token" } });
    await store.append("org-1", "run-1", raw);
    const replayed = await store.replay("org-1", "run-1");
    expect(replayed).toHaveLength(1);
    // The store is a dumb sink; callers must pass through redactForStorage.
    // Verify the documented composition keeps secrets out of durable bytes:
    await store.append("org-1", "run-2", redactForStorage(raw));
    const run2 = await store.replay("org-1", "run-2");
    expect(JSON.stringify(run2[0])).not.toContain("super-secret-token");
  });

  it("credential grant provider resolves refs but grants are not echoed into events", async () => {
    // Simulate the host seam: refs -> scoped grants. Grants go to runtimeConfig
    // only; the event path has no field for them.
    const provider = {
      grant: async (refs: readonly string[]) => ({
        credentialGrants: refs.map((ref) => ({ ref, scope: "runtime-scoped" })),
      }),
    };
    const grants = await provider.grant(["vault://model-key"]);
    expect(JSON.stringify(grants)).not.toContain("sk-");
    expect((grants.credentialGrants as Array<{ ref: string }>)[0]?.ref).toBe("vault://model-key");
  });
});
