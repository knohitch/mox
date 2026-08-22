import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@mox/contracts";
import { projectWorkView } from "../src/domain/work-view.js";

const base = { eventId: "e1", agentId: "a1", threadId: "t1", at: "2026-01-01T00:00:00Z" };

function ev(partial: { type: AgentEvent["type"] } & Record<string, unknown>): AgentEvent {
  return { ...base, ...partial } as AgentEvent;
}

describe("projectWorkView", () => {
  it("projects a full turn with tools into ordered work items", () => {
    const events: AgentEvent[] = [
      ev({ type: "turn.started", turnId: "turn-1", input: { text: "browse example.com" } }),
      ev({ type: "message.completed", messageId: "m1", turnId: "turn-1", text: "Opening the page." }),
      ev({ type: "tool.requested", turnId: "turn-1", toolName: "computer", input: { action: { kind: "navigate", url: "https://example.com" } } }),
      ev({ type: "tool.completed", turnId: "turn-1", toolName: "computer", output: { ok: true }, ok: true }),
      ev({ type: "tool.requested", turnId: "turn-1", toolName: "files.write", input: { path: "report.md" } }),
      ev({ type: "approval.opened", approvalId: "ap1", summary: "needs computer" }),
      ev({ type: "approval.resolved", approvalId: "ap1", outcome: "approved" }),
      ev({ type: "turn.completed", turnId: "turn-1", output: "done" }),
    ];
    const items = projectWorkView(events);
    const kinds = items.map((i) => i.kind);
    expect(kinds).toEqual(["turn", "message", "terminal", "file-change", "approval", "approval", "turn"]);
    // Tool outcome attached to matching item.
    const terminal = items.find((i) => i.kind === "terminal");
    expect(terminal?.ok).toBe(true);
  });

  it("never renders message deltas as separate items (streaming stays in chat)", () => {
    const events: AgentEvent[] = [
      ev({ type: "message.delta", messageId: "m1", delta: "Hel" }),
      ev({ type: "message.delta", messageId: "m1", delta: "lo" }),
    ];
    expect(projectWorkView(events)).toHaveLength(0);
  });

  it("marks failed tools and fatal errors distinctly", () => {
    const events: AgentEvent[] = [
      ev({ type: "tool.requested", turnId: "t", toolName: "computer", input: { action: { kind: "click", x: 1, y: 2 } } }),
      ev({ type: "tool.completed", turnId: "t", toolName: "computer", output: { error: "element not found" }, ok: false }),
      ev({ type: "error", error: "provider crashed", fatal: true }),
    ];
    const items = projectWorkView(events);
    expect(items.find((i) => i.kind === "terminal")?.ok).toBe(false);
    expect(items.find((i) => i.kind === "error")?.title).toBe("Fatal error");
  });
});
