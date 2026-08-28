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
