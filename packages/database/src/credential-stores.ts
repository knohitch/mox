import { and, eq } from "drizzle-orm";
import type { MoxDb } from "./client.js";
import { customerCredentialSecrets, systemCredentialSecrets } from "./schema/index.js";

export interface PgCustomerCredentialRef {
  orgId: string;
  externalId: string;
}

export interface PgSystemCredentialRef {
  externalId: string;
}

/**
 * PostgreSQL authority for customer-owned encrypted credential payloads.
 * Every operation is physically scoped by organization id: an external id
 * alone can never address another organization's secret.
 */
export class PgCustomerCredentialStore {
  constructor(private readonly db: MoxDb) {}

  async put(ref: PgCustomerCredentialRef, sealed: string): Promise<void> {
    await this.db
      .insert(customerCredentialSecrets)
      .values({
        orgId: ref.orgId,
        externalId: ref.externalId,
        sealed,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [customerCredentialSecrets.orgId, customerCredentialSecrets.externalId],
        set: { sealed, updatedAt: new Date() },
      });
  }

  async get(ref: PgCustomerCredentialRef): Promise<string | null> {
    const [row] = await this.db
      .select({ sealed: customerCredentialSecrets.sealed })
      .from(customerCredentialSecrets)
      .where(
        and(
          eq(customerCredentialSecrets.orgId, ref.orgId),
          eq(customerCredentialSecrets.externalId, ref.externalId),
        ),
      )
      .limit(1);
    return row?.sealed ?? null;
  }
}

/**
 * PostgreSQL authority for Mox-owned encrypted secrets. It has no organization
 * address surface and cannot read customer rows.
 */
export class PgSystemCredentialStore {
  constructor(private readonly db: MoxDb) {}

  async put(ref: PgSystemCredentialRef, sealed: string): Promise<void> {
    await this.db
      .insert(systemCredentialSecrets)
      .values({ externalId: ref.externalId, sealed, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: systemCredentialSecrets.externalId,
        set: { sealed, updatedAt: new Date() },
      });
  }

  async get(ref: PgSystemCredentialRef): Promise<string | null> {
    const [row] = await this.db
      .select({ sealed: systemCredentialSecrets.sealed })
      .from(systemCredentialSecrets)
      .where(eq(systemCredentialSecrets.externalId, ref.externalId))
      .limit(1);
    return row?.sealed ?? null;
  }
}