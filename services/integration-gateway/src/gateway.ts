/**
 * Integration gateway service: connections, tool catalogues and explicit
 * per-org/user/agent tool grants. Outbound tool calls pass policy/audit at
 * the runtime; this layer is the authorization source of truth.
 */

import type { ToolDefinition } from "@mox/contracts";
import type { IntegrationConnection, IntegrationProvider, IntegrationProviderKind } from "./providers.js";

export interface ToolGrant {
  grantId: string;
  orgId: string;
  toolName: string;
  connectionId: string;
  /** Grant scope — explicit, one or both. */
  agentId?: string;
  userId?: string;
  grantedBy: string;
  createdAt: string;
  revokedAt?: string;
}

export interface IntegrationStore {
  upsertConnection(connection: IntegrationConnection): Promise<void>;
  getConnection(connectionId: string): Promise<IntegrationConnection | undefined>;
  listConnections(orgId: string): Promise<IntegrationConnection[]>;
  setStatus(connectionId: string, status: "connected" | "disconnected" | "error"): Promise<void>;

  addGrant(grant: ToolGrant): Promise<ToolGrant>;
  getGrant(orgId: string, grantId: string): Promise<ToolGrant | undefined>;
  revokeGrant(orgId: string, grantId: string): Promise<void>;
  listGrants(filter: { orgId: string; agentId?: string; userId?: string }): Promise<ToolGrant[]>;
}

export class InMemoryIntegrationStore implements IntegrationStore {
  private readonly connections = new Map<string, IntegrationConnection>();
  private readonly grants = new Map<string, ToolGrant>();

  async upsertConnection(connection: IntegrationConnection): Promise<void> {
    this.connections.set(connection.connectionId, connection);
  }
  async getConnection(connectionId: string): Promise<IntegrationConnection | undefined> {
    return this.connections.get(connectionId);
  }
  async listConnections(orgId: string): Promise<IntegrationConnection[]> {
    return [...this.connections.values()].filter((c) => c.orgId === orgId);
  }
  async setStatus(connectionId: string, status: "connected" | "disconnected" | "error"): Promise<void> {
    const conn = this.connections.get(connectionId);
    if (conn) conn.status = status;
  }
  async addGrant(grant: ToolGrant): Promise<ToolGrant> {
    this.grants.set(grant.grantId, grant);
    return grant;
  }
  async getGrant(orgId: string, grantId: string): Promise<ToolGrant | undefined> {
    const grant = this.grants.get(grantId);
    return grant && grant.orgId === orgId ? grant : undefined;
  }
  async revokeGrant(orgId: string, grantId: string): Promise<void> {
    const grant = this.grants.get(grantId);
    if (grant && grant.orgId === orgId) grant.revokedAt = new Date().toISOString();
  }
  async listGrants(filter: { orgId: string; agentId?: string; userId?: string }): Promise<ToolGrant[]> {
    return [...this.grants.values()].filter(
      (g) =>
        g.orgId === filter.orgId &&
        !g.revokedAt &&
        (filter.agentId === undefined || g.agentId === filter.agentId) &&
        (filter.userId === undefined || g.userId === filter.userId),
    );
  }
}

export class IntegrationGateway {
  readonly store: IntegrationStore;
  private readonly providers = new Map<IntegrationProviderKind, IntegrationProvider>();

  constructor(store: IntegrationStore = new InMemoryIntegrationStore()) {
    this.store = store;
  }

  registerProvider(provider: IntegrationProvider): void {
    this.providers.set(provider.kind, provider);
  }

  provider(kind: IntegrationProviderKind): IntegrationProvider {
    const provider = this.providers.get(kind);
    if (!provider) throw new Error(`no integration provider registered for ${kind}`);
    return provider;
  }

  async connect(connection: IntegrationConnection): Promise<IntegrationConnection> {
    this.provider(connection.providerKind); // must be registered
    await this.store.upsertConnection({ ...connection, status: "connected" });
    return { ...connection, status: "connected" };
  }

  async disconnect(connectionId: string): Promise<void> {
    await this.store.setStatus(connectionId, "disconnected");
  }

  /** Tools a connection currently exposes (provider-honest catalogue). */
  async listToolsForConnection(connectionId: string): Promise<ToolDefinition[]> {
    const connection = await this.store.getConnection(connectionId);
    if (!connection || connection.status !== "connected") return [];
    return this.provider(connection.providerKind).listTools(connection);
  }

  /** Explicit grant of one tool to an agent and/or user. */
  async grantTool(input: {
    orgId: string;
    connectionId: string;
    toolName: string;
    agentId?: string;
    userId?: string;
    grantedBy: string;
  }): Promise<ToolGrant> {
    if (!input.agentId && !input.userId) throw new Error("tool grants require an agent and/or user subject");
    // The tool must actually exist on the connection's live catalogue.
    const tools = await this.listToolsForConnection(input.connectionId);
    if (!tools.some((t) => t.name === input.toolName)) {
      throw new Error(`tool ${input.toolName} is not exposed by connection ${input.connectionId}`);
    }
    return this.store.addGrant({
      grantId: `grant_${crypto.randomUUID()}`,
      ...input,
      createdAt: new Date().toISOString(),
    });
  }

  /** Revocation ends authorization immediately. */
  async revokeGrant(orgId: string, grantId: string): Promise<void> {
    await this.store.revokeGrant(orgId, grantId);
  }

  /** Authorization check used before every outbound integration tool call. */
  async isToolAuthorized(filter: { orgId: string; toolName: string; agentId?: string; userId?: string }): Promise<boolean> {
    const grants = await this.store.listGrants(filter);
    return grants.some((g) => g.toolName === filter.toolName);
  }
}
