/**
 * Scoped feature flags (Prompt 13).
 *
 * Flags gate rollouts and experiments at six scopes with explicit
 * precedence: user > organization > plan > provider > region > global.
 * Flags NEVER replace entitlements: entitlements decide what a customer has
 * paid for; flags decide whether a capability is switched on right now.
 * Every flag change is recorded in an audit log.
 */

export type FlagScope = "global" | "region" | "plan" | "organization" | "user" | "provider";

export interface FlagScopeKey {
  scope: FlagScope;
  /** Scope selector; empty string for global. */
  scopeKey: string;
}

export interface FlagRecord extends FlagScopeKey {
  flag: string;
  enabled: boolean;
  rolloutPct?: number;
  updatedBy: string;
  updatedAt: string;
}

export interface FlagChangeAudit {
  id: string;
  flag: string;
  scope: FlagScope;
  scopeKey: string;
  action: "set" | "removed";
  enabled?: boolean;
  actor: string;
  at: string;
}

export interface FlagContext {
  regionCode?: string;
  planTier?: string;
  orgId?: string;
  userId?: string;
  providerName?: string;
}

export interface FeatureFlagStore {
  set(record: FlagRecord): Promise<void>;
  remove(flag: string, scope: FlagScope, scopeKey: string): Promise<void>;
  all(flag?: string): Promise<FlagRecord[]>;
  appendAudit(entry: FlagChangeAudit): Promise<void>;
  listAudit(flag?: string): Promise<FlagChangeAudit[]>;
}

export class InMemoryFeatureFlagStore implements FeatureFlagStore {
  private readonly records = new Map<string, FlagRecord>();
  private readonly auditLog: FlagChangeAudit[] = [];

  private key(flag: string, scope: FlagScope, scopeKey: string): string {
    return `${flag}|${scope}|${scopeKey}`;
  }

  async set(record: FlagRecord): Promise<void> {
    this.records.set(this.key(record.flag, record.scope, record.scopeKey), record);
  }

  async remove(flag: string, scope: FlagScope, scopeKey: string): Promise<void> {
    this.records.delete(this.key(flag, scope, scopeKey));
  }

  async all(flag?: string): Promise<FlagRecord[]> {
    return [...this.records.values()].filter((r) => (flag ? r.flag === flag : true));
  }

  async appendAudit(entry: FlagChangeAudit): Promise<void> {
    this.auditLog.push(entry);
  }

  async listAudit(flag?: string): Promise<FlagChangeAudit[]> {
    return [...this.auditLog].filter((a) => (flag ? a.flag === flag : true));
  }
}

export class FeatureFlagService {
  readonly store: FeatureFlagStore;

  constructor(store: FeatureFlagStore = new InMemoryFeatureFlagStore()) {
    this.store = store;
  }

  async setFlag(input: { flag: string; scope: FlagScope; scopeKey?: string; enabled: boolean; rolloutPct?: number; actor: string }): Promise<FlagRecord> {
    if (input.rolloutPct !== undefined && (input.rolloutPct < 0 || input.rolloutPct > 100)) {
      throw new Error("rolloutPct must be within [0, 100]");
    }
    const record: FlagRecord = {
      flag: input.flag,
      scope: input.scope,
      scopeKey: input.scope === "global" ? "" : (input.scopeKey ?? ""),
      enabled: input.enabled,
      rolloutPct: input.rolloutPct,
      updatedBy: input.actor,
      updatedAt: new Date().toISOString(),
    };
    await this.store.set(record);
    await this.store.appendAudit({
      id: `audit_${crypto.randomUUID()}`,
      flag: input.flag,
      scope: input.scope,
      scopeKey: record.scopeKey,
      action: "set",
      enabled: input.enabled,
      actor: input.actor,
      at: record.updatedAt,
    });
    return record;
  }

  async removeFlag(input: { flag: string; scope: FlagScope; scopeKey?: string; actor: string }): Promise<void> {
    const scopeKey = input.scope === "global" ? "" : (input.scopeKey ?? "");
    await this.store.remove(input.flag, input.scope, scopeKey);
    await this.store.appendAudit({
      id: `audit_${crypto.randomUUID()}`,
      flag: input.flag,
      scope: input.scope,
      scopeKey,
      action: "removed",
      actor: input.actor,
      at: new Date().toISOString(),
    });
  }

  /**
   * Evaluate one flag for a context. Precedence from most to least specific:
   * user > organization > plan > provider > region > global.
   * Unset anywhere → false.
   */
  async isEnabled(flag: string, context: FlagContext = {}): Promise<boolean> {
    const records = await this.store.all(flag);
    const match = (
      scope: FlagScope,
      scopeKey: string | undefined,
    ): FlagRecord | undefined =>
      records.find((r) => r.scope === scope && r.scopeKey === (scopeKey ?? ""));

    const ordered: Array<FlagRecord | undefined> = [
      context.userId ? match("user", context.userId) : undefined,
      context.orgId ? match("organization", context.orgId) : undefined,
      context.planTier ? match("plan", context.planTier) : undefined,
      context.providerName ? match("provider", context.providerName) : undefined,
      context.regionCode ? match("region", context.regionCode) : undefined,
      match("global", ""),
    ];

    for (const record of ordered) {
      if (!record) continue;
      if (record.rolloutPct !== undefined) {
        // Deterministic bucketing on the most specific identity available.
        const identity =
          context.userId ?? context.orgId ?? `${record.scope}:${record.scopeKey}`;
        const bucket = hashBucket(`${flag}:${identity}`);
        return bucket < record.rolloutPct;
      }
      return record.enabled;
    }
    return false;
  }

  listAudit(flag?: string): Promise<FlagChangeAudit[]> {
    return this.store.listAudit(flag);
  }
}

function hashBucket(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % 100;
}
