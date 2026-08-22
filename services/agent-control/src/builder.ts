/**
 * Simple Mode builder (Prompt 10): a no-code input shape that compiles into
 * the canonical AgentDefinition. Developer Mode authors the same definition
 * directly — there is exactly one agent engine (Architecture Rule 5).
 */

import { randomUUID } from "node:crypto";
import { AgentDefinition } from "@mox/contracts";

export interface SimpleModeInput {
  orgId: string;
  slug: string;
  displayName: string;
  avatarUrl?: string;
  role?: string;
  instructions: string;
  /** Model selection as "providerSlug/modelSlug". */
  model: string;
  toolNames: string[];
  knowledgeIds?: string[];
  browserEnabled: boolean;
  channelIds?: string[];
  schedule?: { cron: string; timezone: string; prompt: string };
  /** Deployment target: customer-vps server id, sandbox, or mox-cloud region. */
  target:
    | { kind: "customer-vps"; vpsId: string }
    | { kind: "mox-cloud"; region?: string }
    | { kind: "sandbox" };
  voiceEnabled?: boolean;
  voiceId?: string;
  permissionsPreset: "safe" | "balanced" | "full";
}

const PERMISSION_PRESETS: Record<
  SimpleModeInput["permissionsPreset"],
  { toolPolicy: "default" | "allow-all" | "custom"; requireApprovalFor: string[] }
> = {
  safe: { toolPolicy: "default", requireApprovalFor: ["computer", "spend", "external-send", "deployment"] },
  balanced: { toolPolicy: "default", requireApprovalFor: ["spend", "external-send"] },
  full: { toolPolicy: "allow-all", requireApprovalFor: [] },
};

function nowIso(): string {
  return new Date().toISOString();
}

/** Compile a Simple Mode form into the same AgentDefinition devs author. */
export function compileSimpleMode(input: SimpleModeInput): AgentDefinition {
  const preset = PERMISSION_PRESETS[input.permissionsPreset];
  const now = nowIso();
  return AgentDefinition.parse({
    schemaVersion: 1,
    agentId: `agent_${randomUUID()}`,
    orgId: input.orgId,
    slug: input.slug,
    identity: {
      displayName: input.displayName,
      role: input.role,
      avatarUrl: input.avatarUrl,
    },
    instructions: { text: input.instructions },
    model: parseModelSelection(input.model),
    tools: { toolNames: input.toolNames, integrations: [] },
    skills: [],
    knowledge: (input.knowledgeIds ?? []).map((id) => ({ knowledgeId: id, access: ["read", "search"] })),
    computer: {
      enabled: input.browserEnabled,
      allowBrowser: input.browserEnabled,
      sandbox: input.browserEnabled ? "container" : "none",
    },
    voice: {
      enabled: Boolean(input.voiceEnabled),
      voiceId: input.voiceId,
    },
    channels: (input.channelIds ?? []).map((id) => ({ channelId: id })),
    deployment: input.target,
    permissions: {
      toolPolicy: preset.toolPolicy,
      requireApprovalFor: preset.requireApprovalFor as never,
    },
    memory: { enabled: true, scope: "org" },
    schedules: input.schedule
      ? [{ scheduleId: `sched_${randomUUID()}`, ...input.schedule, enabled: true }]
      : [],
    workflows: [],
    subagents: [],
    authoring: { mode: "simple" },
    metadata: {},
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * Parse "provider/model" pairs. Full provider resolution happens in the
 * model gateway; the builder only normalizes the selection shape.
 */
function parseModelSelection(model: string): { providerId: string; modelId: string } {
  const [providerId, modelId] = model.split("/");
  if (!providerId || !modelId) {
    throw new Error(`model must be "provider/model": ${model}`);
  }
  return { providerId, modelId };
}

/** Developer Mode path: validate the raw definition (same schema). */
export function compileDeveloperMode(raw: unknown): AgentDefinition {
  return AgentDefinition.parse(raw);
}
