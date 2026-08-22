import { describe, expect, it } from "vitest";
import { AgentEvent } from "@mox/contracts";
import {
  RunStartRequest,
  RunResumeRequest,
  RunCancelRequest,
  ApprovalRespondRequest,
  HealthResult,
  RPC_ERROR,
  RpcResponse,
  StreamEventParams,
} from "../src/protocol.js";

const definition = () => ({
  schemaVersion: 1,
  agentId: "agent-1",
  orgId: "org-1",
  slug: "test-agent",
  identity: { displayName: "Test Agent" },
  instructions: { text: "do things" },
  model: { providerId: "stub", modelId: "stub-1" },
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
});

describe("runtime wire protocol", () => {
  it("accepts a valid RunStartRequest with a full AgentDefinition", () => {
    const parsed = RunStartRequest.parse({
      runId: "run-1",
      orgId: "org-1",
      agentId: "agent-1",
      threadId: "thread-1",
      definition: definition(),
      runtimeConfig: { model: { provider: "stub" } },
    });
    expect(parsed.definition.agentId).toBe("agent-1");
  });

  it("rejects an invalid AgentDefinition on the wire", () => {
    const bad = definition();
    (bad as Record<string, unknown>).schemaVersion = 2;
    expect(() =>
      RunStartRequest.parse({
        runId: "run-1",
        orgId: "org-1",
        agentId: "agent-1",
        threadId: "thread-1",
        definition: bad,
        runtimeConfig: {},
      }),
    ).toThrow();
  });

  it("requires resumeToken for run.resume", () => {
    const base = {
      runId: "run-2",
      orgId: "org-1",
      agentId: "agent-1",
      threadId: "thread-1",
      definition: definition(),
      runtimeConfig: {},
    };
    expect(RunResumeRequest.safeParse(base).success).toBe(false);
    expect(RunResumeRequest.safeParse({ ...base, resumeToken: "tok" }).success).toBe(true);
  });

  it("validates approval outcomes are only approved|denied", () => {
    expect(
      ApprovalRespondRequest.safeParse({ approvalId: "a1", outcome: "approved" }).success,
    ).toBe(true);
    expect(
      ApprovalRespondRequest.safeParse({ approvalId: "a1", outcome: "maybe" }).success,
    ).toBe(false);
  });

  it("validates cancel requests carry a run id", () => {
    expect(RunCancelRequest.safeParse({}).success).toBe(false);
    expect(RunCancelRequest.safeParse({ runId: "r1" }).success).toBe(true);
  });

  it("round-trips a JSON-RPC response envelope", () => {
    const raw = { jsonrpc: "2.0", id: 3, result: { ok: true } };
    const parsed = RpcResponse.parse(JSON.parse(JSON.stringify(raw)));
    expect(parsed.id).toBe(3);
  });

  it("exposes canonical error codes including runtime failure range", () => {
    expect(RPC_ERROR.runtimeFailure).toBe(-32000);
    expect(RPC_ERROR.busy).toBe(-32001);
  });

  it("parses streamed canonical agent events and rejects unknown shapes", () => {
    const params = {
      runId: "run-1",
      event: AgentEvent.parse({
        eventId: crypto.randomUUID(),
        agentId: "agent-1",
        at: new Date().toISOString(),
        type: "turn.started",
      }),
    };
    expect(StreamEventParams.parse(params).event.type).toBe("turn.started");
    expect(StreamEventParams.safeParse({ runId: "run-1", event: { type: "bogus" } }).success).toBe(false);
  });

  it("health results require version and counters", () => {
    expect(HealthResult.safeParse({ ok: true, uptimeMs: 1, activeRuns: 0 }).success).toBe(false);
    expect(
      HealthResult.safeParse({ ok: true, uptimeMs: 1, activeRuns: 0, version: "0.1.0" }).success,
    ).toBe(true);
  });
});
