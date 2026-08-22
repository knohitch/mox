import { describe, expect, it } from "vitest";
import { agentStatus, avatarHue, initials } from "../src/domain/roster.js";
import type { AgentSummary } from "../src/api/types.js";

function summary(over: Partial<AgentSummary> = {}): AgentSummary {
  return {
    definition: {
      schemaVersion: 1,
      agentId: "a1",
      orgId: "o",
      slug: "browse-bot",
      identity: { displayName: "Browsy", title: "Web Researcher" },
      instructions: { text: "x" },
      model: {} as never,
      tools: { toolNames: [], integrations: [] },
      skills: [],
      knowledge: [],
      computer: { enabled: true, allowBrowser: true, sandbox: "container" },
      voice: { enabled: false },
      channels: [],
      deployment: { kind: "mox-cloud" },
      permissions: { toolPolicy: "default" },
      memory: { enabled: true, scope: "agent" },
      schedules: [],
      workflows: [],
      subagents: [],
      authoring: { mode: "simple" },
      metadata: {},
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    },
    ...over,
  } as AgentSummary;
}

describe("roster presence (one normalized Agent concept)", () => {
  it("derives working/running/unavailable from runtime status first", () => {
    expect(agentStatus(summary({ runtimeStatus: "busy" }))).toBe("working");
    expect(agentStatus(summary({ runtimeStatus: "ready" }))).toBe("running");
    expect(agentStatus(summary({ runtimeStatus: "crashed" }))).toBe("unavailable");
  });

  it("falls back to deployment state when no runtime is live", () => {
    expect(agentStatus(summary({ deploymentState: "running" }))).toBe("idle");
    expect(agentStatus(summary({ deploymentState: "provisioning" }))).toBe("running");
    expect(agentStatus(summary({ deploymentState: "stopped" }))).toBe("unavailable");
    expect(agentStatus(summary({}))).toBe("unavailable"); // fail visible
  });

  it("unread nudges a ready agent to working attention", () => {
    expect(agentStatus(summary({ runtimeStatus: "ready", hasUnread: true }))).toBe("working");
  });
});

describe("avatar derivation", () => {
  it("hue is stable and initials come from display name", () => {
    expect(avatarHue("browse-bot")).toBe(avatarHue("browse-bot"));
    expect(initials(summary().definition)).toBe("BR");
  });
});
