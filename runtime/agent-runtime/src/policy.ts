import { randomUUID } from "node:crypto";
import { DecisionId, PolicyRuleId, ToolName, type PolicyDecision } from "@mox/contracts";

/**
 * Policy boundary (Prompt 03): DSH approval/question flows remain interaction
 * seams, but the authority for "may this tool run" is Mox policy — never
 * local DSH configuration. Tool executions capable of side effects must be
 * decided here (and later routed through Mox Policy/Computer/Integration
 * gateways, Prompt 04+).
 *
 * Fail-closed: a missing engine, a missing rule, or an engine error denies.
 */

export type ToolDangerLevel = "read-only" | "write" | "destructive" | "network" | "spend";

export interface PolicyInput {
  orgId: string;
  agentId: string;
  toolName: string;
  dangerLevel: ToolDangerLevel;
  input: unknown;
  /** Tools already approved by a human for this run (by name). */
  approvedTools?: ReadonlySet<string>;
}

/** Definition-level policy inputs consumed by PermissionsPolicyEngine. */
export interface DefinitionPolicyInputs {
  toolPolicy: "default" | "allow-all" | "custom";
  allowedTools?: readonly string[];
  deniedTools?: readonly string[];
  requireApprovalFor?: readonly string[];
}

/** The seam the runtime consults before any tool executes. */
export interface RuntimePolicyEngine {
  decide(input: PolicyInput & Partial<DefinitionPolicyInputs>): Promise<PolicyDecision>;
}

const DENY = (
  reason: string,
  input: PolicyInput,
  ruleId?: string,
): PolicyDecision => ({
  decisionId: DecisionId.parse(randomUUID()),
  subject: { agentId: input.agentId, toolName: ToolName.parse(input.toolName) },
  effect: "deny",
  ruleId: ruleId === undefined ? undefined : PolicyRuleId.parse(ruleId),
  reason,
  evaluatedAt: new Date().toISOString(),
});

/**
 * Default engine derived from AgentDefinition.permissions:
 * - deny-list beats allow-list; toolPolicy "custom" requires membership;
 * - write-or-worse tools require prior human approval (fail closed);
 * - unknown danger classification is treated as most dangerous.
 */
export class PermissionsPolicyEngine implements RuntimePolicyEngine {
  async decide(
    input: PolicyInput & Partial<DefinitionPolicyInputs>,
  ): Promise<PolicyDecision> {
    if (input.deniedTools?.includes(input.toolName)) {
      return DENY(`tool ${input.toolName} is denied by definition`, input);
    }
    if ((input.toolPolicy ?? "custom") === "custom") {
      const allowed = input.allowedTools?.includes(input.toolName) ?? false;
      if (!allowed) {
        return DENY(`tool ${input.toolName} is not in the custom allow list`, input);
      }
    }
    const needsApproval = this.dangerRank(input.dangerLevel) >= this.dangerRank("write");
    if (needsApproval && !(input.approvedTools?.has(input.toolName) ?? false)) {
      return {
        decisionId: DecisionId.parse(randomUUID()),
        subject: { agentId: input.agentId, toolName: ToolName.parse(input.toolName) },
        effect: "needs-approval",
        reason: `tool ${input.toolName} (${input.dangerLevel}) requires human approval`,
        evaluatedAt: new Date().toISOString(),
      };
    }
    return {
      decisionId: DecisionId.parse(randomUUID()),
      subject: { agentId: input.agentId, toolName: ToolName.parse(input.toolName) },
      effect: "allow",
      reason: `allowed by definition policy (${input.toolPolicy ?? "default"}, danger ${input.dangerLevel})`,
      evaluatedAt: new Date().toISOString(),
    };
  }

  private dangerRank(level: ToolDangerLevel): number {
    switch (level) {
      case "read-only":
        return 0;
      case "write":
      case "destructive":
      case "network":
      case "spend":
        return 1;
      default:
        return 2; // unknown → treated as most dangerous (fail closed)
    }
  }
}

/** Always-deny engine: used when no definition-level policy can be built. */
export class DenyAllPolicyEngine implements RuntimePolicyEngine {
  async decide(input: PolicyInput & Partial<DefinitionPolicyInputs>): Promise<PolicyDecision> {
    return DENY("no policy engine configured for this agent", input);
  }
}

/** Wrap an engine so that thrown errors become denials instead of crashes. */
export function failClosed(engine: RuntimePolicyEngine): RuntimePolicyEngine {
  return {
    async decide(input: PolicyInput & Partial<DefinitionPolicyInputs>): Promise<PolicyDecision> {
      try {
        const decision = await engine.decide(input);
        // An engine returning a malformed/unknown effect fails closed.
        if (decision.effect !== "allow" && decision.effect !== "needs-approval") {
          return DENY(`policy engine returned non-allow effect: ${decision.effect}`, input);
        }
        return decision;
      } catch (error) {
        return DENY(
          `policy engine error: ${error instanceof Error ? error.message : String(error)}`,
          input,
        );
      }
    },
  };
}
