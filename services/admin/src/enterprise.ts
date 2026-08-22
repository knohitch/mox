/**
 * Enterprise contracts (Prompt 13): enterprise is NOT separate code.
 *
 * A custom organization contract configures negotiated terms through the
 * SAME entitlement engine used by every plan — plus non-entitlement
 * metadata (SLA, domains, SSO readiness, private networking hooks) that
 * operations tooling reads. Nothing here branches on plan names.
 */

import type { EntitlementService, EntitlementValues } from "@mox/entitlements";

export interface EnterpriseContractConfig {
  orgId: string;
  contractRef: string;
  /** Negotiated monthly price; overrides regional price books when set. */
  customPriceMinor?: bigint | number;
  currency?: string;
  /** Entitlement-layer values resolved by @mox/entitlements precedence. */
  entitlementValues: EntitlementValues;
  metadata: EnterpriseContractMetadata;
  active: boolean;
  effectiveFrom: string;
  effectiveUntil?: string;
}

export interface EnterpriseContractMetadata {
  includedNodes: number;
  customComputeClassCodes: string[];
  privateModelSlugs: string[];
  dedicatedDatabase: boolean;
  dedicatedRuntime: boolean;
  customRetentionDays?: number;
  customDomains: string[];
  auditExportEnabled: boolean;
  ssoSamlReady: boolean;
  ssoMetadataUrl?: string;
  privateNetworkingHooks: string[];
  slaMonthlyUptimePct?: number;
  slaSupportResponseHours?: number;
  whiteLabel: boolean;
}

export interface ContractAuditEntry {
  at: string;
  actor: string;
  action: "created" | "updated" | "deactivated";
  contractRef: string;
  summary: string;
}

export interface EnterpriseStore {
  upsertContract(config: EnterpriseContractConfig): Promise<void>;
  getContract(orgId: string): Promise<EnterpriseContractConfig | undefined>;
  appendAudit(entry: ContractAuditEntry): Promise<void>;
  listAudit(contractRef?: string): Promise<ContractAuditEntry[]>;
}

export class InMemoryEnterpriseStore implements EnterpriseStore {
  private readonly contracts = new Map<string, EnterpriseContractConfig>();
  private readonly auditLog: ContractAuditEntry[] = [];

  async upsertContract(config: EnterpriseContractConfig): Promise<void> {
    this.contracts.set(config.orgId, config);
  }

  async getContract(orgId: string): Promise<EnterpriseContractConfig | undefined> {
    return this.contracts.get(orgId);
  }

  async appendAudit(entry: ContractAuditEntry): Promise<void> {
    this.auditLog.push(entry);
  }

  async listAudit(contractRef?: string): Promise<ContractAuditEntry[]> {
    return [...this.auditLog].filter((e) => (contractRef ? e.contractRef === contractRef : true));
  }
}

export class EnterpriseContractService {
  readonly store: EnterpriseStore;
  private readonly entitlements: EntitlementService;

  constructor(entitlements: EntitlementService, store: EnterpriseStore = new InMemoryEnterpriseStore()) {
    this.entitlements = entitlements;
    this.store = store;
  }

  /**
   * Create/update a contract. Entitlement values flow into the shared
   * entitlement engine as a custom contract layer — identical resolution
   * semantics for Plus customers and Fortune 500s.
   */
  async apply(input: { config: Omit<EnterpriseContractConfig, never>; actor: string }): Promise<EnterpriseContractConfig> {
    const existing = await this.store.getContract(input.config.orgId);
    await this.store.upsertContract(input.config);
    // Mirror into the entitlement engine's contract layer.
    await this.entitlements.applyContract({
      orgId: input.config.orgId,
      contractId: input.config.contractRef,
      values: input.config.entitlementValues,
      active: input.config.active,
      effectiveFrom: input.config.effectiveFrom,
      effectiveUntil: input.config.effectiveUntil,
    });
    const summary = Object.entries(input.config.entitlementValues)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(", ");
    await this.store.appendAudit({
      at: new Date().toISOString(),
      actor: input.actor,
      action: existing ? "updated" : "created",
      contractRef: input.config.contractRef,
      summary: summary || "(no entitlement changes)",
    });
    return input.config;
  }

  async deactivate(input: { orgId: string; actor: string }): Promise<void> {
    const config = await this.require(input.orgId);
    const deactivated: EnterpriseContractConfig = { ...config, active: false };
    await this.store.upsertContract(deactivated);
    await this.entitlements.applyContract({
      orgId: config.orgId,
      contractId: config.contractRef,
      values: config.entitlementValues,
      active: false,
      effectiveFrom: config.effectiveFrom,
      effectiveUntil: config.effectiveUntil,
    });
    await this.store.appendAudit({
      at: new Date().toISOString(),
      actor: input.actor,
      action: "deactivated",
      contractRef: config.contractRef,
      summary: "",
    });
  }

  get(orgId: string): Promise<EnterpriseContractConfig | undefined> {
    return this.store.getContract(orgId);
  }

  listAudit(contractRef?: string): Promise<ContractAuditEntry[]> {
    return this.store.listAudit(contractRef);
  }

  private async require(orgId: string): Promise<EnterpriseContractConfig> {
    const config = await this.store.getContract(orgId);
    if (!config) throw new Error(`no enterprise contract for ${orgId}`);
    return config;
  }
}
