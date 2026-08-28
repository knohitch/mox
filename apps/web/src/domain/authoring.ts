import type { AgentDefinition } from "@mox/contracts";
import type { AgentSummary, SimpleAgentInput } from "../api/types.js";

/**
 * Simple-mode authoring round-trip (Phase 02 §J).
 *
 * Rebuild a Simple-mode input from a canonical definition so the Settings
 * surface can let a user edit the fields the Simple builder accepts. Lossless
 * for the fields Simple Mode produces; developer-authored definitions fall
 * back to their existing values (the UI disables inline editing for those).
 */
export function permissionPresetFromDefinition(d: Pick<AgentDefinition, "permissions">): SimpleAgentInput["permissionsPreset"] {
  if (d.permissions.toolPolicy === "allow-all") return "full";
  if (d.permissions.requireApprovalFor?.includes("computer")) return "safe";
  return "balanced";
}

export function simpleInputFromDefinition(d: AgentSummary["definition"]): SimpleAgentInput {
  const target =
    d.deployment.kind === "customer-vps"
      ? { kind: "customer-vps" as const, vpsId: d.deployment.vpsId }
      : d.deployment.kind === "mox-cloud"
        ? { kind: "mox-cloud" as const, region: d.deployment.region }
        : { kind: "sandbox" as const };
  return {
    displayName: d.identity.displayName,
    role: d.identity.role,
    instructions: d.instructions.text,
    model: `${d.model.providerId}/${d.model.modelId}`,
    toolNames: d.tools.toolNames,
    browserEnabled: d.computer.enabled,
    permissionsPreset: permissionPresetFromDefinition(d),
    target,
  };
}

/** Deterministic slug from a display name (mirrors the modal's live slug). */
export function slugFromName(name: string): string | undefined {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || undefined;
}