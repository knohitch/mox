import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { and, eq, sql } from "drizzle-orm";
import type { MoxDb } from "@mox/database";
import { authRateLimits, securityEvents } from "@mox/database";

export interface RateLimitPolicy {
  scope: string;
  bucketKey: string;
  limit: number;
  windowMs: number;
  lockMs: number;
  requestIp?: string;
  userAgent?: string | string[];
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds?: number;
}

export function bucketHash(value: string): string {
  return createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
}

export function clientIp(req: IncomingMessage, trustedProxyIps: string[] = []): string {
  const remote = req.socket.remoteAddress ?? "";
  if (!trustedProxyIps.includes(remote)) return remote;
  const forwarded = req.headers["x-forwarded-for"];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
  return first || remote;
}

export class DurableRateLimiter {
  constructor(private readonly db: MoxDb) {}

  async check(input: RateLimitPolicy): Promise<RateLimitResult> {
    const now = new Date();
    const windowStart = new Date(now.getTime() - input.windowMs);
    return this.db.transaction(async (tx) => {
      await tx
        .insert(authRateLimits)
        .values({
          scope: input.scope,
          bucketKey: input.bucketKey,
          windowStart: now,
          count: 0,
        })
        .onConflictDoNothing({ target: [authRateLimits.scope, authRateLimits.bucketKey] });

      const locked = await tx.execute(sql`
        SELECT id, window_start, count, locked_until
        FROM auth_rate_limits
        WHERE scope = ${input.scope} AND bucket_key = ${input.bucketKey}
        FOR UPDATE
      `);
      const row = ((locked as { rows?: Record<string, unknown>[] }).rows ?? [])[0];
      if (!row) return { allowed: true };

      const lockedUntil = row.locked_until ? new Date(String(row.locked_until)) : undefined;
      if (lockedUntil && lockedUntil > now) {
        await recordBlock(tx, input);
        return { allowed: false, retryAfterSeconds: Math.ceil((lockedUntil.getTime() - now.getTime()) / 1000) };
      }

      const currentWindow = new Date(String(row.window_start));
      const resetWindow = currentWindow <= windowStart;
      const nextCount = resetWindow ? 1 : Number(row.count ?? 0) + 1;
      const nextLock = nextCount > input.limit ? new Date(now.getTime() + input.lockMs) : null;
      await tx
        .update(authRateLimits)
        .set({
          windowStart: resetWindow ? now : currentWindow,
          count: nextCount,
          lockedUntil: nextLock,
          updatedAt: now,
        })
        .where(and(eq(authRateLimits.scope, input.scope), eq(authRateLimits.bucketKey, input.bucketKey)));

      if (nextLock) {
        await recordBlock(tx, input);
        return { allowed: false, retryAfterSeconds: Math.ceil(input.lockMs / 1000) };
      }
      return { allowed: true };
    });
  }
}

async function recordBlock(
  tx: Parameters<Parameters<MoxDb["transaction"]>[0]>[0],
  input: RateLimitPolicy,
): Promise<void> {
  await tx.insert(securityEvents).values({
    kind: "rate_limit_block",
    scope: input.scope,
    bucketKey: input.bucketKey,
    requestIp: input.requestIp ?? null,
    userAgent: Array.isArray(input.userAgent) ? input.userAgent.join(",") : input.userAgent ?? null,
    detail: { limit: input.limit, windowMs: input.windowMs, lockMs: input.lockMs },
  });
}
