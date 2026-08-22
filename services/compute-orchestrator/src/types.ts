/** Compute orchestrator domain types. */

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
  /** Vault reference for this account's API credentials. */
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
  /** Cross-process worker claim lease. */
  leaseUntil?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

/** One-time, server-owned enrollment grant bound to exactly one order/org. */
export interface NodeEnrollmentRecord {
  id: string;
  tokenId: string;
  tokenHash: string;
  orgId: string;
  orderId: string;
  expiresAt: string;
  consumedAt?: string;
  consumedByNodeId?: string;
  revokedAt?: string;
  createdAt: string;
}

/** Enrollment record for a Mox Node agent running on the customer VPS. */
export interface MoxNodeRecord {
  id: string;
  orgId: string;
  orderId?: string;
  nodeId: string;
  /** Historical one-time enrollment token hash; never accepted for auth. */
  enrollTokenHash: string;
  /** Current bearer token hash. Raw bearer token is never persisted. */
  agentTokenHash?: string;
  version?: string;
  capabilities: string[];
  metrics?: Record<string, number | string>;
  enrolledAt: string;
  lastHeartbeatAt: string;
  status: "active" | "lost" | "retired";
}
