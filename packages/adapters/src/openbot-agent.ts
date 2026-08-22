import { AgentDefinition, type ModelSelection } from "@mox/contracts";

/**
 * OpenBot agent profile → Mox AgentDefinition.
 *
 * `OpenBotAgentProfile` is a structural mirror of the minimal fields an
 * OpenBot agents.yaml profile carries. It deliberately does NOT import from
 * OpenBot-main: imported trees must never become a dependency sink for new
 * Mox code (docs/architecture/REPOSITORY_LAYOUT.md).
 */

export interface OpenBotAgentProfile {
  name: string;
  description?: string;
  prompt: string;
  model?: string;
  temperature?: number;
  tools?: string[];
  avatarUrl?: string;
  tags?: string[];
}

export interface OpenBotProfileMappingOptions {
  orgId: string;
  agentId: string;
  now: string;
  /** Default model selection when the profile does not name one. */
  defaultModel: ModelSelection;
}

export function openBotProfileToAgentDefinition(
  profile: OpenBotAgentProfile,
  opts: OpenBotProfileMappingOptions,
): AgentDefinition {
  const ts = opts.now;
  return AgentDefinition.parse({
    schemaVersion: 1,
    agentId: opts.agentId,
    orgId: opts.orgId,
    slug: profile.name,
    identity: {
      displayName: profile.name,
      role: profile.description,
      avatarUrl: profile.avatarUrl,
    },
    instructions: { text: profile.prompt },
    model: profile.model ? { ...opts.defaultModel, modelId: profile.model } : opts.defaultModel,
    tools: { toolNames: profile.tools ?? [], integrations: [] },
    skills: [],
    knowledge: [],
    computer: { enabled: false, allowBrowser: false, sandbox: "none" },
    voice: { enabled: false },
    channels: [],
    deployment: { kind: "sandbox" },
    permissions: { toolPolicy: "default" },
    memory: { enabled: false, scope: "thread" },
    schedules: [],
    workflows: [],
    subagents: [],
    authoring: { mode: "developer" },
    metadata: { source: "openbot", tags: profile.tags ?? [] },
    createdAt: ts,
    updatedAt: ts,
  });
}
