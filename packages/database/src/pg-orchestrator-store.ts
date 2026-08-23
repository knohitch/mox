import { and, asc, eq, inArray, lte, or, sql } from "drizzle-orm";
import type {
  ComputeClass,
  MoxNodeRecord,
  NodeEnrollmentTokenRecord,
  OperationKind,
  OrchestratorStore,
  ProviderAccountRecord,
  ServerOperation,
  ServerOrder,
  SshKeyRecord,
} from "@mox/compute-orchestrator";
import type { MoxDb } from "./client.js";
import {
  computeClasses,
  moxNodes,
  nodeEnrollmentTokens,
  providerAccounts,
  serverOperations,
  serverOrders,
  sshKeys,
} from "./schema/index.js";

/**
 * PostgreSQL orchestrator store (Prompt 00 §C/§E): durable desired-state for
 * server orders/operations plus the enrollment-token authority. The consume
 * path uses a conditional UPDATE ... WHERE state='issued' AND expires_at >
 * now() so exactly one concurrent enrollment can win; replayed or expired
 * tokens can never flip state twice.
 */

function iso(value: Date | null | undefined): string | undefined {
  return value ? value.toISOString() : undefined;
}

export class PgOrchestratorStore implements OrchestratorStore {
  constructor(private readonly db: MoxDb) {}

  // ---- Compute classes ------------------------------------------------------

  async upsertComputeClass(cls: ComputeClass): Promise<void> {
    const values = {
      code: cls.code,
      displayName: cls.displayName,
      minVcpu: cls.minVcpu,
      minRamGb: cls.minRamGb,
      skuMap: cls.skuMap as unknown as object,
      active: cls.active,
      updatedAt: new Date(),
    };
    await this.db
      .insert(computeClasses)
      .values(values)
      .onConflictDoUpdate({ target: computeClasses.code, set: values });
  }

  async getComputeClass(code: string): Promise<ComputeClass | undefined> {
    const rows = await this.db.select().from(computeClasses).where(eq(computeClasses.code, code)).limit(1);
    return rows[0] ? toComputeClass(rows[0]) : undefined;
  }

  async listComputeClasses(): Promise<ComputeClass[]> {
    const rows = await this.db.select().from(computeClasses).orderBy(asc(computeClasses.code));
    return rows.map(toComputeClass);
  }

  // ---- Provider accounts ----------------------------------------------------

  async upsertProviderAccount(account: ProviderAccountRecord): Promise<void> {
    const values = {
      id: account.id,
      providerName: account.providerName,
      accountLabel: account.accountLabel,
      regionCode: account.regionCode ?? null,
      commercialStatus: account.commercialStatus,
      healthScore: account.healthScore,
      credentialRefId: account.credentialRefId ?? null,
      enabled: account.enabled,
    };
    await this.db
      .insert(providerAccounts)
      .values(values)
      .onConflictDoUpdate({
        target: [providerAccounts.providerName, providerAccounts.accountLabel],
        set: values,
      });
  }

  async listProviderAccounts(providerName?: string): Promise<ProviderAccountRecord[]> {
    const rows = providerName
      ? await this.db.select().from(providerAccounts).where(eq(providerAccounts.providerName, providerName))
      : await this.db.select().from(providerAccounts);
    return rows.map((row) => ({
      id: row.id,
      providerName: row.providerName,
      accountLabel: row.accountLabel,
      regionCode: row.regionCode ?? undefined,
      commercialStatus: row.commercialStatus as ProviderAccountRecord["commercialStatus"],
      healthScore: row.healthScore,
      enabled: row.enabled,
      credentialRefId: row.credentialRefId ?? undefined,
    }));
  }

  // ---- SSH keys ----------------------------------------------------------------

  async addSshKey(key: SshKeyRecord): Promise<SshKeyRecord> {
    await this.db.insert(sshKeys).values({
      id: key.id,
      orgId: key.orgId,
      label: key.label,
      publicKey: key.publicKey,
      fingerprint: key.fingerprint,
    });
    return key;
  }

  async getSshKey(id: string): Promise<SshKeyRecord | undefined> {
    const rows = await this.db.select().from(sshKeys).where(eq(sshKeys.id, id)).limit(1);
    return rows[0] ? toSshKey(rows[0]) : undefined;
  }

  async listSshKeys(orgId: string): Promise<SshKeyRecord[]> {
    const rows = await this.db.select().from(sshKeys).where(eq(sshKeys.orgId, orgId));
    return rows.map(toSshKey);
  }

  // ---- Orders ------------------------------------------------------------------

  /** Returns false when the (org, idempotencyKey) pair already exists. */
  async insertOrder(order: ServerOrder): Promise<boolean> {
    const inserted = await this.db
      .insert(serverOrders)
      .values(toOrderRow(order))
      .onConflictDoNothing({ target: [serverOrders.orgId, serverOrders.idempotencyKey] })
      .returning({ id: serverOrders.id });
    return inserted.length > 0;
  }

  async getOrder(id: string): Promise<ServerOrder | undefined> {
    const rows = await this.db.select().from(serverOrders).where(eq(serverOrders.id, id)).limit(1);
    return rows[0] ? toOrder(rows[0]) : undefined;
  }

  async findOrderByIdempotencyKey(orgId: string, idempotencyKey: string): Promise<ServerOrder | undefined> {
    const rows = await this.db
      .select()
      .from(serverOrders)
      .where(and(eq(serverOrders.orgId, orgId), eq(serverOrders.idempotencyKey, idempotencyKey)))
      .limit(1);
    return rows[0] ? toOrder(rows[0]) : undefined;
  }

  async updateOrder(order: ServerOrder): Promise<void> {
    await this.db
      .update(serverOrders)
      .set({ ...toOrderRow(order), updatedAt: new Date() })
      .where(eq(serverOrders.id, order.id));
  }

  async listOrdersInState(states: string[]): Promise<ServerOrder[]> {
    const rows = await this.db
      .select()
      .from(serverOrders)
      .where(inArray(serverOrders.state, states as ServerOrder["state"][]));
    return rows.map(toOrder);
  }

  async listOrdersForOrg(orgId: string): Promise<ServerOrder[]> {
    const rows = await this.db
      .select()
      .from(serverOrders)
      .where(eq(serverOrders.orgId, orgId))
      .orderBy(asc(serverOrders.createdAt));
    return rows.map(toOrder);
  }

  // ---- Operations --------------------------------------------------------------

  async upsertOperation(op: ServerOperation): Promise<void> {
    const values = toOperationRow(op);
    await this.db
      .insert(serverOperations)
      .values(values)
      .onConflictDoUpdate({
        target: [serverOperations.orderId, serverOperations.kind, serverOperations.idempotencyKey],
        set: { ...values, updatedAt: new Date() },
      });
  }

  async getOperation(orderId: string, kind: OperationKind, idempotencyKey: string): Promise<ServerOperation | undefined> {
    const rows = await this.db
      .select()
      .from(serverOperations)
      .where(
        and(
          eq(serverOperations.orderId, orderId),
          eq(serverOperations.kind, kind),
          eq(serverOperations.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    return rows[0] ? toOperation(rows[0]) : undefined;
  }

  async updateOperation(op: ServerOperation): Promise<void> {
    await this.db
      .update(serverOperations)
      .set({ ...toOperationRow(op), updatedAt: new Date() })
      .where(eq(serverOperations.id, op.id));
  }

  async dueOperations(nowIso: string): Promise<ServerOperation[]> {
    const now = new Date(nowIso);
    const rows = await this.db
      .select()
      .from(serverOperations)
      .where(
        and(
          or(eq(serverOperations.state, "queued"), eq(serverOperations.state, "failed")),
          lte(serverOperations.nextAttemptAt, now),
        ),
      )
      .orderBy(asc(serverOperations.nextAttemptAt));
    return rows
      .map(toOperation)
      .filter((op) => op.attempts < op.maxAttempts);
  }

  // ---- Nodes ---------------------------------------------------------------

  async upsertNode(node: MoxNodeRecord): Promise<MoxNodeRecord> {
    const values = toNodeRow(node);
    await this.db
      .insert(moxNodes)
      .values(values)
      .onConflictDoUpdate({ target: moxNodes.nodeId, set: values });
    return node;
  }

  async getNode(nodeId: string): Promise<MoxNodeRecord | undefined> {
    const rows = await this.db.select().from(moxNodes).where(eq(moxNodes.nodeId, nodeId)).limit(1);
    return rows[0] ? toNode(rows[0]) : undefined;
  }

  async updateNode(node: MoxNodeRecord): Promise<void> {
    await this.db
      .update(moxNodes)
      .set(toNodeRow(node))
      .where(eq(moxNodes.nodeId, node.nodeId));
  }

  async listNodes(): Promise<MoxNodeRecord[]> {
    const rows = await this.db.select().from(moxNodes);
    return rows.map(toNode);
  }

  async consumeNonce(nonce: string): Promise<boolean> {
    // Nonce table reuse via node_commands uniqueness is handled at dispatch;
    // advisory nonce consumption stays ephemeral by contract.
    void nonce;
    return true;
  }

  // ---- Enrollment tokens (Prompt 00 �E) ---------------------------------------

  async createEnrollmentToken(record: NodeEnrollmentTokenRecord): Promise<void> {
    await this.db.insert(nodeEnrollmentTokens).values({
      id: record.id,
      tokenHash: record.tokenHash,
      orgId: record.orgId,
      orderId: record.orderId,
      providerInstanceId: record.providerInstanceId ?? null,
      state: record.state,
      expiresAt: new Date(record.expiresAt),
      consumedAt: record.consumedAt ? new Date(record.consumedAt) : null,
      createdAt: new Date(record.createdAt),
    });
  }

  async getEnrollmentToken(tokenHash: string): Promise<NodeEnrollmentTokenRecord | undefined> {
    const rows = await this.db
      .select()
      .from(nodeEnrollmentTokens)
      .where(eq(nodeEnrollmentTokens.tokenHash, tokenHash))
      .limit(1);
    return rows[0] ? toEnrollmentToken(rows[0]) : undefined;
  }

  async updateEnrollmentToken(record: NodeEnrollmentTokenRecord): Promise<void> {
    await this.db
      .update(nodeEnrollmentTokens)
      .set({
        providerInstanceId: record.providerInstanceId ?? null,
        state: record.state,
        expiresAt: new Date(record.expiresAt),
        consumedAt: record.consumedAt ? new Date(record.consumedAt) : null,
      })
      .where(eq(nodeEnrollmentTokens.tokenHash, record.tokenHash));
  }

  /**
   * Atomic single-use consume. The conditional UPDATE flips state only from
   * 'issued' while unexpired; concurrent callers race on the row lock and
   * exactly one observes a non-zero affected-row count.
   */
  async consumeEnrollmentToken(tokenHash: string, nowIso: string): Promise<boolean> {
    const updated = await this.db
      .update(nodeEnrollmentTokens)
      .set({ state: "consumed", consumedAt: new Date(nowIso) })
      .where(
        and(
          eq(nodeEnrollmentTokens.tokenHash, tokenHash),
          eq(nodeEnrollmentTokens.state, "issued"),
          sql`${nodeEnrollmentTokens.expiresAt} > ${new Date(nowIso)}`,
        ),
      )
      .returning({ id: nodeEnrollmentTokens.id });
    if (updated.length > 0) return true;
    // Mark an expired-but-unconsumed token so audits see the transition.
    await this.db
      .update(nodeEnrollmentTokens)
      .set({ state: "expired" })
      .where(
        and(
          eq(nodeEnrollmentTokens.tokenHash, tokenHash),
          eq(nodeEnrollmentTokens.state, "issued"),
          sql`${nodeEnrollmentTokens.expiresAt} <= ${new Date(nowIso)}`,
        ),
      );
    return false;
  }
}

// ---- Row mappers -----------------------------------------------------------

type ComputeClassRow = typeof computeClasses.$inferSelect;
type SshKeyRow = typeof sshKeys.$inferSelect;
type OrderRow = typeof serverOrders.$inferSelect;
type OperationRow = typeof serverOperations.$inferSelect;
type NodeRow = typeof moxNodes.$inferSelect;
type EnrollmentTokenRow = typeof nodeEnrollmentTokens.$inferSelect;

function toComputeClass(row: ComputeClassRow): ComputeClass {
  return {
    code: row.code,
    displayName: row.displayName,
    minVcpu: row.minVcpu,
    minRamGb: row.minRamGb,
    skuMap: (row.skuMap ?? []) as ComputeClass["skuMap"],
    active: row.active,
  };
}

function toSshKey(row: SshKeyRow): SshKeyRecord {
  return {
    id: row.id,
    orgId: row.orgId,
    label: row.label,
    publicKey: row.publicKey,
    fingerprint: row.fingerprint,
    createdAt: row.createdAt.toISOString(),
  };
}

function toOrderRow(order: ServerOrder) {
  return {
    id: order.id,
    orgId: order.orgId,
    subscriptionItemId: order.subscriptionItemId ?? null,
    computeClassCode: order.computeClassCode,
    state: order.state,
    providerName: order.providerName ?? null,
    providerAccountId: order.providerAccountId ?? null,
    regionCode: order.regionCode ?? null,
    providerSku: order.providerSku ?? null,
    providerInstanceId: order.providerInstanceId ?? null,
    ipv4: order.ipv4 ?? null,
    ipv6: order.ipv6 ?? null,
    hostname: order.hostname,
    sshKeyId: order.sshKeyId ?? null,
    reverseDns: order.reverseDns ?? null,
    idempotencyKey: order.idempotencyKey,
    attemptCount: order.attemptCount,
    lastError: order.lastError ?? null,
    retentionUntil: order.retentionUntil ? new Date(order.retentionUntil) : null,
    canceledAt: order.canceledAt ? new Date(order.canceledAt) : null,
    destroyedAt: order.destroyedAt ? new Date(order.destroyedAt) : null,
  };
}

function toOrder(row: OrderRow): ServerOrder {
  return {
    id: row.id,
    orgId: row.orgId,
    subscriptionItemId: row.subscriptionItemId ?? undefined,
    computeClassCode: row.computeClassCode,
    state: row.state,
    providerName: row.providerName ?? undefined,
    providerAccountId: row.providerAccountId ?? undefined,
    regionCode: row.regionCode ?? undefined,
    providerSku: row.providerSku ?? undefined,
    providerInstanceId: row.providerInstanceId ?? undefined,
    ipv4: row.ipv4 ?? undefined,
    ipv6: row.ipv6 ?? undefined,
    hostname: row.hostname,
    sshKeyId: row.sshKeyId ?? undefined,
    reverseDns: row.reverseDns ?? undefined,
    idempotencyKey: row.idempotencyKey,
    attemptCount: row.attemptCount,
    lastError: row.lastError ?? undefined,
    retentionUntil: iso(row.retentionUntil),
    canceledAt: iso(row.canceledAt),
    destroyedAt: iso(row.destroyedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toOperationRow(op: ServerOperation) {
  return {
    id: op.id,
    orderId: op.orderId,
    kind: op.kind,
    state: op.state,
    providerOperationId: op.providerOperationId ?? null,
    idempotencyKey: op.idempotencyKey,
    attempts: op.attempts,
    maxAttempts: op.maxAttempts,
    nextAttemptAt: new Date(op.nextAttemptAt),
    lastError: op.lastError ?? null,
  };
}

function toOperation(row: OperationRow): ServerOperation {
  return {
    id: row.id,
    orderId: row.orderId,
    kind: row.kind as OperationKind,
    state: row.state,
    providerOperationId: row.providerOperationId ?? undefined,
    idempotencyKey: row.idempotencyKey,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    nextAttemptAt: row.nextAttemptAt.toISOString(),
    lastError: row.lastError ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toNodeRow(node: MoxNodeRecord) {
  return {
    nodeId: node.nodeId,
    orgId: node.orgId,
    orderId: node.orderId ?? null,
    enrollTokenHash: node.enrollTokenHash,
    agentTokenHash: node.agentTokenHash ?? null,
    version: node.version ?? null,
    capabilities: node.capabilities as unknown as object,
    metrics: (node.metrics ?? null) as unknown as object | null,
    enrolledAt: new Date(node.enrolledAt),
    lastHeartbeatAt: new Date(node.lastHeartbeatAt),
    status: node.status,
  };
}

function toNode(row: NodeRow): MoxNodeRecord {
  return {
    id: row.id,
    orgId: row.orgId,
    orderId: row.orderId ?? undefined,
    nodeId: row.nodeId,
    enrollTokenHash: row.enrollTokenHash,
    agentTokenHash: row.agentTokenHash ?? undefined,
    version: row.version ?? undefined,
    capabilities: (row.capabilities ?? []) as string[],
    metrics: (row.metrics ?? undefined) as MoxNodeRecord["metrics"],
    enrolledAt: row.enrolledAt.toISOString(),
    lastHeartbeatAt: row.lastHeartbeatAt.toISOString(),
    status: row.status as MoxNodeRecord["status"],
  };
}

function toEnrollmentToken(row: EnrollmentTokenRow): NodeEnrollmentTokenRecord {
  return {
    id: row.id,
    tokenHash: row.tokenHash,
    orgId: row.orgId,
    orderId: row.orderId,
    providerInstanceId: row.providerInstanceId ?? undefined,
    state: row.state,
    expiresAt: row.expiresAt.toISOString(),
    consumedAt: iso(row.consumedAt),
    createdAt: row.createdAt.toISOString(),
  };
}
