import { describe, expect, it } from "vitest";
import { AgentEvent, ModelProvider } from "@mox/contracts";
import {
  dshEventToAgentEvent,
  dshEventToEnvelope,
  openBotProfileToAgentDefinition,
  openMausDriversToModelProviders,
} from "../src/index.js";

const now = "2026-08-21T12:00:00Z";

describe("OpenBot profile → AgentDefinition", () => {
  it("maps prompt, model, tools and identity", () => {
    const def = openBotProfileToAgentDefinition(
      {
        name: "researcher",
        description: "Does research",
        prompt: "You research things.",
        model: "gpt-x",
        tools: ["web.search", "fs.read"],
        tags: ["work"],
      },
      {
        orgId: "org_1" as never,
        agentId: "agent_1" as never,
        now,
        defaultModel: { providerId: "p", modelId: "m" } as never,
      },
    );
    expect(def.instructions.text).toBe("You research things.");
    expect(def.model.modelId).toBe("gpt-x");
    expect(def.tools.toolNames).toEqual(["web.search", "fs.read"]);
    expect(def.metadata["source"]).toBe("openbot");
  });

  it("falls back to the default model when the profile names none", () => {
    const def = openBotProfileToAgentDefinition(
      { name: "plain", prompt: "hi" },
      {
        orgId: "org_1" as never,
        agentId: "agent_2" as never,
        now,
        defaultModel: { providerId: "p", modelId: "m" } as never,
      },
    );
    expect(def.model).toEqual({ providerId: "p", modelId: "m" });
  });
});

describe("OpenMaus drivers → ModelProvider", () => {
  it("produces validated cli-proxy providers with vendor data in extension", () => {
    const providers = openMausDriversToModelProviders(now);
    expect(providers.length).toBe(7);
    const grok = providers.find((p) => p.providerId === "openmaus_grok");
    expect(grok).toBeDefined();
    const parsed = ModelProvider.parse(grok);
    expect(parsed.kind).toBe("cli-proxy");
    expect(parsed.extension?.["binary"]).toBe("grok");
    expect(parsed.extension?.["acp"]).toBe(true);
  });
});

describe("DSH session event → AgentEvent", () => {
  it("maps deltas, tool calls and errors to canonical events", () => {
    const ctx = { agentId: "agent_1" as never, correlationId: "corr_1" };
    const delta = dshEventToAgentEvent(
      { kind: "assistant-delta", turnId: "t1", messageId: "m1", delta: "He", at: now },
      ctx,
    );
    expect(delta.type).toBe("message.delta");

    const tool = dshEventToAgentEvent(
      { kind: "tool-call", turnId: "t1", tool: "web.search", input: { q: "x" }, at: now },
      ctx,
    );
    expect(tool.type).toBe("tool.requested");

    const err = dshEventToAgentEvent({ kind: "error", turnId: "t1", message: "boom", fatal: false, at: now }, ctx);
    expect(err.type).toBe("error");

    // Every mapped event validates against the canonical union.
    AgentEvent.parse(delta);
    AgentEvent.parse(tool);
    AgentEvent.parse(err);
  });

  it("wraps mapped events in the canonical envelope", () => {
    const env = dshEventToEnvelope(
      { kind: "turn-start", turnId: "t1", at: now },
      { agentId: "agent_1" as never, correlationId: "corr_1" },
    );
    expect(env.type).toBe("agent.turn.started");
    expect(env.correlationId).toBe("corr_1");
    expect(env.payload.type).toBe("turn.started");
  });
});