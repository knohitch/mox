/**
 * Server-side session authentication (Prompt 00 §A): sessions are durable
 * rows in `auth_sessions`; tokens are 256-bit random values stored only as
 * sha256 hashes and compared in constant time. Identity (user/org/role)
 * always comes from the database — never hard-coded.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { MoxDb } from "@mox/database";
import { authSessions, memberships, organizations, users } from "@mox/database";
import type { SessionIdentity } from "@mox/control-plane-contracts";

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status = 401,
  ) {
    super(message);
  }
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export interface IssuedSession {
  sessionToken: string;
  expiresAt: Date;
}

/**
 * Exchanges the deployment bootstrap credential for a durable session bound
 * to the platform owner. Real per-user login flows extend this seam later
 * without changing the client contract.
 */
export async function createSessionFromBootstrap(input: {
  db: MoxDb;
  bootstrapApiToken: string;
  presentedToken: string;
  ttlMs: number;
}): Promise<IssuedSession> {
  if (!input.presentedToken || !constantTimeEquals(input.bootstrapApiToken, input.presentedToken)) {
    throw new AuthError("invalid credentials", 401);
  }
  // The bootstrap principal is the first platform owner; identity schema
  // provisioning guarantees exactly one exists before the API accepts traffic.
  const [owner] = await input.db.select().from(users).limit(1);
  if (!owner) {
    throw new AuthError("no platform owner exists; provision the identity schema first", 503);
  }
  const expiresAt = new Date(Date.now() + input.ttlMs);
  const sessionToken = randomBytes(32).toString("base64url");
  await input.db.insert(authSessions).values({
    userId: owner.id,
    tokenHash: hashToken(sessionToken),
    expiresAt,
  });
  return { sessionToken, expiresAt };
}

/** Authenticates a bearer token and loads authoritative user/org identity. */
export async function authenticate(
  db: MoxDb,
  authorizationHeader: string | undefined,
): Promise<{ userId: string; sessionId: string; identity: SessionIdentity }> {
  const token = authorizationHeader?.startsWith("Bearer ")
    ? authorizationHeader.slice("Bearer ".length).trim()
    : "";
  if (!token) throw new AuthError("missing bearer token");

  const sessionRows = await db
    .select()
    .from(authSessions)
    .where(
      and(
        eq(authSessions.tokenHash, hashToken(token)),
        isNull(authSessions.revokedAt),
        gt(authSessions.expiresAt, new Date()),
      ),
    )
    .limit(1);
  const session = sessionRows[0];
  if (!session) throw new AuthError("session invalid or expired");

  const userRows = await db.select().from(users).where(eq(users.id, session.userId)).limit(1);
  const user = userRows[0];
  if (!user || user.disabledAt) throw new AuthError("session user no longer active");

  const membershipRows = await db
    .select({ orgId: memberships.orgId, role: memberships.role })
    .from(memberships)
    .where(eq(memberships.userId, user.id))
    .limit(1);
  const membership = membershipRows[0];
  if (!membership) throw new AuthError("user has no organization membership", 403);

  const orgRows = await db.select().from(organizations).where(eq(organizations.id, membership.orgId)).limit(1);
  const org = orgRows[0];
  if (!org) throw new AuthError("membership references a missing organization", 503);

  return {
    userId: user.id,
    sessionId: session.id,
    identity: {
      userId: user.id,
      email: user.email,
      displayName: user.displayName ?? user.email,
      orgId: org.id,
      orgSlug: org.slug,
      orgDisplayName: org.displayName,
      role: membership.role,
    },
  };
}
