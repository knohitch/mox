import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createEnvelope, envelopeSchema } from "../src/index.js";

const payloadSchema = z.object({ text: z.string() });

describe("event envelope", () => {
  it("creates a valid envelope with generated ids", () => {
    const env = createEnvelope({
      type: "agent.message.delta",
      version: 1,
      scope: { orgId: "org_1" as never },
      payload: { text: "hello" },
    });
    const parsed = envelopeSchema(payloadSchema).parse(env);
    expect(parsed.eventId).toBeTruthy();
    expect(parsed.correlationId).toBeTruthy();
    expect(parsed.payload.text).toBe("hello");
  });

  it("preserves causation chains", () => {
    const first = createEnvelope({
      type: "agent.turn.started",
      version: 1,
      scope: { orgId: "org_1" as never },
      payload: {},
    });
    const second = createEnvelope({
      type: "agent.tool.requested",
      version: 1,
      scope: { orgId: "org_1" as never },
      correlationId: first.correlationId,
      causationId: first.eventId,
      payload: {},
    });
    expect(second.causationId).toBe(first.eventId);
    expect(second.correlationId).toBe(first.correlationId);
  });

  it("rejects an invalid payload", () => {
    const env = createEnvelope({
      type: "agent.message.delta",
      version: 1,
      scope: {},
      payload: { text: 42 as never },
    });
    expect(() => envelopeSchema(payloadSchema).parse(env)).toThrow();
  });
});