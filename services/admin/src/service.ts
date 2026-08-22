/**
 * Admin service facade: every area of the platform reachable through one
 * role-checked surface. Delegates to authoritative services; owns only
 * admin-specific state (account status, support notes, settings, audit).
 */

import type { CostEngine } from "@mox/cost-engine";
import type { EntitlementService, EntitlementKey } from "@mox/entitlements";
import type { FeatureFlagService, FlagContext, FlagScope } from "@mox/feature-flags";
import type {
  AdminActor,
  AdminCapability,
  AdminStore,
  OrgAccountRecord,
} from "./rbac.js";
import { AdminAccessError, CAPABILITY_ROLES, InMemoryAdminStore } from "./rbac.js";
import type { EnterpriseContractConfig } from "./enterprise.js";
import type { EnterpriseContractService } from "./enterprise.js";

function nowIso(): string {
  return new Date().toISOString();
}

export interface MarginReportRequest {
  dimension: "org" | "plan" | "region" | "provider";
  window: { from: string; to: string };
  currency: string;
  fxRates: Record<string, number>;
}

/** Minimal read shapes the admin UI consumes; services stay authoritative. */
export interface BillingSummaryRow {
  subscriptionId: string;
  orgId: string;
  planVersionId: string;
  priceVersionId: string;
  state: string;
  currentPeriodEnd?: string;
  failedRenewals: number;
}

export interface BillingAuthority {
  listSubscriptionSummaries(): Promise<BillingSummaryRow[]>;
  adminSuspend(subscriptionId: string, adminId: string, reason: string): Promise<void>;
  adminReactivate(subscriptionId: string, adminId: string): Promise<void>;
  createPlanVersion(productId: string, version: number): Promise<{ id: string }>;
  activatePlanVersion(planVersionId: string): Promise<unknown>;
  setPlanEntitlementValues(planVersionId: string, values: Partial<Record<string, boolean | number | string>>): Promise<unknown>;
  addFixedPriceVersion(priceBookId: string, amountMinor: bigint | number, currency: string, effectiveFrom?: string): Promise<unknown>;
  upsertPriceBook(book: { productId: string; pricingRegionCode: string; mode: string; baseCurrency?: string; baseAmountMinor?: bigint | number; fxRate?: number }): Promise<{ id: string }>;
  attachAddon(subscriptionId: string, addonCode: string, quantity: number): Promise<unknown>;
}

export interface ComputeAuthority {
  registerProviderAccount(account: { providerName: string; accountLabel: string; commercialStatus: string; healthScore?: number; enabled?: boolean; regionCode?: string }): Promise<{ id: string }>;
  setCommercialApproval(input: { providerName: string; accountLabel: string; approve: boolean; actor: string }): Promise<void>;
  disableProviderAccount(input: { providerName: string; accountLabel: string; reason: string }): Promise<void>;
  rotateProviderAccountCredential(input: { providerName: string; accountLabel: string; newCredentialRefId: string; actor: string }): Promise<unknown>;
  configureComputeClass(cls: { code: string; displayName: string; minVcpu: number; minRamGb: number; skuMap: unknown[]; active: boolean }): Promise<void>;
  listServerOrders(): Promise<Array<{ id: string; orgId: string; state: string; hostname: string; providerName?: string }>>;
  providerHealthReports(): Promise<Array<{ name: string; report: unknown }>>;
}

export interface AgentsAuthority {
  listAgentSummaries(): Promise<Array<{ agentId: string; slug: string; status: string; revisions: number }>>;
}

export interface OperationsAuthority {
  listIncidents(): Promise<Array<{ incidentId: string; kind: string; status: string; title: string }>>;
  listOpenAbuseCases(): Promise<Array<{ caseId: string; orgId: string; category: string; severity: string; status: string }>>;
  backupSummaries(): Promise<Array<{ backupId: string; orgId: string; state: string; location: string }>>;
}

export class AdminService {
  readonly store: AdminStore;
  private readonly entitlements: EntitlementService;
  private readonly flags: FeatureFlagService;
  private readonly costs: CostEngine;
  private readonly enterpriseSvc: EnterpriseContractService;
  private readonly billing?: BillingAuthority;
  private readonly compute?: ComputeAuthority;
  private readonly agents?: AgentsAuthority;
  private readonly operations?: OperationsAuthority;

  constructor(options: {
    entitlements: EntitlementService;
    flags: FeatureFlagService;
    costs: CostEngine;
    enterprise: EnterpriseContractService;
    billing?: BillingAuthority;
    compute?: ComputeAuthority;
    agents?: AgentsAuthority;
    operations?: OperationsAuthority;
    store?: AdminStore;
  }) {
    this.store = options.store ?? new InMemoryAdminStore();
    this.entitlements = options.entitlements;
    this.flags = options.flags;
    this.costs = options.costs;
    this.enterpriseSvc = options.enterprise;
    this.billing = options.billing;
    this.compute = options.compute;
    this.agents = options.agents;
    this.operations = options.operations;
  }

  private authorize(actor: AdminActor, capability: AdminCapability): void {
    const allowed = CAPABILITY_ROLES[capability];
    if (!allowed.includes(actor.role)) {
      throw new AdminAccessError(capability);
    }
  }

  private async audit(actor: AdminActor, capability: string, detail: string): Promise<void> {
    await this.store.appendAudit({
      id: `adm_${crypto.randomUUID()}`,
      actor: `${actor.role}:${actor.userId}`,
      capability,
      detail,
      at: nowIso(),
    });
  }

  // ---- Customers / organizations ---------------------------------------------

  async listOrganizations(actor: AdminActor): Promise<OrgAccountRecord[]> {
    this.authorize(actor, "customers.read");
    return this.store.listOrgAccounts();
  }

  async setAccountStatus(actor: AdminActor, input: { orgId: string; status: OrgAccountRecord["status"]; reason?: string }): Promise<void> {
    this.authorize(actor, "customers.write");
    const existing = (await this.store.getOrgAccount(input.orgId)) ?? {
      orgId: input.orgId,
      displayName: input.orgId,
      status: "active" as const,
      updatedAt: nowIso(),
    };
    await this.store.upsertOrgAccount({
      ...existing,
      status: input.status,
      suspendedReason: input.status === "active" ? undefined : input.reason,
      updatedAt: nowIso(),
    });
    await this.audit(actor, "customers.write", `org ${input.orgId} → ${input.status}`);
  }

  async addSupportNote(actor: AdminActor, input: { orgId: string; note: string }): Promise<void> {
    this.authorize(actor, "customers.read"); // any staff may take notes
    await this.store.addSupportNote({
      id: `note_${crypto.randomUUID()}`,
      orgId: input.orgId,
      authorUserId: actor.userId,
      note: input.note,
      at: nowIso(),
    });
    await this.audit(actor, "customers.read", `support note on ${input.orgId}`);
  }

  async getSupportNotes(actor: AdminActor, orgId: string) {
    this.authorize(actor, "customers.read");
    return this.store.listSupportNotes(orgId);
  }

  // ---- Billing -----------------------------------------------------------------

  async listSubscriptions(actor: AdminActor): Promise<BillingSummaryRow[]> {
    this.authorize(actor, "customers.read");
    if (!this.billing) throw new AdminAccessError("billing authority not configured");
    return this.billing.listSubscriptionSummaries();
  }

  async suspendSubscription(actor: AdminActor, input: { subscriptionId: string; reason: string }): Promise<void> {
    this.authorize(actor, "billing.write");
    if (!this.billing) throw new AdminAccessError("billing authority not configured");
    await this.billing.adminSuspend(input.subscriptionId, actor.userId, input.reason);
    await this.audit(actor, "billing.write", `suspend ${input.subscriptionId}: ${input.reason}`);
  }

  async reactivateSubscription(actor: AdminActor, subscriptionId: string): Promise<void> {
    this.authorize(actor, "billing.write");
    if (!this.billing) throw new AdminAccessError("billing authority not configured");
    await this.billing.adminReactivate(subscriptionId, actor.userId);
    await this.audit(actor, "billing.write", `reactivate ${subscriptionId}`);
  }

  /** Create + activate a new plan version and set a regional price — no deploy. */
  async publishPlanChange(actor: AdminActor, input: {
    productId: string;
    version: number;
    entitlementValues: Partial<Record<EntitlementKey, boolean | number | string>>;
    priceBookId?: string;
    newPriceMinor?: bigint | number;
    currency?: string;
  }): Promise<{ planVersionId: string }> {
    this.authorize(actor, "billing.write");
    if (!this.billing) throw new AdminAccessError("billing authority not configured");
    const version = await this.billing.createPlanVersion(input.productId, input.version);
    if (Object.keys(input.entitlementValues).length > 0) {
      await this.billing.setPlanEntitlementValues(version.id, input.entitlementValues);
    }
    await this.billing.activatePlanVersion(version.id);
    if (input.priceBookId && input.newPriceMinor !== undefined) {
      await this.billing.addFixedPriceVersion(input.priceBookId, input.newPriceMinor, input.currency ?? "USD");
    }
    await this.audit(
      actor,
      "billing.write",
      `plan ${input.productId} v${input.version} activated${input.priceBookId ? ` with new price on book ${input.priceBookId}` : ""}`,
    );
    return { planVersionId: version.id };
  }

  async grantEntitlementOverride(actor: AdminActor, input: { orgId: string; key: EntitlementKey; value: boolean | number | string; note?: string }): Promise<void> {
    this.authorize(actor, "billing.write");
    await this.entitlements.grantOverride({ orgId: input.orgId, key: input.key, value: input.value, grantedBy: actor.userId, note: input.note });
    await this.audit(actor, "billing.write", `override ${input.key}=${String(input.value)} for ${input.orgId}`);
  }

  async attachAddon(actor: AdminActor, input: { subscriptionId: string; addonCode: string; quantity: number }): Promise<void> {
    this.authorize(actor, "billing.write");
    if (!this.billing) throw new AdminAccessError("billing authority not configured");
    await this.billing.attachAddon(input.subscriptionId, input.addonCode, input.quantity);
    await this.audit(actor, "billing.write", `addon ${input.addonCode} x${input.quantity} on ${input.subscriptionId}`);
  }

  // ---- Compute -----------------------------------------------------------------

  async setProviderCommercialApproval(actor: AdminActor, input: { providerName: string; accountLabel: string; approve: boolean }): Promise<void> {
    this.authorize(actor, "compute.write");
    if (!this.compute) throw new AdminAccessError("compute authority not configured");
    await this.compute.setCommercialApproval({ ...input, actor: actor.userId });
    await this.audit(actor, "compute.write", `${input.providerName}/${input.accountLabel} approval=${String(input.approve)}`);
  }

  async rotateProviderCredential(actor: AdminActor, input: { providerName: string; accountLabel: string; newCredentialRefId: string }): Promise<void> {
    this.authorize(actor, "compute.write");
    if (!this.compute) throw new AdminAccessError("compute authority not configured");
    await this.compute.rotateProviderAccountCredential({ ...input, actor: actor.userId });
    await this.audit(actor, "compute.write", `credential rotated for ${input.providerName}/${input.accountLabel}`);
  }

  async upsertComputeClass(actor: AdminActor, cls: Parameters<ComputeAuthority["configureComputeClass"]>[0]): Promise<void> {
    this.authorize(actor, "compute.write");
    if (!this.compute) throw new AdminAccessError("compute authority not configured");
    await this.compute.configureComputeClass(cls);
    await this.audit(actor, "compute.write", `compute class ${cls.code}`);
  }

  async serverInventory(actor: AdminActor) {
    this.authorize(actor, "operations.read");
    if (!this.compute) throw new AdminAccessError("compute authority not configured");
    return this.compute.listServerOrders();
  }

  // ---- Costs -----------------------------------------------------------------

  async marginReport(actor: AdminActor, request: MarginReportRequest) {
    this.authorize(actor, "costs.read");
    return this.costs.margin(request);
  }

  // ---- Feature flags -----------------------------------------------------------

  async setFlag(actor: AdminActor, input: { flag: string; scope: FlagScope; scopeKey?: string; enabled: boolean; rolloutPct?: number }): Promise<void> {
    this.authorize(actor, "flags.write");
    await this.flags.setFlag({ ...input, actor: actor.userId });
    await this.audit(actor, "flags.write", `${input.flag}@${input.scope}:${input.scopeKey ?? ""}=${String(input.enabled)}`);
  }

  async evaluateFlag(actor: AdminActor, flag: string, context: FlagContext): Promise<boolean> {
    this.authorize(actor, "operations.read");
    return this.flags.isEnabled(flag, context);
  }

  // ---- Enterprise ---------------------------------------------------------------

  async applyEnterpriseContract(actor: AdminActor, config: EnterpriseContractConfig): Promise<void> {
    this.authorize(actor, "enterprise.write");
    await this.enterpriseSvc.apply({ config, actor: actor.userId });
    await this.audit(actor, "enterprise.write", `contract ${config.contractRef} for ${config.orgId}`);
  }

  async deactivateEnterpriseContract(actor: AdminActor, orgId: string): Promise<void> {
    this.authorize(actor, "enterprise.write");
    await this.enterpriseSvc.deactivate({ orgId, actor: actor.userId });
    await this.audit(actor, "enterprise.write", `contract deactivated for ${orgId}`);
  }

  async getEnterpriseContract(actor: AdminActor, orgId: string) {
    this.authorize(actor, "customers.read");
    return this.enterpriseSvc.get(orgId);
  }

  // ---- System settings ------------------------------------------------------------

  async setSystemSetting(actor: AdminActor, input: { key: string; value: string }): Promise<void> {
    this.authorize(actor, "settings.write");
    await this.store.setSystemSetting({ key: input.key, value: input.value, updatedBy: actor.userId, updatedAt: nowIso() });
    await this.audit(actor, "settings.write", `${input.key}`);
  }

  async auditTrail(actor: AdminActor) {
    this.authorize(actor, "operations.read");
    return this.store.listAudit();
  }
}
