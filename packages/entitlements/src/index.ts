/**
 * Mox entitlements: the single authority for workspace access limits.
 *
 * Rules (Prompt 08):
 * - Entitlement keys are data, never hard-coded plan capabilities.
 * - Values resolve with explicit precedence:
 *     enterprise custom contract > org override > plan version value > default.
 * - Business limits are admin-editable; code only interprets keys.
 */

export const ENTITLEMENT_KEYS = [
  "included_compute_class",
  "included_server_count",
  "max_agents",
  "active_concurrent_agents",
  "agent_rooms",
  "agents_per_room",
  "browser_sessions",
  "cli_sessions",
  "developer_mode",
  "model_connections",
  "mox_ai_credits",
  "channel_connections",
  "integrations",
  "storage_gb",
  "backup_retention_days",
  "team_members",
  "voice_minutes",
  "schedule_workflow_limit",
] as const;

export type EntitlementKey = (typeof ENTITLEMENT_KEYS)[number];

export type EntitlementValueType = "boolean" | "integer" | "text";

export interface EntitlementDefinition {
  key: EntitlementKey;
  valueType: EntitlementValueType;
  description: string;
  /** Fallback when a plan version does not define the key. */
  defaultValue: boolean | number | string;
}

export interface EntitlementValues {
  readonly [key: string]: boolean | number | string;
}

/** A resolved entitlement decision with provenance for auditability. */
export interface ResolvedEntitlement {
  key: EntitlementKey;
  value: boolean | number | string;
  source: "custom_contract" | "org_override" | "plan" | "default";
}

export interface OrgOverride {
  orgId: string;
  key: EntitlementKey;
  value: boolean | number | string;
  grantedBy: string;
  note?: string;
  createdAt: string;
  expiresAt?: string;
}

/** Enterprise custom contract: whole-key overrides negotiated per org. */
export interface CustomContract {
  orgId: string;
  contractId: string;
  values: EntitlementValues;
  active: boolean;
  effectiveFrom: string;
  effectiveUntil?: string;
}

export interface EntitlementStore {
  getDefinition(key: EntitlementKey): Promise<EntitlementDefinition | undefined>;
  listDefinitions(): Promise<EntitlementDefinition[]>;
  upsertDefinition(def: EntitlementDefinition): Promise<void>;
  getPlanValues(planVersionId: string): Promise<EntitlementValues>;
  setPlanValues(planVersionId: string, values: EntitlementValues): Promise<void>;
  listOverrides(orgId: string): Promise<OrgOverride[]>;
  addOverride(override: OrgOverride): Promise<void>;
  removeOverride(orgId: string, key: EntitlementKey): Promise<void>;
  getActiveContract(orgId: string, now: string): Promise<CustomContract | undefined>;
  upsertContract(contract: CustomContract): Promise<void>;
}

export class InMemoryEntitlementStore implements EntitlementStore {
  private readonly defs = new Map<string, EntitlementDefinition>();
  private readonly planValues = new Map<string, EntitlementValues>();
  private readonly overrides = new Map<string, Map<string, OrgOverride>>();
  private readonly contracts = new Map<string, CustomContract>();

  async getDefinition(key: EntitlementKey): Promise<EntitlementDefinition | undefined> {
    return this.defs.get(key);
  }

  async listDefinitions(): Promise<EntitlementDefinition[]> {
    return [...this.defs.values()];
  }

  async upsertDefinition(def: EntitlementDefinition): Promise<void> {
    this.defs.set(def.key, def);
  }

  async getPlanValues(planVersionId: string): Promise<EntitlementValues> {
    return this.planValues.get(planVersionId) ?? {};
  }

  async setPlanValues(planVersionId: string, values: EntitlementValues): Promise<void> {
    this.planValues.set(planVersionId, { ...values });
  }

  async listOverrides(orgId: string): Promise<OrgOverride[]> {
    return [...(this.overrides.get(orgId)?.values() ?? [])];
  }

  async addOverride(override: OrgOverride): Promise<void> {
    let map = this.overrides.get(override.orgId);
    if (!map) {
      map = new Map();
      this.overrides.set(override.orgId, map);
    }
    map.set(override.key, override);
  }

  async removeOverride(orgId: string, key: EntitlementKey): Promise<void> {
    this.overrides.get(orgId)?.delete(key);
  }

  async getActiveContract(orgId: string, now: string): Promise<CustomContract | undefined> {
    const contract = this.contracts.get(orgId);
    if (!contract || !contract.active) return undefined;
    if (contract.effectiveFrom > now) return undefined;
    if (contract.effectiveUntil && contract.effectiveUntil <= now) return undefined;
    return contract;
  }

  async upsertContract(contract: CustomContract): Promise<void> {
    this.contracts.set(contract.orgId, contract);
  }
}

function isExpiredOverride(override: OrgOverride, now: string): boolean {
  return override.expiresAt !== undefined && override.expiresAt <= now;
}

/**
 * Resolve one entitlement key through precedence layers.
 * Precedence (highest wins):
 *   custom_contract > org_override > plan > definition default.
 */
export function resolveKey(
  definition: EntitlementDefinition,
  planValues: EntitlementValues,
  contract: CustomContract | undefined,
  overrides: OrgOverride[],
  now: string,
): ResolvedEntitlement {
  const contractValue: boolean | number | string | undefined = contract
    ? contract.values[definition.key]
    : undefined;
  if (contractValue !== undefined) {
    return { key: definition.key, value: contractValue, source: "custom_contract" };
  }
  const live = overrides.filter((o) => !isExpiredOverride(o, now));
  const matching = live.find((o) => o.key === definition.key);
  if (matching) {
    return { key: definition.key, value: matching.value, source: "org_override" };
  }
  const planValue: boolean | number | string | undefined = planValues[definition.key];
  if (planValue !== undefined) {
    return { key: definition.key, value: planValue, source: "plan" };
  }
  return { key: definition.key, value: definition.defaultValue, source: "default" };
}

export class EntitlementService {
  constructor(private readonly store: EntitlementStore) {}

  async define(def: EntitlementDefinition): Promise<void> {
    await this.store.upsertDefinition(def);
  }

  async setPlanValues(planVersionId: string, values: EntitlementValues): Promise<void> {
    await this.store.setPlanValues(planVersionId, values);
  }

  async grantOverride(input: Omit<OrgOverride, "createdAt"> & { createdAt?: string }): Promise<OrgOverride> {
    const override: OrgOverride = { ...input, createdAt: input.createdAt ?? new Date().toISOString() };
    await this.store.addOverride(override);
    return override;
  }

  async revokeOverride(orgId: string, key: EntitlementKey): Promise<void> {
    await this.store.removeOverride(orgId, key);
  }

  async applyContract(contract: CustomContract): Promise<void> {
    await this.store.upsertContract(contract);
  }

  async resolve(orgId: string, key: EntitlementKey, planVersionId: string, now?: string): Promise<ResolvedEntitlement> {
    const at = now ?? new Date().toISOString();
    const definition =
      (await this.store.getDefinition(key)) ??
      ({ key, valueType: inferType(key), description: "", defaultValue: defaultFor(inferType(key)) } as EntitlementDefinition);
    const [planValues, contract, overrides] = await Promise.all([
      this.store.getPlanValues(planVersionId),
      this.store.getActiveContract(orgId, at),
      this.store.listOverrides(orgId),
    ]);
    return resolveKey(definition, planValues, contract, overrides, at);
  }

  /** Boolean convenience gate used by feature code. Never checks plan names. */
  async isEnabled(orgId: string, key: EntitlementKey, planVersionId: string, now?: string): Promise<boolean> {
    const resolved = await this.resolve(orgId, key, planVersionId, now);
    return resolved.value === true || resolved.value === "true";
  }

  /** Numeric limit convenience; -1 means unlimited by convention. */
  async limitOf(orgId: string, key: EntitlementKey, planVersionId: string, now?: string): Promise<number> {
    const resolved = await this.resolve(orgId, key, planVersionId, now);
    return typeof resolved.value === "number" ? resolved.value : Number(resolved.value);
  }
}

function inferType(key: string): EntitlementValueType {
  switch (key) {
    case "included_compute_class":
      return "text";
    case "developer_mode":
      return "boolean";
    default:
      return "integer";
  }
}

function defaultFor(type: EntitlementValueType): boolean | number | string {
  switch (type) {
    case "boolean":
      return false;
    case "text":
      return "";
    default:
      return 0;
  }
}
