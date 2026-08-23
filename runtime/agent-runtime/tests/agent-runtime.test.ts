import { describe, expect, it } from "vitest";
import type { AgentDefinition, AgentEvent } from "@mox/contracts";
import { AgentRuntime } from "../src/agent-runtime.js";
import { assertRuntimeCapabilityMatrixClosed, REQUIRED_RUNTIME_CAPABILITIES } from "../src/capability-matrix.js";
import { InMemorySessionEventStore } from "../src/persistence.js";
import { PermissionsPolicyEngine } from "../src/policy.js";
import {
  MoxRuntimeUnavailableError,
  assertMoxRuntimeMode,
  rejectReferenceRuntimeCapabilities,
} from "../src/production-mode.js";
import { ReferenceAgentEngine, type ModelStub } from "../src/reference-engine.js";
import { ToolRegistry } from "../src/tools.js";
import type { ToolDefinition } from "@mox/contracts";

// ---- fakes ----

class FakeRuntimeClient {
  sent: Array<{ method: string; params: unknown }> = [];
  failNextStart = false;
  listeners = new Set<(p: { runId: string; event: AgentEvent }) => void>();

  async health() {
    return { ok: true, uptimeMs: 1, activeRuns: this.sent.filter((s) => s.method === "run.start").length, version: "fake-1" };
  }
  async capabilities() {
    return { runtime: "fake", protocolVersion: 1, capabilities: ["chat"], tools: [] };
  }
  async startRun(params: Record<string, unknown>) {
    this.sent.push({ method: "run.start", params });
    if (this.failNextStart) {
      this.failNextStart = false;
      throw new Error("runtime refused launch");
    }
    return { runId: params.runId as string, accepted: true, resumeToken: `tok-${String(params.runId)}` };
  }
  async resumeRun(params: Record<string, unknown>) {
    this.sent.push({ method: "run.resume", params });
    return { runId: params.runId as string, accepted: true, resumeToken: params.resumeToken as string };
  }
  async cancelRun(params: { runId: string }) {
    this.sent.push({ method: "run.cancel", params });
    return { runId: params.runId, cancelled: true };
  }
  async listRuns() {
    return { runs: [] };
  }
  async respondApproval() {
    return { approvalId: "a", delivered: true };
  }
  async shutdown() {
    this.sent.push({ method: "runtime.shutdown", params: {} });
    return { shuttingDown: true, runsCancelled: 0 };
  }
}

function definition(overrides: Record<string, unknown> = {}): AgentDefinition {
  return {
    schemaVersion: 1,
    agentId: "agent-1",
    orgId: "org-1",
    slug: "test",
    identity: { displayName: "T" },
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
    ...overrides,
  } as unknown as AgentDefinition;
}

function makeRuntime(client: FakeRuntimeClient, store = new InMemorySessionEventStore()) {
  return new AgentRuntime({ client: client as never, events: store, maxRestartsPerRun: 1 });
}

// ---- tests ----

describe("AgentRuntime launch (AgentDefinition → runtime)", () => {
  it("forwards a validated definition with org/agent/thread scope", async () => {
    const client = new FakeRuntimeClient();
    const runtime = makeRuntime(client);
    const result = await runtime.launch({
      definition: definition(),
      orgId: "org-1",
      agentId: "agent-1",
      threadId: "thread-1",
      userInput: "hello",
    });
    expect(result.accepted).toBe(true);
    const sent = client.sent[0]!;
    expect(sent.method).toBe("run.start");
    expect((sent.params as { orgId: string }).orgId).toBe("org-1");
    expect((sent.params as { definition: AgentDefinition }).definition.agentId).toBe("agent-1");
    expect((sent.params as { userInput: string }).userInput).toBe("hello");
  });

  it("rejects invalid definitions before they reach the runtime", async () => {
    const client = new FakeRuntimeClient();
    const runtime = makeRuntime(client);
    await expect(
      runtime.launch({
        definition: definition({ schemaVersion: 9 }) as AgentDefinition,
        orgId: "org-1",
        agentId: "agent-1",
        threadId: "thread-1",
        userInput: null,
      }),
    ).rejects.toThrow();
    expect(client.sent).toHaveLength(0);
  });

  it("merges config-provider output and credential grants into runtimeConfig", async () => {
    const client = new FakeRuntimeClient();
    const runtime = new AgentRuntime({
      client: client as never,
      events: new InMemorySessionEventStore(),
      config: { build: async () => ({ region: "us" }) },
      credentials: { grant: async (refs) => ({ grants: refs.map((r) => ({ ref: r })) }) },
    });
    await runtime.launch({
      definition: definition(),
      orgId: "org-1",
      agentId: "agent-1",
      threadId: "thread-1",
      userInput: null,
      credentialRefs: ["vault://a", "vault://b"],
    });
    const cfg = (client.sent[0]!.params as { runtimeConfig: Record<string, unknown> }).runtimeConfig;
    expect(cfg.region).toBe("us");
    expect(Array.isArray(cfg.grants)).toBe(true);
  });
});

describe("production Mox Runtime mode", () => {
  it("closes the runtime capability matrix with no missing documented core gaps", () => {
    expect(() => assertRuntimeCapabilityMatrixClosed()).not.toThrow();
    expect(REQUIRED_RUNTIME_CAPABILITIES).toContain("model loop");
    expect(REQUIRED_RUNTIME_CAPABILITIES).toContain("approvals");
  });

  it("production cannot silently use the reference engine or disabled runtime", () => {
    expect(() => assertMoxRuntimeMode({ nodeEnv: "production", mode: "disabled" })).toThrow(MoxRuntimeUnavailableError);
    expect(() => assertMoxRuntimeMode({ nodeEnv: "production", mode: "reference-dev", runtimeCommand: "node" })).toThrow(
      MoxRuntimeUnavailableError,
    );
    expect(() => assertMoxRuntimeMode({ nodeEnv: "production", mode: "full" })).toThrow(MoxRuntimeUnavailableError);
    expect(() => assertMoxRuntimeMode({ nodeEnv: "production", mode: "full", runtimeCommand: "mox-runtime" })).not.toThrow();
  });

  it("production rejects reference-like runtime capabilities after connection", () => {
    expect(() =>
      rejectReferenceRuntimeCapabilities({
        runtime: "mox-reference",
        protocolVersion: 1,
        capabilities: [...REQUIRED_RUNTIME_CAPABILITIES],
        tools: [],
      }),
    ).toThrow(MoxRuntimeUnavailableError);
  });
});

describe("tenant isolation", () => {
  it("hides runs of other orgs in listRuns", async () => {
    const client = new FakeRuntimeClient();
    const runtime = makeRuntime(client);
    await runtime.launch({ definition: definition(), orgId: "org-1", agentId: "a1", threadId: "t1", userInput: null });
    await runtime.launch({
      definition: definition({ orgId: "org-2", agentId: "agent-2" }),
      orgId: "org-2",
      agentId: "agent-2",
      threadId: "t2",
      userInput: null,
    });
    const forOrg1 = runtime.listRuns("org-1");
    expect(forOrg1).toHaveLength(1);
    expect(forOrg1[0]!.orgId).toBe("org-1");
  });

  it("refuses cross-tenant event replay", async () => {
    const client = new FakeRuntimeClient();
    const store = new InMemorySessionEventStore();
    const runtime = makeRuntime(client, store);
    const { runId } = await runtime.launch({
      definition: definition(),
      orgId: "org-1",
      agentId: "a1",
      threadId: "t1",
      userInput: null,
    });
    await store.append("org-1", runId, {
      eventId: crypto.randomUUID(),
      agentId: "a1",
      at: new Date().toISOString(),
      type: "turn.started",
    } as AgentEvent);
    await expect(runtime.replayEvents("org-2", runId)).rejects.toThrow("cross-tenant");
    await expect(runtime.replayEvents("org-1", runId)).resolves.toHaveLength(1);
  });

  it("event store rejects appends from a foreign org for an existing run", async () => {
    const store = new InMemorySessionEventStore();
    await store.append("org-1", "run-x", {
      eventId: crypto.randomUUID(),
      agentId: "a",
      at: new Date().toISOString(),
      type: "turn.started",
    } as AgentEvent);
    await expect(
      store.append("org-2", "run-x", {
        eventId: crypto.randomUUID(),
        agentId: "a",
        at: new Date().toISOString(),
        type: "turn.started",
      } as AgentEvent),
    ).rejects.toThrow("not owned by org");
  });
});

describe("supervision: cancel, crash/restart", () => {
  it("cancels a live run through the client", async () => {
    const client = new FakeRuntimeClient();
    const runtime = makeRuntime(client);
    const { runId } = await runtime.launch({
      definition: definition(),
      orgId: "org-1",
      agentId: "a1",
      threadId: "t1",
      userInput: null,
    });
    expect(await runtime.cancel(runId, "user asked")).toBe(true);
    expect(client.sent[client.sent.length - 1]!.method).toBe("run.cancel");
  });

  it("restarts after a crash within the bounded budget, resuming when a token exists", async () => {
    const client = new FakeRuntimeClient();
    const runtime = makeRuntime(client);
    const input = { definition: definition(), orgId: "org-1", agentId: "a1", threadId: "t1", userInput: "x" };
    const first = await runtime.launch(input);
    const again = await runtime.restartAfterCrash(first.runId, input, first.resumeToken);
    if (!("blocked" in again)) {
      expect(again.resumeToken).toBe(first.resumeToken);
      expect(client.sent[client.sent.length - 1]!.method).toBe("run.resume");
    } else {
      throw new Error("restart should be allowed within budget");
    }
  });

  it("blocks restarts after the budget is exhausted", async () => {
    const client = new FakeRuntimeClient();
    const runtime = makeRuntime(client);
    const input = { definition: definition(), orgId: "org-1", agentId: "a1", threadId: "t1", userInput: "x" };
    const first = await runtime.launch(input);
    await runtime.restartAfterCrash(first.runId, input); // restart 1 (max)
    const third = await runtime.restartAfterCrash(first.runId, input);
    expect("blocked" in third && third.blocked).toContain("max restarts");
  });

  it("shutdown cancels active runs then asks the runtime to stop", async () => {
    const client = new FakeRuntimeClient();
    const runtime = makeRuntime(client);
    await runtime.launch({ definition: definition(), orgId: "org-1", agentId: "a1", threadId: "t1", userInput: null });
    const result = await runtime.shutdown();
    expect(result.runsCancelled).toBe(1);
    const methods = client.sent.map((s) => s.method);
    expect(methods).toContain("runtime.shutdown");
    expect(methods[methods.length - 2]).toBe("run.cancel");
  });
});

describe("reference engine: model stub → tool gate → canonical events", () => {
  function makeToolRegistry(log: string[], opts: { danger: ToolDefinition["dangerLevel"] }) {
    const tools = new ToolRegistry();
    tools.register({
      definition: {
        name: "search" as never,
        displayName: "Search",
        description: "d",
        inputSchema: {},
        dangerLevel: opts.danger,
        requiresApproval: false,
      },
      execute: async (input) => {
        log.push("executed");
        return { echo: input };
      },
    });
    return tools;
  }

  it("read-only tool executes without approval and emits canonical events", async () => {
    const log: string[] = [];
    const tools = makeToolRegistry(log, { danger: "read-only" });
    const model: ModelStub = async () => ({ text: "hi", toolRequests: [{ toolName: "search", input: { q: "x" } }] });
    const engine = new ReferenceAgentEngine(model, new PermissionsPolicyEngine());
    const events: AgentEvent[] = [];
    const result = await engine.executeTurn({
      ctx: { runId: "r", orgId: "org-1", agentId: "agent-1", threadId: "t", approvedTools: new Set() },
      definition: definition(),
      userInput: null,
      runtimeConfig: {},
      emit: async (e) => {
        const { makeAgentEvent } = await import("../src/events.js");
        events.push(makeAgentEvent("agent-1", e));
      },
      askApproval: async () => "approved",
      shouldAbort: () => false,
      tools,
    });
    expect(log).toEqual(["executed"]);
    expect(result.output).toBe("hi");
    const types = events.map((e) => e.type);
    expect(types).toContain("message.completed");
    expect(types).toContain("tool.requested");
    expect(types).toContain("tool.completed");
    const completed = events.find((e) => e.type === "tool.completed")!;
    expect((completed as { ok: boolean }).ok).toBe(true);
  });

  it("dangerous tool requires approval: deny blocks execution", async () => {
    const log: string[] = [];
    const tools = makeToolRegistry(log, { danger: "destructive" });
    const model: ModelStub = async () => ({ toolRequests: [{ toolName: "search", input: {} }] });
    const engine = new ReferenceAgentEngine(model, new PermissionsPolicyEngine());
    const events: AgentEvent[] = [];
    await engine.executeTurn({
      ctx: { runId: "r", orgId: "org-1", agentId: "agent-1", threadId: "t", approvedTools: new Set() },
      definition: definition(),
      userInput: null,
      runtimeConfig: {},
      emit: async (e) => {
        const { makeAgentEvent } = await import("../src/events.js");
        events.push(makeAgentEvent("agent-1", e));
      },
      askApproval: async () => "denied",
      shouldAbort: () => false,
      tools,
    });
    expect(log).toEqual([]); // never executed
    const types = events.map((e) => e.type);
    expect(types).toContain("approval.opened");
    expect(types).toContain("approval.resolved");
    const completed = events.find((e) => e.type === "tool.completed") as { ok: boolean } | undefined;
    expect(completed?.ok).toBe(false);
  });

  it("approval granted: opens, executes once, resolves approved", async () => {
    const log: string[] = [];
    const tools = makeToolRegistry(log, { danger: "write" });
    const model: ModelStub = async () => ({ toolRequests: [{ toolName: "search", input: 1 }] });
    const engine = new ReferenceAgentEngine(model, new PermissionsPolicyEngine());
    const events: AgentEvent[] = [];
    await engine.executeTurn({
      ctx: { runId: "r", orgId: "org-1", agentId: "agent-1", threadId: "t", approvedTools: new Set() },
      definition: definition(),
      userInput: null,
      runtimeConfig: {},
      emit: async (e) => {
        const { makeAgentEvent } = await import("../src/events.js");
        events.push(makeAgentEvent("agent-1", e));
      },
      askApproval: async () => "approved",
      shouldAbort: () => false,
      tools,
    });
    expect(log).toEqual(["executed"]);
    const resolved = events.find((e) => e.type === "approval.resolved") as { outcome: string };
    expect(resolved.outcome).toBe("approved");
  });

  it("policy deny-list blocks even pre-approved tools", async () => {
    const log: string[] = [];
    const tools = makeToolRegistry(log, { danger: "read-only" });
    const model: ModelStub = async () => ({ toolRequests: [{ toolName: "search", input: 1 }] });
    const engine = new ReferenceAgentEngine(model, new PermissionsPolicyEngine());
    const events: AgentEvent[] = [];
    await engine.executeTurn({
      ctx: { runId: "r", orgId: "org-1", agentId: "agent-1", threadId: "t", approvedTools: new Set(["search"]) },
      definition: definition({ permissions: { toolPolicy: "default", deniedTools: ["search"] } }),
      userInput: null,
      runtimeConfig: {},
      emit: async (e) => {
        const { makeAgentEvent } = await import("../src/events.js");
        events.push(makeAgentEvent("agent-1", e));
      },
      askApproval: async () => "approved",
      shouldAbort: () => false,
      tools,
    });
    expect(log).toEqual([]);
    expect(events.some((e) => e.type === "tool.completed")).toBe(true);
  });
});
