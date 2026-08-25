/**
 * Compute orchestrator domain types (Prompt 09).
 *
 * Server orders are desired-state records. The orchestrator reconciles
 * them toward provider reality through durable, idempotent operations.
 * HTTP callers only ever observe state; they never wait on providers.
 */

export type OrderState =
  | "requested"
  | "provisioning"
  | "running"
  | "error"
  | "resizing"
  | "stopping"
  | "stopped"
  | "cancelling"
  | "canceled"
  | "retention"
  | "destroyed";

export interface ComputeClassSkuCandidate {
  providerName: string;
  regionCode: string;
  providerSku: string;
}

export interface ComputeClass {
  code: string;
  displayName: string;
  minVcpu: number;
  minRamGb: number;
  skuMap: ComputeClassSkuCandidate[];
  active: boolean;
}

export interface SshKeyRecord {
  id: string;
  orgId: string;
  label: string;
  publicKey: string;
  fingerprint: string;
  createdAt: string;
}

export interface ProviderAccountRecord {
  id: string;
  providerName: string;
  accountLabel: string;
  regionCode?: string;
  commercialStatus: "active" | "verify" | "approved" | "disabled";
  healthScore: number;
  enabled: boolean;
  /** Vault reference for this account's API credentials (rotation target). */
  credentialRefId?: string;
  rotatedAt?: string;
  disabledReason?: string;
}

export interface ServerOrder {
  id: string;
  orgId: string;
  subscriptionItemId?: string;
  computeClassCode: string;
  state: OrderState;
  providerName?: string;
  providerAccountId?: string;
  regionCode?: string;
  providerSku?: string;
  providerInstanceId?: string;
  ipv4?: string;
  ipv6?: string;
  hostname: string;
  sshKeyId?: string;
  reverseDns?: string;
  idempotencyKey: string;
  requestFingerprint?: string;
  attemptCount: number;
  lastError?: string;
  retentionUntil?: string;
  canceledAt?: string;
  destroyedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type OperationKind =
  | "provision"
  | "start"
  | "stop"
  | "reboot"
  | "resize"
  | "reinstall"
  | "cancel";

export type OperationState = "queued" | "running" | "succeeded" | "failed" | "abandoned";

export interface ServerOperation {
  id: string;
  orderId: string;
  kind: OperationKind;
  state: OperationState;
  providerOperationId?: string;
  idempotencyKey: string;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  /**
   * Security Repair 05B §A: fencing token set by every successful claim.
   * Post-claim writebacks must present the claimed version; a worker whose
   * lease was stolen updates zero rows and must stop.
   */
  leaseVersion?: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

/** Enrollment record for a Mox Node agent running on the customer VPS. */
export interface MoxNodeRecord {
  id: string;
  orgId: string;
  orderId?: string;
  nodeId: string;
  /** Legacy field: hash of the consumed one-time bootstrap token. */
  enrollTokenHash: string;
  /**
   * Durable node identity (Prompt 00 §E8/E9): sha256 of the agent token
   * issued after successful bootstrap enrollment. Heartbeats authenticate
   * with the plaintext token; this stores only its hash.
   */
  agentTokenHash?: string;
  version?: string;
  capabilities: string[];
  metrics?: Record<string, number | string>;
  enrolledAt: string;
  lastHeartbeatAt: string;
  status: "active" | "lost" | "retired";
}

/** Pre-persisted expected bootstrap secret for first-time enrollment (§E). */
export interface NodeEnrollmentTokenRecord {
  id: string;
  /** sha256 hex of the bootstrap secret; plaintext is never stored. */
  tokenHash: string;
  orgId: string;
  orderId: string;
  /** Bound once the provider instance id is known post-provision. */
  providerInstanceId?: string;
  /** Server-issued node identity expected from cloud-init. */
  expectedNodeId?: string;
  state: "issued" | "consumed" | "expired" | "revoked";
  expiresAt: string;
  consumedAt?: string;
  createdAt: string;
}
