import { randomUUID } from "node:crypto";
import type { AgentDefinition } from "@mox/contracts";
import type { AgentEngine, ApprovalQuestion, RunContext } from "./engine.js";
import { makeAgentEvent, type AgentEventInput } from "./events.js";
import type { PermissionsPolicyEngine } from "./policy.js";
import type { ToolRegistry } from "./tools.js";

/**
 * Reference turn engine: the in-repo loop (model call → tool requests → final
 * message) used by tests and as the behavioral contract the production Mox
 * Runtime process must match. Model seam and policy engine are injectable;
 * tests supply stubs, Mox Model Gateway supplies real providers.
 */

export interface ModelStubRequest {
  definition: AgentDefinition;
  userInput: unknown;
  history: readonly AgentEventInput[];
}

export interface ModelStubResult {
  /** Plain text reply. */
  text?: string;
  /** Tools the model wants executed, in order. */
  toolRequests?: Array<{ toolName: string; input: unknown }>;
}

/** The model seam: swap for Mox Model Gateway providers. */
export type ModelStub = (request: ModelStubRequest) => Promise<ModelStubResult>;

export class ReferenceAgentEngine implements AgentEngine {
  readonly name = "mox-reference";
  readonly capabilities = ["chat", "tools", "streaming", "approvals"];

  constructor(
    private readonly model: ModelStub,
    private readonly policy: PermissionsPolicyEngine,
  ) {}

  async executeTurn(input: {
    ctx: RunContext;
    definition: AgentDefinition;
    userInput: unknown;
    runtimeConfig: Record<string, unknown>;
    resumeToken?: string;
    emit: (event: AgentEventInput) => Promise<void>;
    askApproval: (question: ApprovalQuestion) => Promise<"approved" | "denied">;
    shouldAbort: () => boolean;
    tools: ToolRegistry;
  }): Promise<{ output: unknown; resumeToken?: string }> {
    const { ctx, definition, emit, tools } = input;
    const messageId = randomUUID();
    const turnId = randomUUID();

    const modelResult = await this.model({
      definition,
      userInput: input.userInput,
      history: [],
    });

    if (modelResult.text !== undefined && !input.shouldAbort()) {
      await emit({ type: "message.delta", messageId, delta: modelResult.text });
      await emit({
        type: "message.completed",
        messageId,
        text: modelResult.text,
      });
    }

    let lastToolOutput: unknown = undefined;
    for (const request of modelResult.toolRequests ?? []) {
      if (input.shouldAbort()) break;
      await emit(
        makeAgentEvent(ctx.agentId, {
          type: "tool.requested",
          turnId,
          toolName: request.toolName,
          input: request.input,
        }),
      );
      const result = await tools.invokeGated(
        { toolName: request.toolName, input: request.input },
        this.policy,
        {
          orgId: ctx.orgId,
          agentId: ctx.agentId,
          approvedTools: ctx.approvedTools,
          // Definition-level policy inputs consumed by PermissionsPolicyEngine:
          toolPolicy: definition.permissions.toolPolicy,
          allowedTools: definition.permissions.allowedTools,
          deniedTools: definition.permissions.deniedTools,
          requireApprovalFor: definition.permissions.requireApprovalFor,
        },
        async (question: ApprovalQuestion) => {
          await emit(
            makeAgentEvent(ctx.agentId, {
              type: "approval.opened",
              approvalId: question.approvalId,
              summary: question.summary,
            }),
          );
          const outcome = await input.askApproval(question);
          await emit(
            makeAgentEvent(ctx.agentId, {
              type: "approval.resolved",
              approvalId: question.approvalId,
              outcome: outcome === "approved" ? "approved" : "denied",
            }),
          );
          return outcome;
        },
      );
      await emit(
        makeAgentEvent(ctx.agentId, {
          type: "tool.completed",
          turnId,
          toolName: request.toolName,
          output: result.output,
          ok: result.ok,
        }),
      );
      lastToolOutput = result.output;
    }

    return {
      output: modelResult.text ?? lastToolOutput ?? null,
      resumeToken: `ref:${ctx.runId}`,
    };
  }
}
