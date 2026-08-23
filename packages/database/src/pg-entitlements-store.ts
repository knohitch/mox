import { and, eq } from "drizzle-orm";
import type {
  CustomContract,
  EntitlementDefinition,
  EntitlementKey,
  EntitlementStore,
  EntitlementValues,
  OrgOverride,
} from "@mox/entitlements";
import type { MoxDb } from "./client.js";
import { customContracts, entitlementDefinitions, entitlementOverrides, planEntitlementValues } from "./schema/index.js";

/**
 * PostgreSQL entitlement store (Prompt 00 §D4): definitions, plan-version
 * values, org overrides and enterprise contracts are durable rows — never
 * authoritative process memory.
 */

function iso(value: Date | null | undefined): string | undefined {
  return value ? value.toISOString() : undefined;
}

export class PgEntitlementStore implements EntitlementStore {
  constructor(private readonly db: MoxDb) {}

  async getDefinition(key: EntitlementKey): Promise<EntitlementDefinition | undefined> {
    const rows = await this.db
      .select()
      .from(entitlementDefinitions)
      .where(eq(entitlementDefinitions.key, key))
      .limit(1);
    const row = rows[0];
    return row
      ? {
          key: row.key as EntitlementKey,
          valueType: row.valueType as EntitlementDefinition["valueType"],
          description: row.description,
          defaultValue: row.defaultValue as boolean | number | string,
        }
      : undefined;
  }

  async listDefinitions(): Promise<EntitlementDefinition[]> {
    const rows = await this.db.select().from(entitlementDefinitions);
    return rows.map((row) => ({
      key: row.key as EntitlementKey,
      valueType: row.valueType as EntitlementDefinition["valueType"],
      description: row.description,
      defaultValue: row.defaultValue as boolean | number | string,
    }));
  }

  async upsertDefinition(def: EntitlementDefinition): Promise<void> {
    const values = {
      key: def.key,
      valueType: def.valueType,
      description: def.description,
      defaultValue: def.defaultValue as unknown as object,
      updatedAt: new Date(),
    };
    await this.db
      .insert(entitlementDefinitions)
      .values(values)
      .onConflictDoUpdate({ target: entitlementDefinitions.key, set: values });
  }

  async getPlanValues(planVersionId: string): Promise<EntitlementValues> {
    const rows = await this.db
      .select()
      .from(planEntitlementValues)
      .where(eq(planEntitlementValues.planVersionId, planVersionId));
    const out: Record<string, boolean | number | string> = {};
    for (const row of rows) out[row.key] = row.value as boolean | number | string;
    return out;
  }

  async setPlanValues(planVersionId: string, values: EntitlementValues): Promise<void> {
    await this.db.delete(planEntitlementValues).where(eq(planEntitlementValues.planVersionId, planVersionId));
    const entries = Object.entries(values);
    if (entries.length === 0) return;
    await this.db.insert(planEntitlementValues).values(
      entries.map(([key, value]) => ({
        planVersionId,
        key,
        value: value as unknown as object,
      })),
    );
  }

  async listOverrides(orgId: string): Promise<OrgOverride[]> {
    const rows = await this.db
      .select()
      .from(entitlementOverrides)
      .where(eq(entitlementOverrides.orgId, orgId));
    return rows.map((row) => ({
      orgId: row.orgId,
      key: row.key as EntitlementKey,
      value: row.value as boolean | number | string,
      grantedBy: row.grantedBy,
      note: row.note ?? undefined,
      createdAt: row.createdAt.toISOString(),
      expiresAt: iso(row.expiresAt),
    }));
  }

  async addOverride(override: OrgOverride): Promise<void> {
    await this.db
      .insert(entitlementOverrides)
      .values({
        orgId: override.orgId,
        key: override.key,
        value: override.value as unknown as object,
        grantedBy: override.grantedBy,
        note: override.note ?? null,
        createdAt: new Date(override.createdAt),
        expiresAt: override.expiresAt ? new Date(override.expiresAt) : null,
      })
      .onConflictDoUpdate({
        target: [entitlementOverrides.orgId, entitlementOverrides.key],
        set: {
          value: override.value as unknown as object,
          grantedBy: override.grantedBy,
          note: override.note ?? null,
          expiresAt: override.expiresAt ? new Date(override.expiresAt) : null,
        },
      });
  }

  async removeOverride(orgId: string, key: EntitlementKey): Promise<void> {
    await this.db
      .delete(entitlementOverrides)
      .where(and(eq(entitlementOverrides.orgId, orgId), eq(entitlementOverrides.key, key)));
  }

  async getActiveContract(orgId: string, now: string): Promise<CustomContract | undefined> {
    const rows = await this.db
      .select()
      .from(customContracts)
      .where(and(eq(customContracts.orgId, orgId), eq(customContracts.active, true)));
    const at = new Date(now);
    for (const row of rows) {
      if (row.effectiveFrom > at) continue;
      if (row.effectiveUntil && row.effectiveUntil <= at) continue;
      return {
        orgId: row.orgId,
        contractId: row.contractRef,
        values: (row.values ?? {}) as EntitlementValues,
        active: row.active,
        effectiveFrom: row.effectiveFrom.toISOString(),
        effectiveUntil: iso(row.effectiveUntil),
      };
    }
    return undefined;
  }

  async upsertContract(contract: CustomContract): Promise<void> {
    const existing = await this.db
      .select()
      .from(customContracts)
      .where(eq(customContracts.contractRef, contract.contractId))
      .limit(1);
    const values = {
      orgId: contract.orgId,
      contractRef: contract.contractId,
      values: contract.values as unknown as object,
      active: contract.active,
      effectiveFrom: new Date(contract.effectiveFrom),
      effectiveUntil: contract.effectiveUntil ? new Date(contract.effectiveUntil) : null,
    };
    if (existing[0]) {
      await this.db.update(customContracts).set(values).where(eq(customContracts.id, existing[0].id));
    } else {
      await this.db.insert(customContracts).values(values);
    }
  }
}
