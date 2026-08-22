/** Compute orchestrator persistence contract + in-memory reference implementation. */

import { createHash, randomUUID } from "node:crypto";
import type {
  ComputeClass,
  MoxNodeRecord,
  NodeEnrollmentRecord,
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
  /** Atomically claim queued/failed work or an expired running lease. */
  claimOperation(operationId: string, nowIso: string, leaseUntilIso: string): Promise<ServerOperation | undefined>;

  // One-time node enrollment grants
  createNodeEnrollment(record: NodeEnrollmentRecord): Promise<NodeEnrollmentRecord>;
  getActiveNodeEnrollmentForOrder(orderId: string, nowIso: string): Promise<NodeEnrollmentRecord | undefined>;
  consumeNodeEnrollment(input: {
    tokenId: string;
    tokenHash: string;
    nodeId: string;
    nowIso: string;
  }): Promise<NodeEnrollmentRecord | undefined>;
  revokeNodeEnrollmentsForOrder(orderId: string, nowIso: string): Promise<number>;

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
  private readonly opIndex = new Map<string, string>();
  private readonly enrollments = new Map<string, NodeEnrollmentRecord>();
  private readonly nodes = new Map<string, MoxNodeRecord>();
  private readonly nonces = new Set<string>();

  async upsertComputeClass(cls: ComputeClass): Promise<void> {
    this.classes.set(cls.code, { ...cls, skuMap: [...cls.skuMap] });
  }

  async getComputeClass(code: string): Promise<ComputeClass | undefined> {
    return this.classes.get(code);
  }

  async listComputeClasses(): Promise<ComputeClass[]> {
    return [...this.classes.values()];
  }

  async upsertProviderAccount(account: ProviderAccountRecord): Promise<void> {
    this.accounts.set(`${account.providerName}:${account.accountLabel}`, { ...account });
  }

  async listProviderAccounts(providerName?: string): Promise<ProviderAccountRecord[]> {
    const all = [...this.accounts.values()];
    return providerName ? all.filter((a) => a.providerName === providerName) : all;
  }

  async addSshKey(key: SshKeyRecord): Promise<SshKeyRecord> {
    this.sshKeys.set(key.id, { ...key });
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
    this.orders.set(order.id, { ...order });
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
    const updated = { ...order, updatedAt: new Date().toISOString() };
    Object.assign(order, updated);
    this.orders.set(order.id, updated);
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
    const existingId = this.opIndex.get(key);
    if (!existingId) {
      this.opIndex.set(key, op.id);
      this.operations.set(op.id, { ...op });
      return;
    }
    this.operations.set(existingId, { ...op, id: existingId });
  }

  async getOperation(orderId: string, kind: OperationKind, idempotencyKey: string): Promise<ServerOperation | undefined> {
    const id = this.opIndex.get(`${orderId}:${kind}:${idempotencyKey}`);
    return id ? this.operations.get(id) : undefined;
  }

  async updateOperation(op: ServerOperation): Promise<void> {
    const updated = { ...op, updatedAt: new Date().toISOString() };
    Object.assign(op, updated);
    this.operations.set(op.id, updated);
  }

  async dueOperations(nowIso: string): Promise<ServerOperation[]> {
    const now = Date.parse(nowIso);
    return [...this.operations.values()]
      .filter((op) => {
        if (op.attempts >= op.maxAttempts) return false;
        if ((op.state === "queued" || op.state === "failed") && Date.parse(op.nextAttemptAt) <= now) return true;
        return op.state === "running" && !!op.leaseUntil && Date.parse(op.leaseUntil) <= now;
      })
      .sort((a, b) => a.nextAttemptAt.localeCompare(b.nextAttemptAt));
  }

  async claimOperation(operationId: string, nowIso: string, leaseUntilIso: string): Promise<ServerOperation | undefined> {
    const op = this.operations.get(operationId);
    if (!op || op.attempts >= op.maxAttempts) return undefined;
    const now = Date.parse(nowIso);
    const claimable =
      ((op.state === "queued" || op.state === "failed") && Date.parse(op.nextAttemptAt) <= now) ||
      (op.state === "running" && !!op.leaseUntil && Date.parse(op.leaseUntil) <= now);
    if (!claimable) return undefined;
    const claimed: ServerOperation = { ...op, state: "running", leaseUntil: leaseUntilIso, updatedAt: nowIso };
    this.operations.set(operationId, claimed);
    return claimed;
  }

  async createNodeEnrollment(record: NodeEnrollmentRecord): Promise<NodeEnrollmentRecord> {
    if (this.enrollments.has(record.tokenId)) throw new Error(`enrollment token id exists: ${record.tokenId}`);
    this.enrollments.set(record.tokenId, { ...record });
    return record;
  }

  async getActiveNodeEnrollmentForOrder(orderId: string, nowIso: string): Promise<NodeEnrollmentRecord | undefined> {
    return [...this.enrollments.values()]
      .filter(
        (r) =>
          r.orderId === orderId &&
          !r.consumedAt &&
          !r.revokedAt &&
          Date.parse(r.expiresAt) > Date.parse(nowIso),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  }

  async consumeNodeEnrollment(input: {
    tokenId: string;
    tokenHash: string;
    nodeId: string;
    nowIso: string;
  }): Promise<NodeEnrollmentRecord | undefined> {
    const row = this.enrollments.get(input.tokenId);
    if (
      !row ||
      row.tokenHash !== input.tokenHash ||
      row.consumedAt ||
      row.revokedAt ||
      Date.parse(row.expiresAt) <= Date.parse(input.nowIso)
    ) {
      return undefined;
    }
    const consumed = { ...row, consumedAt: input.nowIso, consumedByNodeId: input.nodeId };
    this.enrollments.set(row.tokenId, consumed);
    return consumed;
  }

  async revokeNodeEnrollmentsForOrder(orderId: string, nowIso: string): Promise<number> {
    let count = 0;
    for (const [tokenId, row] of this.enrollments) {
      if (row.orderId !== orderId || row.consumedAt || row.revokedAt) continue;
      this.enrollments.set(tokenId, { ...row, revokedAt: nowIso });
      count += 1;
    }
    return count;
  }

  async upsertNode(node: MoxNodeRecord): Promise<MoxNodeRecord> {
    this.nodes.set(node.nodeId, { ...node, capabilities: [...node.capabilities] });
    return node;
  }

  async getNode(nodeId: string): Promise<MoxNodeRecord | undefined> {
    return this.nodes.get(nodeId);
  }

  async updateNode(node: MoxNodeRecord): Promise<void> {
    this.nodes.set(node.nodeId, { ...node, capabilities: [...node.capabilities] });
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
