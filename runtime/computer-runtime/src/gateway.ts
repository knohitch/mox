import { randomUUID } from "node:crypto";
import {
  AuditId,
  type ApprovalRequest,
  type AuditEvent,
  type ComputerAction,
  Extensions,
  type JsonValue,
  OrgId,
  type PolicyDecision,
  ResourceId,
} from "@mox/contracts";
import {
  type PolicyAuditEntry,
  type PolicyContext,
  PolicyEngine,
} from "@mox/policy";
import {
  EgressPolicy,
  gatewayTokenSecretFromEnv,
  redactMetadata,
  validateGatewaySigningSecret,
  verifyGatewayToken,
  type GatewayTokenClaims,
} from "@mox/security";
import { effectClassOf, type ComputerProvider, type ResolvedAction } from "./provider.js";

/**
 * The Mox Computer Gateway — the ONLY way an agent action reaches a computer
 * (Architecture Rule 1 + Prompt 04 canonical flow):
 *
 *   agent tool request → Mox runtime → Computer Gateway
 *     → entitlement check → policy decision → optional human approval
 *     → audit → ComputerProvider → action/result
 *
 * Security invariants enforced here:
 * - a request without a valid gateway-minted token is rejected before any
 *   policy or provider code runs (no direct browser-service access);
 * - the decision is evaluated on SERVER-resolved context, never on labels
 *   the caller claimed;
 * - every decision (allow, deny, ask) is audited before the provider acts;
 * - sessions are strictly per (org, agent, session) — never shared.
 */

export interface EntitlementChecker {
  /** May this org use the computer capability at all? */
  check(orgId: string, capability: "computer" | "shell" | "screencast"): Promise<{ entitled: boolean; reason?: string }>;
}

export interface ApprovalFlow {
  /**
   * Resolve a needs-approval decision. Hosts open an ApprovalRequest, notify
   * surfaces, and await the human. Returns the canonical resolved request.
   */
  requestApproval(input: {
    orgId: string;
    agentId: string;
    sessionId: string;
    summary: string;
    /** JSON-serializable context persisted with the ApprovalRequest. */
    payload: unknown;
  }): Promise<ApprovalRequest>;
  /** Grant scope + TTL applied when a human approves. */
  grantScopeFor(request: ApprovalRequest): { scope: Record<string, string>; ttlSeconds: number };
}

export interface ComputerAuditSink {
  record(event: AuditEvent): Promise<void>;
}

export interface ComputerGatewayOptions {
  provider: ComputerProvider;
  policy: PolicyEngine;
  entitlements: EntitlementChecker;
  approvals: ApprovalFlow;
  audit: ComputerAuditSink;
  /**
   * Egress gate for network-reaching actions (navigate). Deny beats allow;
   * fail closed. Server-side only — callers cannot influence the decision.
   *
   * IMPORTANT: this policy is hostname-level authorization. The reusable
   * ComputerGateway does NOT itself pin a browser engine's DNS resolution to
   * validated IP addresses. Production browser composition must add that
   * network-layer control before claiming resolved-IP SSRF protection.
   */
  egress?: EgressPolicy;
  /** Default approval TTL in seconds (grant expiry). */
  defaultGrantTtlSeconds?: number;
  /** Hard cap on concurrent sessions per org (resource-limit behavior). */
  maxSessionsPerOrg?: number;
  /**
   * Security Repair 05B §C: the gateway signing secret. REQUIRED in
   * production — absent a configured secret the gateway constructor throws
   * (computer capability not_configured). Tests inject a deterministic
   * strong key explicitly.
   */
  gatewaySecret?: string;
}

export class GatewayRejectedError extends Error {
  constructor(
    public readonly code:
      | "unauthorized"
      | "not-entitled"
      | "denied"
      | "approval-denied"
      | "limit-exceeded"
      | "unknown-session",
    message: string,
  ) {
    super(message);
    this.name = "GatewayRejectedError";
  }
}

export class ComputerGateway {
  /** sessionId → owning org/agent, for cross-tenant checks. */
  private readonly owners = new Map<string, { orgId: string; agentId: string }>();
  private readonly gatewaySecret: string;
  private readonly egress: EgressPolicy;

  constructor(private readonly opts: ComputerGatewayOptions) {
    // Fail closed at construction: every injected secret passes the SAME
    // validator as env/mint/verify helpers; absence falls back only to the
    // explicitly configured environment authority.
    this.gatewaySecret = opts.gatewaySecret !== undefined
      ? validateGatewaySigningSecret(opts.gatewaySecret, "injected")
      : gatewayTokenSecretFromEnv();
    // Security Repair 07 §E: omission is not an unrestricted browser. A
    // deny-all policy is installed by construction until an explicit safe
    // egress authority is supplied.
    this.egress = opts.egress ?? new EgressPolicy();
  }

  private verify(token: string, now: Date = new Date()) {
    return verifyGatewayToken(token, now, { secret: this.gatewaySecret });
  }

  /**
   * Open a computer session. Requires a gateway token minted by the Control
   * Plane — an agent can never self-assert a session.
   */
  async openSession(
    token: string,
    input: { requestedSessionId?: string },
    now: Date = new Date(),
  ): Promise<{ sessionId: string; claims: GatewayTokenClaims }> {
    const verified = this.verify(token, now);
    if (!verified.ok) throw new GatewayRejectedError("unauthorized", verified.reason);
    const claims = verified.claims;
    if (!claims.agentId) throw new GatewayRejectedError("unauthorized", "gateway token missing agent scope");

    const entitlement = await this.opts.entitlements.check(claims.orgId, "computer");
    if (!entitlement.entitled) {
      throw new GatewayRejectedError("not-entitled", entitlement.reason ?? "computer not entitled");
    }

    if (input.requestedSessionId && input.requestedSessionId !== claims.sessionId) {
      throw new GatewayRejectedError("unauthorized", "requested session does not match gateway token");
    }
    const active = Array.from(this.owners.entries()).filter(([, o]) => o.orgId === claims.orgId);
    const max = this.opts.maxSessionsPerOrg ?? 8;
    if (active.length >= max) {
      throw new GatewayRejectedError(
        "limit-exceeded",
        `org ${claims.orgId} reached max concurrent computer sessions (${max})`,
      );
    }

    const sessionId = input.requestedSessionId ?? claims.sessionId ?? randomUUID();
    if (this.owners.has(sessionId)) {
      throw new GatewayRejectedError("unknown-session", "session id already in use");
    }
    await this.opts.provider.openSession({ orgId: claims.orgId, agentId: claims.agentId, sessionId });
    this.owners.set(sessionId, { orgId: claims.orgId, agentId: claims.agentId });
    await this.audit(claims, sessionId, "computer.session.open", "success", { sessionId });
    return { sessionId, claims };
  }

  /**
   * Execute one action through the canonical flow. This is the method the
   * agent-runtime tool gate calls; there is no other path to the provider.
   */
  async executeAction(
    token: string,
    sessionId: string,
    action: ComputerAction,
    pageFacts?: { url: string; host: string; element?: { ref: string; role: string; name: string } },
    now: Date = new Date(),
  ): Promise<{ outcome: Awaited<ReturnType<ComputerProvider["execute"]>>; decision: PolicyDecision }> {
    const verified = this.verify(token, now);
    if (!verified.ok) throw new GatewayRejectedError("unauthorized", verified.reason);
    const claims = verified.claims;
    if (!claims.agentId) throw new GatewayRejectedError("unauthorized", "gateway token missing agent scope");

    // The token must be bound to the addressed session: a valid token for a
    // DIFFERENT session is still a direct-access attempt (no session-hopping).
    if (claims.sessionId !== sessionId) {
      await this.audit(claims, sessionId, "computer.action", "denied", { reason: "token not bound to session" });
      throw new GatewayRejectedError("unauthorized", "gateway token is not bound to this session");
    }

    const owner = this.owners.get(sessionId);
    if (!owner) throw new GatewayRejectedError("unknown-session", `no such session: ${sessionId}`);
    if (owner.orgId !== claims.orgId || owner.agentId !== claims.agentId) {
      // Cross-agent or cross-tenant use of someone else's session.
      await this.audit(claims, sessionId, "computer.action", "denied", { reason: "session ownership mismatch" });
      throw new GatewayRejectedError("unauthorized", "session belongs to another agent/org");
    }

    const effectClass = effectClassOf(action);

    // Egress/network controls: navigate targets are decided server-side
    // against the org's egress policy before any policy/provider work.
    if (action.kind === "navigate") {
      const egress = this.egress.decide(action.url);
      if (egress.action === "deny") {
        await this.audit(claims, sessionId, "computer.navigate", "denied", {
          reason: egress.reason,
          host: safeHost(action.url),
        });
        throw new GatewayRejectedError("denied", `egress denied: ${egress.reason}`);
      }
    }

    const entitlement = await this.opts.entitlements.check(claims.orgId, effectClass === "shell" ? "shell" : "computer");
    if (!entitlement.entitled) {
      throw new GatewayRejectedError("not-entitled", entitlement.reason ?? `${effectClass} not entitled`);
    }

    // Server-resolved policy context: page/element facts come from the
    // gateway's own snapshot fetch (pageFacts), never from caller labels.
    const ctx: PolicyContext = {
      orgId: claims.orgId,
      agentId: claims.agentId,
      sessionId: claims.sessionId,
      tool: { name: `computer_${effectClass}`, dangerLevel: effectClass === "read" ? "read-only" : "write" },
      page: pageFacts ? { url: pageFacts.url, host: pageFacts.host } : undefined,
      element: pageFacts?.element,
      effectClass,
    };

    let decision = await this.opts.policy.decide(ctx);

    // Optional human approval: canonical ApprovalRequest → grant → re-decide.
    if (decision.effect === "needs-approval") {
      const request = await this.opts.approvals.requestApproval({
        orgId: claims.orgId,
        agentId: claims.agentId,
        sessionId,
        summary: decision.reason,
        payload: { action, effectClass, page: pageFacts?.url } as JsonValue,
      });
      if (request.state === "approved") {
        const { scope, ttlSeconds } = this.opts.approvals.grantScopeFor(request);
        this.opts.policy.addGrant({
          approvalId: request.approvalId,
          outcome: "approved",
          scope: scope as never,
          expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
          grantedBy: request.resolvedBy,
        });
        decision = await this.opts.policy.decide(ctx);
      } else {
        // The human explicitly refused (or the request expired/was cancelled):
        // a distinct, auditable refusal — not a policy-rule denial.
        await this.audit(claims, sessionId, `computer.${effectClass}`, "denied", {
          approvalId: request.approvalId,
          approvalState: request.state,
        });
        throw new GatewayRejectedError(
          "approval-denied",
          `approval ${request.approvalId} resolved ${request.state}`,
        );
      }
    }

    await this.audit(claims, sessionId, `computer.${effectClass}`, decision.effect === "allow" ? "success" : "denied", {
      decisionId: decision.decisionId,
      reason: decision.reason,
      ruleId: decision.ruleId,
    });

    if (decision.effect !== "allow") {
      throw new GatewayRejectedError(decision.effect === "deny" ? "denied" : "approval-denied", decision.reason);
    }

    const resolved: ResolvedAction = {
      action,
      effectClass,
      page: pageFacts ? { url: pageFacts.url, host: pageFacts.host } : undefined,
      element: pageFacts?.element,
      key: (action as { key?: string }).key,
    };
    const outcome = await this.opts.provider.execute(sessionId, resolved);
    return { outcome, decision };
  }

  /** Human takeover: pauses agent actions; recorded in audit. */
  async startTakeover(token: string, sessionId: string, takenBy: string): Promise<void> {
    const verified = this.verify(token);
    if (!verified.ok) throw new GatewayRejectedError("unauthorized", verified.reason);
    this.assertSessionBound(verified.claims, sessionId);
    const owner = this.owners.get(sessionId);
    if (!owner || owner.orgId !== verified.claims.orgId) {
      throw new GatewayRejectedError("unknown-session", "no such session for this org");
    }
    await this.opts.provider.startTakeover(sessionId, takenBy);
    await this.audit(verified.claims, sessionId, "computer.takeover.start", "success", { takenBy });
  }

  async endTakeover(token: string, sessionId: string): Promise<void> {
    const verified = this.verify(token);
    if (!verified.ok) throw new GatewayRejectedError("unauthorized", verified.reason);
    this.assertSessionBound(verified.claims, sessionId);
    const owner = this.owners.get(sessionId);
    if (!owner || owner.orgId !== verified.claims.orgId) {
      throw new GatewayRejectedError("unknown-session", "no such session for this org");
    }
    await this.opts.provider.endTakeover(sessionId);
    await this.audit(verified.claims, sessionId, "computer.takeover.end", "success", {});
  }

  /**
   * Screencast metadata for a session (token + ownership checked; metadata is
   * scrubbed by the provider — frames stream inside the isolated runtime).
   */
  async getScreencastInfo(token: string, sessionId: string): Promise<Record<string, unknown>> {
    const verified = this.verify(token);
    if (!verified.ok) throw new GatewayRejectedError("unauthorized", verified.reason);
    this.assertSessionBound(verified.claims, sessionId);
    const owner = this.owners.get(sessionId);
    if (!owner || owner.orgId !== verified.claims.orgId) {
      throw new GatewayRejectedError("unknown-session", "no such session for this org");
    }
    return this.opts.provider.screencastInfo(sessionId);
  }

  async closeSession(token: string, sessionId: string): Promise<void> {
    const verified = this.verify(token);
    if (!verified.ok) throw new GatewayRejectedError("unauthorized", verified.reason);
    this.assertSessionBound(verified.claims, sessionId);
    const owner = this.owners.get(sessionId);
    if (!owner || owner.orgId !== verified.claims.orgId) {
      throw new GatewayRejectedError("unknown-session", "no such session for this org");
    }
    await this.opts.provider.closeSession(sessionId);
    this.owners.delete(sessionId);
    await this.audit(verified.claims, sessionId, "computer.session.close", "success", {});
  }

  /**
   * Crash of the underlying provider session: release the provider-side
   * session (best-effort — it may already be gone) and drop ownership so the
   * supervisor/gateway can reopen a fresh session on restart.
   */
  async handleProviderCrash(sessionId: string, reason: string): Promise<void> {
    const owner = this.owners.get(sessionId);
    if (!owner) return;
    try {
      await this.opts.provider.closeSession(sessionId);
    } catch {
      // Provider state already destroyed by the crash; nothing to release.
    }
    this.owners.delete(sessionId);
    await this.audit(
      { orgId: owner.orgId, agentId: owner.agentId, sessionId },
      sessionId,
      "computer.session.crash",
      "error",
      { reason },
    );
  }

  /** A token minted for one session may never act on another (no hopping). */
  private assertSessionBound(claims: GatewayTokenClaims, sessionId: string): void {
    if (claims.sessionId !== sessionId) {
      throw new GatewayRejectedError("unauthorized", "gateway token is not bound to this session");
    }
  }

  private async audit(
    claims: { orgId: string; agentId: string; sessionId?: string },
    sessionId: string,
    action: string,
    outcome: AuditEvent["outcome"],
    metadata: Record<string, unknown>,
  ): Promise<void> {
    // Security Repair 05B §E: freeform audit metadata (reason, takenBy,
    // crash text) is scrubbed BEFORE it is persisted — no secrets in audit.
    await this.opts.audit.record({
      auditId: AuditId.parse(randomUUID()),
      orgId: OrgId.parse(claims.orgId),
      actor: { kind: "agent", agentId: claims.agentId },
      action,
      resource: { kind: "computer-session", id: ResourceId.parse(sessionId) },
      outcome,
      metadata: JSON.parse(JSON.stringify(redactMetadata(metadata))) as Extensions,
      at: new Date().toISOString(),
    });
  }
}

export type { PolicyAuditEntry };

/** Best-effort host extraction for audit rows; never throws. */
function safeHost(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}
