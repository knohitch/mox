import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@mox/contracts";
import { DemoMoxApi } from "../src/api/demo-api.js";

describe("DemoMoxApi (web seam over canonical contracts)", () => {
  it("streams a run as canonical events ending in turn.completed", async () => {
    const api = new DemoMoxApi();
    const events: AgentEvent[] = [];
    const handle = await api.send("a_writer", "t_a_writer", "what is the status?", (e) => events.push(e));
    await handle.done;

    expect(events[0]?.type).toBe("turn.started");
    expect(events.at(-1)?.type).toBe("turn.completed");
    expect(events.some((e) => e.type === "message.delta")).toBe(true);
    expect(events.some((e) => e.type === "message.completed")).toBe(true);
    // Persisted event log matches what was streamed.
    const stored = await api.getEvents("t_a_writer");
    expect(stored.length).toBe(events.length);
  });

  it("gates computer use behind a real approval round-trip", async () => {
    const api = new DemoMoxApi();
    let opened: AgentEvent | undefined;
    const handle = await api.send("a_browse", "t_a_browse", "browse https://example.com/report", async (e) => {
      if (e.type === "approval.opened") {
        opened = e;
        // Resolve while the run is blocked waiting.
        await api.resolveApproval((e as { approvalId: string }).approvalId, "approved");
      }
    });
    await handle.done;
    expect(opened).toBeDefined();
    const events = await api.getEvents("t_a_browse");
    expect(events.some((e) => e.type === "approval.resolved" && (e as { outcome: string }).outcome === "approved")).toBe(true);
    // The tool ran through the gateway-shaped path after approval only.
    expect(events.some((e) => e.type === "tool.completed")).toBe(true);
  });

  it("cancelled runs end in turn.failed with no completed message", async () => {
    const api = new DemoMoxApi();
    const events: AgentEvent[] = [];
    let handleRef: { cancel(): void } | undefined;
    const handle = await api.send("a_code", "t_a_code", "long task please", (e) => {
      events.push(e);
      if (e.type === "message.delta") handleRef?.cancel();
    });
    handleRef = handle;
    await handle.done;
    const types = events.map((e) => e.type);
    expect(types).not.toContain("turn.completed");
    expect(types.at(-1)).toBe("turn.failed");
  });

  it("rooms are first-class domain objects with shared threads", async () => {
    const api = new DemoMoxApi();
    const rooms = await api.listRooms();
    expect(rooms.length).toBeGreaterThan(0);
    const created = await api.createRoom({ title: "Incident", memberAgentIds: ["a_ops", "a_code"] });
    expect(created.memberAgentIds).toEqual(["a_ops", "a_code"]);
    const msgs = await api.getMessages(`room:${created.roomId}`);
    expect(msgs).toEqual([]);
  });
});
