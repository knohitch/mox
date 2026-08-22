import { z } from "zod";
import {
  AdapterId,
  ApprovalId,
  AuditId,
  ChannelId,
  ConnectionId,
  CostId,
  CredentialReference,
  DecisionId,
  DesiredStateId,
  Extensions,
  IdempotencyKey,
  IntegrationId,
  IsoDateTime,
  JsonValue,
  NotificationId,
  OperationId,
  OrgId,
  PolicyRuleId,
  ResourceId,
  ToolName,
  UsageId,
  UserId,
} from "./core.js";

/**
 * Operational contracts: channels, integrations/tools, policy/approvals,
 * usage/cost/notifications/audit, and idempotent reconciliation
 * (DesiredState + OperationRecord).
 */

// ---- Channels ----

export const ChannelAdapter = z.object({
  adapterId: AdapterId,
  displayName: z.string().min(1),
  kinds: z.array(z.enum(["web", "webhook", "relay"])).min(1),
  extension: Extensions.optional(),
});
export type ChannelAdapter = z.infer<typeof ChannelAdapter>;

export const ChannelConnection = z.object({
  channelId: ChannelId,
  orgId: OrgId,
  adapterId: AdapterId,
  status: z.enum(["active", "paused", "error"]),
  address: z.string().optional(),
  secretRef: CredentialReference.optional(),
  extension: Extensions.optional(),
});
export type ChannelConnection = z.infer<typeof ChannelConnection>;

export const ChannelMessage = z.object({
  messageId: z.string().min(1),
  channelId: ChannelId,
  threadId: z.string().optional(),
  roomId: z.string().optional(),
  author: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("user"), userId: UserId }),
    z.object({ kind: z.literal("agent"), agentId: z.string().min(1) }),
    z.object({ kind: z.literal("system") }),
  ]),
  body: z.object({
    text: z.string().optional(),
    attachments: z.array(z.object({ name: z.string(), url: z.string(), mimeType: z.string() })).optional(),
  }),
  sentAt: IsoDateTime,
});
export type ChannelMessage = z.infer<typeof ChannelMessage>;

// ---- Integrations & tools ----

export const ToolDefinition = z.object({
  name: ToolName,
  displayName: z.string().min(1),
  description: z.string().min(1),
  /** JSON Schema for the tool input. */
  inputSchema: JsonValue,
  dangerLevel: z.enum(["read-only", "write", "destructive", "network", "spend"]),
  requiresApproval: z.boolean(),
});
export type ToolDefinition = z.infer<typeof ToolDefinition>;

export const IntegrationProvider = z.object({
  integrationId: IntegrationId,
  displayName: z.string().min(1),
  auth: z.enum(["oauth2", "api-key", "none"]),
  tools: z.array(ToolDefinition),
  extension: Extensions.optional(),
});
export type IntegrationProvider = z.infer<typeof IntegrationProvider>;

export const IntegrationConnection = z.object({
  connectionId: ConnectionId,
  orgId: OrgId,
  integrationId: IntegrationId,
  credential: CredentialReference,
  status: z.enum(["connected", "expired", "revoked", "error"]),
  scopes: z.array(z.string()).optional(),
});
export type IntegrationConnection = z.infer<typeof IntegrationConnection>;

// ---- Policy & approvals ----

export const PolicyDecision = z.object({
  decisionId: DecisionId,
  subject: z.object({
    agentId: z.string().optional(),
    userId: UserId.optional(),
    toolName: ToolName.optional(),
    actionKind: z.string().optional(),
  }),
  effect: z.enum(["allow", "deny", "needs-approval"]),
  ruleId: PolicyRuleId.optional(),
  reason: z.string().min(1),
  evaluatedAt: IsoDateTime,
  ttlSeconds: z.number().int().positive().optional(),
});
export type PolicyDecision = z.infer<typeof PolicyDecision>;

export const ApprovalRequest = z.object({
  approvalId: ApprovalId,
  orgId: OrgId,
  agentId: z.string().min(1),
  threadId: z.string().optional(),
  kind: z.enum(["tool-run", "computer-action", "spend", "external-send", "deployment"]),
  summary: z.string().min(1),
  payload: JsonValue,
  state: z.enum(["open", "approved", "denied", "expired", "cancelled"]),
  requestedAt: IsoDateTime,
  resolvedAt: IsoDateTime.optional(),
  resolvedBy: UserId.optional(),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequest>;

// ---- Usage / cost / notifications / audit ----

export const UsageEvent = z.object({
  usageId: UsageId,
  orgId: OrgId,
  agentId: z.string().optional(),
  metric: z.enum(["tokens-in", "tokens-out", "actions", "computer-minutes", "voice-minutes", "requests"]),
  quantity: z.number().nonnegative(),
  modelId: z.string().optional(),
  at: IsoDateTime,
  /** Metering metadata (request id, latency, scope used, cost hooks). */
  extension: Extensions.optional(),
});
export type UsageEvent = z.infer<typeof UsageEvent>;

export const CostEvent = z.object({
  costId: CostId,
  orgId: OrgId,
  agentId: z.string().optional(),
  amountCents: z.number(),
  currency: z.string().length(3),
  usageIds: z.array(UsageId).min(1),
  at: IsoDateTime,
});
export type CostEvent = z.infer<typeof CostEvent>;

export const NotificationEvent = z.object({
  notificationId: NotificationId,
  orgId: OrgId,
  userId: UserId,
  channel: z.enum(["in-app", "email", "push", "webhook"]),
  subject: z.string().min(1),
  body: z.string().min(1),
  state: z.enum(["queued", "sent", "failed", "read"]),
  at: IsoDateTime,
});
export type NotificationEvent = z.infer<typeof NotificationEvent>;

export const AuditEvent = z.object({
  auditId: AuditId,
  orgId: OrgId,
  actor: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("user"), userId: UserId }),
    z.object({ kind: z.literal("agent"), agentId: z.string().min(1) }),
    z.object({ kind: z.literal("system") }),
  ]),
  action: z.string().min(1),
  resource: z.object({ kind: z.string().min(1), id: ResourceId }),
  outcome: z.enum(["success", "denied", "error"]),
  metadata: Extensions.optional(),
  at: IsoDateTime,
});
export type AuditEvent = z.infer<typeof AuditEvent>;

// ---- Idempotent reconciliation ----

/** Terminal errors never retry; retryable errors carry bounded retry state. */
export const ErrorClassification = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("terminal"), code: z.string().min(1), message: z.string().min(1) }),
  z.object({
    kind: z.literal("retryable"),
    code: z.string().min(1),
    message: z.string().min(1),
    attempts: z.number().int().positive(),
    maxAttempts: z.number().int().positive(),
    retryAfterSeconds: z.number().int().positive().optional(),
  }),
]);
export type ErrorClassification = z.infer<typeof ErrorClassification>;

export const DesiredStateResourceKind = z.enum([
  "compute-instance",
  "agent-deployment",
  "channel-connection",
  "server",
]);
export type DesiredStateResourceKind = z.infer<typeof DesiredStateResourceKind>;

export const DesiredState = z.object({
  desiredStateId: DesiredStateId,
  orgId: OrgId,
  resourceKind: DesiredStateResourceKind,
  resourceId: ResourceId,
  revision: z.number().int().positive(),
  spec: JsonValue,
  specHash: z.string().min(8),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type DesiredState = z.infer<typeof DesiredState>;

export const OperationRecord = z.object({
  operationId: OperationId,
  idempotencyKey: IdempotencyKey,
  orgId: OrgId,
  desiredStateId: DesiredStateId.optional(),
  resourceKind: DesiredStateResourceKind,
  resourceId: ResourceId,
  phase: z.enum(["planned", "acquiring", "applying", "verifying", "applied", "failed", "cancelled"]),
  desiredRevision: z.number().int().positive().optional(),
  observed: JsonValue.optional(),
  providerRequestId: z.string().optional(),
  providerResourceId: z.string().optional(),
  error: ErrorClassification.optional(),
  retry: z.object({
    attempts: z.number().int().nonnegative(),
    maxAttempts: z.number().int().positive(),
    nextRetryAt: IsoDateTime.optional(),
  }),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OperationRecord = z.infer<typeof OperationRecord>;