import { z } from "zod";
import {
  ConnectionId,
  CredentialReference,
  Extensions,
  HealthReport,
  InstanceId,
  IsoDateTime,
  ModelId,
  OrgId,
  ProductId,
  ProviderId,
  SessionId,
  UserId,
} from "./core.js";

/**
 * Model, computer and compute provider contracts. Vendor-specific fields are
 * carried in `extension` records (Architecture Rule 2); common operations and
 * health semantics stay top-level.
 */

export const ModelCapability = z.enum([
  "chat",
  "tools",
  "vision",
  "audio-in",
  "audio-out",
  "embedding",
  "reasoning",
  "json-mode",
  "streaming",
]);
export type ModelCapability = z.infer<typeof ModelCapability>;

export const ModelDefinition = z.object({
  modelId: ModelId,
  providerId: ProviderId,
  displayName: z.string().min(1),
  contextWindowTokens: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive().optional(),
  capabilities: z.array(ModelCapability),
  pricing: z
    .object({
      inputCentsPerMTok: z.number().nonnegative(),
      outputCentsPerMTok: z.number().nonnegative(),
    })
    .optional(),
  /** Registry metadata (Prompt 07). */
  modalities: z.array(z.enum(["text", "image", "audio", "video"])).optional(),
  reasoningLevels: z.array(z.enum(["none", "low", "medium", "high"])).optional(),
  status: z.enum(["active", "deprecated"]).default("active"),
  /** ISO region codes this model serves; absent = no restriction. */
  regions: z.array(z.string()).optional(),
  extension: Extensions.optional(),
});
export type ModelDefinition = z.infer<typeof ModelDefinition>;

export const ModelProvider = z.object({
  providerId: ProviderId,
  displayName: z.string().min(1),
  kind: z.enum(["api", "cli-proxy", "local", "first-party"]),
  capabilities: z.array(ModelCapability),
  health: HealthReport,
  /** Vendor-specific configuration lives here, never in top-level fields. */
  extension: Extensions.optional(),
});
export type ModelProvider = z.infer<typeof ModelProvider>;

export const ModelConnection = z.object({
  connectionId: ConnectionId,
  orgId: OrgId,
  providerId: ProviderId,
  credential: CredentialReference,
  status: z.enum(["connected", "error", "unauthorized", "disabled"]),
  models: z.array(ModelId).optional(),
  extension: Extensions.optional(),
});
export type ModelConnection = z.infer<typeof ModelConnection>;

export interface ModelSelection {
  providerId: ProviderId;
  modelId: ModelId;
  connectionId?: ConnectionId;
  temperature?: number;
  maxOutputTokens?: number;
  fallback?: ModelSelection;
}
export const ModelSelection: z.ZodType<ModelSelection> = z.lazy(() =>
  z.object({
    providerId: ProviderId,
    modelId: ModelId,
    connectionId: ConnectionId.optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    fallback: z.lazy(() => ModelSelection).optional(),
  }),
);

// ---- Computer (browser/desktop control) ----

export const ComputerProvider = z.object({
  computerProviderId: ProviderId,
  displayName: z.string().min(1),
  kinds: z.array(z.enum(["browser", "desktop", "mobile"])).min(1),
  health: HealthReport,
  extension: Extensions.optional(),
});
export type ComputerProvider = z.infer<typeof ComputerProvider>;

export const ComputerSession = z.object({
  sessionId: SessionId,
  computerProviderId: ProviderId,
  instanceId: InstanceId.optional(),
  orgId: OrgId,
  ownerId: UserId,
  mode: z.enum(["headless", "interactive"]),
  resolution: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).optional(),
  state: z.enum(["pending", "active", "paused", "closed"]),
  startedAt: IsoDateTime,
  endedAt: IsoDateTime.optional(),
});
export type ComputerSession = z.infer<typeof ComputerSession>;

export const ComputerAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("screenshot") }),
  z.object({
    kind: z.literal("click"),
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
    button: z.enum(["left", "right", "middle"]).optional(),
  }),
  z.object({ kind: z.literal("type"), text: z.string() }),
  z.object({ kind: z.literal("key"), key: z.string().min(1) }),
  z.object({ kind: z.literal("scroll"), direction: z.enum(["up", "down"]), amount: z.number().int().positive() }),
  z.object({ kind: z.literal("navigate"), url: z.string().min(1) }),
  z.object({ kind: z.literal("execute"), command: z.string().min(1) }),
  z.object({ kind: z.literal("wait"), ms: z.number().int().positive() }),
]);
export type ComputerAction = z.infer<typeof ComputerAction>;

// ---- Compute (infrastructure) ----

export const ComputeClass = z.enum(["nano", "small", "medium", "large", "gpu-small", "gpu-large"]);
export type ComputeClass = z.infer<typeof ComputeClass>;

export const ComputeProduct = z.object({
  productId: ProductId,
  computeProviderId: ProviderId,
  displayName: z.string().min(1),
  classes: z.array(ComputeClass).min(1),
  currency: z.string().length(3),
  unitPriceCents: z.number().nonnegative(),
  unit: z.enum(["hour", "minute", "month"]),
});
export type ComputeProduct = z.infer<typeof ComputeProduct>;

export const ComputeProvider = z.object({
  computeProviderId: ProviderId,
  displayName: z.string().min(1),
  products: z.array(ComputeProduct),
  health: HealthReport,
  extension: Extensions.optional(),
});
export type ComputeProvider = z.infer<typeof ComputeProvider>;

export const ComputeInstance = z.object({
  instanceId: InstanceId,
  orgId: OrgId,
  productId: ProductId,
  computeClass: ComputeClass,
  state: z.enum(["requested", "provisioning", "running", "degraded", "stopped", "terminated"]),
  providerResourceId: z.string().optional(),
  region: z.string().optional(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ComputeInstance = z.infer<typeof ComputeInstance>;