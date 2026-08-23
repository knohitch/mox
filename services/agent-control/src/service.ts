/**
 * Agent control service (Prompt 10): versioning, deployment reconciliation,
 * entitlement gating and audited browser terminal sessions.
 */

import type { AgentDefinition, DeploymentTarget } from "@mox/contracts";
import { EntitlementService } from "@mox/entitlements";
import {
  InMemoryAgentControlStore,
  diffDefinitions,
  type AgentControlStore,
  type AgentRecord,
  type AgentVersionRecord,
  type DeploymentRecord,
  type NodeChannel,
} from "./store.js";

export class AgentControlError extends Error {}
export class NotEntitledError extends AgentControlError {}

function nowIso(): string {
  return new Date().toISOString();
}

export interface DeployImageResolver {
  /** Maps an agent + target to the container image the node should run. */
  resolve(definition: AgentDefinition, target: DeploymentTarget): Promise<{ image: string; env: Record<string, string> }>;
}

/** Default resolver: Mox Runtime image; external endpoints proxy instead. */
export class DefaultImageResolver implements DeployImageResolver {
  async resolve(
    definition: AgentDefinition,
    target: DeploymentTarget,
  ): Promise<{ image: string; env: Record<string, string> }> {
    if (target.kind === "local-device") throw new AgentControlError("local-device targets are not deployable from web");
    const image =
      "runtimeImage" in definition.metadata && typeof definition.metadata.runtimeImage === "string"
        ? definition.metadata.runtimeImage
        : "ghcr.io/mox/mox-runtime:latest";
    return {
      image,
      env: {
        MOX_AGENT_ID: definition.agentId,
        MOX_ORG_ID: definition.orgId,
        MOX_AGENT_SLUG: definition.slug,
        ...(target.kind === "customer-vps" ? { MOX_TARGET_VPS: target.vpsId } : {}),
      },
    };
  }
}

export interface TerminalSession {
  sessionId: string;
  orgId: string;
  userId: string;
  serverOrderId: string;
  state: "open" | "closed";
  openedAt: string;
  closedAt?: string;
  commandCount: number;
}

export interface ServerOwnershipLookup {
  /** Returns the org that owns a server order, or undefined. */
  ownerOf(serverOrderId: string): Promise<string | undefined>;
}

export class AgentControlService {
  readonly store: AgentControlStore;
  private readonly entitlements?: EntitlementService;
  private readonly nodeChannel?: NodeChannel;
  private readonly imageResolver: DeployImageResolver;
  private readonly serverOwnership?: ServerOwnershipLookup;

  constructor(
    store: AgentControlStore = new InMemoryAgentControlStore(),
    options: {
      entitlements?: EntitlementService;
      nodeChannel?: NodeChannel;
      imageResolver?: DeployImageResolver;
      serverOwnership?: ServerOwnershipLookup;
    } = {},
  ) {
    this.store = store;
    this.entitlements = options.entitlements;
    this.nodeChannel = options.nodeChannel;
    this.imageResolver = options.imageResolver ?? new DefaultImageResolver();
    this.serverOwnership = options.serverOwnership;
  }

  // ---- Authoring -------------------------------------------------------------

  async createDraft(input: { orgId: string; definition: AgentDefinition; userId: string }): Promise<AgentRecord> {
    const record: AgentRecord = {
      agentId: input.definition.agentId,
      orgId: input.orgId,
      slug: input.definition.slug,
      draft: input.definition,
      status: "draft",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    await this.store.upsertAgent(record);
    return record;
  }

  async getDraft(orgId: string, slug: string): Promise<AgentRecord> {
    const record = await this.store.getAgent(orgId, slug);
    if (!record) throw new AgentControlError(`agent ${slug} not found`);
    return record;
  }

  async updateDraft(orgId: string, slug: string, definition: AgentDefinition): Promise<AgentRecord> {
    const record = await this.getDraft(orgId, slug);
    record.draft = definition;
    record.updatedAt = nowIso();
    await this.store.upsertAgent(record);
    return record;
  }

  /**
   * Publish freezes the draft into immutable revision N+1.
   * Developer-mode gate: developer_mode entitlement when the definition was
   * authored in developer mode.
   */
  async publish(orgId: string, slug: string, input: { userId: string; changelog?: string }): Promise<AgentVersionRecord> {
    const record = await this.getDraft(orgId, slug);
    if (record.draft.authoring.mode === "developer" && this.entitlements) {
      const entitled = await this.entitlements.isEnabled(orgId, "developer_mode", "plan-version-current");
      if (!entitled) throw new NotEntitledError("developer mode is not enabled for this plan");
    }
    const history = await this.store.listVersions(record.agentId);
    const revision = (history.at(-1)?.revision ?? 0) + 1;
    const version: AgentVersionRecord = {
      agentId: record.agentId,
      revision,
      definition: JSON.parse(JSON.stringify(record.draft)) as AgentDefinition,
      changelog: input.changelog,
      createdBy: input.userId,
      createdAt: nowIso(),
    };
    await this.store.appendVersion(version);
    record.status = "active";
    await this.store.upsertAgent(record);
    return version;
  }

  async listVersions(orgId: string, slug: string): Promise<AgentVersionRecord[]> {
    const record = await this.getDraft(orgId, slug);
    return this.store.listVersions(record.agentId);
  }

  /** Human-readable change summary between two published versions. */
  async diffVersions(orgId: string, slug: string, fromRevision: number, toRevision: number): Promise<string[]> {
    const [from, to] = await Promise.all([
      this.store.getVersion((await this.getDraft(orgId, slug)).agentId, fromRevision),
      this.store.getVersion((await this.getDraft(orgId, slug)).agentId, toRevision),
    ]);
    if (!from || !to) throw new AgentControlError("both revisions must be published");
    return diffDefinitions(from.definition, to.definition);
  }

  // ---- Deployments -----------------------------------------------------------

  /** Deploy a pinned revision. Entitlement-gated on active agents. */
  async deploy(input: {
    orgId: string;
    slug: string;
    revision: number;
    target: DeploymentTarget;
    nodeId?: string;
  }): Promise<DeploymentRecord> {
    if (this.entitlements) {
      const limit = await this.entitlements.limitOf(input.orgId, "active_concurrent_agents", "plan-version-current");
      if (limit >= 0) {
        // Org-wide live-agent count; the agent being replaced doesn't block
        // its own redeploy.
        let liveOthers = 0;
        for (const other of await this.store.listAllAgents()) {
          if (other.orgId !== input.orgId || other.slug === input.slug) continue;
          const live = (await this.store.findDeploymentsForAgent(other.agentId)).filter((d) =>
            ["desired", "provisioning", "running"].includes(d.state),
          );
          if (live.length > 0) liveOthers += 1;
        }
        if (liveOthers >= limit) {
          throw new NotEntitledError(`plan allows ${limit} concurrent agents`);
        }
      }
    }
    const record = await this.getDraft(input.orgId, input.slug);
    const version = await this.store.getVersion(record.agentId, input.revision);
    if (!version) throw new AgentControlError(`revision ${input.revision} is not published; deploy published versions only`);

    const existing = await this.store.findDeploymentsForAgent(record.agentId);
    const current = existing.find((d) => d.state === "running" || d.state === "degraded" || d.state === "provisioning");
    if (current) {
      current.state = "stopped";
      current.updatedAt = nowIso();
      await this.store.upsertDeployment(current);
      if (this.nodeChannel && current.target.kind === "customer-vps") {
        await this.nodeChannel.stopWorkload(current.target.vpsId, `mox-agent-${record.slug}`);
      }
    }

    const deployment: DeploymentRecord = {
      deploymentId: `dep_${record.agentId}_${input.revision}`,
      orgId: input.orgId,
      agentId: record.agentId,
      revision: input.revision,
      target: input.target,
      state: "desired",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    await this.store.upsertDeployment(deployment);
    return deployment;
  }

  /**
   * Reconcile desired deployments toward their targets via Mox Node signed
   * commands. External AG-UI endpoints register as proxies without runtime
   * internals; custom Docker/Git images resolve through DeployImageResolver.
   */
  async reconcile(): Promise<{ reconciled: number; failed: number }> {
    let reconciled = 0;
    let failed = 0;
    for (const record of await this.store.listAllAgents()) {
      const deployments = await this.store.findDeploymentsForAgent(record.agentId);
      for (const deployment of deployments.filter((d) => d.state === "desired" || d.state === "failed")) {
        try {
          const version = await this.store.getVersion(deployment.agentId, deployment.revision);
          if (!version) throw new AgentControlError(`pinned revision ${deployment.revision} missing`);
          const { image, env } = await this.imageResolver.resolve(version.definition, deployment.target);
          if (deployment.target.kind === "customer-vps") {
            if (!this.nodeChannel) throw new AgentControlError("no node channel configured");
            await this.nodeChannel.applyWorkload({
              nodeId: deployment.target.vpsId,
              deploymentId: deployment.deploymentId,
              image,
              env,
              restartPolicy: "on-failure",
            });
          }
          // mox-cloud/sandbox targets reconcile through the runtime scheduler
          // with the same versioned definition (contract identical).
          deployment.state = "running";
          deployment.lastAppliedAt = nowIso();
          deployment.updatedAt = nowIso();
          await this.store.upsertDeployment(deployment);
          reconciled += 1;
        } catch (error) {
          deployment.state = "failed";
          deployment.lastError = error instanceof Error ? error.message : String(error);
          deployment.updatedAt = nowIso();
          await this.store.upsertDeployment(deployment);
          failed += 1;
        }
      }
    }
    return { reconciled, failed };
  }

  /** Rollback re-pins deployments to an older published version. */
  async rollback(input: { orgId: string; slug: string; toRevision: number }): Promise<DeploymentRecord | undefined> {
    const record = await this.getDraft(input.orgId, input.slug);
    const version = await this.store.getVersion(record.agentId, input.toRevision);
    if (!version) throw new AgentControlError(`revision ${input.toRevision} not found`);
    const deployments = await this.store.findDeploymentsForAgent(record.agentId);
    const latest = deployments.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (!latest) return undefined;
    latest.revision = input.toRevision;
    latest.state = "desired";
    latest.updatedAt = nowIso();
    await this.store.upsertDeployment(latest);
    await this.reconcile();
    return latest;
  }

  // ---- Browser terminal --------------------------------------------------------

  /**
   * Open an audited terminal session to a customer-owned server. Entitlement
   * gated; control-plane hosts are structurally unaddressable because the
   * target must be a server order owned by the caller's org.
   */
  async openTerminal(input: { orgId: string; userId: string; serverOrderId: string }): Promise<TerminalSession> {
    if (this.entitlements) {
      const entitled = await this.entitlements.isEnabled(input.orgId, "cli_sessions", "plan-version-current");
      if (!entitled) throw new NotEntitledError("terminal access is not enabled for this plan");
    }
    const owner = await this.serverOwnership?.ownerOf(input.serverOrderId);
    if (!owner || owner !== input.orgId) {
      throw new AgentControlError("terminal target must be a server owned by your organization");
    }
    return {
      sessionId: `term_${Math.random().toString(36).slice(2, 12)}`,
      orgId: input.orgId,
      userId: input.userId,
      serverOrderId: input.serverOrderId,
      state: "open",
      openedAt: nowIso(),
      commandCount: 0,
    };
  }
}
