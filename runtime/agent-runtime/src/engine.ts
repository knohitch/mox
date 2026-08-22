import type { AgentDefinition } from "@mox/contracts";

/**
 * Execution engine seam: the single place where a DSH-derived kernel plugs
 * into the Mox runtime host. Prompt 03's in-repo implementation is the
 * reference loop (model stub + tool registry + approval questions); the DSH
 * out-of-process kernel implements the same interface from its SDK process,
 * keeping failure boundaries clean.
 *
 * The engine receives only Mox contracts and resolved config — it never
 * imports Control Plane modules, and its local storage is non-authoritative.
 */

export interface ToolRequest {
  toolName: string;
  input: unknown;
  dangerLevel: "read-only" | "write" | "destructive" | "network" | "spend";
}

/** A question the engine poses when policy returns needs-approval. */
export interface ApprovalQuestion {
  approvalId: string;
  summary: string;
  request: ToolRequest;
}

export interface RunContext {
  runId: string;
  orgId: string;
  agentId: string;
  threadId: string;
  /** Human-approved tool names for this run (approval.respond results). */
  approvedTools: Set<string>;
}

/**
 * The turn executor. Implementations drive one conversational turn:
 * call the model, execute tools through the provided gate, stream events
 * via `emit`, and resolve with the final output.
 */
export interface AgentEngine {
  readonly name: string;
  readonly capabilities: readonly string[];
  executeTurn(input: {
    ctx: RunContext;
    definition: AgentDefinition;
    userInput: unknown;
    runtimeConfig: Record<string, unknown>;
    resumeToken?: string;
    emit: (event: AgentEventInput) => Promise<void>;
    askApproval: (question: ApprovalQuestion) => Promise<"approved" | "denied">;
    shouldAbort: () => boolean;
    tools: ToolRegistry;
  }): Promise<{ output: unknown; resumeToken?: string }>;
}

import type { AgentEventInput } from "./events.js";
import type { ToolRegistry } from "./tools.js";
