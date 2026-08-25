/**
 * Security Repair 05B §I: cluster-wide SSE admission over PostgreSQL
 * (bounded lease/counter design — no Redis dependency).
 *
 * Per-user, per-IP and global caps are enforced across ALL replicas:
 *   - admit() locks one counter row per (scope, key), counts active
 *     streams, and writes one expiring lease row per scope;
 *   - release() deletes the leases and decrements the counters;
 *   - heartbeat() extends the leases (the SSE ping loop calls it);
 *   - sweep() (lifecycle ticker) expires dead leases and decrements —
 *     a crashed process leaves only expiring lease state, never a
 *     permanent capacity leak.
 */

import { randomUUID } from "node:crypto";
import { and, eq, lte, sql } from "drizzle-orm";
import type { MoxDb } from "@mox/database";
import { sseAdmissionState, sseConnections } from "@mox/database";

export class SseAdmissionDeniedError extends Error {
  constructor(scope: string) {
    super(`sse admission denied: ${scope} cap reached`);
    this.name = "SseAdmissionDeniedError";
  }
}

export interface SseLimits {
  perUser: number;
  perIp: number;
  global: number;
  leaseTtlMs: number;
}

export const DEFAULT_SSE_LIMITS: SseLimits = {
  perUser: 5,
  perIp: 25,
  global: 1000,
  leaseTtlMs: 90_000,
};

export interface SseAdmissionHandle {
  connectionId: string;
  release(): Promise<void>;
  heartbeat(): Promise<void>;
}

export class ClusterSseAdmission {
  constructor(
    private readonly db: MoxDb,
    private readonly limits: SseLimits,
  ) {}

  async admit(userId: string, ip: string): Promise<SseAdmissionHandle> {
    const scopes: Array<{ scope: string; key: string; cap: number }> = [
      { scope: "user", key: userId, cap: this.limits.perUser },
      { scope: "ip", key: ip, cap: this.limits.perIp },
      { scope: "global", key: "global", cap: this.limits.global },
    ];
    const connectionId = randomUUID();
    const leaseExpiresAt = new Date(Date.now() + this.limits.leaseTtlMs);
    await this.db.transaction(async (tx) => {
      for (const entry of scopes) {
        await tx
          .insert(sseAdmissionState)
          .values({ scope: entry.scope, scopeKey: entry.key, active: 0 })
          .onConflictDoNothing();
        const locked = await tx.execute(sql`
          SELECT active FROM sse_admission_state
          WHERE scope = ${entry.scope} AND scope_key = ${entry.key}
          FOR UPDATE
        `);
        const active = Number(
          ((locked as { rows?: Array<{ active?: number | string }> }).rows ?? [])[0]?.active ?? 0,
        );
        if (active >= entry.cap) throw new SseAdmissionDeniedError(entry.scope);
        await tx
          .update(sseAdmissionState)
          .set({ active: active + 1, updatedAt: new Date() })
          .where(and(eq(sseAdmissionState.scope, entry.scope), eq(sseAdmissionState.scopeKey, entry.key)));
      }
      for (const entry of scopes) {
        await tx.insert(sseConnections).values({
          connectionId,
          scope: entry.scope,
          scopeKey: entry.key,
          owner: userId,
          leaseExpiresAt,
        });
      }
    });
    return {
      connectionId,
      release: () => this.release(connectionId),
      heartbeat: () => this.heartbeat(connectionId),
    };
  }

  async release(connectionId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const removed = await tx
        .delete(sseConnections)
        .where(eq(sseConnections.connectionId, connectionId))
        .returning({ scope: sseConnections.scope, scopeKey: sseConnections.scopeKey });
      for (const row of removed) {
        await tx
          .update(sseAdmissionState)
          .set({ active: sql`GREATEST(${sseAdmissionState.active} - 1, 0)`, updatedAt: new Date() })
          .where(and(eq(sseAdmissionState.scope, row.scope), eq(sseAdmissionState.scopeKey, row.scopeKey)));
      }
    });
  }

  async heartbeat(connectionId: string): Promise<void> {
    await this.db
      .update(sseConnections)
      .set({ leaseExpiresAt: new Date(Date.now() + this.limits.leaseTtlMs) })
      .where(eq(sseConnections.connectionId, connectionId));
  }

  /** Lifecycle sweep: expire dead leases and reclaim their capacity. */
  async sweep(nowIso: string): Promise<number> {
    let reclaimed = 0;
    await this.db.transaction(async (tx) => {
      const expired = await tx
        .delete(sseConnections)
        .where(lte(sseConnections.leaseExpiresAt, new Date(nowIso)))
        .returning({ scope: sseConnections.scope, scopeKey: sseConnections.scopeKey });
      for (const row of expired) {
        await tx
          .update(sseAdmissionState)
          .set({ active: sql`GREATEST(${sseAdmissionState.active} - 1, 0)`, updatedAt: new Date() })
          .where(and(eq(sseAdmissionState.scope, row.scope), eq(sseAdmissionState.scopeKey, row.scopeKey)));
        reclaimed += 1;
      }
    });
    return reclaimed;
  }
}
