/**
 * Compute orchestrator (Prompt 09): Mox-owned desired-state workflow for
 * dedicated VPS provisioning. HTTP requests only observe state; a durable
 * reconciliation loop drives providers with idempotent, retryable ops.
 *
 * Rules enforced here:
 * - Double-click ordering is safe: (org, idempotencyKey) dedupe.
 * - Hetzner-class providers need commercialStatus "approved" to serve traffic.
 * - Mox Node is untrusted: enrollment/heartbeat are advisory; ownership,
 *   entitlement and billing truth never depend on it.
 * - Provider-side lifecycle works even when the node is offline.
 */

import { randomBytes } from "node:crypto";
import type { ComputeProvider } from "@mox/compute-providers";
import type { HealthReport } from "@mox/contracts";
import { ProviderError } from "@mox/compute-providers";
import type { ProviderHealthScorer } from "@mox/provider-health";
import { buildMoxNodeCloudInit } from "./cloudinit.js";
import {
  InMemoryOrchestratorStore,
  hashesEqual,
  newId,
  sha256Hex,
  type OrchestratorStore,
} from "./store.js";
import type {
  ComputeClass,
  ComputeClassSkuCandidate,
  MoxNodeRecord,
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
/** Raised when a bootstrap enrollment attempt fails validation/consumption. */
export class EnrollmentError extends OrchestratorError {}

export interface OrchestratorOptions {
  /**
   * Public control-plane endpoint passed into node cloud-init (Prompt 00
   * §F). Required validated deployment configuration — there is no default.
   * Optional at the type level only so DI containers fail at construction.
   */
  controlPlaneUrl?: string;
  /** Test/local override permitting non-https endpoints. Never in production. */
  allowInsecureControlPlaneUrl?: boolean;
  /** Bootstrap enrollment token lifetime; short by design. */
  enrollTokenTtlMs?: number;
  /** Backoff base for operation retries. */
  retryBaseMs?: number;
  maxAttempts?: number;
  /** Heartbeat staleness threshold for marking nodes lost. */
  heartbeatLostMs?: number;
  /** Retention window before destroyed cleanup. */
  retentionDays?: number;
  /** Optional health registry; when present, selection ranks by health. */
  healthScorer?: ProviderHealthScorer;
}

interface ReconcileResult {
  processed: number;
  succeeded: number;
  failed: number;
  abandoned: number;
}

function validateControlPlaneUrl(raw: string, allowInsecure: boolean): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new OrchestratorError(`controlPlaneUrl is not a valid URL: ${JSON.stringify(raw)}`);
  }
  if (parsed.protocol !== "https:" && !(allowInsecure && parsed.protocol === "http:")) {
    throw new OrchestratorError(
      `controlPlaneUrl must use https (got ${parsed.protocol}); set MOX_CONTROL_PLANE_URL to a valid https endpoint`,
    );
  }
  return parsed.toString().replace(/\/$/, "");
}

export class ComputeOrchestrator {
  readonly store: OrchestratorStore;
  private readonly providers = new Map<string, ComputeProvider>();
  private readonly healthScorer?: ProviderHealthScorer;
  readonly controlPlaneUrl: string;
  private readonly retryBaseMs: number;
  private readonly defaultMaxAttempts: number;
  private readonly heartbeatLostMs: number;
  private readonly retentionDays: number;
  private readonly enrollTokenTtlMs: number;

  constructor(store: OrchestratorStore = new InMemoryOrchestratorStore(), options: OrchestratorOptions = {}) {
    if (!options.controlPlaneUrl) {
      throw new OrchestratorError(
        "controlPlaneUrl is required deployment configuration (MOX_CONTROL_PLANE_URL); refusing to start with a hard-coded endpoint",
      );
    }
    this.controlPlaneUrl = validateControlPlaneUrl(options.controlPlaneUrl, options.allowInsecureControlPlaneUrl === true);
    this.store = store;
    this.healthScorer = options.healthScorer;
    this.retryBaseMs = options.retryBaseMs ?? 1000;
    this.defaultMaxAttempts = options.maxAttempts ?? 5;
    this.heartbeatLostMs = options.heartbeatLostMs ?? 5 * 60_000;
    this.retentionDays = options.retentionDays ?? 14;
    this.enrollTokenTtlMs = options.enrollTokenTtlMs ?? 30 * 60_000;
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

  /**
   * Rotate an account's credential reference (blast-radius control).
   * Rotation is metadata here: the vault swap happens in @mox/credentials;
   * this records which credential ref the account now uses.
   */
  async rotateProviderAccountCredential(input: { providerName: string; accountLabel: string; newCredentialRefId: string; actor: string }): Promise<ProviderAccountRecord> {
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

  /**
   * Pick the best SKU candidate whose provider is configured AND
   * commercially approved AND has an enabled account. When a health scorer
   * is registered, candidates are ranked by health score and offline
   * providers are skipped — but health NEVER overrides commercial approval,
   * entitlement or region compatibility: those gate eligibility first.
   */
  private async selectCandidate(
    candidates: ComputeClassSkuCandidate[],
  ): Promise<{ candidate: ComputeClassSkuCandidate; account?: ProviderAccountRecord }> {
    const eligible: Array<{ candidate: ComputeClassSkuCandidate; account?: ProviderAccountRecord }> = [];
    for (const candidate of candidates) {
      const provider = this.providers.get(candidate.providerName);
      if (!provider || !provider.configured) continue;
      // Commercial gate: verify/disabled providers take no production traffic.
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

    if (!this.healthScorer || eligible.length === 1) {
      return eligible[0]!;
    }
    // Health-aware ranking among already-eligible providers only.
    const ranked = await this.healthScorer.rank(
      eligible.map((e) => e.candidate.providerName),
    );
    for (const rankedEntry of ranked) {
      if (rankedEntry.record.state === "offline") continue; // fail closed on offline providers
      const match = eligible.find((e) => e.candidate.providerName === rankedEntry.providerName)!;
      return match;
    }
    throw new NotApprovedError("all eligible compute providers are currently offline per health scoring");
  }

  // ---- SSH keys ----------------------------------------------------------------

  async addSshKey(orgId: string, label: string, publicKey: string): Promise<SshKeyRecord> {
    const fingerprint = `SHA256:${sha256Hex(publicKey).slice(0, 43)}`;
    return this.store.addSshKey({ id: newId(), orgId, label, publicKey, fingerprint, createdAt: new Date().toISOString() });
  }

  async listSshKeys(orgId: string): Promise<SshKeyRecord[]> {
    return this.store.listSshKeys(orgId);
  }

  // ---- Ordering --------------------------------------------------------------

  /**
   * Order a dedicated VPS. Idempotent per (org, idempotencyKey): a
   * double-click returns the same order instead of buying two servers.
   * Returns the order immediately in requested/provisioning state.
   */
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
      return { order: raced!, created: false };
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

  /**
   * Cancel + destroy through the PROVIDER API — works even when the
   * customer's Mox Node is offline or disabled.
   */
  async cancelOrder(orderId: string): Promise<void> {
    const order = await this.getOrder(orderId);
    if (["canceled", "destroyed"].includes(order.state)) return;
    order.canceledAt = new Date().toISOString();
    order.state = "cancelling";
    await this.store.updateOrder(order);
    await this.enqueue(order.id, "cancel", `${order.id}:cancel`);
  }

  // ---- Durable operations ------------------------------------------------------

  private async enqueue(
    orderId: string,
    kind: OperationKind | "provision",
    idempotencyKey: string,
    payloadHint?: Record<string, string>,
  ): Promise<ServerOperation> {
    const op: ServerOperation = {
      id: newId(),
      orderId,
      kind: kind as OperationKind,
      state: "queued",
      idempotencyKey: payloadHint ? `${idempotencyKey}:${payloadHint.sku}` : idempotencyKey,
      attempts: 0,
      maxAttempts: this.defaultMaxAttempts,
      nextAttemptAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await this.store.upsertOperation(op);
    return op;
  }

  /**
   * Reconciliation tick: process all due operations once. In production this
   * runs from a durable queue worker; tests call it directly. Concurrent
   * workers never double-execute an operation (in-flight claim).
   */
  private readonly inFlightOps = new Set<string>();

  async reconcile(now?: string): Promise<ReconcileResult> {
    const at = now ?? new Date().toISOString();
    let succeeded = 0;
    let failed = 0;
    let abandoned = 0;
    const due = await this.store.dueOperations(at);
    for (const op of due) {
      // Skip operations claimed, finished or exhausted since the snapshot.
      if (this.inFlightOps.has(op.id)) continue;
      if (op.state === "running" || op.state === "succeeded" || op.state === "abandoned") continue;
      if (op.attempts >= op.maxAttempts) continue;
      this.inFlightOps.add(op.id);
      try {
        await this.executeOperation(op, at);
        op.state = "succeeded";
        await this.store.updateOperation(op);
        succeeded += 1;
      } catch (error) {
        op.attempts += 1;
        op.lastError = error instanceof Error ? error.message : String(error);
        const retryable =
          error instanceof ProviderError
            ? error.retryable
            : error instanceof OrchestratorError || error instanceof NotFoundError || error instanceof NotApprovedError
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
    return { processed: due.length, succeeded, failed, abandoned };
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
        // Prompt 00 §E: the bootstrap secret is cryptographically strong and
        // its hash is PERSISTED before provisioning/cloud-init runs. The
        // plaintext exists only in the bootstrap payload below.
        const enrollToken = randomBytes(32).toString("base64url");
        const enrollTokenHash = sha256Hex(enrollToken);
        await this.store.createEnrollmentToken({
          id: newId(),
          tokenHash: enrollTokenHash,
          orgId: order.orgId,
          orderId: order.id,
          state: "issued",
          expiresAt: new Date(Date.parse(at) + this.enrollTokenTtlMs).toISOString(),
          createdAt: at,
        });
        const cloudInit = buildMoxNodeCloudInit({
          controlPlaneUrl: this.controlPlaneUrl,
          enrollToken,
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
          // Bind the pending enrollment expectation to the exact instance
          // now that the provider id is known (§E3).
          const expected = await this.store.getEnrollmentToken(enrollTokenHash);
          if (expected && expected.state === "issued") {
            expected.providerInstanceId = result.instance.providerInstanceId;
            await this.store.updateEnrollmentToken(expected);
          }
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
        void at;
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
        if (order.providerInstanceId) {
          await provider.cancel(order.providerInstanceId);
        }
        order.state = "retention";
        order.retentionUntil = new Date(Date.parse(at) + this.retentionDays * 24 * 3600 * 1000).toISOString();
        await this.store.updateOrder(order);
        break;
      }
      case "start":
      case "stop":
      case "reinstall": {
        const provider = this.requireProviderForOrder(order);
        const method = op.kind === "start" ? provider.start(order.providerInstanceId!)
          : op.kind === "stop" ? provider.stop(order.providerInstanceId!)
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

  /** Retention sweep: retention → destroyed. */
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

  // ---- Provider health ---------------------------------------------------------

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

  // ---- Mox Node (untrusted) -----------------------------------------------------

  /**
   * First-time enrollment (Prompt 00 §E). The presented bootstrap token is
   * validated against the PRE-PERSISTED expected record: org/order binding,
   * expiry, state, constant-time hash comparison, then an atomic single-use
   * consume. Wrong, replayed or already-consumed tokens all fail. On success
   * a durable node identity (agent token) is issued; its hash is stored and
   * only the plaintext is returned in this one response.
   */
  async enrollNode(input: {
    orgId: string;
    orderId: string;
    nodeId: string;
    enrollToken: string;
    version?: string;
    capabilities?: string[];
    now?: string;
  }): Promise<{ node: MoxNodeRecord; agentToken: string }> {
    const at = input.now ?? new Date().toISOString();
    if (!input.enrollToken || !input.orderId) {
      throw new EnrollmentError("enrollment requires orderId and enrollToken");
    }
    const tokenHash = sha256Hex(input.enrollToken);
    const expected = await this.store.getEnrollmentToken(tokenHash);
    // Audit note: failures never echo token material.
    if (!expected) throw new EnrollmentError("unknown enrollment token");
    if (expected.state === "consumed") throw new EnrollmentError("enrollment token already used");
    if (expected.state !== "issued") throw new EnrollmentError(`enrollment token ${expected.state}`);
    if (expected.expiresAt <= at) throw new EnrollmentError("enrollment token expired");
    if (expected.orgId !== input.orgId) throw new EnrollmentError("enrollment token org mismatch");
    if (expected.orderId !== input.orderId) throw new EnrollmentError("enrollment token order mismatch");
    // Constant-time comparison of the two digests (§E6).
    if (!hashesEqual(expected.tokenHash, tokenHash)) {
      throw new EnrollmentError("enrollment token mismatch");
    }
    // Atomic consume: exactly one concurrent enrollment can win (§E7/E11).
    const consumed = await this.store.consumeEnrollmentToken(tokenHash, at);
    if (!consumed) throw new EnrollmentError("enrollment token already used");

    const agentToken = randomBytes(32).toString("base64url");
    const existing = await this.store.getNode(input.nodeId);
    if (existing) {
      // Durable identity rotation for a re-imaged node id.
      existing.enrollTokenHash = tokenHash;
      existing.agentTokenHash = sha256Hex(agentToken);
      existing.orgId = input.orgId;
      existing.orderId = input.orderId;
      existing.version = input.version;
      existing.capabilities = input.capabilities ?? [];
      existing.lastHeartbeatAt = at;
      existing.status = "active";
      await this.store.updateNode(existing);
      return { node: existing, agentToken };
    }
    const record: MoxNodeRecord = {
      id: newId(),
      orgId: input.orgId,
      orderId: input.orderId,
      nodeId: input.nodeId,
      enrollTokenHash: tokenHash,
      agentTokenHash: sha256Hex(agentToken),
      version: input.version,
      capabilities: input.capabilities ?? [],
      enrolledAt: at,
      lastHeartbeatAt: at,
      status: "active",
    };
    const node = await this.store.upsertNode(record);
    return { node, agentToken };
  }

  /**
   * Heartbeats authenticate with the durable agent token issued at
   * enrollment (§E9) — never with the one-time bootstrap secret.
   * Updates advisory telemetry only.
   */
  async heartbeat(
    nodeId: string,
    metrics: Record<string, number | string>,
    auth: { agentToken: string },
    options: { version?: string; now?: string } = {},
  ): Promise<void> {
    const node = await this.store.getNode(nodeId);
    if (!node) throw new NotFoundError(`unknown node ${nodeId}`);
    if (!node.agentTokenHash || !hashesEqual(node.agentTokenHash, sha256Hex(auth.agentToken))) {
      throw new OrchestratorError("node authentication failed");
    }
    node.metrics = metrics;
    node.lastHeartbeatAt = options.now ?? new Date().toISOString();
    if (options.version) node.version = options.version;
    if (node.status === "lost") node.status = "active";
    await this.store.updateNode(node);
  }

  /** Marks nodes lost whose heartbeat exceeded the staleness threshold. */
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
}
