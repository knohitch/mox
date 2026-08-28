export type ServerState =
  | "requested"
  | "provisioning"
  | "running"
  | "error"
  | "resizing"
  | "stopping"
  | "stopped"
  | "cancelling"
  | "canceled"
  | "retention"
  | "destroyed";

export type DeploymentKind = "sandbox" | "shared_host" | "dedicated_vps" | "customer_vps";

export type DeploymentState = "desired" | "provisioning" | "running" | "degraded" | "stopped" | "failed";

export function projectDeploymentState(
  orderState: ServerState | undefined,
  heartbeatAt: string | undefined,
): DeploymentState {
  if (!orderState) return "desired";
  switch (orderState) {
    case "running":
      return heartbeatAt ? "running" : "degraded";
    case "requested":
    case "provisioning":
    case "resizing":
    case "cancelling":
      return "provisioning";
    case "stopping":
    case "stopped":
    case "canceled":
    case "retention":
    case "destroyed":
      return "stopped";
    case "error":
      return "failed";
    default:
      return "desired";
  }
}

export function projectDeploymentTarget(
  kind: DeploymentKind,
  orderId: string | undefined,
): { kind: string; vpsId?: string; region?: string } {
  switch (kind) {
    case "sandbox":
      return { kind: "sandbox" };
    case "customer_vps":
      return { kind: "customer-vps", vpsId: orderId ?? "" };
    case "shared_host":
    case "dedicated_vps":
    default:
      return { kind: "mox-cloud" };
  }
}

export function deploymentVersionId(agentId: string | undefined, desiredRevision: number): string {
  return `${agentId ?? "unknown"}@${desiredRevision}`;
}

export type ModelAvailability = { state: "available" | "not_configured" | "error"; reason?: string };

export function projectModelAvailability(status: string, hasCreds: boolean): ModelAvailability {
  if (!hasCreds) {
    return { state: "not_configured", reason: "no provider credentials connected" };
  }
  switch (status) {
    case "configured":
      return { state: "available" };
    case "error":
      return { state: "error", reason: "provider connection error" };
    case "disabled":
    case "unconfigured":
    default:
      return { state: "not_configured", reason: status };
  }
}

export interface ServerOrderView {
  providerInstanceId?: string | null;
  id: string;
  hostname: string;
  computeClassCode?: string | null;
  regionCode?: string | null;
  state: ServerState;
  providerName?: string | null;
  lastError?: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface ServerSummaryView {
  serverId: string;
  orderId: string;
  displayName: string;
  kind: "customer-vps";
  computeClass: string | null;
  region: string;
  state: ServerState;
  agentsRunning: null;
  cpuPct: null;
  memPct: null;
  provider: string | null;
  lastError: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export function projectServerSummary(order: ServerOrderView): ServerSummaryView {
  return {
    serverId: order.providerInstanceId ?? order.id,
    orderId: order.id,
    displayName: order.hostname,
    kind: "customer-vps",
    computeClass: order.computeClassCode ?? null,
    region: order.regionCode ?? "unknown",
    state: order.state,
    agentsRunning: null,
    cpuPct: null,
    memPct: null,
    provider: order.providerName ?? null,
    lastError: order.lastError ?? null,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
}

// ---- Phase 04: Extended Capabilities Projections ----------------------------

export type UsageStatus =
  | "within_included"
  | "soft_limit_warning"
  | "hard_limit_blocked"
  | "unlimited"
  | "overage";

export function projectUsageStatus(
  consumed: number,
  included: number,
  limits?: { hardLimit?: number; softLimit?: number },
): UsageStatus {
  if (included < 0 && limits?.hardLimit === undefined) {
    return "unlimited";
  }
  if (limits?.hardLimit !== undefined && consumed > limits.hardLimit) {
    return "hard_limit_blocked";
  }
  if (limits?.softLimit !== undefined && consumed > limits.softLimit) {
    return "soft_limit_warning";
  }
  if (included >= 0 && consumed > included) {
    return "overage";
  }
  return "within_included";
}

/** Customer-safe backup location descriptor (never leaks s3 credentials or internal bucket paths). */
export function maskBackupLocation(location: string, kind: string): string {
  if (kind === "s3_copy" || location.startsWith("s3://")) {
    return "Mox Cloud Storage";
  }
  if (kind === "provider_snapshot" || location.includes("snapshot")) {
    return "Server Snapshot";
  }
  return "Cloud Storage";
}

/** Owner safety rules for team member mutations. */
export function canMutateMember(params: {
  callerRole: string;
  targetRole: string;
  isOwnerTarget: boolean;
  activeOwnerCount: number;
  action: "demote" | "remove";
}): { allowed: boolean; reason?: string } {
  if (params.isOwnerTarget) {
    if (params.callerRole !== "owner") {
      return { allowed: false, reason: "only workspace owners can modify owner memberships" };
    }
    if (params.activeOwnerCount <= 1) {
      return { allowed: false, reason: "cannot demote or remove the only remaining workspace owner" };
    }
  }
  return { allowed: true };
}

/** Validates schedule count against schedule_workflow_limit entitlement. */
export function validateScheduleLimit(
  schedulesCount: number,
  limit: number,
): { allowed: boolean; reason?: string } {
  if (limit >= 0 && schedulesCount > limit) {
    return { allowed: false, reason: `schedules count (${schedulesCount}) exceeds entitlement limit (${limit})` };
  }
  return { allowed: true };
}

/** Validates subagent delegation refs to prevent self-reference cycles. */
export function validateSubagents(
  subagents: Array<{ agentId: string }>,
  currentAgentId: string,
  currentSlug?: string,
): { valid: boolean; reason?: string } {
  for (const sub of subagents) {
    if (sub.agentId === currentAgentId || (currentSlug && sub.agentId === currentSlug)) {
      return { valid: false, reason: "subagent cannot self-reference the agent itself" };
    }
  }
  return { valid: true };
}

/** Validates knowledge access permissions. */
export function validateKnowledgeAccess(
  access: string[],
): { valid: boolean; reason?: string } {
  if (!access || access.length === 0) {
    return { valid: false, reason: "at least one access permission is required" };
  }
  const allowed = new Set(["read", "search", "attach"]);
  for (const a of access) {
    if (!allowed.has(a)) {
      return { valid: false, reason: `invalid knowledge access permission: ${a}` };
    }
  }
  return { valid: true };
}


