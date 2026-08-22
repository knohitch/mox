import { z } from "zod";
import {
  AgentId,
  DeploymentId,
  EventId,
  IsoDateTime,
  JsonValue,
  MessageId,
  ModelId,
  ProviderId,
  RoomId,
  ThreadId,
  ToolName,
} from "./core.js";

/**
 * Durable session-event semantics (Prompt 06). These are the APPEND-ORIENTED
 * records persisted in PostgreSQL; the live `AgentEvent` union streams the
 * same facts to clients. Hidden chain-of-thought is not representable here —
 * there is no field for it, anywhere.
 *
 * Correlation/causation: every record carries correlationId (the run or room
 * objective that caused it) and causationId (the immediately-causing event).
 */

export const RunScopeIds = z.object({
  orgId: z.string().min(1),
  agentId: AgentId.optional(),
  threadId: ThreadId.optional(),
  roomId: RoomId.optional(),
  runId: z.string().min(1).optional(),
  turnId: z.string().optional(),
});
export type RunScopeIds = z.infer<typeof RunScopeIds>;

const Base = RunScopeIds.extend({
  eventId: EventId,
  at: IsoDateTime,
  /** Immediately-causing event, for causal chains. */
  causationId: EventId.optional(),
  correlationId: z.string().min(1),
});

export const SessionEvent = z.discriminatedUnion("type", [
  // Runs
  Base.extend({ type: z.literal("run.started"), input: JsonValue.optional() }),
  Base.extend({ type: z.literal("run.completed"), output: JsonValue.optional() }),
  Base.extend({ type: z.literal("run.failed"), error: z.string().min(1), retryable: z.boolean().default(false) }),
  Base.extend({ type: z.literal("run.cancelled"), reason: z.string().optional() }),

  // Model metadata (never request bodies verbatim; metadata only)
  Base.extend({
    type: z.literal("model.requested"),
    providerId: ProviderId.optional(),
    modelId: ModelId.optional(),
    inputTokensEstimate: z.number().int().nonnegative().optional(),
  }),
  Base.extend({
    type: z.literal("model.responded"),
    providerId: ProviderId.optional(),
    modelId: ModelId.optional(),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    latencyMs: z.number().int().nonnegative().optional(),
  }),

  // Assistant content
  Base.extend({ type: z.literal("assistant.delta"), messageId: MessageId, delta: z.string() }),
  Base.extend({ type: z.literal("assistant.final"), messageId: MessageId, text: z.string() }),

  // User + system thread traffic
  Base.extend({ type: z.literal("user.message"), messageId: MessageId, text: z.string() }),
  Base.extend({ type: z.literal("system.notification"), level: z.enum(["info", "warn", "error"]).default("info"), text: z.string().min(1) }),

  // Tools
  Base.extend({ type: z.literal("tool.requested"), toolName: ToolName, input: JsonValue }),
  Base.extend({ type: z.literal("tool.started"), toolName: ToolName }),
  Base.extend({ type: z.literal("tool.completed"), toolName: ToolName, outputSummary: JsonValue, ok: z.boolean() }),
  Base.extend({ type: z.literal("tool.failed"), toolName: ToolName, error: z.string().min(1) }),

  // Approvals
  Base.extend({ type: z.literal("approval.requested"), approvalId: z.string().min(1), summary: z.string().min(1) }),
  Base.extend({ type: z.literal("approval.resolved"), approvalId: z.string().min(1), outcome: z.enum(["approved", "denied", "expired", "cancelled"]) }),

  // Computer actions (references Computer Gateway audit rows, never secrets)
  Base.extend({ type: z.literal("computer.action"), effectClass: z.string().min(1), summary: z.string().min(1) }),

  // Files / artifacts
  Base.extend({ type: z.literal("artifact.produced"), path: z.string().min(1), mediaType: z.string().optional(), sizeBytes: z.number().int().nonnegative().optional() }),

  // Subagents
  Base.extend({ type: z.literal("subagent.started"), subagentAgentId: AgentId, delegation: z.enum(["ask", "auto"]) }),
  Base.extend({ type: z.literal("subagent.completed"), subagentAgentId: AgentId, ok: z.boolean() }),

  // Workflows / jobs
  Base.extend({ type: z.literal("workflow.started"), workflowId: z.string().min(1) }),
  Base.extend({ type: z.literal("workflow.finished"), workflowId: z.string().min(1), ok: z.boolean() }),
  Base.extend({ type: z.literal("job.updated"), jobId: z.string().min(1), status: z.enum(["pending", "running", "succeeded", "failed"]) }),

  // Deployments
  Base.extend({
    type: z.literal("deployment.updated"),
    deploymentId: DeploymentId.optional(),
    state: z.enum(["desired", "provisioning", "running", "degraded", "stopped", "failed"]),
    note: z.string().optional(),
  }),
]);

export type SessionEvent = z.infer<typeof SessionEvent>;
export type SessionEventType = SessionEvent["type"];

/** Ordered, replayable projection row for fast UI queries. */
export const SessionEventRecord = z.object({
  seq: z.number().int().nonnegative(),
  event: SessionEvent,
});
export type SessionEventRecord = z.infer<typeof SessionEventRecord>;
