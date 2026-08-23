import { z } from "zod";
import { AgentDefinition, AgentEvent } from "@mox/contracts";

/**
 * Mox runtime wire protocol (v1).
 *
 * The only contract between the Control Plane and any agent runtime process.
 * Transport-agnostic: framed JSON-RPC 2.0 over stdio today; the same messages
 * may ride any byte-stream transport later. Runtime internals never appear
 * here — this package is the entire surface the Control Plane may depend on.
 */

// ---- Envelope (JSON-RPC 2.0 subset) ----

export const RpcId = z.union([z.string(), z.number().int()]);
export type RpcId = z.infer<typeof RpcId>;

export const RpcRequest = z.object({
  jsonrpc: z.literal("2.0"),
  id: RpcId,
  method: z.string().min(1),
  params: z.unknown().optional(),
});
export type RpcRequest = z.infer<typeof RpcRequest>;

export const RpcError = z.object({
  code: z.number().int(),
  message: z.string(),
  data: z.unknown().optional(),
});
export type RpcError = z.infer<typeof RpcError>;

export const RpcResponse = z.object({
  jsonrpc: z.literal("2.0"),
  id: RpcId,
  result: z.unknown().optional(),
  error: RpcError.optional(),
});
export type RpcResponse = z.infer<typeof RpcResponse>;

/** Server-initiated notification carrying a runtime event stream item. */
export const RpcNotification = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.string().min(1),
  params: z.unknown(),
});
export type RpcNotification = z.infer<typeof RpcNotification>;

/** Canonical JSON-RPC error codes used by the runtime. */
export const RPC_ERROR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  /** Server range for runtime-specific failures. */
  runtimeFailure: -32000,
  busy: -32001,
  unknownRun: -32002,
} as const;

// ---- Methods (client → runtime) ----

export const RUNTIME_METHODS = [
  "runtime/health",
  "runtime.capabilities",
  "run.start",
  "run.resume",
  "run.cancel",
  "run.list",
  "approval.respond",
  "runtime.shutdown",
] as const;
export type RuntimeMethod = (typeof RUNTIME_METHODS)[number];

export const HealthRequest = z.object({}).default({});
export type HealthRequest = z.infer<typeof HealthRequest>;

export const CapabilitiesRequest = z.object({}).default({});
export type CapabilitiesRequest = z.infer<typeof CapabilitiesRequest>;

export const RunStartRequest = z.object({
  runId: z.string().min(1),
  orgId: z.string().min(1),
  agentId: z.string().min(1),
  threadId: z.string().min(1),
  /** Full AgentDefinition snapshot; the runtime never reads agent storage. */
  definition: AgentDefinition,
  /** The user/system input that starts this turn. */
  userInput: z.unknown(),
  /**
   * Opaque runtime config blob assembled by the host from its own provider
   * seams. The client treats it as bytes; the runtime validates its shape.
   * Secrets travel only inside credential grants, never in plaintext fields.
   */
  runtimeConfig: z.record(z.string(), z.unknown()),
});
export type RunStartRequest = z.infer<typeof RunStartRequest>;

export const RunResumeRequest = RunStartRequest.extend({
  /** Runtime-side session token returned by a previous run on this thread. */
  resumeToken: z.string().min(1),
});
export type RunResumeRequest = z.infer<typeof RunResumeRequest>;

export const RunCancelRequest = z.object({
  runId: z.string().min(1),
  reason: z.string().min(1).optional(),
});
export type RunCancelRequest = z.infer<typeof RunCancelRequest>;

export const RunListRequest = z.object({
  orgId: z.string().min(1).optional(),
}).default({});
export type RunListRequest = z.infer<typeof RunListRequest>;

export const ApprovalRespondRequest = z.object({
  approvalId: z.string().min(1),
  outcome: z.enum(["approved", "denied"]),
  resolvedBy: z.string().min(1).optional(),
});
export type ApprovalRespondRequest = z.infer<typeof ApprovalRespondRequest>;

export const ShutdownRequest = z.object({
  gracefulTimeoutMs: z.number().int().positive().max(120_000).default(10_000),
});
export type ShutdownRequest = z.infer<typeof ShutdownRequest>;

// ---- Results (runtime → client) ----

export const HealthResult = z.object({
  ok: z.boolean(),
  uptimeMs: z.number().int().nonnegative(),
  activeRuns: z.number().int().nonnegative(),
  version: z.string().min(1),
});
export type HealthResult = z.infer<typeof HealthResult>;

export const CapabilitiesResult = z.object({
  runtime: z.string().min(1),
  protocolVersion: z.number().int().positive(),
  capabilities: z.array(z.string().min(1)),
  tools: z.array(
    z.object({
      name: z.string().min(1),
      description: z.string(),
      /** Whether invoking this tool requires an approval round-trip. */
      requiresApproval: z.boolean(),
    }),
  ),
});
export type CapabilitiesResult = z.infer<typeof CapabilitiesResult>;

export const RunStartResult = z.object({
  runId: z.string().min(1),
  accepted: z.boolean(),
  /** Opaque token for resuming the underlying session after restart. */
  resumeToken: z.string().optional(),
});
export type RunStartResult = z.infer<typeof RunStartResult>;

export const RunResumeResult = RunStartResult;
export type RunResumeResult = z.infer<typeof RunResumeResult>;

export const RunCancelResult = z.object({
  runId: z.string().min(1),
  cancelled: z.boolean(),
});
export type RunCancelResult = z.infer<typeof RunCancelResult>;

export const ActiveRun = z.object({
  runId: z.string().min(1),
  orgId: z.string().min(1),
  agentId: z.string().min(1),
  threadId: z.string().min(1),
  state: z.enum(["starting", "running", "waiting-approval", "cancelling"]),
  startedAt: z.string().min(1),
});
export type ActiveRun = z.infer<typeof ActiveRun>;

export const RunListResult = z.object({
  runs: z.array(ActiveRun),
});
export type RunListResult = z.infer<typeof RunListResult>;

export const ApprovalRespondResult = z.object({
  approvalId: z.string().min(1),
  delivered: z.boolean(),
});
export type ApprovalRespondResult = z.infer<typeof ApprovalRespondResult>;

export const ShutdownResult = z.object({
  shuttingDown: z.boolean(),
  runsCancelled: z.number().int().nonnegative(),
});
export type ShutdownResult = z.infer<typeof ShutdownResult>;

// ---- Notifications (runtime → client, event stream) ----

export const STREAM_NOTIFICATION = "runtime.event";

export const StreamEventParams = z.object({
  runId: z.string().min(1),
  /** Canonical Mox AgentEvent — the only event shape that crosses the wire. */
  event: AgentEvent,
});
export type StreamEventParams = z.infer<typeof StreamEventParams>;
