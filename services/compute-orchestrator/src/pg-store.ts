import { and, asc, desc, eq, gt, inArray, isNull, lte, or } from "drizzle-orm";
import {
  computeClasses,
  moxNodes,
  nodeConsumedNonces,
  nodeEnrollmentTokens,
  providerAccounts,
  serverOperations,
  serverOrders,
  sshKeys,
  type MoxDb,
} from "@mox/database";
import type { OrchestratorStore } from "./store.js";
import type {
  ComputeClass,
  ComputeClassSkuCandidate,
  MoxNodeRecord,
  NodeEnrollmentRecord,
  OperationKind,
  ProviderAccountRecord,
  ServerOperation,
  ServerOrder,
  SshKeyRecord,
} from "./types.js";

/** PostgreSQL-backed production authority for compute orchestration. */
export class PgOrchestratorStore implements OrchestratorStore {
  constructor(private readonly db: MoxDb) {}

  async upsertComputeClass(cls: ComputeClass): Promise<void> {
    await this.db
      .insert(computeClasses)
      .values({
        code: cls.code,
        displayName: cls.displayName,
        minVcpu: cls.minVcpu,
        minRamGb: cls.minRamGb,
        skuMap: cls.skuMap,
        active: cls.active,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: computeClasses.code,
        set: {
          displayName: cls.displayName,
          minVcpu: cls.minVcpu,
          minRamGb: cls.minRamGb,
          skuMap: cls.skuMap,
          active: cls.active,
          updatedAt: new Date(),
        },
      });
  }

  async getComputeClass(code: string): Promise<ComputeClass | undefined> {
    const [row] = await this.db.select().from(computeClasses).where(eq(computeClasses.code, code)).limit(1);
    return row ? toComputeClass(row) : undefined;
  }

  async listComputeClasses(): Promise<ComputeClass[]> {
    return (await this.db.select().from(computeClasses).orderBy(asc(computeClasses.code))).map(toComputeClass);
  }

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
      rotatedAt: account.rotatedAt ? new Date(account.rotatedAt) : null,
      disabledReason: account.disabledReason ?? null,
    };
    await this.db
      .insert(providerAccounts)
      .values(values)
      .onConflictDoUpdate({
        target: [providerAccounts.providerName, providerAccounts.accountLabel],
        set: {
          regionCode: values.regionCode,
          commercialStatus: values.commercialStatus,
          healthScore: values.healthScore,
          credentialRefId: values.credentialRefId,
          enabled: values.enabled,
          rotatedAt: values.rotatedAt,
          disabledReason: values.disabledReason,
        },
      });
  }

  async listProviderAccounts(providerName?: string): Promise<ProviderAccountRecord[]> {
    const rows = providerName
      ? await this.db.select().from(providerAccounts).where(eq(providerAccounts.providerName, providerName))
      : await this.db.select().from(providerAccounts);
    return rows.map(toProviderAccount);
  }

  async addSshKey(key: SshKeyRecord): Promise<SshKeyRecord> {
    const [row] = await this.db
      .insert(sshKeys)
      .values({
        id: key.id,
        orgId: key.orgId,
        label: key.label,
        publicKey: key.publicKey,
        fingerprint: key.fingerprint,
        createdAt: new Date(key.createdAt),
      })
      .returning();
    if (!row) throw new Error("insert SSH key returned no row");
    return toSshKey(row);
  }

  async getSshKey(id: string): Promise<SshKeyRecord | undefined> {
    const [row] = await this.db.select().from(sshKeys).where(eq(sshKeys.id, id)).limit(1);
    return row ? toSshKey(row) : undefined;
  }

  async listSshKeys(orgId: string): Promise<SshKeyRecord[]> {
    return (await this.db.select().from(sshKeys).where(eq(sshKeys.orgId, orgId))).map(toSshKey);
  }

  async insertOrder(order: ServerOrder): Promise<boolean> {
    const rows = await this.db
      .insert(serverOrders)
      .values(toOrderInsert(order))
      .onConflictDoNothing({ target: [serverOrders.orgId, serverOrders.idempotencyKey] })
      .returning({ id: serverOrders.id });
    return rows.length > 0;
  }

  async getOrder(id: string): Promise<ServerOrder | undefined> {
    const [row] = await this.db.select().from(serverOrders).where(eq(serverOrders.id, id)).limit(1);
    return row ? toOrder(row) : undefined;
  }

  async findOrderByIdempotencyKey(orgId: string, idempotencyKey: string): Promise<ServerOrder | undefined> {
    const [row] = await this.db
      .select()
      .from(serverOrders)
      .where(and(eq(serverOrders.orgId, orgId), eq(serverOrders.idempotencyKey, idempotencyKey)))
      .limit(1);
    return row ? toOrder(row) : undefined;
  }

  async updateOrder(order: ServerOrder): Promise<void> {
    await this.db
      .update(serverOrders)
      .set({ ...toOrderMutable(order), updatedAt: new Date() })
      .where(eq(serverOrders.id, order.id));
  }

  async listOrdersInState(states: string[]): Promise<ServerOrder[]> {
    if (states.length === 0) return [];
    const typed = states as ServerOrder["state"][];
    return (await this.db.select().from(serverOrders).where(inArray(serverOrders.state, typed))).map(toOrder);
  }

  async listOrdersForOrg(orgId: string): Promise<ServerOrder[]> {
    return (
      await this.db
        .select()
        .from(serverOrders)
        .where(eq(serverOrders.orgId, orgId))
        .orderBy(asc(serverOrders.createdAt))
    ).map(toOrder);
  }

  async upsertOperation(op: ServerOperation): Promise<void> {
    const values = toOperationInsert(op);
    await this.db
      .insert(serverOperations)
      .values(values)
      .onConflictDoUpdate({
        target: [serverOperations.orderId, serverOperations.kind, serverOperations.idempotencyKey],
        set: {
          state: values.state,
          providerOperationId: values.providerOperationId,
          attempts: values.attempts,
          maxAttempts: values.maxAttempts,
          nextAttemptAt: values.nextAttemptAt,
          leaseUntil: values.leaseUntil,
          lastError: values.lastError,
          updatedAt: new Date(),
        },
      });
  }

  async getOperation(orderId: string, kind: OperationKind, idempotencyKey: string): Promise<ServerOperation | undefined> {
    const [row] = await this.db
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
    return row ? toOperation(row) : undefined;
  }

  async updateOperation(op: ServerOperation): Promise<void> {
    await this.db
      .update(serverOperations)
      .set({
        state: op.state,
        providerOperationId: op.providerOperationId ?? null,
        attempts: op.attempts,
        maxAttempts: op.maxAttempts,
        nextAttemptAt: new Date(op.nextAttemptAt),
        leaseUntil: op.leaseUntil ? new Date(op.leaseUntil) : null,
        lastError: op.lastError ?? null,
        updatedAt: new Date(),
      })
      .where(eq(serverOperations.id, op.id));
  }

  async dueOperations(nowIso: string): Promise<ServerOperation[]> {
    const now = new Date(nowIso);
    const rows = await this.db
      .select()
      .from(serverOperations)
      .where(
        and(
          or(
            and(
              inArray(serverOperations.state, ["queued", "failed"]),
              lte(serverOperations.nextAttemptAt, now),
            ),
            and(eq(serverOperations.state, "running"), lte(serverOperations.leaseUntil, now)),
          ),
        ),
      )
      .orderBy(asc(serverOperations.nextAttemptAt));
    return rows.filter((row) => row.attempts < row.maxAttempts).map(toOperation);
  }

  async claimOperation(operationId: string, nowIso: string, leaseUntilIso: string): Promise<ServerOperation | undefined> {
    const now = new Date(nowIso);
    const [row] = await this.db
      .update(serverOperations)
      .set({ state: "running", leaseUntil: new Date(leaseUntilIso), updatedAt: now })
      .where(
        and(
          eq(serverOperations.id, operationId),
          or(
            and(
              inArray(serverOperations.state, ["queued", "failed"]),
              lte(serverOperations.nextAttemptAt, now),
            ),
            and(eq(serverOperations.state, "running"), lte(serverOperations.leaseUntil, now)),
          ),
        ),
      )
      .returning();
    return row && row.attempts < row.maxAttempts ? toOperation(row) : undefined;
  }

  async createNodeEnrollment(record: NodeEnrollmentRecord): Promise<NodeEnrollmentRecord> {
    const [row] = await this.db
      .insert(nodeEnrollmentTokens)
      .values({
        id: record.id,
        tokenId: record.tokenId,
        tokenHash: record.tokenHash,
        orgId: record.orgId,
        orderId: record.orderId,
        expiresAt: new Date(record.expiresAt),
        consumedAt: record.consumedAt ? new Date(record.consumedAt) : null,
        consumedByNodeId: record.consumedByNodeId ?? null,
        revokedAt: record.revokedAt ? new Date(record.revokedAt) : null,
        createdAt: new Date(record.createdAt),
      })
      .returning();
    if (!row) throw new Error("insert node enrollment returned no row");
    return toEnrollment(row);
  }

  async getActiveNodeEnrollmentForOrder(orderId: string, nowIso: string): Promise<NodeEnrollmentRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(nodeEnrollmentTokens)
      .where(
        and(
          eq(nodeEnrollmentTokens.orderId, orderId),
          isNull(nodeEnrollmentTokens.consumedAt),
          isNull(nodeEnrollmentTokens.revokedAt),
          gt(nodeEnrollmentTokens.expiresAt, new Date(nowIso)),
        ),
      )
      .orderBy(desc(nodeEnrollmentTokens.createdAt))
      .limit(1);
    return row ? toEnrollment(row) : undefined;
  }

  async consumeNodeEnrollment(input: {
    tokenId: string;
    tokenHash: string;
    nodeId: string;
    nowIso: string;
  }): Promise<NodeEnrollmentRecord | undefined> {
    const now = new Date(input.nowIso);
    const [row] = await this.db
      .update(nodeEnrollmentTokens)
      .set({ consumedAt: now, consumedByNodeId: input.nodeId })
      .where(
        and(
          eq(nodeEnrollmentTokens.tokenId, input.tokenId),
          eq(nodeEnrollmentTokens.tokenHash, input.tokenHash),
          isNull(nodeEnrollmentTokens.consumedAt),
          isNull(nodeEnrollmentTokens.revokedAt),
          gt(nodeEnrollmentTokens.expiresAt, now),
        ),
      )
      .returning();
    return row ? toEnrollment(row) : undefined;
  }

  async revokeNodeEnrollmentsForOrder(orderId: string, nowIso: string): Promise<number> {
    const rows = await this.db
      .update(nodeEnrollmentTokens)
      .set({ revokedAt: new Date(nowIso) })
      .where(
        and(
          eq(nodeEnrollmentTokens.orderId, orderId),
          isNull(nodeEnrollmentTokens.consumedAt),
          isNull(nodeEnrollmentTokens.revokedAt),
        ),
      )
      .returning({ id: nodeEnrollmentTokens.id });
    return rows.length;
  }

  async upsertNode(node: MoxNodeRecord): Promise<MoxNodeRecord> {
    const values = {
      id: node.id,
      orgId: node.orgId,
      orderId: node.orderId ?? null,
      nodeId: node.nodeId,
      enrollTokenHash: node.enrollTokenHash,
      agentTokenHash: node.agentTokenHash ?? null,
      version: node.version ?? null,
      capabilities: node.capabilities,
      metrics: node.metrics ?? null,
      enrolledAt: new Date(node.enrolledAt),
      lastHeartbeatAt: new Date(node.lastHeartbeatAt),
      status: node.status,
    };
    const [row] = await this.db
      .insert(moxNodes)
      .values(values)
      .onConflictDoUpdate({
        target: moxNodes.nodeId,
        set: {
          orgId: values.orgId,
          orderId: values.orderId,
          enrollTokenHash: values.enrollTokenHash,
          agentTokenHash: values.agentTokenHash,
          version: values.version,
          capabilities: values.capabilities,
          metrics: values.metrics,
          enrolledAt: values.enrolledAt,
          lastHeartbeatAt: values.lastHeartbeatAt,
          status: values.status,
        },
      })
      .returning();
    if (!row) throw new Error("upsert Mox Node returned no row");
    return toNode(row);
  }

  async getNode(nodeId: string): Promise<MoxNodeRecord | undefined> {
    const [row] = await this.db.select().from(moxNodes).where(eq(moxNodes.nodeId, nodeId)).limit(1);
    return row ? toNode(row) : undefined;
  }

  async updateNode(node: MoxNodeRecord): Promise<void> {
    await this.db
      .update(moxNodes)
      .set({
        orgId: node.orgId,
        orderId: node.orderId ?? null,
        enrollTokenHash: node.enrollTokenHash,
        agentTokenHash: node.agentTokenHash ?? null,
        version: node.version ?? null,
        capabilities: node.capabilities,
        metrics: node.metrics ?? null,
        enrolledAt: new Date(node.enrolledAt),
        lastHeartbeatAt: new Date(node.lastHeartbeatAt),
        status: node.status,
      })
      .where(eq(moxNodes.nodeId, node.nodeId));
  }

  async listNodes(): Promise<MoxNodeRecord[]> {
    return (await this.db.select().from(moxNodes)).map(toNode);
  }

  async consumeNonce(nonce: string): Promise<boolean> {
    const rows = await this.db
      .insert(nodeConsumedNonces)
      .values({ nonce })
      .onConflictDoNothing({ target: nodeConsumedNonces.nonce })
      .returning({ nonce: nodeConsumedNonces.nonce });
    return rows.length > 0;
  }
}

function toComputeClass(row: typeof computeClasses.$inferSelect): ComputeClass {
  return {
    code: row.code,
    displayName: row.displayName,
    minVcpu: row.minVcpu,
    minRamGb: row.minRamGb,
    skuMap: row.skuMap as ComputeClassSkuCandidate[],
    active: row.active,
  };
}

function toProviderAccount(row: typeof providerAccounts.$inferSelect): ProviderAccountRecord {
  return {
    id: row.id,
    providerName: row.providerName,
    accountLabel: row.accountLabel,
    regionCode: row.regionCode ?? undefined,
    commercialStatus: row.commercialStatus as ProviderAccountRecord["commercialStatus"],
    healthScore: row.healthScore,
    enabled: row.enabled,
    credentialRefId: row.credentialRefId ?? undefined,
    rotatedAt: row.rotatedAt?.toISOString(),
    disabledReason: row.disabledReason ?? undefined,
  };
}

function toSshKey(row: typeof sshKeys.$inferSelect): SshKeyRecord {
  return {
    id: row.id,
    orgId: row.orgId,
    label: row.label,
    publicKey: row.publicKey,
    fingerprint: row.fingerprint,
    createdAt: row.createdAt.toISOString(),
  };
}

function toOrderInsert(order: ServerOrder): typeof serverOrders.$inferInsert {
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
    createdAt: new Date(order.createdAt),
    updatedAt: new Date(order.updatedAt),
  };
}

function toOrderMutable(order: ServerOrder) {
  const row = toOrderInsert(order);
  const { id: _id, orgId: _orgId, idempotencyKey: _idem, createdAt: _createdAt, ...mutable } = row;
  return mutable;
}

function toOrder(row: typeof serverOrders.$inferSelect): ServerOrder {
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
    retentionUntil: row.retentionUntil?.toISOString(),
    canceledAt: row.canceledAt?.toISOString(),
    destroyedAt: row.destroyedAt?.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toOperationInsert(op: ServerOperation): typeof serverOperations.$inferInsert {
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
    leaseUntil: op.leaseUntil ? new Date(op.leaseUntil) : null,
    lastError: op.lastError ?? null,
    createdAt: new Date(op.createdAt),
    updatedAt: new Date(op.updatedAt),
  };
}

function toOperation(row: typeof serverOperations.$inferSelect): ServerOperation {
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
    leaseUntil: row.leaseUntil?.toISOString(),
    lastError: row.lastError ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toEnrollment(row: typeof nodeEnrollmentTokens.$inferSelect): NodeEnrollmentRecord {
  return {
    id: row.id,
    tokenId: row.tokenId,
    tokenHash: row.tokenHash,
    orgId: row.orgId,
    orderId: row.orderId,
    expiresAt: row.expiresAt.toISOString(),
    consumedAt: row.consumedAt?.toISOString(),
    consumedByNodeId: row.consumedByNodeId ?? undefined,
    revokedAt: row.revokedAt?.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

function toNode(row: typeof moxNodes.$inferSelect): MoxNodeRecord {
  return {
    id: row.id,
    orgId: row.orgId,
    orderId: row.orderId ?? undefined,
    nodeId: row.nodeId,
    enrollTokenHash: row.enrollTokenHash,
    agentTokenHash: row.agentTokenHash ?? undefined,
    version: row.version ?? undefined,
    capabilities: row.capabilities as string[],
    metrics: (row.metrics as Record<string, number | string> | null) ?? undefined,
    enrolledAt: row.enrolledAt.toISOString(),
    lastHeartbeatAt: row.lastHeartbeatAt.toISOString(),
    status: row.status as MoxNodeRecord["status"],
  };
}
