import type { AgentDefinition } from "@mox/contracts";

/**
 * Agent roster presence (Prompt 05). One normalized Mox `Agent` concept —
 * never separate "bot"/"coworker" models. Presence derives from runtime +
 * deployment facts; UI vocabulary only.
 */

export type AgentStatus = "running" | "working" | "idle" | "unavailable";

export interface AgentPresenceInput {
  definition: AgentDefinition;
  deploymentState?: string;
  runtimeStatus?: string;
  hasUnread?: boolean;
}

export function agentStatus(input: AgentPresenceInput): AgentStatus {
  switch (input.runtimeStatus) {
    case "busy":
      return "working";
    case "ready":
      return input.hasUnread ? "working" : "running";
    case "starting":
      return "running";
    case "crashed":
    case "stopping":
      return "unavailable";
    default:
      break;
  }
  switch (input.deploymentState) {
    case "running":
      return "idle";
    case "provisioning":
    case "desired":
      return "running";
    case "degraded":
      return "unavailable";
    case "failed":
    case "stopped":
      return "unavailable";
    default:
      return "unavailable";
  }
}

/** Deterministic hue from the agent slug so avatars are stable across renders. */
export function avatarHue(slug: string): number {
  let h = 0;
  for (let i = 0; i < slug.length; i += 1) {
    h = (h * 31 + slug.charCodeAt(i)) % 360;
  }
  return h;
}

export function initials(definition: Pick<AgentDefinition, "identity" | "slug">): string {
  const name = definition.identity.displayName.trim();
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}`.toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

export const STATUS_LABEL: Record<AgentStatus, string> = {
  running: "Online",
  working: "Working",
  idle: "Idle",
  unavailable: "Unavailable",
};
