/**
 * Compute orchestrator persistence contract + in-memory implementation.
 * Mirrors packages/database schema/compute.ts for Postgres deployment.
 */

import { createHash, randomUUID } from "node:crypto";
import type {
  ComputeClass,
  MoxNodeRecord,
  OperationKind,
  ProviderAccountRecord,
  ServerOperation,
  ServerOrder,
  SshKeyRecord,
} from "./types.js";

export interface OrchestratorStore {
  // Compute classes
  upsertComputeClass(cls: ComputeClass): Promise<void>;
  getComputeClass(code: string): Promise<ComputeClass | undefined>;
  listComputeClasses(): Promise<ComputeClass[]>;

  // Provider accounts
  upsertProviderAccount(account: ProviderAccountRecord): Promise<void>;
  listProviderAccounts(providerName?: string): Promise<ProviderAccountRecord[]>;

  // SSH keys
  addSshKey(key: SshKeyRecord): Promise<SshKeyRecord>;
  getSshKey(id: string): Promise<SshKeyRecord | undefined>;
  listSshKeys(orgId: string): Promise<SshKeyRecord[]>;

  // Orders
  insertOrder(order: ServerOrder): Promise<boolean>;
  getOrder(id: string): Promise<ServerOrder | undefined>;
  findOrderByIdempotencyKey(orgId: string, idempotencyKey: string): Promise<ServerOrder | undefined>;
  updateOrder(order: ServerOrder): Promise<void>;
  listOrdersInState(states: string[]): Promise<ServerOrder[]>;
  listOrdersForOrg(orgId: string): Promise<ServerOrder[]>;

  // Operations
  upsertOperation(op: ServerOperation): Promise<void>;
  getOperation(orderId: string, kind: OperationKind, idempotencyKey: string): Promise<ServerOperation | undefined>;
  updateOperation(op: ServerOperation): Promise<void>;
  dueOperations(nowIso: string): Promise<ServerOperation[]>;

  // Nodes
  upsertNode(node: MoxNodeRecord): Promise<MoxNodeRecord>;
  getNode(nodeId: string): Promise<MoxNodeRecord | undefined>;
  updateNode(node: MoxNodeRecord): Promise<void>;
  listNodes(): Promise<MoxNodeRecord[]>;
  consumeNonce(nonce: string): Promise<boolean>;
}

export class InMemoryOrchestratorStore implements OrchestratorStore {
  private readonly classes = new Map<string, ComputeClass>();
  private readonly accounts = new Map<string, ProviderAccountRecord>();
  private readonly sshKeys = new Map<string, SshKeyRecord>();
  private readonly orders = new Map<string, ServerOrder>();
  private readonly idemIndex = new Map<string, string>();
  private readonly operations = new Map<string, ServerOperation>();
  private readonly opIndex = new Set<string>();
  private readonly nodes = new Map<string, MoxNodeRecord>();
  private readonly nonces = new Set<string>();

  async upsertComputeClass(cls: ComputeClass): Promise<void> {
    this.classes.set(cls.code, cls);
  }

  async getComputeClass(code: string): Promise<ComputeClass | undefined> {
    return this.classes.get(code);
  }

  async listComputeClasses(): Promise<ComputeClass[]> {
    return [...this.classes.values()];
  }

  async upsertProviderAccount(account: ProviderAccountRecord): Promise<void> {
    this.accounts.set(`${account.providerName}:${account.accountLabel}`, account);
  }

  async listProviderAccounts(providerName?: string): Promise<ProviderAccountRecord[]> {
    const all = [...this.accounts.values()];
    return providerName ? all.filter((a) => a.providerName === providerName) : all;
  }

  async addSshKey(key: SshKeyRecord): Promise<SshKeyRecord> {
    this.sshKeys.set(key.id, key);
    return key;
  }

  async getSshKey(id: string): Promise<SshKeyRecord | undefined> {
    return this.sshKeys.get(id);
  }

  async listSshKeys(orgId: string): Promise<SshKeyRecord[]> {
    return [...this.sshKeys.values()].filter((k) => k.orgId === orgId);
  }

  /** Returns false when the (org, idempotencyKey) pair already exists. */
  async insertOrder(order: ServerOrder): Promise<boolean> {
    const key = `${order.orgId}:${order.idempotencyKey}`;
    if (this.idemIndex.has(key)) return false;
    this.orders.set(order.id, order);
    this.idemIndex.set(key, order.id);
    return true;
  }

  async getOrder(id: string): Promise<ServerOrder | undefined> {
    return this.orders.get(id);
  }

  async findOrderByIdempotencyKey(orgId: string, idempotencyKey: string): Promise<ServerOrder | undefined> {
    const id = this.idemIndex.get(`${orgId}:${idempotencyKey}`);
    return id ? this.orders.get(id) : undefined;
  }

  async updateOrder(order: ServerOrder): Promise<void> {
    order.updatedAt = new Date().toISOString();
    this.orders.set(order.id, order);
  }

  async listOrdersInState(states: string[]): Promise<ServerOrder[]> {
    return [...this.orders.values()].filter((o) => states.includes(o.state));
  }

  async listOrdersForOrg(orgId: string): Promise<ServerOrder[]> {
    return [...this.orders.values()]
      .filter((o) => o.orgId === orgId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async upsertOperation(op: ServerOperation): Promise<void> {
    const key = `${op.orderId}:${op.kind}:${op.idempotencyKey}`;
    if (!this.opIndex.has(key)) {
      this.opIndex.add(key);
      this.operations.set(op.id, op);
    } else {
      await this.updateOperation(op);
    }
  }

  async getOperation(orderId: string, kind: OperationKind, idempotencyKey: string): Promise<ServerOperation | undefined> {
    for (const op of this.operations.values()) {
      if (op.orderId === orderId && op.kind === kind && op.idempotencyKey === idempotencyKey) return op;
    }
    return undefined;
  }

  async updateOperation(op: ServerOperation): Promise<void> {
    op.updatedAt = new Date().toISOString();
    this.operations.set(op.id, op);
  }

  async dueOperations(nowIso: string): Promise<ServerOperation[]> {
    const now = Date.parse(nowIso);
    return [...this.operations.values()]
      .filter(
        (op) =>
          (op.state === "queued" || op.state === "failed") &&
          Date.parse(op.nextAttemptAt) <= now &&
          op.attempts < op.maxAttempts,
      )
      .sort((a, b) => a.nextAttemptAt.localeCompare(b.nextAttemptAt));
  }

  async upsertNode(node: MoxNodeRecord): Promise<MoxNodeRecord> {
    this.nodes.set(node.nodeId, node);
    return node;
  }

  async getNode(nodeId: string): Promise<MoxNodeRecord | undefined> {
    return this.nodes.get(nodeId);
  }

  async updateNode(node: MoxNodeRecord): Promise<void> {
    this.nodes.set(node.nodeId, node);
  }

  async listNodes(): Promise<MoxNodeRecord[]> {
    return [...this.nodes.values()];
  }

  async consumeNonce(nonce: string): Promise<boolean> {
    if (this.nonces.has(nonce)) return false;
    this.nonces.add(nonce);
    return true;
  }
}

export function newId(): string {
  return randomUUID();
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
