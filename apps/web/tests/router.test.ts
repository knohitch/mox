import { describe, expect, it } from "vitest";
import { matchPath } from "../src/router.js";

describe("router path matching", () => {
  it("matches exact paths", () => {
    expect(matchPath("/agents", "/agents")).toEqual({});
    expect(matchPath("/agents", "/agents/1")).toBeNull();
    expect(matchPath("/", "/")).toEqual({});
  });

  it("extracts params", () => {
    expect(matchPath("/agents/:agentId", "/agents/a_browse")).toEqual({ agentId: "a_browse" });
    expect(matchPath("/rooms/:roomId/messages/:messageId", "/rooms/r1/messages/m9")).toEqual({
      roomId: "r1",
      messageId: "m9",
    });
  });

  it("ignores query strings and decodes components", () => {
    expect(matchPath("/agents/:id", "/agents/a%20b?tab=chat")).toEqual({ id: "a b" });
  });
});
