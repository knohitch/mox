/**
 * Agent versioning + deployment reconciliation (Prompt 10).
 *
 * - Drafts are editable; publish freezes an immutable version snapshot.
 * - Deployments pin an exact published version; running deployments are
 *   never mutated invisibly.
 * - Reconciliation drives desired state to Mox Node via signed commands
 *   (transport abstracted behind NodeChannel for tests/production).
 */

import type { AgentDefinition, DeploymentTarget } from "@mox/contracts";

export interface AgentRecord {
  agentId: string;
  orgId: string;
  slug: string;
  /** Live draft definition; safe to edit. */
  draft: AgentDefinition;
  status: "draft" | "active" | "paused" | "retired";
  createdAt: string;
  updatedAt: string;
}

export interface AgentVersionRecord {
  agentId: string;
  revision: number;
  definition: AgentDefinition;
  changelog?: string;
  createdBy: string;
  createdAt: string;
}

export interface DeploymentRecord {
  deploymentId: string;
  orgId: string;
  agentId: string;
  /** Exact pinned version; rollback re-pins an older one. */
  revision: number;
  target: DeploymentTarget;
  state: "desired" | "provisioning" | "running" | "degraded" | "stopped" | "failed";
  lastAppliedAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentControlStore {
  upsertAgent(agent: AgentRecord): Promise<void>;
  getAgent(orgId: string, slug: string): Promise<AgentRecord | undefined>;
  listAgents(orgId: string): Promise<AgentRecord[]>;
  listAllAgents(): Promise<AgentRecord[]>;
  appendVersion(version: AgentVersionRecord): Promise<boolean>;
  getVersion(agentId: string, revision: number): Promise<AgentVersionRecord | undefined>;
  listVersions(agentId: string): Promise<AgentVersionRecord[]>;
  upsertDeployment(deployment: DeploymentRecord): Promise<DeploymentRecord>;
  getDeployment(deploymentId: string): Promise<DeploymentRecord | undefined>;
  findDeploymentsForAgent(agentId: string): Promise<DeploymentRecord[]>;
}

export class InMemoryAgentControlStore implements AgentControlStore {
  private readonly agents = new Map<string, AgentRecord>();
  private readonly versions = new Map<string, AgentVersionRecord[]>();
  private readonly deployments = new Map<string, DeploymentRecord>();

  async upsertAgent(agent: AgentRecord): Promise<void> {
    this.agents.set(`${agent.orgId}:${agent.slug}`, agent);
  }

  async getAgent(orgId: string, slug: string): Promise<AgentRecord | undefined> {
    return this.agents.get(`${orgId}:${slug}`);
  }

  async listAgents(orgId: string): Promise<AgentRecord[]> {
    return [...this.agents.values()].filter((a) => a.orgId === orgId);
  }

  async listAllAgents(): Promise<AgentRecord[]> {
    return [...this.agents.values()];
  }

  async appendVersion(version: AgentVersionRecord): Promise<boolean> {
    const list = this.versions.get(version.agentId) ?? [];
    if (list.some((v) => v.revision === version.revision)) return false;
    list.push(version);
    this.versions.set(version.agentId, list);
    return true;
  }

  async getVersion(agentId: string, revision: number): Promise<AgentVersionRecord | undefined> {
    return (this.versions.get(agentId) ?? []).find((v) => v.revision === revision);
  }

  async listVersions(agentId: string): Promise<AgentVersionRecord[]> {
    return [...(this.versions.get(agentId) ?? [])].sort((a, b) => a.revision - b.revision);
  }

  async upsertDeployment(deployment: DeploymentRecord): Promise<DeploymentRecord> {
    this.deployments.set(deployment.deploymentId, deployment);
    return deployment;
  }

  async getDeployment(deploymentId: string): Promise<DeploymentRecord | undefined> {
    return this.deployments.get(deploymentId);
  }

  async findDeploymentsForAgent(agentId: string): Promise<DeploymentRecord[]> {
    return [...this.deployments.values()].filter((d) => d.agentId === agentId);
  }
}

/** Transport to a Mox Node; production uses signed command envelopes. */
export interface NodeChannel {
  applyWorkload(input: {
    nodeId: string;
    deploymentId: string;
    image: string;
    env: Record<string, string>;
    restartPolicy: "no" | "on-failure" | "always";
    cpus?: number;
    memoryMb?: number;
  }): Promise<void>;
  stopWorkload(nodeId: string, name: string): Promise<void>;
}

export function diffDefinitions(a: AgentDefinition, b: AgentDefinition): string[] {
  const changes: string[] = [];
  if (a.instructions.text !== b.instructions.text) changes.push("instructions");
  if (JSON.stringify(a.model) !== JSON.stringify(b.model)) changes.push("model");
  if (JSON.stringify(a.tools) !== JSON.stringify(b.tools)) changes.push("tools");
  if (JSON.stringify(a.permissions) !== JSON.stringify(b.permissions)) changes.push("permissions");
  if (JSON.stringify(a.computer) !== JSON.stringify(b.computer)) changes.push("computer");
  if (JSON.stringify(a.schedules) !== JSON.stringify(b.schedules)) changes.push("schedules");
  if (JSON.stringify(a.channels) !== JSON.stringify(b.channels)) changes.push("channels");
  if (JSON.stringify(a.knowledge) !== JSON.stringify(b.knowledge)) changes.push("knowledge");
  return changes;
}
