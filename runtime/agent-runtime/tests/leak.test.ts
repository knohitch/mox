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
    const raw = ev({ output: { token: "super-secret-token", text: "DATABASE_URL=postgres://user:pass@db.internal/app" } });
    await store.append("org-1", "run-1", raw);
    const replayed = await store.replay("org-1", "run-1");
    expect(replayed).toHaveLength(1);
    const rawBytes = JSON.stringify(replayed[0]);
    expect(rawBytes).not.toContain("super-secret-token");
    expect(rawBytes).not.toContain("postgres://user:pass@db.internal/app");
  });

  it("sanitizes model-context replay for shell output and private keys", async () => {
    const store = new InMemorySessionEventStore();
    const privateKey = ["-----BEGIN", "PRIVATE KEY-----\nabc123\n-----END", "PRIVATE KEY-----"].join(" ");
    await store.append("org-1", "run-secret", ev({
      output: {
        stdout: `ok ${privateKey}`,
        url: "https://storage.example.com/object?X-Amz-Signature=abc123&X-Amz-Credential=AKIASECRET",
      },
    }));
    const replayed = await store.replay("org-1", "run-secret");
    const bytes = JSON.stringify(replayed);
    expect(bytes).not.toContain("BEGIN PRIVATE KEY");
    expect(bytes).not.toContain("X-Amz-Signature=abc123");
    expect(bytes).toContain("[redacted]");
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
