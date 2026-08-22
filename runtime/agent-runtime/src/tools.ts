import { randomUUID } from "node:crypto";
import type { ToolDefinition } from "@mox/contracts";

/**
 * Tool registry: the runtime's inventory of invocable tools. Registration is
 * explicit per-run (from the definition's tool list + host-provided builtins);
 * the gate consults the policy engine before any handler executes.
 */

export interface RegisteredTool {
  definition: ToolDefinition;
  execute(input: unknown): Promise<unknown>;
}

export interface ToolGateRequest {
  toolName: string;
  input: unknown;
}

/** Result of a gated invocation: canonical tool.completed payload fields. */
export interface ToolInvocationResult {
  ok: boolean;
  output: unknown;
}

import type { DefinitionPolicyInputs, PolicyInput, RuntimePolicyEngine } from "./policy.js";
import type { ApprovalQuestion } from "./engine.js";

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): void {
    if (this.tools.has(tool.definition.name)) {
      throw new Error(`tool already registered: ${tool.definition.name}`);
    }
    this.tools.set(tool.definition.name, tool);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): readonly RegisteredTool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Gated invocation path. Flow: unknown tool → deny; policy deny → deny;
   * needs-approval → askApproval callback (host streams approval.opened and
   * awaits the user); approved → execute once, never re-asking for a second
   * approval of the same tool in the same run.
   */
  async invokeGated(
    request: ToolGateRequest,
    policy: RuntimePolicyEngine,
    policyBase: Omit<PolicyInput, "toolName" | "input" | "dangerLevel"> & DefinitionPolicyInputs,
    askApproval: (question: ApprovalQuestion) => Promise<"approved" | "denied">,
  ): Promise<ToolInvocationResult> {
    const tool = this.tools.get(request.toolName);
    if (!tool) {
      return { ok: false, output: { error: `unknown tool: ${request.toolName}` } };
    }
    const decision = await policy.decide({
      ...policyBase,
      toolName: request.toolName,
      dangerLevel: tool.definition.dangerLevel,
      input: request.input,
    });
    if (decision.effect === "deny") {
      return { ok: false, output: { error: `policy denied ${request.toolName}`, reason: decision.reason } };
    }
    if (decision.effect === "needs-approval") {
      const outcome = await askApproval({
        approvalId: randomUUID(),
        summary: decision.reason,
        request: {
          toolName: request.toolName,
          input: request.input,
          dangerLevel: tool.definition.dangerLevel,
        },
      });
      if (outcome !== "approved") {
        return { ok: false, output: { error: `approval denied for ${request.toolName}` } };
      }
    }
    try {
      const output = await tool.execute(request.input);
      return { ok: true, output };
    } catch (error) {
      return {
        ok: false,
        output: { error: `tool failed: ${error instanceof Error ? error.message : String(error)}` },
      };
    }
  }
}
