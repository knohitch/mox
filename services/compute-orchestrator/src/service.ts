/**
 * Mox compute orchestration authority.
 *
 * Provider side effects are driven from durable desired state. Mox Node is
 * customer-controlled and untrusted: it can report telemetry and execute
 * authenticated commands, but it cannot choose its organization, order,
 * entitlements or billing state.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { ComputeProvider } from "@mox/compute-providers";
import { ProviderError } from "@mox/compute-providers";
import type { HealthReport } from "@mox/contracts";
import type { ProviderHealthScorer } from "@mox/provider-health";
import { buildMoxNodeCloudInit } from "./cloudinit.js";
import {
  InMemoryOrchestratorStore,
  newId,
  sha256Hex,
  type OrchestratorStore,
} from "./store.js";
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

export class OrchestratorError extends Error {}
export class NotFoundError extends OrchestratorError {}
export class NotApprovedError extends OrchestratorError {}
export class TerminalFailureError extends OrchestratorError {}
export class NodeAuthenticationError extends OrchestratorError {}

export interface OrchestratorOptions {
  /** Backoff base for provider-operation retries. */
  retryBaseMs?: number;
  maxAttempts?: number;
  /** Recover a provider operation after a worker dies while holding it. */
  operationLeaseMs?: number;
  /** Heartbeat staleness threshold for marking nodes lost. */
  heartbeatLostMs?: number;
  /** Retention window before destroyed cleanup. */
  retentionDays?: number;
  /** Lifetime of a first-boot/re-enrollment grant. */
  nodeEnrollmentTtlMs?: number;
  /**
   * Mox-owned secret used only to sign node enrollment grants. It must come
   * from the system secret boundary (KMS/vault/env injection), never from a
   * customer credential record. Provision/enrollment fail closed without it.
   */
  nodeEnrollmentSecret?: string;
  /** Public/control-plane origin inserted into cloud-init. */
  controlPlaneUrl?: string;
  /** Optional health registry; when present, selection ranks by health. */
  healthScorer?: ProviderHealthScorer;
}

interface ReconcileResult {
  processed: number;
  succeeded: number;
  failed: number;
  abandoned: number;
}

export interface NodeEnrollmentResult {
  node: MoxNodeRecord;
  /** Returned once to Mox Node; only its hash is persisted. */
  agentToken: string;
}

export class ComputeOrchestrator {
  readonly store: OrchestratorStore;
  private readonly providers = new Map<string, ComputeProvider>();
  private readonly healthScorer?: ProviderHealthScorer;
  private readonly retryBaseMs: number;
  private readonly defaultMaxAttempts: number;
  private readonly operationLeaseMs: number;
  private readonly heartbeatLostMs: number;
  private readonly retentionDays: number;
  private readonly nodeEnrollmentTtlMs: number;
  private readonly nodeEnrollmentSecret?: string;
  private readonly controlPlaneUrl: string;

  constructor(store: OrchestratorStore = new InMemoryOrchestratorStore(), options: OrchestratorOptions = {}) {
    this.store = store;
    this.healthScorer = options.healthScorer;
    this.retryBaseMs = options.retryBaseMs ?? 1000;
    this.defaultMaxAttempts = options.maxAttempts ?? 5;
    this.operationLeaseMs = options.operationLeaseMs ?? 2 * 60_000;
    this.heartbeatLostMs = options.heartbeatLostMs ?? 5 * 60_000;
    this.retentionDays = options.retentionDays ?? 14;
    this.nodeEnrollmentTtlMs = options.nodeEnrollmentTtlMs ?? 24 * 60 * 60_000;
    this.nodeEnrollmentSecret = options.nodeEnrollmentSecret;
    this.controlPlaneUrl = options.controlPlaneUrl ?? "https://control-plane.mox.internal";
  }

  // ---- Registration ----------------------------------------------------------

  registerProvider(provider: ComputeProvider): void {
    this.providers.set(provider.name, provider);
  }

  provider(name: string): ComputeProvider {
    const p = this.providers.get(name);
    if (!p) throw new NotFoundError(`compute provider "${name}" not registered`);
    return p;
  }

  async configureComputeClass(cls: Omit<ComputeClass, never> & { code: string }): Promise<void> {
    await this.store.upsertComputeClass(cls as ComputeClass);
  }

  async registerProviderAccount(account: Omit<ProviderAccountRecord, "id"> & { id?: string }): Promise<ProviderAccountRecord> {
    const full: ProviderAccountRecord = { ...account, id: account.id ?? newId() } as ProviderAccountRecord;
    await this.store.upsertProviderAccount(full);
    return full;
  }

  async rotateProviderAccountCredential(input: {
    providerName: string;
    accountLabel: string;
    newCredentialRefId: string;
    actor: string;
  }): Promise<ProviderAccountRecord> {
    const accounts = await this.store.listProviderAccounts(input.providerName);
    const account = accounts.find((a) => a.accountLabel === input.accountLabel);
    if (!account) throw new NotFoundError(`provider account ${input.providerName}/${input.accountLabel}`);
    const rotated: ProviderAccountRecord = {
      ...account,
      credentialRefId: input.newCredentialRefId,
      rotatedAt: new Date().toISOString(),
    };
    await this.store.upsertProviderAccount(rotated);
    return rotated;
  }

  async disableProviderAccount(input: { providerName: string; accountLabel: string; reason: string }): Promise<void> {
    const accounts = await this.store.listProviderAccounts(input.providerName);
    const account = accounts.find((a) => a.accountLabel === input.accountLabel);
    if (!account) throw new NotFoundError(`provider account ${input.providerName}/${input.accountLabel}`);
    await this.store.upsertProviderAccount({ ...account, enabled: false, disabledReason: input.reason });
  }

  private async selectCandidate(
    candidates: ComputeClassSkuCandidate[],
  ): Promise<{ candidate: ComputeClassSkuCandidate; account?: ProviderAccountRecord }> {
    const eligible: Array<{ candidate: ComputeClassSkuCandidate; account?: ProviderAccountRecord }> = [];
    for (const candidate of candidates) {
      const provider = this.providers.get(candidate.providerName);
      if (!provider || !provider.configured) continue;
      if (provider.commercialStatus === "verify" || provider.commercialStatus === "disabled") continue;
      const accounts = (await this.store.listProviderAccounts(candidate.providerName)).filter((a) => a.enabled);
      const account =
        accounts.find((a) => a.commercialStatus === "approved" || a.commercialStatus === "active") ?? accounts[0];
      eligible.push({ candidate, account });
    }
    if (eligible.length === 0) {
      throw new NotApprovedError(
        "no eligible compute candidate: providers missing, unconfigured, or not commercially approved",
      );
    }

    if (!this.healthScorer || eligible.length === 1) return eligible[0]!;
    const ranked = await this.healthScorer.rank(eligible.map((e) => e.candidate.providerName));
    for (const rankedEntry of ranked) {
      if (rankedEntry.record.state === "offline") continue;
      const match = eligible.find((e) => e.candidate.providerName === rankedEntry.providerName);
      if (match) return match;
    }
    throw new NotApprovedError("all eligible compute providers are currently offline per health scoring");
  }

  // ---- SSH keys --------------------------------------------------------------

  async addSshKey(orgId: string, label: string, publicKey: string): Promise<SshKeyRecord> {
    const fingerprint = `SHA256:${sha256Hex(publicKey).slice(0, 43)}`;
    return this.store.addSshKey({
      id: newId(),
      orgId,
      label,
      publicKey,
      fingerprint,
      createdAt: new Date().toISOString(),
    });
  }

  async listSshKeys(orgId: string): Promise<SshKeyRecord[]> {
    return this.store.listSshKeys(orgId);
  }

  // ---- Ordering --------------------------------------------------------------

  async orderServer(input: {
    orgId: string;
    computeClassCode: string;
    hostname: string;
    idempotencyKey: string;
    sshKeyId?: string;
    subscriptionItemId?: string;
  }): Promise<{ order: ServerOrder; created: boolean }> {
    const existing = await this.store.findOrderByIdempotencyKey(input.orgId, input.idempotencyKey);
    if (existing) return { order: existing, created: false };

    const cls = await this.store.getComputeClass(input.computeClassCode);
    if (!cls || !cls.active) throw new NotFoundError(`compute class ${input.computeClassCode}`);

    const now = new Date().toISOString();
    const order: ServerOrder = {
      id: newId(),
      orgId: input.orgId,
      subscriptionItemId: input.subscriptionItemId,
      computeClassCode: cls.code,
      state: "requested",
      hostname: input.hostname,
      sshKeyId: input.sshKeyId,
      idempotencyKey: input.idempotencyKey,
      attemptCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    const inserted = await this.store.insertOrder(order);
    if (!inserted) {
      const raced = await this.store.findOrderByIdempotencyKey(input.orgId, input.idempotencyKey);
      if (!raced) throw new OrchestratorError("order dedupe raced but canonical order was not found");
      return { order: raced, created: false };
    }
    await this.enqueue(order.id, "provision", `${order.id}:provision`);
    order.state = "provisioning";
    await this.store.updateOrder(order);
    return { order, created: true };
  }

  async getOrder(id: string): Promise<ServerOrder> {
    const order = await this.store.getOrder(id);
    if (!order) throw new NotFoundError(`server order ${id}`);
    return order;
  }

  async listOrders(orgId: string): Promise<ServerOrder[]> {
    return this.store.listOrdersForOrg(orgId);
  }

  async requestResize(orderId: string, targetClassCode: string): Promise<ServerOperation> {
    const order = await this.getOrder(orderId);
    if (order.state !== "running" && order.state !== "stopped") {
      throw new OrchestratorError(`cannot resize order in state ${order.state}`);
    }
    const cls = await this.store.getComputeClass(targetClassCode);
    if (!cls) throw new NotFoundError(`compute class ${targetClassCode}`);
    const { candidate } = await this.selectCandidate(cls.skuMap);
    order.state = "resizing";
    await this.store.updateOrder(order);
    return this.enqueue(order.id, "resize", `${order.id}:resize`, { sku: candidate.providerSku });
  }

  async requestReboot(orderId: string): Promise<ServerOperation> {
    await this.getOrder(orderId);
    return this.enqueue(orderId, "reboot", `${orderId}:reboot`);
  }

  async cancelOrder(orderId: string): Promise<void> {
    const order = await this.getOrder(orderId);
    if (["canceled", "destroyed"].includes(order.state)) return;
    order.canceledAt = new Date().toISOString();
    order.state = "cancelling";
    await this.store.updateOrder(order);
    await this.enqueue(order.id, "cancel", `${order.id}:cancel`);
  }

  // ---- Durable operations ----------------------------------------------------

  private async enqueue(
    orderId: string,
    kind: OperationKind | "provision",
    idempotencyKey: string,
    payloadHint?: Record<string, string>,
  ): Promise<ServerOperation> {
    const now = new Date().toISOString();
    const op: ServerOperation = {
      id: newId(),
      orderId,
      kind: kind as OperationKind,
      state: "queued",
      idempotencyKey: payloadHint ? `${idempotencyKey}:${payloadHint.sku}` : idempotencyKey,
      attempts: 0,
      maxAttempts: this.defaultMaxAttempts,
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.upsertOperation(op);
    return op;
  }

  /**
   * Process due work using a store-level atomic lease. The in-process set is
   * only an optimization; correctness across replicas comes from
   * claimOperation(). Expired running leases are reclaimable after crashes.
   */
  private readonly inFlightOps = new Set<string>();

  async reconcile(now?: string): Promise<ReconcileResult> {
    const at = now ?? new Date().toISOString();
    let processed = 0;
    let succeeded = 0;
    let failed = 0;
    let abandoned = 0;
    const due = await this.store.dueOperations(at);

    for (const snapshot of due) {
      if (this.inFlightOps.has(snapshot.id)) continue;
      const leaseUntil = new Date(Date.parse(at) + this.operationLeaseMs).toISOString();
      const op = await this.store.claimOperation(snapshot.id, at, leaseUntil);
      if (!op) continue;
      processed += 1;
      this.inFlightOps.add(op.id);
      try {
        await this.executeOperation(op, at);
        op.state = "succeeded";
        op.leaseUntil = undefined;
        await this.store.updateOperation(op);
        succeeded += 1;
      } catch (error) {
        op.attempts += 1;
        op.leaseUntil = undefined;
        op.lastError = error instanceof Error ? error.message : String(error);
        const retryable =
          error instanceof ProviderError
            ? error.retryable
            : error instanceof OrchestratorError
              ? false
              : true;
        if (!retryable || op.attempts >= op.maxAttempts) {
          op.state = "abandoned";
          await this.store.updateOperation(op);
          abandoned += 1;
          const order = await this.store.getOrder(op.orderId);
          if (order && !["cancelling", "canceled", "destroyed"].includes(order.state)) {
            order.state = "error";
            order.lastError = op.lastError;
            await this.store.updateOrder(order);
          }
          if (op.kind !== "cancel") failed += 1;
        } else {
          const backoffMs = this.retryBaseMs * 2 ** (op.attempts - 1);
          op.nextAttemptAt = new Date(Date.parse(at) + backoffMs).toISOString();
          op.state = "failed";
          await this.store.updateOperation(op);
          failed += 1;
        }
      } finally {
        this.inFlightOps.delete(op.id);
      }
    }
    return { processed, succeeded, failed, abandoned };
  }

  private async executeOperation(op: ServerOperation, at: string): Promise<void> {
    const order = await this.store.getOrder(op.orderId);
    if (!order) throw new NotFoundError(`order ${op.orderId} vanished`);

    switch (op.kind) {
      case "provision": {
        const cls = await this.store.getComputeClass(order.computeClassCode);
        if (!cls) throw new NotFoundError(`compute class ${order.computeClassCode}`);
        const { candidate, account } = await this.selectCandidate(cls.skuMap);
        const provider = this.provider(candidate.providerName);
        const sshKey = order.sshKeyId ? await this.store.getSshKey(order.sshKeyId) : undefined;
        const enrollment = await this.issueNodeEnrollment(order.id, { now: at });
        const cloudInit = buildMoxNodeCloudInit({
          controlPlaneUrl: this.controlPlaneUrl,
          enrollToken: enrollment.token,
          orgId: order.orgId,
          orderId: order.id,
        });
        const startedAt = Date.now();
        try {
          const result = await provider.provision({
            idempotencyKey: op.idempotencyKey,
            regionCode: candidate.regionCode,
            providerSku: candidate.providerSku,
            hostname: order.hostname,
            sshPublicKey: sshKey?.publicKey ?? "",
            cloudInitUserData: cloudInit,
          });
          this.healthScorer?.record({
            providerName: candidate.providerName,
            accountLabel: account?.accountLabel,
            operation: "provision",
            ok: true,
            latencyMs: Date.now() - startedAt,
            at: new Date().toISOString(),
          });
          order.providerName = candidate.providerName;
          order.providerAccountId = account?.id;
          order.regionCode = candidate.regionCode;
          order.providerSku = candidate.providerSku;
          order.providerInstanceId = result.instance.providerInstanceId;
          order.ipv4 = result.instance.ipv4;
          order.ipv6 = result.instance.ipv6;
          order.state = "running";
          await this.store.updateOrder(order);
        } catch (error) {
          this.healthScorer?.record({
            providerName: candidate.providerName,
            accountLabel: account?.accountLabel,
            operation: "provision",
            ok: false,
            latencyMs: Date.now() - startedAt,
            at: new Date().toISOString(),
          });
          throw error;
        }
        break;
      }
      case "resize": {
        const provider = this.requireProviderForOrder(order);
        const sku = op.idempotencyKey.split(":").at(-1)!;
        const operation = await provider.resize(order.providerInstanceId!, sku);
        op.providerOperationId = operation.providerOperationId;
        order.providerSku = sku;
        order.state = "running";
        await this.store.updateOrder(order);
        break;
      }
      case "reboot": {
        const provider = this.requireProviderForOrder(order);
        const operation = await provider.reboot(order.providerInstanceId!);
        op.providerOperationId = operation.providerOperationId;
        break;
      }
      case "cancel": {
        const provider = this.requireProviderForOrder(order);
        if (order.providerInstanceId) await provider.cancel(order.providerInstanceId);
        order.state = "retention";
        order.retentionUntil = new Date(Date.parse(at) + this.retentionDays * 24 * 3600 * 1000).toISOString();
        await this.store.updateOrder(order);
        break;
      }
      case "start":
      case "stop":
      case "reinstall": {
        const provider = this.requireProviderForOrder(order);
        const method =
          op.kind === "start"
            ? provider.start(order.providerInstanceId!)
            : op.kind === "stop"
              ? provider.stop(order.providerInstanceId!)
              : provider.reinstall(order.providerInstanceId!, "", "");
        const operation = await method;
        op.providerOperationId = operation.providerOperationId;
        if (op.kind === "start") order.state = "running";
        if (op.kind === "stop") order.state = "stopped";
        await this.store.updateOrder(order);
        break;
      }
      default:
        throw new OrchestratorError(`unknown operation kind ${op.kind satisfies never}`);
    }
  }

  private requireProviderForOrder(order: ServerOrder): ComputeProvider {
    if (!order.providerName) throw new OrchestratorError("order has no provider assignment yet");
    return this.provider(order.providerName);
  }

  async runRetentionSweep(now?: string): Promise<number> {
    const at = now ?? new Date().toISOString();
    let destroyed = 0;
    for (const order of await this.store.listOrdersInState(["retention"])) {
      if (order.retentionUntil && order.retentionUntil <= at) {
        order.state = "destroyed";
        order.destroyedAt = at;
        await this.store.updateOrder(order);
        destroyed += 1;
      }
    }
    return destroyed;
  }

  // ---- Provider health -------------------------------------------------------

  async providerHealth(): Promise<Array<{ name: string; report: HealthReport }>> {
    const reports: Array<{ name: string; report: HealthReport }> = [];
    for (const [name, provider] of this.providers) {
      if (!provider.configured) continue;
      try {
        reports.push({ name, report: await provider.health() });
      } catch {
        reports.push({ name, report: { state: "unavailable", checkedAt: new Date().toISOString() } });
      }
    }
    return reports;
  }

  // ---- Mox Node enrollment/authentication -----------------------------------

  /**
   * Return an existing unconsumed grant for provider retries, or create one.
   * The token is reconstructible from tokenId + the Mox-owned signing secret,
   * so the raw token never has to be stored in PostgreSQL.
   */
  async issueNodeEnrollment(
    orderId: string,
    options: { rotate?: boolean; now?: string } = {},
  ): Promise<{ token: string; expiresAt: string; grant: NodeEnrollmentRecord }> {
    const secret = this.requireEnrollmentSecret();
    const order = await this.getOrder(orderId);
    if (["canceled", "retention", "destroyed"].includes(order.state)) {
      throw new OrchestratorError(`cannot issue node enrollment for order in state ${order.state}`);
    }
    const now = options.now ?? new Date().toISOString();
    if (options.rotate) await this.store.revokeNodeEnrollmentsForOrder(order.id, now);

    const existing = options.rotate
      ? undefined
      : await this.store.getActiveNodeEnrollmentForOrder(order.id, now);
    if (existing) {
      return { token: this.signEnrollmentToken(existing.tokenId, secret), expiresAt: existing.expiresAt, grant: existing };
    }

    const tokenId = newId();
    const token = this.signEnrollmentToken(tokenId, secret);
    const grant: NodeEnrollmentRecord = {
      id: newId(),
      tokenId,
      tokenHash: sha256Hex(token),
      orgId: order.orgId,
      orderId: order.id,
      expiresAt: new Date(Date.parse(now) + this.nodeEnrollmentTtlMs).toISOString(),
      createdAt: now,
    };
    await this.store.createNodeEnrollment(grant);
    return { token, expiresAt: grant.expiresAt, grant };
  }

  /**
   * First enrollment is accepted only when a server-issued, signed, unexpired
   * and unconsumed grant can be atomically consumed. orgId/orderId are derived
   * from that grant; the node is never allowed to supply them.
   */
  async enrollNode(input: {
    nodeId: string;
    enrollToken: string;
    version?: string;
    capabilities?: string[];
    now?: string;
  }): Promise<NodeEnrollmentResult> {
    const now = input.now ?? new Date().toISOString();
    const tokenId = this.verifyEnrollmentToken(input.enrollToken);
    const grant = await this.store.consumeNodeEnrollment({
      tokenId,
      tokenHash: sha256Hex(input.enrollToken),
      nodeId: input.nodeId,
      nowIso: now,
    });
    if (!grant) throw new NodeAuthenticationError("invalid, expired, revoked, or already-consumed node enrollment token");

    const order = await this.getOrder(grant.orderId);
    if (order.orgId !== grant.orgId) throw new NodeAuthenticationError("node enrollment grant ownership mismatch");
    if (["canceled", "retention", "destroyed"].includes(order.state)) {
      throw new NodeAuthenticationError(`node enrollment rejected for order in state ${order.state}`);
    }

    const existing = await this.store.getNode(input.nodeId);
    if (existing && (existing.orgId !== grant.orgId || existing.orderId !== grant.orderId)) {
      throw new NodeAuthenticationError("node id is already bound to a different Mox server");
    }

    const agentToken = randomBytes(32).toString("base64url");
    const record: MoxNodeRecord = {
      id: existing?.id ?? newId(),
      orgId: grant.orgId,
      orderId: grant.orderId,
      nodeId: input.nodeId,
      enrollTokenHash: grant.tokenHash,
      agentTokenHash: sha256Hex(agentToken),
      version: input.version ?? existing?.version,
      capabilities: input.capabilities ?? existing?.capabilities ?? [],
      metrics: existing?.metrics,
      enrolledAt: existing?.enrolledAt ?? now,
      lastHeartbeatAt: now,
      status: "active",
    };
    const node = await this.store.upsertNode(record);
    return { node, agentToken };
  }

  /** Rotate a node bearer token without changing its server/org binding. */
  async rotateNodeAgentToken(nodeId: string): Promise<string> {
    const node = await this.store.getNode(nodeId);
    if (!node) throw new NotFoundError(`unknown node ${nodeId}`);
    const agentToken = randomBytes(32).toString("base64url");
    node.agentTokenHash = sha256Hex(agentToken);
    await this.store.updateNode(node);
    return agentToken;
  }

  /** Heartbeats require the bearer token issued during enrollment/rotation. */
  async heartbeat(
    nodeId: string,
    agentToken: string,
    metrics: Record<string, number | string>,
    version?: string,
    now?: string,
  ): Promise<void> {
    const node = await this.authenticateNode(nodeId, agentToken);
    node.metrics = metrics;
    node.lastHeartbeatAt = now ?? new Date().toISOString();
    if (version) node.version = version;
    if (node.status === "lost") node.status = "active";
    await this.store.updateNode(node);
  }

  async authenticateNode(nodeId: string, agentToken: string): Promise<MoxNodeRecord> {
    const node = await this.store.getNode(nodeId);
    if (!node?.agentTokenHash) throw new NodeAuthenticationError("unknown or unauthenticated node");
    const provided = Buffer.from(sha256Hex(agentToken));
    const expected = Buffer.from(node.agentTokenHash);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      throw new NodeAuthenticationError("invalid node bearer token");
    }
    return node;
  }

  async sweepLostNodes(now?: string): Promise<string[]> {
    const at = now ?? new Date().toISOString();
    const lost: string[] = [];
    for (const node of await this.store.listNodes()) {
      if (Date.parse(at) - Date.parse(node.lastHeartbeatAt) > this.heartbeatLostMs && node.status === "active") {
        node.status = "lost";
        await this.store.updateNode(node);
        lost.push(node.nodeId);
      }
    }
    return lost;
  }

  private requireEnrollmentSecret(): string {
    if (!this.nodeEnrollmentSecret || this.nodeEnrollmentSecret.length < 32) {
      throw new OrchestratorError("Mox node enrollment signing secret is not configured or is too short");
    }
    return this.nodeEnrollmentSecret;
  }

  private signEnrollmentToken(tokenId: string, secret: string): string {
    const signature = createHmac("sha256", secret).update(`mox-node-enrollment:v1:${tokenId}`).digest("base64url");
    return `${tokenId}.${signature}`;
  }

  private verifyEnrollmentToken(token: string): string {
    const secret = this.requireEnrollmentSecret();
    const separator = token.indexOf(".");
    if (separator <= 0 || separator === token.length - 1) {
      throw new NodeAuthenticationError("malformed node enrollment token");
    }
    const tokenId = token.slice(0, separator);
    const expected = this.signEnrollmentToken(tokenId, secret);
    const a = Buffer.from(expected);
    const b = Buffer.from(token);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new NodeAuthenticationError("invalid node enrollment token signature");
    }
    return tokenId;
  }
}
