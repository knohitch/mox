import { describe, expect, it } from "vitest";
import { ApprovalId, type AuditEvent, type ComputerAction, type JsonValue, OrgId, UserId } from "@mox/contracts";
import { PolicyEngine } from "@mox/policy";
import { EgressPolicy, mintGatewayToken } from "@mox/security";
import {
  ComputerGateway,
  GatewayRejectedError,
  PlaywrightComputerProvider,
  StaticEntitlementChecker,
  type ApprovalFlow,
  type ComputerAuditSink,
  type EntitlementChecker,
} from "../src/index.js";

const ORG = "org-1";
const AGENT = "agent-1";
const SESSION = "sess-1";
// Real wall-clock base: gateway methods verify tokens with their default
// (real-time) clock unless explicitly overridden, so tests anchor to it.
const NOW = new Date();

function tokenFor(orgId = ORG, agentId = AGENT, sessionId = SESSION, ttlSeconds = 3600): string {
  return mintGatewayToken({ orgId, agentId, sessionId, ttlSeconds }, NOW).token;
}

function allowAllPolicy(): PolicyEngine {
  return new PolicyEngine({
    rules: [{ ruleId: "allow-computer", effect: "allow", expression: "orgId == org-1" }],
    defaultEffect: "deny",
    now: () => NOW,
  });
}

/** Provider spy so tests can prove whether the provider was reached. */
class CountingProvider extends PlaywrightComputerProvider {
  executed = 0;
  override async execute(
    sessionId: string,
    resolved: Parameters<PlaywrightComputerProvider["execute"]>[1],
  ) {
    this.executed += 1;
    return super.execute(sessionId, resolved);
  }
}

interface Harness {
  gateway: ComputerGateway;
  provider: CountingProvider;
  policy: PolicyEngine;
  auditEvents: AuditEvent[];
  approvals: { requests: number; outcome: "approved" | "denied"; grantTtlSeconds: number };
}

function harness(overrides: Partial<Parameters<typeof buildGateway>[0]> = {}): Harness {
  const provider = new CountingProvider();
  const policy = overrides.policy ?? allowAllPolicy();
  const auditEvents: AuditEvent[] = [];
  const audit: ComputerAuditSink = { record: async (e) => void auditEvents.push(e) };
  const approvals = { requests: 0, outcome: "approved" as "approved" | "denied", grantTtlSeconds: 300 };
  const approvalFlow: ApprovalFlow = {
    requestApproval: async (input) => {
      approvals.requests += 1;
      return {
        approvalId: ApprovalId.parse(`apr-${approvals.requests}`),
        orgId: OrgId.parse(input.orgId),
        agentId: input.agentId,
        kind: "computer-action",
        summary: input.summary,
        payload: input.payload as JsonValue,
        state: approvals.outcome,
        requestedAt: NOW.toISOString(),
        resolvedAt: NOW.toISOString(),
        resolvedBy: UserId.parse("user-7"),
      };
    },
    grantScopeFor: () => ({ scope: {} as Record<string, string>, ttlSeconds: approvals.grantTtlSeconds }),
  };
  const gateway = buildGateway({ provider, policy, audit, approvalFlow, ...overrides });
  return { gateway, provider, policy, auditEvents, approvals };
}

function buildGateway(args: {
  provider: CountingProvider;
  policy: PolicyEngine;
  audit: ComputerAuditSink;
  approvalFlow: ApprovalFlow;
  entitlements?: EntitlementChecker;
  egress?: EgressPolicy;
  maxSessionsPerOrg?: number;
}): ComputerGateway {
  return new ComputerGateway({
    provider: args.provider,
    policy: args.policy,
    entitlements: args.entitlements ?? StaticEntitlementChecker.allowAll(),
    approvals: args.approvalFlow,
    audit: args.audit,
    egress: args.egress,
    maxSessionsPerOrg: args.maxSessionsPerOrg,
  });
}

async function open(h: Harness): Promise<string> {
  // Deterministic session id so every tokenFor() (claims.sessionId=SESSION)
  // stays session-bound, mirroring control-plane-assigned ids.
  const opened = await h.gateway.openSession(tokenFor(), { requestedSessionId: SESSION });
  return opened.sessionId;
}

describe("ComputerGateway — browser action happy path", () => {
  it("opens a session and executes a navigate + screenshot through policy", async () => {
    const h = harness();
    const sessionId = await open(h);

    const nav = await h.gateway.executeAction(
      tokenFor(),
      sessionId,
      { kind: "navigate", url: "https://example.com/" } satisfies ComputerAction,
      { url: "https://example.com/", host: "example.com" },
      NOW,
    );
    expect(nav.outcome.ok).toBe(true);
    expect(nav.decision.effect).toBe("allow");

    const shot = await h.gateway.executeAction(
      tokenFor(),
      sessionId,
      { kind: "screenshot" } satisfies ComputerAction,
      { url: "https://example.com/", host: "example.com" },
      NOW,
    );
    expect(shot.outcome.ok).toBe(true);
    expect(h.provider.executed).toBe(2);
    // Audited: session open + one allow per action.
    expect(h.auditEvents.filter((e) => e.outcome === "success")).toHaveLength(3);
  });

  it("session state is per agent/provider and screencast metadata carries no secrets", async () => {
    const h = harness();
    const sessionId = await open(h);
    await h.gateway.startTakeover(tokenFor(), sessionId, "user-7");
    const info = (await h.gateway.getScreencastInfo(tokenFor(), sessionId)) as Record<string, unknown>;
    expect(info.humanControl).toBe(true);
    expect(info.transport).toBe("cdp-screencast");
    // Session identifiers are secret-shaped: they must never ride along.
    expect(JSON.stringify(info)).not.toContain(sessionId);
  });
});

describe("ComputerGateway — unauthorized direct browser access", () => {
  it("rejects missing/garbage/expired tokens BEFORE provider or policy runs", async () => {
    const h = harness();
    for (const bad of ["", "garbage", mintGatewayToken({ orgId: ORG, agentId: AGENT, sessionId: SESSION, ttlSeconds: -1 }, NOW).token]) {
      await expect(h.gateway.openSession(bad, {})).rejects.toMatchObject({ code: "unauthorized" });
    }
    await expect(
      h.gateway.executeAction("", SESSION, { kind: "screenshot" }, undefined, NOW),
    ).rejects.toMatchObject({ code: "unauthorized" });
    expect(h.provider.executed).toBe(0);
    expect(h.auditEvents).toHaveLength(0);
  });

  it("an agent cannot bypass policy by addressing a session directly", async () => {
    const h = harness();
    await open(h);
    // A token bound to a DIFFERENT session is a direct-access attempt even
    // when org/agent match — no session hopping, no provider reach.
    await expect(
      h.gateway.executeAction(
        mintGatewayToken({ orgId: ORG, agentId: AGENT, sessionId: "other-session", ttlSeconds: 60 }, NOW).token,
        SESSION,
        { kind: "click", x: 1, y: 2 },
        undefined,
        NOW,
      ),
    ).rejects.toMatchObject({ code: "unauthorized" });
    const denial = h.auditEvents.find((e) => e.action === "computer.action");
    expect(denial?.outcome).toBe("denied");
    expect(h.provider.executed).toBe(0);
  });
});

describe("ComputerGateway — isolation", () => {
  it("cross-agent use of another agent's session is rejected", async () => {
    const h = harness();
    const sessionId = await open(h);
    await expect(
      h.gateway.executeAction(
        tokenFor(ORG, "agent-2"),
        sessionId,
        { kind: "screenshot" },
        undefined,
        NOW,
      ),
    ).rejects.toMatchObject({ code: "unauthorized" });
    const denial = h.auditEvents.find((e) => e.action === "computer.action");
    expect(denial?.outcome).toBe("denied");
    expect(h.provider.executed).toBe(0);
  });

  it("cross-tenant use is rejected and sessions never leak across orgs", async () => {
    const h = harness();
    const sessionId = await open(h);
    await expect(
      h.gateway.openSession(tokenFor("org-2", AGENT), {}),
    ).resolves.toBeDefined();
    await expect(
      h.gateway.executeAction(tokenFor("org-2", AGENT), sessionId, { kind: "screenshot" }, undefined, NOW),
    ).rejects.toMatchObject({ code: "unauthorized" });
    await expect(
      h.gateway.closeSession(tokenFor("org-2", AGENT), sessionId),
    ).rejects.toMatchObject({ code: "unknown-session" });
    expect(h.provider.executed).toBe(0);
  });

  it("unknown sessions are refused (token bound to the missing session)", async () => {
    const h = harness();
    await expect(
      h.gateway.executeAction(
        mintGatewayToken({ orgId: ORG, agentId: AGENT, sessionId: "nope", ttlSeconds: 60 }, NOW).token,
        "nope",
        { kind: "screenshot" },
        undefined,
        NOW,
      ),
    ).rejects.toMatchObject({ code: "unknown-session" });
  });
});

describe("ComputerGateway — policy outcomes", () => {
  it("deny rules block actions and the provider is never called", async () => {
    const policy = new PolicyEngine({
      rules: [{ ruleId: "no-nav", effect: "deny", expression: 'effectClass == "navigate"' }],
      defaultEffect: "ask",
      now: () => NOW,
    });
    const h = harness({ policy });
    const sessionId = await open(h);
    await expect(
      h.gateway.executeAction(tokenFor(), sessionId, { kind: "navigate", url: "https://example.com/" }, undefined, NOW),
    ).rejects.toMatchObject({ code: "denied" });
    expect(h.provider.executed).toBe(0);
  });

  it("not-entitled orgs are refused before any policy work", async () => {
    const entitlements = new StaticEntitlementChecker({}, "plan lacks computer");
    const h = harness({ entitlements });
    await expect(h.gateway.openSession(tokenFor(), {})).rejects.toMatchObject({ code: "not-entitled" });
    expect(h.auditEvents.filter((e) => e.action === "computer.session.open")).toHaveLength(0);
  });

  it("shell requires its own entitlement", async () => {
    const strict = new StaticEntitlementChecker({ computer: true, shell: false });
    const h = harness({ entitlements: strict });
    await h.gateway.openSession(tokenFor(), { requestedSessionId: SESSION });
    await expect(
      h.gateway.executeAction(tokenFor(), SESSION, { kind: "execute", command: "ls" }, undefined, NOW),
    ).rejects.toMatchObject({ code: "not-entitled" });
    expect(h.provider.executed).toBe(0);
  });
});

describe("ComputerGateway — human approval flow", () => {
  function askPolicy(): PolicyEngine {
    return new PolicyEngine({ defaultEffect: "ask", now: () => NOW });
  }

  it("needs-approval → approved grant re-decides to allow and executes once", async () => {
    const h = harness({ policy: askPolicy() });
    h.approvals.outcome = "approved";
    const sessionId = await open(h);
    const res = await h.gateway.executeAction(
      tokenFor(),
      sessionId,
      { kind: "navigate", url: "https://example.com/" },
      undefined,
      NOW,
    );
    expect(res.decision.effect).toBe("allow");
    expect(res.decision.reason).toContain("apr-1");
    expect(h.provider.executed).toBe(1);
    expect(h.policy.listGrants()).toHaveLength(1);
  });

  it("denied approval results in refusal with no execution", async () => {
    const h = harness({ policy: askPolicy() });
    h.approvals.outcome = "denied";
    const sessionId = await open(h);
    await expect(
      h.gateway.executeAction(tokenFor(), sessionId, { kind: "navigate", url: "https://example.com/" }, undefined, NOW),
    ).rejects.toMatchObject({ code: "approval-denied" });
    expect(h.provider.executed).toBe(0);
  });

  it("grants expire per TTL; after expiry a fresh approval is required", async () => {
    let t = Date.now();
    const clocked = new PolicyEngine({ defaultEffect: "ask", now: () => new Date(t) });
    const h = harness({ policy: clocked });
    h.approvals.grantTtlSeconds = 60;
    const sessionId = await open(h);

    await h.gateway.executeAction(tokenFor(), sessionId, { kind: "navigate", url: "https://example.com/" }, undefined, new Date(t));
    expect(h.policy.listGrants()).toHaveLength(1);
    expect(h.approvals.requests).toBe(1);

    t += 61_000; // advance the policy clock past the grant TTL
    h.approvals.outcome = "denied"; // no fresh human consent → refusal
    await expect(
      h.gateway.executeAction(
        tokenFor(),
        sessionId,
        { kind: "navigate", url: "https://example.com/2" },
        undefined,
        new Date(t),
      ),
    ).rejects.toMatchObject({ code: "approval-denied" });
    expect(h.approvals.requests).toBe(2); // expired grant forced a new approval attempt
  });
});

describe("ComputerGateway — resource limits & crash recovery", () => {
  it("enforces maxSessionsPerOrg", async () => {
    const h = harness({ maxSessionsPerOrg: 2 });
    await h.gateway.openSession(tokenFor(ORG, AGENT, "s1"), {});
    await h.gateway.openSession(tokenFor(ORG, AGENT, "s2"), {});
    await expect(h.gateway.openSession(tokenFor(ORG, AGENT, "s3"), {})).rejects.toMatchObject({
      code: "limit-exceeded",
    });
  });

  it("duplicate explicit session ids collide instead of hijacking", async () => {
    const h = harness();
    await h.gateway.openSession(tokenFor(), { requestedSessionId: SESSION });
    await expect(h.gateway.openSession(tokenFor(), { requestedSessionId: SESSION })).rejects.toMatchObject({
      code: "unknown-session",
    });
  });

  it("provider crash drops ownership; the session can be re-opened (restart)", async () => {
    const h = harness();
    const sessionId = await open(h);
    await h.gateway.handleProviderCrash(sessionId, "chromium exited code 1");
    await expect(
      h.gateway.executeAction(tokenFor(), sessionId, { kind: "screenshot" }, undefined, NOW),
    ).rejects.toMatchObject({ code: "unknown-session" });
    const reopened = await h.gateway.openSession(tokenFor(), { requestedSessionId: sessionId });
    expect(reopened.sessionId).toBe(sessionId);
  });
});

describe("ComputerGateway — egress controls", () => {
  const egress = new EgressPolicy({
    allow: [{ host: ".trusted.test", action: "allow" }],
    deny: [{ host: "blocked.trusted.test", action: "deny" }],
  });

  it("allowed destinations navigate normally", async () => {
    const h = harness({ egress });
    const sessionId = await open(h);
    const res = await h.gateway.executeAction(
      tokenFor(),
      sessionId,
      { kind: "navigate", url: "https://app.trusted.test/" },
      undefined,
      NOW,
    );
    expect(res.outcome.ok).toBe(true);
  });

  it("egress-denied destinations refuse before policy or provider run", async () => {
    const h = harness({ egress });
    const sessionId = await open(h);
    await expect(
      h.gateway.executeAction(
        tokenFor(),
        sessionId,
        { kind: "navigate", url: "https://evil.example.net/" },
        undefined,
        NOW,
      ),
    ).rejects.toMatchObject({ code: "denied" });
    await expect(
      h.gateway.executeAction(
        tokenFor(),
        sessionId,
        { kind: "navigate", url: "https://blocked.trusted.test/" },
        undefined,
        NOW,
      ),
    ).rejects.toMatchObject({ code: "denied" });
    const navDenials = h.auditEvents.filter((e) => e.action === "computer.navigate" && e.outcome === "denied");
    expect(navDenials.length).toBe(2);
    expect(h.provider.executed).toBe(0); // nothing reached the browser
  });
});

describe("ComputerGateway — human takeover", () => {
  it("takeover pauses agent actions; end resumes them", async () => {
    const h = harness();
    const sessionId = await open(h);

    await h.gateway.startTakeover(tokenFor(), sessionId, "user-7");
    const paused = await h.gateway.executeAction(
      tokenFor(),
      sessionId,
      { kind: "type", text: "hello" },
      undefined,
      NOW,
    );
    expect(paused.outcome.ok).toBe(false);
    expect(JSON.stringify(paused.outcome.output)).toContain("human has control");
    // Reads still work during takeover.
    const shot = await h.gateway.executeAction(tokenFor(), sessionId, { kind: "screenshot" }, undefined, NOW);
    expect(shot.outcome.ok).toBe(true);

    await h.gateway.endTakeover(tokenFor(), sessionId);
    const resumed = await h.gateway.executeAction(
      tokenFor(),
      sessionId,
      { kind: "type", text: "hello" },
      undefined,
      NOW,
    );
    expect(resumed.outcome.ok).toBe(true);
    expect(h.auditEvents.some((e) => e.action === "computer.takeover.start")).toBe(true);
    expect(h.auditEvents.some((e) => e.action === "computer.takeover.end")).toBe(true);
  });

  it("takeover cannot be started against another org's session", async () => {
    const h = harness();
    const sessionId = await open(h);
    await expect(h.gateway.startTakeover(tokenFor("org-9"), sessionId, "intruder")).rejects.toMatchObject({
      code: "unknown-session",
    });
  });
});

describe("GatewayRejectedError", () => {
  it("is an Error with a stable code and name", () => {
    const err = new GatewayRejectedError("denied", "nope");
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("denied");
    expect(err.name).toBe("GatewayRejectedError");
  });
});
