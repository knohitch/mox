import { describe, expect, it } from "vitest";
import { EventId, type AgentEvent } from "@mox/contracts";
import {
  dedupeById,
  fromResumeToken,
  rebuildHistory,
  rebuildHistoryFromAgentEvents,
  toResumeToken,
} from "../src/index.js";
import {
  agentEventsToCopilotMessages,
  sessionEventsToCopilotMessages,
} from "../src/index.js";

let n = 0;
const agentEvent = (partial: Partial<AgentEvent>): AgentEvent => {
  n += 1;
  return {
    eventId: EventId.parse(`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`),
    agentId: "a1",
    at: "2026-01-01T00:00:00Z",
    ...partial,
  } as AgentEvent;
};

describe("DSH session persistence adapter", () => {
  it("rebuilds history from durable events with idempotent replay", () => {
    const stored: Parameters<typeof rebuildHistory>[0] = [
      { eventId: "e1", type: "user.message", messageId: "m1", text: "hi", orgId: "o", correlationId: "c", at: "" },
      { eventId: "e2", type: "assistant.final", messageId: "m2", text: "hello!", orgId: "o", correlationId: "c", at: "" },
      // duplicate of e2 (retry after reconnect)
      { eventId: "e2", type: "assistant.final", messageId: "m2", text: "hello!", orgId: "o", correlationId: "c", at: "" },
      {
        eventId: "e3",
        type: "tool.completed",
        toolName: "computer",
        outputSummary: { ok: true },
        ok: true,
        orgId: "o",
        correlationId: "c",
        at: "",
      },
    ] as never;
    const history = rebuildHistory(stored);
    expect(history.map((h) => h.role)).toEqual(["user", "assistant", "tool"]);
    expect(history[1]?.content).toBe("hello!");
    expect(history[2]?.toolName).toBe("computer");
  });

  it("dedupes by eventId across the live AgentEvent stream too", () => {
    const a = agentEvent({ type: "message.completed", messageId: "m1" as never, text: "x" });
    const twice = [a, a];
    expect(dedupeById(twice)).toHaveLength(1);
    expect(rebuildHistoryFromAgentEvents(twice)).toHaveLength(1);
  });

  it("resume tokens round-trip and reject garbage", () => {
    const token = toResumeToken({ runId: "run-9", lastSeq: 42 });
    expect(fromResumeToken(token)).toEqual({ runId: "run-9", lastSeq: 42 });
    expect(fromResumeToken("garbage")).toBeUndefined();
    expect(fromResumeToken(toResumeToken({ runId: "", lastSeq: -1 }))?.runId).toBe("");
  });
});

describe("CopilotKit adapter (optional client compat, never authoritative)", () => {
  it("projects session events into AG-UI message shapes without persisting anything", () => {
    const msgs = sessionEventsToCopilotMessages([
      { eventId: "e1", type: "user.message", messageId: "m1", text: "hi", orgId: "o", correlationId: "c", at: "" },
      { eventId: "e2", type: "assistant.final", messageId: "m2", text: "yo", orgId: "o", correlationId: "c", at: "" },
    ] as never);
    expect(msgs).toEqual([
      { id: "m1", role: "user", content: "hi" },
      { id: "m2", role: "assistant", content: "yo" },
    ]);
  });

  it("agent event streams map tool outputs to tool messages", () => {
    const msgs = agentEventsToCopilotMessages([
      agentEvent({ type: "tool.completed", toolName: "files.write" as never, output: { ok: true }, ok: true }),
    ]);
    expect(msgs[0]?.role).toBe("tool");
    expect(msgs[0]?.name).toBe("files.write");
  });
});
