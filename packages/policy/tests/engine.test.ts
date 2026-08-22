import { describe, expect, it } from "vitest";
import {
  matchExpression,
  PolicyEngine,
  type PolicyAuditEntry,
  type PolicyContext,
} from "../src/index.js";

function ctx(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    orgId: "org-1",
    agentId: "agent-1",
    sessionId: "run-1",
    tool: { name: "computer_navigate", dangerLevel: "write" },
    page: { url: "https://example.com/x", host: "example.com" },
    effectClass: "navigate",
    ...overrides,
  };
}

describe("PolicyEngine decision precedence", () => {
  it("allows when an explicit allow rule matches", async () => {
    const engine = new PolicyEngine({
      rules: [{ ruleId: "allow-nav", effect: "allow", expression: 'effectClass == "navigate"' }],
      defaultEffect: "deny",
    });
    const d = await engine.decide(ctx());
    expect(d.effect).toBe("allow");
    expect(d.ruleId).toBe("allow-nav");
  });

  it("denies by rule and deny beats allow regardless of order", async () => {
    const engine = new PolicyEngine({
      rules: [
        { ruleId: "allow-all", effect: "allow", expression: "orgId == org-1" },
        { ruleId: "deny-admin", effect: "deny", expression: 'page.host == "admin.example.com"' },
      ],
    });
    const denied = await engine.decide(ctx({ page: { url: "https://admin.example.com/", host: "admin.example.com" } }));
    expect(denied.effect).toBe("deny");
    expect(denied.ruleId).toBe("deny-admin");
  });

  it("broken deny expression denies (fail closed)", async () => {
    const engine = new PolicyEngine({
      rules: [{ ruleId: "typo", effect: "deny", expression: "(((" }],
      defaultEffect: "allow" as never,
    });
    const d = await engine.decide(ctx());
    // Even a default of allow cannot rescue a broken deny.
    expect(d.effect).toBe("deny");
    expect(d.reason).toContain("fail closed");
  });

  it("broken allow expression is skipped, not fatal, and does not allow", async () => {
    const engine = new PolicyEngine({
      rules: [{ ruleId: "broken-allow", effect: "allow", expression: "(((" }],
      defaultEffect: "deny",
    });
    const d = await engine.decide(ctx());
    expect(d.effect).toBe("deny");
  });

  it("falls back to default ask when nothing matches", async () => {
    const engine = new PolicyEngine({ defaultEffect: "ask" });
    const d = await engine.decide(ctx());
    expect(d.effect).toBe("needs-approval");
    expect(d.reason).toContain("default effect is ask");
  });

  it("falls back to default deny (OpenBot default) when nothing matches", async () => {
    const engine = new PolicyEngine({});
    const d = await engine.decide(ctx());
    expect(d.effect).toBe("deny");
  });
});

describe("matchExpression", () => {
  it("matches dotted paths with == and !=", () => {
    expect(matchExpression('tool.name == "computer_navigate"', ctx())).toBe(true);
    expect(matchExpression('tool.name != "computer_navigate"', ctx())).toBe(false);
    expect(matchExpression("page.host == missing-host", ctx())).toBe(false);
  });

  it("reports broken expressions instead of guessing", () => {
    expect(matchExpression("no operator here", ctx())).toBe("broken");
    expect(matchExpression("", ctx())).toBe("broken");
  });
});

describe("scoped human grants", () => {
  it("a scoped grant allows after an ask decision", async () => {
    const engine = new PolicyEngine({ defaultEffect: "ask" });
    const before = await engine.decide(ctx());
    expect(before.effect).toBe("needs-approval");

    engine.addGrant({
      approvalId: "apr-1",
      outcome: "approved",
      scope: { orgId: "org-1", sessionId: "run-1", toolName: "computer_navigate" },
      grantedBy: "user-7",
    });
    const after = await engine.decide(ctx());
    expect(after.effect).toBe("allow");
    expect(after.reason).toContain("apr-1");
  });

  it("grant scope mismatch does not allow", async () => {
    const engine = new PolicyEngine({ defaultEffect: "deny" });
    engine.addGrant({
      approvalId: "apr-2",
      outcome: "approved",
      scope: { orgId: "org-OTHER", sessionId: "run-1" },
    });
    const d = await engine.decide(ctx());
    expect(d.effect).toBe("deny");
  });

  it("expired grants do not allow", async () => {
    let nowMs = Date.parse("2026-01-01T00:00:00Z");
    const clock = { now: () => new Date(nowMs) };
    const engine = new PolicyEngine({ defaultEffect: "ask", now: clock.now });
    engine.addGrant({
      approvalId: "apr-3",
      outcome: "approved",
      scope: {},
      expiresAt: "2026-01-01T01:00:00Z",
    });
    const allowed = await engine.decide(ctx());
    expect(allowed.effect).toBe("allow");

    nowMs = Date.parse("2026-01-01T02:00:00Z");
    const expired = await engine.decide(ctx());
    expect(expired.effect).toBe("needs-approval");
  });

  it("revokeGrant removes the grant immediately", async () => {
    const engine = new PolicyEngine({ defaultEffect: "ask" });
    engine.addGrant({ approvalId: "apr-4", outcome: "approved", scope: {} });
    expect(engine.revokeGrant("apr-4")).toBe(true);
    const d = await engine.decide(ctx());
    expect(d.effect).toBe("needs-approval");
  });

  it("deny rules beat active grants", async () => {
    const engine = new PolicyEngine({
      rules: [{ ruleId: "deny-shell", effect: "deny", expression: 'effectClass == "shell"' }],
      defaultEffect: "ask",
    });
    engine.addGrant({ approvalId: "apr-5", outcome: "approved", scope: {} });
    const d = await engine.decide(
      ctx({ tool: { name: "computer_execute", dangerLevel: "destructive" }, effectClass: "shell" }),
    );
    expect(d.effect).toBe("deny");
    expect(d.ruleId).toBe("deny-shell");
  });

  it("rule scope outside the context never matches", async () => {
    const engine = new PolicyEngine({
      rules: [{ ruleId: "other-org", effect: "allow", expression: "true == true", scope: { orgId: "org-OTHER" } }],
      defaultEffect: "deny",
    });
    const d = await engine.decide(ctx());
    expect(d.effect).toBe("deny");
  });
});

describe("policy audit trail", () => {
  it("records every decision including allows", async () => {
    const entries: PolicyAuditEntry[] = [];
    const engine = new PolicyEngine({
      rules: [{ ruleId: "allow-read", effect: "allow", expression: 'effectClass == "read"' }],
      defaultEffect: "deny",
      audit: { record: async (e) => {
        entries.push(e);
      } },
    });
    await engine.decide(ctx({ effectClass: "read" }));
    await engine.decide(ctx());
    expect(entries).toHaveLength(2);
    expect(entries[0]?.effect).toBe("allow");
    expect(entries[0]?.matchedRuleId).toBe("allow-read");
    expect(entries[1]?.effect).toBe("deny");
    for (const e of entries) {
      expect(e.orgId).toBe("org-1");
      expect(e.sessionId).toBe("run-1");
    }
  });
});
