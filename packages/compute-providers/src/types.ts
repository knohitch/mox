/**
 * ComputeProvider abstraction (Prompt 09).
 *
 * Providers implement capability flags; Mox business logic never assumes an
 * operation exists. Provider-specific details (Contabo API shapes, Hetzner
 * pricing) stay behind this interface and inside the adapters.
 */

import type { HealthReport } from "@mox/contracts";

export const COMPUTE_PROVIDER_OPERATIONS = [
  "list_products",
  "list_regions",
  "provision",
  "get_instance",
  "start",
  "stop",
  "reboot",
  "resize",
  "reinstall",
  "cancel",
  "snapshots",
  "reverse_dns",
  "provider_health",
] as const;

export type ComputeProviderOperation = (typeof COMPUTE_PROVIDER_OPERATIONS)[number];

export type ComputeCapabilities = Record<ComputeProviderOperation, boolean>;

export function capabilitiesWith(...supported: ComputeProviderOperation[]): ComputeCapabilities {
  const caps = Object.fromEntries(COMPUTE_PROVIDER_OPERATIONS.map((op) => [op, false])) as ComputeCapabilities;
  for (const op of supported) caps[op] = true;
  return caps;
}

export interface ProviderProduct {
  providerSku: string;
  displayName: string;
  vcpu: number;
  ramGb: number;
  diskGb: number;
  /** Wholesale cost stays provider-side; customers never see this. */
  wholesaleCostMinor?: bigint | number;
  wholesaleCurrency?: string;
}

export interface ProviderRegion {
  code: string;
  displayName: string;
}

export type ProvisionState =
  | "pending"
  | "provisioning"
  | "running"
  | "stopped"
  | "error"
  | "canceled";

export interface ProviderInstance {
  providerInstanceId: string;
  state: ProvisionState;
  regionCode: string;
  providerSku: string;
  ipv4?: string;
  ipv6?: string;
  createdAt: string;
}

export interface ProvisionInput {
  /** Mox-side idempotency key; providers must not double-provision. */
  idempotencyKey: string;
  regionCode: string;
  providerSku: string;
  hostname: string;
  sshPublicKey: string;
  cloudInitUserData: string;
}

export interface ProviderOperation {
  providerOperationId: string;
  status: "queued" | "running" | "succeeded" | "failed";
  errorCode?: string;
  message?: string;
}

/** Normalized provider error with retry semantics. */
export class ProviderError extends Error {
  readonly retryable: boolean;
  readonly httpStatus?: number;

  constructor(message: string, options: { retryable?: boolean; httpStatus?: number } = {}) {
    super(message);
    this.name = "ProviderError";
    this.retryable = options.retryable ?? false;
    this.httpStatus = options.httpStatus;
  }
}

export interface ComputeProvider {
  readonly name: string;
  readonly configured: boolean;
  readonly blocker?: string;
  readonly commercialStatus?: "active" | "verify" | "approved" | "disabled";
  readonly capabilities: ComputeCapabilities;

  listProducts(): Promise<ProviderProduct[]>;
  listRegions(): Promise<ProviderRegion[]>;
  provision(input: ProvisionInput): Promise<{ instance: ProviderInstance; operation: ProviderOperation }>;
  getInstance(providerInstanceId: string): Promise<ProviderInstance>;
  start(providerInstanceId: string): Promise<ProviderOperation>;
  stop(providerInstanceId: string): Promise<ProviderOperation>;
  reboot(providerInstanceId: string): Promise<ProviderOperation>;
  resize(providerInstanceId: string, targetSku: string): Promise<ProviderOperation>;
  reinstall(providerInstanceId: string, sshPublicKey: string, cloudInitUserData: string): Promise<ProviderOperation>;
  cancel(providerInstanceId: string): Promise<ProviderOperation>;
  setReverseDns(providerInstanceId: string, ipv4: string, ptr: string): Promise<void>;
  health(): Promise<HealthReport>;
}
