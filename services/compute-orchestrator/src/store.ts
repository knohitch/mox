/**
 * Compute orchestrator persistence contract + in-memory implementation.
 * Mirrors packages/database schema/compute.ts for Postgres deployment.
 */

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  ComputeClass,
  MoxNodeRecord,
  NodeEnrollmentTokenRecord,
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
  /**
   * Security Repair 07 §C: revive one historical abandoned operation in
   * place. History/id identity is preserved; only the abandoned generation
   * may transition back to queued, with attempts reset for a deliberate retry.
   */
  reviveAbandonedOperation(
    orderId: string,
    kind: OperationKind,
    idempotencyKey: string,
    nowIso: string,
    maxAttempts: number,
  ): Promise<ServerOperation | undefined>;
  getOperation(orderId: string, kind: OperationKind, idempotencyKey: string): Promise<ServerOperation | undefined>;
  updateOperation(op: ServerOperation): Promise<void>;
  /**
   * Security Repair 05B §A: fenced post-claim writeback. Updates only when
   * id + state='running' + lease_owner + lease_version all match the claim.
   * Returns false when the worker lost authority — it must stop without
   * touching order state or emitting business events.
   */
  updateOperationFenced(op: ServerOperation, expectedLeaseVersion: number): Promise<boolean>;
  dueOperations(nowIso: string): Promise<ServerOperation[]>;
  claimDueOperations(nowIso: string, workerId: string, leaseMs: number, limit: number): Promise<ServerOperation[]>;

  /**
   * Security Repair 05B §B: quota check + order reservation as ONE
   * serialized PostgreSQL decision (org allocation row lock). Different
   * idempotency keys can never both observe spare capacity; same-key
   * replays return the original order.
   */
  createOrderReserved(input: {
    order: ServerOrder;
    operation: ServerOperation;
    maxServers: number;
  }): Promise<{ status: "created" | "idempotent" | "quota_exceeded"; order?: ServerOrder }>;

  // Nodes
  upsertNode(node: MoxNodeRecord): Promise<MoxNodeRecord>;
  getNode(nodeId: string): Promise<MoxNodeRecord | undefined>;
  updateNode(node: MoxNodeRecord): Promise<void>;
  listNodes(): Promise<MoxNodeRecord[]>;

  // Enrollment bootstrap tokens (Prompt 00 §E / 00B §F)
  /** Persists the expected hash BEFORE provisioning/cloud-init runs. */
  createEnrollmentToken(record: NodeEnrollmentTokenRecord): Promise<void>;
  getEnrollmentToken(tokenHash: string): Promise<NodeEnrollmentTokenRecord | undefined>;
  updateEnrollmentToken(record: NodeEnrollmentTokenRecord): Promise<void>;
  /**
   * Atomic single-use consume: returns true exactly once per token.
   * Concurrent consumers race on the state transition; losers get false.
   */
  consumeEnrollmentToken(tokenHash: string, nowIso: string): Promise<boolean>;
  /**
   * Revokes every currently-issued token for an order (Prompt 00B §F):
   * called before issuing a replacement on provisioning retries and when
   * a provision attempt fails, so stale tokens never remain usable.
   */
  revokeIssuedEnrollmentTokensForOrder(orderId: string, nowIso: string): Promise<number>;
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
  private readonly enrollmentTokens = new Map<string, NodeEnrollmentTokenRecord>();

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
      const existing = await this.getOperation(op.orderId, op.kind, op.idempotencyKey);
      if (!existing) return;
      if (existing.state === "succeeded" || existing.state === "abandoned") return;
      await this.updateOperation({
        ...existing,
        nextAttemptAt: op.nextAttemptAt,
        maxAttempts: op.maxAttempts,
      });
    }
  }

  async reviveAbandonedOperation(
    orderId: string,
    kind: OperationKind,
    idempotencyKey: string,
    nowIso: string,
    maxAttempts: number,
  ): Promise<ServerOperation | undefined> {
    const existing = await this.getOperation(orderId, kind, idempotencyKey);
    if (!existing || existing.state !== "abandoned") return existing;
    const revived: ServerOperation = {
      ...existing,
      state: "queued",
      attempts: 0,
      maxAttempts,
      nextAttemptAt: nowIso,
      lastError: undefined,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      updatedAt: nowIso,
    };
    this.operations.set(existing.id, revived);
    return { ...revived };
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

  /** Fencing mirror: synchronous check-and-set is atomic in single-threaded JS. */
  async updateOperationFenced(op: ServerOperation, expectedLeaseVersion: number): Promise<boolean> {
    const current = this.operations.get(op.id);
    if (!current) return false;
    if (current.state !== "running") return false;
    if (current.leaseOwner !== op.leaseOwner) return false;
    if ((current.leaseVersion ?? 0) !== expectedLeaseVersion) return false;
    await this.updateOperation({ ...op, leaseOwner: undefined, leaseExpiresAt: undefined });
    return true;
  }

  async createOrderReserved(input: {
    order: ServerOrder;
    operation: ServerOperation;
    maxServers: number;
  }): Promise<{ status: "created" | "idempotent" | "quota_exceeded"; order?: ServerOrder }> {
    const { order, operation } = input;
    // In-memory tier is single-threaded: check-then-insert is atomic here
    // and mirrors the row-locked PostgreSQL transaction.
    const key = `${order.orgId}:${order.idempotencyKey}`;
    if (this.idemIndex.has(key)) {
      const existingId = this.idemIndex.get(key)!;
      const existing = this.orders.get(existingId);
      if (
        existing &&
        order.requestFingerprint &&
        existing.requestFingerprint &&
        existing.requestFingerprint !== order.requestFingerprint
      ) {
        throw new Error("idempotency key was already used for a different server order request");
      }
      return { status: "idempotent", order: existing ? { ...existing } : undefined };
    }
    const active = [...this.orders.values()].filter((o) =>
      ["requested", "provisioning", "running", "resizing", "stopping", "stopped", "cancelling"].includes(o.state) &&
      o.orgId === order.orgId,
    );
    if (active.length >= input.maxServers) return { status: "quota_exceeded" };
    order.state = "provisioning";
    this.orders.set(order.id, order);
    this.idemIndex.set(key, order.id);
    this.operations.set(operation.id, operation);
    this.opIndex.add(`${operation.orderId}:${operation.kind}:${operation.idempotencyKey}`);
    return { status: "created", order: { ...order } };
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

  async claimDueOperations(nowIso: string, workerId: string, leaseMs: number, limit: number): Promise<ServerOperation[]> {
    const now = Date.parse(nowIso);
    const leaseExpiresAt = new Date(now + leaseMs).toISOString();
    const claimed: ServerOperation[] = [];
    const due = [...this.operations.values()]
      .filter(
        (op) =>
          (
            (op.state === "queued" || op.state === "failed") ||
            (op.state === "running" && !!op.leaseExpiresAt && Date.parse(op.leaseExpiresAt) <= now)
          ) &&
          Date.parse(op.nextAttemptAt) <= now &&
          op.attempts < op.maxAttempts,
      )
      .sort((a, b) => a.nextAttemptAt.localeCompare(b.nextAttemptAt));
    for (const op of due) {
      if (claimed.length >= limit) break;
      if (op.leaseExpiresAt && Date.parse(op.leaseExpiresAt) > now) continue;
      op.state = "running";
      op.leaseOwner = workerId;
      op.leaseExpiresAt = leaseExpiresAt;
      op.leaseVersion = (op.leaseVersion ?? 0) + 1;
      op.updatedAt = nowIso;
      this.operations.set(op.id, { ...op });
      claimed.push({ ...op });
    }
    return claimed;
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

  async createEnrollmentToken(record: NodeEnrollmentTokenRecord): Promise<void> {
    if (this.enrollmentTokens.has(record.tokenHash)) {
      throw new Error("enrollment token hash already exists");
    }
    this.enrollmentTokens.set(record.tokenHash, { ...record });
  }

  async getEnrollmentToken(tokenHash: string): Promise<NodeEnrollmentTokenRecord | undefined> {
    const record = this.enrollmentTokens.get(tokenHash);
    return record ? { ...record } : undefined;
  }

  async updateEnrollmentToken(record: NodeEnrollmentTokenRecord): Promise<void> {
    this.enrollmentTokens.set(record.tokenHash, { ...record });
  }

  /**
   * Synchronous check-and-set is atomic in single-threaded JS, mirroring the
   * conditional UPDATE ... WHERE state='issued' used by the PG store.
   */
  async consumeEnrollmentToken(tokenHash: string, nowIso: string): Promise<boolean> {
    const record = this.enrollmentTokens.get(tokenHash);
    if (!record) return false;
    const expired = record.expiresAt <= nowIso;
    // Consume-on-sight of an expired token keeps replay attempts auditable.
    if (expired && record.state === "issued") {
      record.state = "expired";
      this.enrollmentTokens.set(tokenHash, record);
    }
    if (record.state !== "issued" || expired) return false;
    record.state = "consumed";
    record.consumedAt = nowIso;
    this.enrollmentTokens.set(tokenHash, record);
    return true;
  }

  /** Revokes every currently-issued token for an order (Prompt 00B §F). */
  async revokeIssuedEnrollmentTokensForOrder(orderId: string, nowIso: string): Promise<number> {
    let revoked = 0;
    for (const record of this.enrollmentTokens.values()) {
      if (record.orderId === orderId && record.state === "issued") {
        record.state = "revoked";
        record.consumedAt = nowIso;
        this.enrollmentTokens.set(record.tokenHash, record);
        revoked += 1;
      }
    }
    return revoked;
  }
}

export function newId(): string {
  return randomUUID();
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Constant-time hex digest comparison; both inputs must be sha256 hex. */
export function hashesEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
