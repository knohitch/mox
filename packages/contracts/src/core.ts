import { z } from "zod";

/**
 * Shared primitives for all Mox contracts: branded identifiers, JSON values,
 * scope, timestamps and provider health semantics.
 *
 * Rules (docs/architecture/CONTRACTS.md):
 * - IDs are branded strings; never accept a bare string where an ID is meant.
 * - Vendor-specific data lives in `extension` records, never in top-level fields.
 * - Timestamps are ISO-8601 UTC strings.
 */

export const IsoDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/, "must be an ISO-8601 timestamp");
export type IsoDateTime = z.infer<typeof IsoDateTime>;

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export const JsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(JsonValue), z.record(z.string(), JsonValue)]),
);

/** Vendor/provider-specific metadata. Never interpreted by Mox core. */
export const Extensions = z.record(z.string(), JsonValue);
export type Extensions = z.infer<typeof Extensions>;

// Branded identifiers: each is a distinct nominal type.
export const OrgId = z.string().min(1).brand<"OrgId">();
export const TenantId = z.string().min(1).brand<"TenantId">();
export const UserId = z.string().min(1).brand<"UserId">();
export const AgentId = z.string().min(1).brand<"AgentId">();
export const AgentVersionId = z.string().min(1).brand<"AgentVersionId">();
export const DeploymentId = z.string().min(1).brand<"DeploymentId">();
export const RuntimeId = z.string().min(1).brand<"RuntimeId">();
export const ThreadId = z.string().min(1).brand<"ThreadId">();
export const RoomId = z.string().min(1).brand<"RoomId">();
export const MessageId = z.string().min(1).brand<"MessageId">();
export const TurnId = z.string().min(1).brand<"TurnId">();
export const ProviderId = z.string().min(1).brand<"ProviderId">();
export const ModelId = z.string().min(1).brand<"ModelId">();
export const ConnectionId = z.string().min(1).brand<"ConnectionId">();
export const SessionId = z.string().min(1).brand<"SessionId">();
export const ActionId = z.string().min(1).brand<"ActionId">();
export const InstanceId = z.string().min(1).brand<"InstanceId">();
export const ProductId = z.string().min(1).brand<"ProductId">();
export const ChannelId = z.string().min(1).brand<"ChannelId">();
export const AdapterId = z.string().min(1).brand<"AdapterId">();
export const IntegrationId = z.string().min(1).brand<"IntegrationId">();
export const ToolName = z.string().min(1).brand<"ToolName">();
export const CredentialId = z.string().min(1).brand<"CredentialId">();
export const PolicyRuleId = z.string().min(1).brand<"PolicyRuleId">();
export const DecisionId = z.string().min(1).brand<"DecisionId">();
export const ApprovalId = z.string().min(1).brand<"ApprovalId">();
export const UsageId = z.string().min(1).brand<"UsageId">();
export const CostId = z.string().min(1).brand<"CostId">();
export const NotificationId = z.string().min(1).brand<"NotificationId">();
export const AuditId = z.string().min(1).brand<"AuditId">();
export const OperationId = z.string().min(1).brand<"OperationId">();
export const DesiredStateId = z.string().min(1).brand<"DesiredStateId">();
export const IdempotencyKey = z.string().min(8).max(200).brand<"IdempotencyKey">();
export const EventId = z.string().min(1).brand<"EventId">();
export const CorrelationId = z.string().min(1).brand<"CorrelationId">();
export const CausationId = z.string().min(1).brand<"CausationId">();
export const ResourceId = z.string().min(1).brand<"ResourceId">();

export type OrgId = z.infer<typeof OrgId>;
export type TenantId = z.infer<typeof TenantId>;
export type UserId = z.infer<typeof UserId>;
export type AgentId = z.infer<typeof AgentId>;
export type AgentVersionId = z.infer<typeof AgentVersionId>;
export type DeploymentId = z.infer<typeof DeploymentId>;
export type RuntimeId = z.infer<typeof RuntimeId>;
export type ThreadId = z.infer<typeof ThreadId>;
export type RoomId = z.infer<typeof RoomId>;
export type MessageId = z.infer<typeof MessageId>;
export type TurnId = z.infer<typeof TurnId>;
export type ProviderId = z.infer<typeof ProviderId>;
export type ModelId = z.infer<typeof ModelId>;
export type ConnectionId = z.infer<typeof ConnectionId>;
export type SessionId = z.infer<typeof SessionId>;
export type ActionId = z.infer<typeof ActionId>;
export type InstanceId = z.infer<typeof InstanceId>;
export type ProductId = z.infer<typeof ProductId>;
export type ChannelId = z.infer<typeof ChannelId>;
export type AdapterId = z.infer<typeof AdapterId>;
export type IntegrationId = z.infer<typeof IntegrationId>;
export type ToolName = z.infer<typeof ToolName>;
export type CredentialId = z.infer<typeof CredentialId>;
export type PolicyRuleId = z.infer<typeof PolicyRuleId>;
export type DecisionId = z.infer<typeof DecisionId>;
export type ApprovalId = z.infer<typeof ApprovalId>;
export type UsageId = z.infer<typeof UsageId>;
export type CostId = z.infer<typeof CostId>;
export type NotificationId = z.infer<typeof NotificationId>;
export type AuditId = z.infer<typeof AuditId>;
export type OperationId = z.infer<typeof OperationId>;
export type DesiredStateId = z.infer<typeof DesiredStateId>;
export type IdempotencyKey = z.infer<typeof IdempotencyKey>;
export type EventId = z.infer<typeof EventId>;
export type CorrelationId = z.infer<typeof CorrelationId>;
export type CausationId = z.infer<typeof CausationId>;
export type ResourceId = z.infer<typeof ResourceId>;

/** Reference to a stored credential. Secrets never travel in contracts. */
export const CredentialReference = z.object({
  credentialId: CredentialId,
  kind: z.enum(["api-key", "oauth-token", "password", "certificate", "ssh-key"]),
  label: z.string().min(1),
  /** Locator inside the credential vault; not the secret itself. */
  vaultRef: z.string().min(1),
  expiresAt: IsoDateTime.optional(),
});
export type CredentialReference = z.infer<typeof CredentialReference>;

/** Tenancy scope carried by every event and most records. */
export const Scope = z.object({
  tenantId: TenantId.optional(),
  orgId: OrgId.optional(),
  userId: UserId.optional(),
  resourceId: ResourceId.optional(),
});
export type Scope = z.infer<typeof Scope>;

/** Provider health semantics shared by every provider surface. */
export const HealthState = z.enum(["healthy", "degraded", "unavailable"]);
export type HealthState = z.infer<typeof HealthState>;

export const HealthReport = z.object({
  state: HealthState,
  reason: z.string().optional(),
  checkedAt: IsoDateTime,
  /** Provider-specific diagnostics; never interpreted by Mox core. */
  details: Extensions.optional(),
});
export type HealthReport = z.infer<typeof HealthReport>;

export function healthyReport(now: string): HealthReport {
  return { state: "healthy", checkedAt: now };
}