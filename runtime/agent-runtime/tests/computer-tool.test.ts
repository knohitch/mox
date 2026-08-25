import { describe, expect, it } from "vitest";
import { ApprovalId, type AgentDefinition, type JsonValue, OrgId } from "@mox/contracts";
import { PolicyEngine } from "@mox/policy";
import { mintGatewayToken } from "@mox/security";
import {
  ComputerGateway,
  createComputerTool,
  PlaywrightComputerProvider,
  StaticEntitlementChecker,
  type ComputerAuditSink,
} from "@mox/computer-runtime";
import {
  PermissionsPolicyEngine,
  ReferenceAgentEngine,
  ToolRegistry,
  type ApprovalQuestion,
} from "../src/index.js";

/**
 * End-to-end proof that Mox Runtime uses Mox Computer Gateway for
 * computer/browser side effects. A reference-engine run issues a
 * `computer` tool request; the request flows runtime gate → gateway
 * (entitlement → policy → approval → audit) → provider — and nothing else can
 * reach the provider.
 */

// Real wall-clock base: gateway token verification uses the default real-time
// clock, so tests anchor token minting and policy clocks to it.
const NOW = new Date();
const GATEWAY_SECRET = "test-gateway-secret-Ab3#x9KpQw7Tz2Lm5Vr8Ys1Nc";

function definition(): AgentDefinition {
  return {
    schemaVersion: 1,
    agentId: "agent-1",
    displayName: "Browser Agent",
    systemInstructions: "Use the computer tool when asked to browse.",
    permissions: { toolPolicy: "default" },
    computer: { enabled: true, allowBrowser: true, sandbox: "container" },
  } as unknown as AgentDefinition;
}

interface World {
  registry: ToolRegistry;
  provider: PlaywrightComputerProvider;
  auditEvents: Array<{ action: string; outcome: string }>;
  sessionId: () => string | undefined;
}

function world(orgId: string, agentId: string): World {
  const provider = new PlaywrightComputerProvider();
  const auditEvents: Array<{ action: string; outcome: string }> = [];
  const audit: ComputerAuditSink = {
    record: async (e) => void auditEvents.push({ action: e.action, outcome: e.outcome }),
  };
  const gateway = new ComputerGateway({
    provider,
    policy: new PolicyEngine({
      rules: [{ ruleId: "allow-computer", effect: "allow", expression: `orgId == ${orgId}` }],
      defaultEffect: "deny",
      now: () => NOW,
    }),
    entitlements: StaticEntitlementChecker.allowAll(),
    gatewaySecret: GATEWAY_SECRET,
    approvals: {
      requestApproval: async (input) => ({
        approvalId: ApprovalId.parse("apr-e2e"),
        orgId: OrgId.parse(input.orgId),
        agentId: input.agentId,
        kind: "computer-action",
        summary: input.summary,
        payload: input.payload as JsonValue,
        state: "approved",
        requestedAt: NOW.toISOString(),
        resolvedAt: NOW.toISOString(),
      }),
      grantScopeFor: () => ({ scope: {}, ttlSeconds: 300 }),
    },
    audit,
  });

  const tool = createComputerTool({
    gateway,
    orgId,
    agentId,
    // Host-minted, session-bound tokens; "bootstrap" proves scope for open.
    tokenFor: (sessionId) =>
      mintGatewayToken({ orgId, agentId, sessionId, ttlSeconds: 3600 }, NOW, GATEWAY_SECRET).token,
  });

  const registry = new ToolRegistry();
  registry.register(tool);

  const w = {
    registry,
    provider,
    auditEvents,
    sessionId: () => tool.sessionId(),
  };
  return w;
}

describe("computer tool over the reference engine (Mox Runtime to gateway to provider)", () => {
  it("routes model-requested browser actions through the gateway to the provider", async () => {
    const w = world("org-1", "agent-1");
    const engine = new ReferenceAgentEngine(async () => ({
      text: undefined,
      toolRequests: [
        { toolName: "computer", input: { action: { kind: "navigate", url: "https://example.com/" } } },
        { toolName: "computer", input: { action: { kind: "screenshot" } } },
      ],
    }), new PermissionsPolicyEngine());

    const events: Array<{ type: string; ok?: boolean }> = [];
    const result = await engine.executeTurn({
      ctx: {
        runId: "run-1",
        orgId: "org-1",
        agentId: "agent-1",
        threadId: "t1",
        approvedTools: new Set(["computer"]),
      },
      definition: definition(),
      userInput: "browse example.com",
      runtimeConfig: {},
      emit: async (e) => void events.push({ type: e.type, ok: (e as { ok?: boolean }).ok }),
      askApproval: async (_q: ApprovalQuestion) => "approved",
      shouldAbort: () => false,
      tools: w.registry,
    });

    expect(result.output).not.toBeNull();
    const completed = events.filter((e) => e.type === "tool.completed");
    expect(completed).toHaveLength(2);
    expect(completed.every((e) => e.ok !== false)).toBe(true);
    expect(w.sessionId()).toBeDefined();
    expect(w.auditEvents.some((a) => a.action === "computer.session.open")).toBe(true);
    expect(w.auditEvents.filter((a) => a.action === "computer.navigate" && a.outcome === "success")).toHaveLength(1);
    expect(w.auditEvents.filter((a) => a.action === "computer.read" && a.outcome === "success")).toHaveLength(1);
  });

  it("gateway denial surfaces as a failed tool result, not a crash", async () => {
    const auditEvents: string[] = [];
    const denyGateway = new ComputerGateway({
      provider: new PlaywrightComputerProvider(),
      gatewaySecret: GATEWAY_SECRET,
      policy: new PolicyEngine({
        rules: [{ ruleId: "no-nav", effect: "deny", expression: 'effectClass == "navigate"' }],
        now: () => NOW,
      }),
      entitlements: StaticEntitlementChecker.allowAll(),
      approvals: {
        requestApproval: async (i) => ({
          approvalId: ApprovalId.parse("apr-x"),
          orgId: OrgId.parse(i.orgId),
          agentId: i.agentId,
          kind: "computer-action",
          summary: i.summary,
          payload: i.payload as JsonValue,
          state: "denied",
          requestedAt: NOW.toISOString(),
          resolvedAt: NOW.toISOString(),
        }),
        grantScopeFor: () => ({ scope: {}, ttlSeconds: 0 }),
      },
      audit: { record: async (e) => void auditEvents.push(e.action) },
    });
    const registry = new ToolRegistry();
    registry.register(
      createComputerTool({
        gateway: denyGateway,
        orgId: "org-1",
        agentId: "agent-1",
        tokenFor: (sessionId) =>
          mintGatewayToken({ orgId: "org-1", agentId: "agent-1", sessionId, ttlSeconds: 60 }, NOW, GATEWAY_SECRET).token,
      }),
    );

    const engine = new ReferenceAgentEngine(async () => ({
      toolRequests: [{ toolName: "computer", input: { action: { kind: "navigate", url: "https://example.com/" } } }],
    }), new PermissionsPolicyEngine());

    let failedOutput: unknown;
    await engine.executeTurn({
      ctx: {
        runId: "run-2",
        orgId: "org-1",
        agentId: "agent-1",
        threadId: "t2",
        approvedTools: new Set(["computer"]),
      },
      definition: definition(),
      userInput: "browse",
      runtimeConfig: {},
      emit: async (e) => {
        if (e.type === "tool.completed") failedOutput = (e as unknown as { output: unknown }).output;
      },
      askApproval: async () => "approved",
      shouldAbort: () => false,
      tools: registry,
    });
    const text = JSON.stringify(failedOutput);
    expect(text).toContain("denied by rule no-nav");
    expect(auditEvents).toContain("computer.navigate");
  });

  it("the runtime seam does not open a second approval flow for computer actions", async () => {
    const w = world("org-1", "agent-1");
    const engine = new ReferenceAgentEngine(async () => ({
      toolRequests: [{ toolName: "computer", input: { action: { kind: "screenshot" } } }],
    }), new PermissionsPolicyEngine());

    let approvalsAsked = 0;
    await engine.executeTurn({
      ctx: {
        runId: "run-3",
        orgId: "org-1",
        agentId: "agent-1",
        threadId: "t3",
        approvedTools: new Set(["computer"]),
      },
      definition: definition(),
      userInput: "screenshot",
      runtimeConfig: {},
      emit: async (e) => {
        if (e.type === "approval.opened") approvalsAsked += 1;
      },
      askApproval: async () => {
        approvalsAsked += 1;
        return "approved";
      },
      shouldAbort: () => false,
      tools: w.registry,
    });
    expect(approvalsAsked).toBe(0); // unified approval lives in the gateway only
    expect(w.auditEvents.some((a) => a.action === "computer.read")).toBe(true);
  });
});
