import { and, asc, eq } from "drizzle-orm";
import type {
  AgentControlStore,
  AgentRecord,
  AgentVersionRecord,
  DeploymentRecord,
} from "@mox/agent-control";
import type { MoxDb } from "./client.js";
import { agentDeployments, agentVersions, agents } from "./schema/index.js";

/**
 * PostgreSQL agent-control store (Prompt 00 §C extension): agent drafts and
 * immutable published versions are durable rows; deployments pin exact
 * revisions. Mirrors the InMemory reference semantics.
 */

function iso(value: Date | null | undefined): string | undefined {
  return value ? value.toISOString() : undefined;
}

export class PgAgentControlStore implements AgentControlStore {
  constructor(private readonly db: MoxDb) {}

  async upsertAgent(agent: AgentRecord): Promise<void> {
    const values = {
      orgId: agent.orgId,
      slug: agent.slug,
      displayName: agent.draft.identity?.displayName ?? agent.slug,
      status: agent.status,
      definition: agent.draft as unknown as object,
      updatedAt: new Date(),
    };
    const existing = await this.db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.orgId, agent.orgId), eq(agents.slug, agent.slug)))
      .limit(1);
    if (existing[0]) {
      await this.db.update(agents).set(values).where(eq(agents.id, existing[0].id));
    } else {
      await this.db.insert(agents).values(values);
    }
  }

  private toAgentRecord(row: typeof agents.$inferSelect): AgentRecord {
    return {
      agentId: row.id,
      orgId: row.orgId,
      slug: row.slug,
      draft: row.definition as AgentRecord["draft"],
      status: row.status as AgentRecord["status"],
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async getAgent(orgId: string, slug: string): Promise<AgentRecord | undefined> {
    const rows = await this.db
      .select()
      .from(agents)
      .where(and(eq(agents.orgId, orgId), eq(agents.slug, slug)))
      .limit(1);
    return rows[0] ? this.toAgentRecord(rows[0]) : undefined;
  }

  async listAgents(orgId: string): Promise<AgentRecord[]> {
    const rows = await this.db.select().from(agents).where(eq(agents.orgId, orgId)).orderBy(asc(agents.createdAt));
    return rows.map((row) => this.toAgentRecord(row));
  }

  async listAllAgents(): Promise<AgentRecord[]> {
    const rows = await this.db.select().from(agents);
    return rows.map((row) => this.toAgentRecord(row));
  }

  /** Returns false when this revision already exists (immutable versions). */
  async appendVersion(version: AgentVersionRecord): Promise<boolean> {
    const inserted = await this.db
      .insert(agentVersions)
      .values({
        orgId: String(version.definition.orgId),
        agentId: version.agentId,
        version: String(version.revision),
        definition: version.definition as unknown as object,
        createdAt: new Date(version.createdAt),
      })
      .onConflictDoNothing({ target: [agentVersions.agentId, agentVersions.version] })
      .returning({ id: agentVersions.id });
    return inserted.length > 0;
  }

  async getVersion(agentId: string, revision: number): Promise<AgentVersionRecord | undefined> {
    const rows = await this.db
      .select()
      .from(agentVersions)
      .where(and(eq(agentVersions.agentId, agentId), eq(agentVersions.version, String(revision))))
      .limit(1);
    const row = rows[0];
    return row
      ? {
          agentId: row.agentId,
          revision: Number(row.version),
          definition: row.definition as AgentVersionRecord["definition"],
          createdBy: row.publishedByUserId ?? "system",
          createdAt: row.createdAt.toISOString(),
        }
      : undefined;
  }

  async listVersions(agentId: string): Promise<AgentVersionRecord[]> {
    const rows = await this.db
      .select()
      .from(agentVersions)
      .where(eq(agentVersions.agentId, agentId))
      .orderBy(asc(agentVersions.version));
    return rows.map((row) => ({
      agentId: row.agentId,
      revision: Number(row.version),
      definition: row.definition as AgentVersionRecord["definition"],
      createdBy: row.publishedByUserId ?? "system",
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async upsertDeployment(deployment: DeploymentRecord): Promise<DeploymentRecord> {
    // The hosted schema stores deployment desired state as a projection of
    // the agent row; full deployment reconciliation lands with Prompt 02.
    // Persist what is authoritative today: desired revision + timestamps.
    const values = {
      orgId: deployment.orgId,
      agentId: deployment.agentId,
      kind: "sandbox" as const,
      desiredRevision: deployment.revision,
      updatedAt: new Date(),
    };
    const existing = await this.db
      .select({ id: agentDeployments.id })
      .from(agentDeployments)
      .where(and(eq(agentDeployments.orgId, deployment.orgId), eq(agentDeployments.agentId, deployment.agentId)))
      .limit(1);
    if (existing[0]) {
      await this.db.update(agentDeployments).set(values).where(eq(agentDeployments.id, existing[0].id));
    } else {
      await this.db.insert(agentDeployments).values(values);
    }
    return deployment;
  }

  async getDeployment(_deploymentId: string): Promise<DeploymentRecord | undefined> {
    void _deploymentId;
    return undefined;
  }

  async findDeploymentsForAgent(agentId: string): Promise<DeploymentRecord[]> {
    const rows = await this.db.select().from(agentDeployments).where(eq(agentDeployments.agentId, agentId));
    return rows.map((row) => ({
      deploymentId: row.id,
      orgId: row.orgId,
      agentId: row.agentId,
      revision: row.desiredRevision,
      target: { kind: "sandbox" },
      state: "desired" as const,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  }
}

void iso;
