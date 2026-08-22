import { describe, expect, it } from "vitest";
import {
  AgentDefinition,
  AgentEvent,
  ApprovalRequest,
  ComputerAction,
  DesiredState,
  ErrorClassification,
  ModelProvider,
  OperationRecord,
  healthyReport,
} from "../src/index.js";

const now = "2026-08-21T12:00:00Z";
const org = "org_test" as never;

function baseDefinition() {
  return {
    schemaVersion: 1,
    agentId: "agent_1",
    orgId: org,
    slug: "helper-bot",
    identity: { displayName: "Helper" },
    instructions: { text: "You are helpful." },
    model: { providerId: "prov_openai", modelId: "model_gpt" },
    tools: { toolNames: ["web.search"], integrations: [] },
    skills: [],
    knowledge: [],
    computer: { enabled: false, allowBrowser: true, sandbox: "container" },
    voice: { enabled: false },
    channels: [],
    deployment: { kind: "sandbox" },
    permissions: { toolPolicy: "default" },
    memory: { enabled: true, scope: "thread" },
    schedules: [],
    workflows: [],
    subagents: [],
    authoring: { mode: "simple" },
    metadata: {},
    createdAt: now,
    updatedAt: now,
  };
}

describe("AgentDefinition", () => {
  it("accepts a valid definition", () => {
    const parsed = AgentDefinition.parse(baseDefinition());
    expect(parsed.identity.displayName).toBe("Helper");
  });

  it("rejects an unknown deployment target kind", () => {
    const bad = { ...baseDefinition(), deployment: { kind: "mars" } };
    expect(() => AgentDefinition.parse(bad)).toThrow();
  });

  it("rejects a bad timestamp", () => {
    const bad = { ...baseDefinition(), createdAt: "yesterday" };
    expect(() => AgentDefinition.parse(bad)).toThrow();
  });

  it("keeps authoring mode as metadata only (same schema for simple and developer)", () => {
    const simple = AgentDefinition.parse({ ...baseDefinition(), authoring: { mode: "simple" } });
    const dev = AgentDefinition.parse({ ...baseDefinition(), authoring: { mode: "developer" } });
    expect(simple.authoring.mode).toBe("simple");
    expect(dev.authoring.mode).toBe("developer");
  });
});

describe("AgentEvent", () => {
  it("discriminates event kinds", () => {
    const delta = AgentEvent.parse({
      type: "message.delta",
      eventId: "evt_1",
      agentId: "agent_1",
      messageId: "msg_1",
      delta: "Hel",
      at: now,
    });
    if (delta.type !== "message.delta") throw new Error("wrong kind");
    expect(delta.delta).toBe("Hel");
    expect(() =>
      AgentEvent.parse({ type: "message.delta", eventId: "evt_2", agentId: "agent_1", at: now }),
    ).toThrow();
  });
});

describe("ComputerAction", () => {
  it("discriminates action kinds", () => {
    const click = ComputerAction.parse({ kind: "click", x: 10, y: 20 });
    expect(click.kind).toBe("click");
    expect(() => ComputerAction.parse({ kind: "teleport" })).toThrow();
  });
});

describe("ModelProvider", () => {
  it("carries vendor data only in extension", () => {
    const provider = ModelProvider.parse({
      providerId: "prov_grok_cli",
      displayName: "Grok (CLI)",
      kind: "cli-proxy",
      capabilities: ["chat", "tools"],
      health: healthyReport(now),
      extension: { binary: "grok", acp: true },
    });
    expect(provider.extension?.["binary"]).toBe("grok");
  });
});

describe("reconciliation", () => {
  it("classifies terminal vs retryable errors", () => {
    const terminal = ErrorClassification.parse({ kind: "terminal", code: "quota_exhausted", message: "no quota" });
    const retryable = ErrorClassification.parse({
      kind: "retryable",
      code: "throttled",
      message: "slow down",
      attempts: 1,
      maxAttempts: 5,
    });
    expect(terminal.kind).toBe("terminal");
    if (retryable.kind !== "retryable") throw new Error("expected retryable");
    expect(retryable.maxAttempts).toBe(5);
    expect(() => ErrorClassification.parse({ kind: "retryable", code: "x", message: "y" })).toThrow();
  });

  it("validates DesiredState and OperationRecord", () => {
    const desired = DesiredState.parse({
      desiredStateId: "ds_1",
      orgId: org,
      resourceKind: "compute-instance",
      resourceId: "res_1",
      revision: 3,
      spec: { computeClass: "small", region: "us-east" },
      specHash: "abcdef123456",
      createdAt: now,
      updatedAt: now,
    });
    expect(desired.revision).toBe(3);

    const op = OperationRecord.parse({
      operationId: "op_1",
      idempotencyKey: "idem-key-0001",
      orgId: org,
      resourceKind: "compute-instance",
      resourceId: "res_1",
      phase: "applying",
      providerRequestId: "req_9",
      retry: { attempts: 2, maxAttempts: 5 },
      createdAt: now,
      updatedAt: now,
    });
    expect(op.phase).toBe("applying");
    expect(() =>
      OperationRecord.parse({ ...op, idempotencyKey: "short" }),
    ).toThrow();
  });
});

describe("ApprovalRequest", () => {
  it("tracks open/resolved state", () => {
    const approval = ApprovalRequest.parse({
      approvalId: "apr_1",
      orgId: org,
      agentId: "agent_1",
      kind: "computer-action",
      summary: "Click confirm button",
      payload: { kind: "click", x: 1, y: 2 },
      state: "open",
      requestedAt: now,
    });
    expect(approval.state).toBe("open");
  });
});