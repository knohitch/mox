/** Pure operational-summary helpers for the customer dashboard. */

export interface AttentionItem {
  id: string;
  title: string;
  detail: string;
  tone: "warn" | "bad";
  href: string;
}

export interface OpsSnapshot {
  agentCount: number;
  runningAgents: number;
  deploymentCount: number;
  failedDeployments: number;
  serverCount: number;
  healthyServers: number;
  degradedServers: number;
  openApprovals: number;
  commerciallyEntitled: boolean | undefined;
}

export function buildOpsSnapshot(input: {
  agents: Array<{ runtimeStatus?: string; deploymentState?: string }>;
  deployments: Array<{ state?: string }>;
  servers: Array<{ state?: string }>;
  approvals: unknown[];
  commerciallyEntitled?: boolean;
}): OpsSnapshot {
  const runningAgents = input.agents.filter((agent) => {
    const state = `${agent.runtimeStatus ?? ""} ${agent.deploymentState ?? ""}`.toLowerCase();
    return state.includes("running") || state.includes("working") || state.includes("busy") || state.includes("active");
  }).length;
  const failedDeployments = input.deployments.filter((row) => /fail|error/.test((row.state ?? "").toLowerCase())).length;
  const healthyServers = input.servers.filter((row) => /run|health|active|online/.test((row.state ?? "").toLowerCase())).length;
  const degradedServers = input.servers.filter((row) => /fail|error|degrad|stop|offline/.test((row.state ?? "").toLowerCase())).length;
  return {
    agentCount: input.agents.length,
    runningAgents,
    deploymentCount: input.deployments.length,
    failedDeployments,
    serverCount: input.servers.length,
    healthyServers,
    degradedServers,
    openApprovals: input.approvals.length,
    commerciallyEntitled: input.commerciallyEntitled,
  };
}

export function buildAttentionItems(input: {
  snapshot: OpsSnapshot;
  failedDeploymentLabels: string[];
  degradedServerLabels: string[];
}): AttentionItem[] {
  const items: AttentionItem[] = [];
  if (input.snapshot.openApprovals > 0) {
    items.push({
      id: "approvals",
      title: `${input.snapshot.openApprovals} approval${input.snapshot.openApprovals === 1 ? "" : "s"} waiting`,
      detail: "An agent is blocked until you approve or deny the request.",
      tone: "warn",
      href: "/agents",
    });
  }
  if (input.snapshot.failedDeployments > 0) {
    items.push({
      id: "deployments",
      title: `${input.snapshot.failedDeployments} failed deployment${input.snapshot.failedDeployments === 1 ? "" : "s"}`,
      detail: input.failedDeploymentLabels.slice(0, 3).join(", ") || "Open Deployments to inspect the failure.",
      tone: "bad",
      href: "/deployments",
    });
  }
  if (input.snapshot.degradedServers > 0) {
    items.push({
      id: "servers",
      title: `${input.snapshot.degradedServers} server${input.snapshot.degradedServers === 1 ? "" : "s"} need attention`,
      detail: input.degradedServerLabels.slice(0, 3).join(", ") || "Open Servers for lifecycle state.",
      tone: "bad",
      href: "/servers",
    });
  }
  if (input.snapshot.commerciallyEntitled === false) {
    items.push({
      id: "billing",
      title: "Commercial access is inactive",
      detail: "Billing or entitlement is blocking paid capabilities.",
      tone: "warn",
      href: "/billing",
    });
  }
  return items;
}

export function isNewWorkspace(snapshot: OpsSnapshot): boolean {
  return snapshot.agentCount === 0 && snapshot.serverCount === 0 && snapshot.deploymentCount === 0;
}
