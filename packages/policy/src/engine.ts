import { randomUUID } from "node:crypto";
import {
  ApprovalId,
  DecisionId,
  type PolicyDecision,
  PolicyRuleId,
  ToolName,
  UserId,
} from "@mox/contracts";

/**
 * The ONE authoritative Mox policy engine (Architecture Rule 1; Prompt 04).
 *
 * Derived from OpenBot's computer gateway policy (deny beats allow, default
 * deny, fail closed on broken rules) and unified with the Mox contracts:
 * decisions are canonical `PolicyDecision`s, human gates are canonical
 * `ApprovalRequest`s. DSH local presets and OpenMaus auto-approve are NOT
 * authoritative — they may propose, this engine decides.
 *
 * Decision precedence:
 *   1. deny rules (a broken deny expression still denies — fail closed);
 *   2. explicit allow rules;
 *   3. active scoped grants (session/agent/org) that have not expired;
 *   4. `ask` rules;
 *   5. default action (default: deny).
 */

export type PolicyEffect = "allow" | "deny" | "ask";

/** A single policy rule. Expressions are simple `field op value` sentences. */
export interface PolicyRule {
  ruleId: string;
  effect: PolicyEffect;
  /** Evaluated against the PolicyContext; see matchExpression(). */
  expression: string;
  /** Optional scope restriction; a rule outside its scope never matches. */
  scope?: PolicyScope;
}

/** Scope of a rule or a granted approval. */
export interface PolicyScope {
  /** Grant applies to one action invocation when set. */
  actionId?: string;
  /** Grant applies to one session (run) when set. */
  sessionId?: string;
  /** Grant applies to one agent when set. */
  agentId?: string;
  /** Grant applies to the whole organization when set. */
  orgId?: string;
  /** Grant applies to a named tool only when set. */
  toolName?: string;
}

/** The facts a rule may be written against. Server-resolved, never caller-claimed. */
export interface PolicyContext {
  orgId: string;
  agentId: string;
  sessionId: string;
  actionId?: string;
  userId?: string;
  tool: { name: string; dangerLevel?: string };
  /** Server-fetched page facts (browser actions). */
  page?: { url: string; host: string };
  /** Server-resolved element facts (from ARIA snapshot the server owns). */
  element?: { ref: string; role: string; name: string };
  /** The key a key-press action is about to send. */
  key?: string;
  /** Action effect class, so one rule covers every activation path. */
  effectClass?: "activate" | "type" | "navigate" | "read" | "write_file" | "read_file" | "list_files" | "shell" | "screencast" | "takeover";
}

/** A human approval that has been granted, with scope + expiry. */
export interface ApprovalGrant {
  approvalId: string;
  outcome: "approved";
  scope: PolicyScope;
  /** ISO-8601 instant after which the grant no longer applies. */
  expiresAt?: string;
  grantedBy?: string;
  grantedAt: string;
}

/** Audit sink: every decision (allow/deny/ask) is recorded, never only failures. */
export interface PolicyAuditSink {
  record(entry: PolicyAuditEntry): Promise<void>;
}

export interface PolicyAuditEntry {
  decisionId: string;
  at: string;
  orgId: string;
  agentId: string;
  sessionId: string;
  toolName: string;
  effect: PolicyDecision["effect"];
  matchedRuleId?: string;
  reason: string;
}

export interface PolicyEngineOptions {
  rules?: PolicyRule[];
  /** Default when no rule matches. OpenBot default-deny; `ask` is allowed. */
  defaultEffect?: Exclude<PolicyEffect, "allow">;
  audit?: PolicyAuditSink;
  now?: () => Date;
}

const EXPRESSION = /^\s*([a-zA-Z_.]+)\s*(==|!=)\s*["']?([^"']*)["']?\s*$/;

/**
 * Minimal, dependency-free expression matcher covering the OpenBot rule
 * shapes Mox needs: `field == value` / `field != value` with dotted paths.
 * A BROKEN EXPRESSION DENIES (fail closed), matching OpenBot semantics —
 * a typo must block, not admit.
 */
export function matchExpression(expression: string, ctx: PolicyContext): boolean | "broken" {
  const m = EXPRESSION.exec(expression);
  if (!m || m[1] === undefined || m[2] === undefined) return "broken";
  const [, path, op, rawValue] = m;
  const value = (rawValue ?? "").trim();
  let actual: unknown = ctx;
  for (const part of path.split(".")) {
    if (actual === null || typeof actual !== "object" || !(part in (actual as Record<string, unknown>))) {
      actual = undefined;
      break;
    }
    actual = (actual as Record<string, unknown>)[part];
  }
  if (op === "==") return actual === value;
  return actual !== value;
}

function scopeMatches(scope: PolicyScope | undefined, ctx: PolicyContext): boolean {
  if (!scope) return true;
  if (scope.actionId !== undefined && scope.actionId !== ctx.actionId) return false;
  if (scope.sessionId !== undefined && scope.sessionId !== ctx.sessionId) return false;
  if (scope.agentId !== undefined && scope.agentId !== ctx.agentId) return false;
  if (scope.orgId !== undefined && scope.orgId !== ctx.orgId) return false;
  if (scope.toolName !== undefined && scope.toolName !== ctx.tool.name) return false;
  return true;
}

function isExpired(iso: string | undefined, now: Date): boolean {
  if (iso === undefined) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && t <= now.getTime();
}

function decision(
  effect: PolicyDecision["effect"],
  reason: string,
  ctx: PolicyContext,
  ruleId?: string,
  now: Date = new Date(),
): PolicyDecision {
  return {
    decisionId: DecisionId.parse(randomUUID()),
    subject: {
      agentId: ctx.agentId,
      userId: ctx.userId === undefined ? undefined : UserId.parse(ctx.userId),
      toolName: ToolName.parse(ctx.tool.name),
      actionKind: ctx.effectClass,
    },
    effect,
    ruleId: ruleId === undefined ? undefined : PolicyRuleId.parse(ruleId),
    reason,
    evaluatedAt: now.toISOString(),
  };
}

export class PolicyEngine {
  private readonly rules: PolicyRule[];
  private readonly defaultEffect: Exclude<PolicyEffect, "allow">;
  private readonly audit: PolicyAuditSink | undefined;
  private readonly now: () => Date;
  /** Active human grants, newest decision wins per approvalId. */
  private readonly grants = new Map<string, ApprovalGrant>();

  constructor(options: PolicyEngineOptions = {}) {
    this.rules = options.rules ?? [];
    this.defaultEffect = options.defaultEffect ?? "deny";
    this.audit = options.audit;
    this.now = options.now ?? (() => new Date());
  }

  /** Record a resolved human approval as a scoped, expiring grant. */
  addGrant(grant: Omit<ApprovalGrant, "grantedAt"> & { grantedAt?: string }): ApprovalGrant {
    const full: ApprovalGrant = { ...grant, grantedAt: grant.grantedAt ?? this.now().toISOString() };
    this.grants.set(full.approvalId, full);
    return full;
  }

  revokeGrant(approvalId: string): boolean {
    return this.grants.delete(approvalId);
  }

  listGrants(): ApprovalGrant[] {
    return Array.from(this.grants.values());
  }

  /**
   * The single decision path. Emits exactly one audited canonical decision.
   * Never throws: an internal error denies (fail closed).
   */
  async decide(ctx: PolicyContext): Promise<PolicyDecision> {
    let out: PolicyDecision;
    try {
      out = this.decideSync(ctx);
    } catch (error) {
      out = decision(
        "deny",
        `policy engine error (fail closed): ${error instanceof Error ? error.message : String(error)}`,
        ctx,
        undefined,
        this.now(),
      );
    }
    if (this.audit) {
      await this.audit.record({
        decisionId: out.decisionId,
        at: out.evaluatedAt,
        orgId: ctx.orgId,
        agentId: ctx.agentId,
        sessionId: ctx.sessionId,
        toolName: ctx.tool.name,
        effect: out.effect,
        matchedRuleId: out.ruleId,
        reason: out.reason,
      });
    }
    return out;
  }

  private decideSync(ctx: PolicyContext): PolicyDecision {
    const now = this.now();

    // 1. Deny first; a broken deny expression denies.
    for (const rule of this.rules) {
      if (rule.effect !== "deny") continue;
      if (!scopeMatches(rule.scope, ctx)) continue;
      const matched = matchExpression(rule.expression, ctx);
      if (matched === "broken") {
        return decision("deny", `broken deny rule denies (fail closed): ${rule.expression}`, ctx, rule.ruleId, now);
      }
      if (matched === true) {
        return decision("deny", `denied by rule ${rule.ruleId}: ${rule.expression}`, ctx, rule.ruleId, now);
      }
    }

    // 2. Explicit allow.
    for (const rule of this.rules) {
      if (rule.effect !== "allow") continue;
      if (!scopeMatches(rule.scope, ctx)) continue;
      const matched = matchExpression(rule.expression, ctx);
      if (matched === true) {
        return decision("allow", `allowed by rule ${rule.ruleId}: ${rule.expression}`, ctx, rule.ruleId, now);
      }
      // A broken allow expression is skipped (does not allow), never crashes.
    }

    // 3. Active, unexpired human grants.
    for (const grant of Array.from(this.grants.values())) {
      if (grant.outcome !== "approved") continue;
      if (isExpired(grant.expiresAt, now)) continue;
      if (!scopeMatches(grant.scope, ctx)) continue;
      return decision(
        "allow",
        `allowed by approval ${grant.approvalId}${grant.expiresAt ? ` (expires ${grant.expiresAt})` : ""}`,
        ctx,
        undefined,
        now,
      );
    }

    // 4. Ask rules → needs-approval.
    for (const rule of this.rules) {
      if (rule.effect !== "ask") continue;
      if (!scopeMatches(rule.scope, ctx)) continue;
      const matched = matchExpression(rule.expression, ctx);
      if (matched === true) {
        return decision(
          "needs-approval",
          `human approval required by rule ${rule.ruleId}: ${rule.expression}`,
          ctx,
          rule.ruleId,
          now,
        );
      }
      if (matched === "broken") {
        return decision("deny", `broken ask rule denies (fail closed): ${rule.expression}`, ctx, rule.ruleId, now);
      }
    }

    // 5. Default (deny or ask).
    if (this.defaultEffect === "ask") {
      return decision("needs-approval", "no rule matched; default effect is ask", ctx, undefined, now);
    }
    return decision("deny", "no rule matched; default deny", ctx, undefined, now);
  }
}

/** Canonical approval id for a new ApprovalRequest. */
export function newApprovalId(): string {
  return ApprovalId.parse(randomUUID());
}
