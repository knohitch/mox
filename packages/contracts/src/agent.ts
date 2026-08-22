import { z } from "zod";
import {
  AgentId,
  AgentVersionId,
  DeploymentId,
  EventId,
  IntegrationId,
  IsoDateTime,
  JsonValue,
  MessageId,
  OrgId,
  RoomId,
  RuntimeId,
  ThreadId,
  ToolName,
  TurnId,
  UserId,
} from "./core.js";
import { ModelSelection } from "./model.js";

/**
 * Agent contracts: definition, versioning, deployment, runtime, events,
 * threads and rooms. Simple and Developer authoring modes both compile into
 * the single AgentDefinition schema (Architecture Rule 5); `authoring` is
 * UI metadata only and never changes runtime semantics.
 */

export const SystemInstructions = z.object({
  text: z.string().min(1),
  appendices: z.array(z.string()).optional(),
});
export type SystemInstructions = z.infer<typeof SystemInstructions>;

export const SkillRef = z.object({
  skillId: z.string().min(1),
  version: z.string().optional(),
  config: JsonValue.optional(),
});
export type SkillRef = z.infer<typeof SkillRef>;

export const KnowledgeRef = z.object({
  knowledgeId: z.string().min(1),
  access: z.array(z.enum(["read", "search", "attach"])).min(1),
});
export type KnowledgeRef = z.infer<typeof KnowledgeRef>;

export const ComputerSettings = z.object({
  enabled: z.boolean(),
  providerId: z.string().optional(),
  allowBrowser: z.boolean(),
  sandbox: z.enum(["none", "container", "vm"]),
  allowScreenControl: z.boolean().optional(),
});
export type ComputerSettings = z.infer<typeof ComputerSettings>;

export const VoiceSettings = z.object({
  enabled: z.boolean(),
  voiceId: z.string().optional(),
  ttsProviderId: z.string().optional(),
  sttProviderId: z.string().optional(),
});
export type VoiceSettings = z.infer<typeof VoiceSettings>;

export const ChannelBinding = z.object({
  channelId: z.string().min(1),
  address: z.string().optional(),
});
export type ChannelBinding = z.infer<typeof ChannelBinding>;

export const DeploymentTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("mox-cloud"), region: z.string().optional() }),
  z.object({ kind: z.literal("customer-vps"), vpsId: z.string().min(1) }),
  z.object({ kind: z.literal("local-device"), deviceId: z.string().min(1) }),
  z.object({ kind: z.literal("sandbox") }),
]);
export type DeploymentTarget = z.infer<typeof DeploymentTarget>;

export const Permissions = z.object({
  toolPolicy: z.enum(["default", "allow-all", "custom"]),
  allowedTools: z.array(ToolName).optional(),
  deniedTools: z.array(ToolName).optional(),
  requireApprovalFor: z.array(z.enum(["computer", "spend", "external-send", "deployment"])).optional(),
  maxSpendPerDayCents: z.number().int().nonnegative().optional(),
});
export type Permissions = z.infer<typeof Permissions>;

export const MemoryConfig = z.object({
  enabled: z.boolean(),
  scope: z.enum(["thread", "room", "agent", "org"]),
  retentionDays: z.number().int().positive().optional(),
});
export type MemoryConfig = z.infer<typeof MemoryConfig>;

export const Schedule = z.object({
  scheduleId: z.string().min(1),
  cron: z.string().min(1),
  timezone: z.string().min(1),
  prompt: z.string().min(1),
  enabled: z.boolean(),
});
export type Schedule = z.infer<typeof Schedule>;

export const SubagentRef = z.object({
  agentId: AgentId,
  delegation: z.enum(["ask", "auto"]),
});
export type SubagentRef = z.infer<typeof SubagentRef>;

export const WorkflowRef = z.object({
  workflowId: z.string().min(1),
  entryAgentId: AgentId.optional(),
});
export type WorkflowRef = z.infer<typeof WorkflowRef>;

/** Simple/Developer UI metadata. Never read by the runtime. */
export const AuthoringMeta = z.object({
  mode: z.enum(["simple", "developer"]),
  sourceTemplateId: z.string().optional(),
  ui: z
    .object({
      iconEmoji: z.string().optional(),
      accentColor: z.string().optional(),
      category: z.string().optional(),
      showAdvanced: z.boolean().optional(),
    })
    .optional(),
});
export type AuthoringMeta = z.infer<typeof AuthoringMeta>;

export const AgentDefinition = z.object({
  schemaVersion: z.literal(1),
  agentId: AgentId,
  orgId: OrgId,
  slug: z.string().min(1),
  identity: z.object({
    displayName: z.string().min(1),
    title: z.string().optional(),
    role: z.string().optional(),
    avatarUrl: z.string().optional(),
  }),
  instructions: SystemInstructions,
  model: ModelSelection,
  tools: z.object({
    toolNames: z.array(ToolName),
    integrations: z.array(z.object({ integrationId: IntegrationId, connectionId: z.string().optional() })),
  }),
  skills: z.array(SkillRef),
  knowledge: z.array(KnowledgeRef),
  computer: ComputerSettings,
  voice: VoiceSettings,
  channels: z.array(ChannelBinding),
  deployment: DeploymentTarget,
  permissions: Permissions,
  memory: MemoryConfig,
  schedules: z.array(Schedule),
  workflows: z.array(WorkflowRef),
  subagents: z.array(SubagentRef),
  authoring: AuthoringMeta,
  metadata: z.record(z.string(), JsonValue),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type AgentDefinition = z.infer<typeof AgentDefinition>;

/** Immutable snapshot of a definition; deployments pin a version. */
export const AgentVersion = z.object({
  versionId: AgentVersionId,
  agentId: AgentId,
  revision: z.number().int().positive(),
  definition: AgentDefinition,
  changelog: z.string().optional(),
  createdBy: UserId,
  createdAt: IsoDateTime,
});
export type AgentVersion = z.infer<typeof AgentVersion>;

export const AgentDeployment = z.object({
  deploymentId: DeploymentId,
  agentId: AgentId,
  versionId: AgentVersionId,
  target: DeploymentTarget,
  state: z.enum(["desired", "provisioning", "running", "degraded", "stopped", "failed"]),
  lastOperationId: z.string().optional(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type AgentDeployment = z.infer<typeof AgentDeployment>;

export const AgentRuntime = z.object({
  runtimeId: RuntimeId,
  agentId: AgentId,
  deploymentId: DeploymentId,
  host: z.enum(["mox-cloud", "customer-vps", "local-device"]),
  status: z.enum(["starting", "ready", "busy", "stopping", "crashed"]),
  capabilities: z.array(z.string()),
  startedAt: IsoDateTime,
  heartbeatAt: IsoDateTime,
});
export type AgentRuntime = z.infer<typeof AgentRuntime>;

// Agent events: discriminated union on `type`.
const AgentEventBase = z.object({
  eventId: EventId,
  agentId: AgentId,
  threadId: ThreadId.optional(),
  roomId: RoomId.optional(),
  turnId: TurnId.optional(),
  at: IsoDateTime,
});

export const AgentEvent = z.discriminatedUnion("type", [
  AgentEventBase.extend({ type: z.literal("turn.started"), input: JsonValue.optional() }),
  AgentEventBase.extend({ type: z.literal("turn.completed"), output: JsonValue.optional() }),
  AgentEventBase.extend({ type: z.literal("turn.failed"), error: z.string().min(1) }),
  AgentEventBase.extend({ type: z.literal("message.delta"), messageId: MessageId, delta: z.string() }),
  AgentEventBase.extend({ type: z.literal("message.completed"), messageId: MessageId, text: z.string() }),
  AgentEventBase.extend({ type: z.literal("tool.requested"), toolName: ToolName, input: JsonValue }),
  AgentEventBase.extend({
    type: z.literal("tool.completed"),
    toolName: ToolName,
    output: JsonValue,
    ok: z.boolean(),
  }),
  AgentEventBase.extend({ type: z.literal("approval.opened"), approvalId: z.string().min(1), summary: z.string() }),
  AgentEventBase.extend({
    type: z.literal("approval.resolved"),
    approvalId: z.string().min(1),
    outcome: z.enum(["approved", "denied", "expired"]),
  }),
  AgentEventBase.extend({ type: z.literal("error"), error: z.string().min(1), fatal: z.boolean() }),
]);
export type AgentEvent = z.infer<typeof AgentEvent>;

export const AgentThread = z.object({
  threadId: ThreadId,
  agentId: AgentId,
  orgId: OrgId,
  userId: UserId.optional(),
  roomId: RoomId.optional(),
  title: z.string().optional(),
  state: z.enum(["active", "archived"]),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type AgentThread = z.infer<typeof AgentThread>;

export const AgentRoom = z.object({
  roomId: RoomId,
  orgId: OrgId,
  title: z.string().min(1),
  memberAgentIds: z.array(AgentId),
  memberUserIds: z.array(UserId),
  createdAt: IsoDateTime,
});
export type AgentRoom = z.infer<typeof AgentRoom>;