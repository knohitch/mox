/**
 * Server-authoritative account authentication (Prompt 00B §A/§B/§C).
 *
 * Design:
 * - Real per-user accounts: signup + password login (scrypt verifiers in
 *   `auth_credentials`), logout, expiry and explicit revocation.
 * - Browser sessions ride an HttpOnly cookie (Secure in production,
 *   SameSite=Lax). The random session token NEVER touches localStorage;
 *   only its sha256 hash is stored server-side.
 * - One-time platform bootstrap: a server-side setup credential may create
 *   exactly the designated owner once; setup then closes permanently. It is
 *   never a reusable login path and never selects an "arbitrary first user".
 * - Multi-org: the active org lives ON the session row and changes only
 *   through a membership-verified switch endpoint. Client-supplied org ids
 *   are never trusted.
 */

import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { MoxDb } from "@mox/database";
import {
  authCredentials,
  authSessions,
  memberships,
  organizations,
  platformSetup,
  users,
} from "@mox/database";
import type { SessionIdentity } from "@mox/control-plane-contracts";
import { assertPasswordPolicy, hashPassword, verifyPassword } from "./password.js";

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status = 401,
  ) {
    super(message);
  }
}

export const SESSION_COOKIE = "mox_session";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEquals(bufA, bufB);
}

function timingSafeEquals(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

// ---- Cookie serialization ---------------------------------------------------

export interface CookieOptions {
  secure: boolean;
  maxAgeSeconds: number;
}

/** Serializes the session cookie: HttpOnly, SameSite=Lax, Secure in prod. */
export function serializeSessionCookie(token: string, options: CookieOptions): string {
  return (
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax` +
    `${options.secure ? "; Secure" : ""}; Max-Age=${options.maxAgeSeconds}`
  );
}

export function serializeClearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function tokenFromCookieHeader(cookieHeader: string | undefined): string {
  if (!cookieHeader) return "";
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return decodeURIComponent(rest.join("="));
  }
  return "";
}

// ---- Signup / login / logout --------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface IdentityResult {
  userId: string;
  sessionId: string;
  identity: SessionIdentity;
  orgs: Array<{ orgId: string; slug: string; displayName: string; role: string }>;
}

async function loadIdentity(db: MoxDb, userId: string, activeOrgId: string | null): Promise<{
  userId: string;
  email: string;
  displayName: string;
  orgId: string;
  orgSlug: string;
  orgDisplayName: string;
  role: string;
  orgs: IdentityResult["orgs"];
}> {
  const userRows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  const user = userRows[0];
  if (!user || user.disabledAt) throw new AuthError("account is not active", 403);

  const membershipRows = await db
    .select({
      orgId: memberships.orgId,
      role: memberships.role,
      slug: organizations.slug,
      displayName: organizations.displayName,
    })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.orgId))
    .where(eq(memberships.userId, userId));

  if (membershipRows.length === 0) throw new AuthError("user has no organization membership", 403);

  // Active org MUST be one of the user's memberships (§C).
  const active =
    membershipRows.find((m) => m.orgId === activeOrgId) ?? membershipRows[0]!;

  return {
    userId: user.id,
    email: user.email,
    displayName: user.displayName ?? user.email,
    orgId: active.orgId,
    orgSlug: active.slug,
    orgDisplayName: active.displayName,
    role: active.role,
    orgs: membershipRows.map((m) => ({
      orgId: m.orgId,
      slug: m.slug,
      displayName: m.displayName,
      role: m.role,
    })),
  };
}

/** Creates a durable session row and returns the plaintext token once. */
async function issueSession(
  db: MoxDb,
  userId: string,
  activeOrgId: string,
  meta: { ipAddress?: string; userAgent?: string },
): Promise<{ sessionToken: string; expiresAt: Date; sessionId: string }> {
  const expiresAt = new Date(Date.now() + DEFAULT_SESSION_TTL_MS);
  const sessionToken = randomBytes(32).toString("base64url");
  const inserted = await db
    .insert(authSessions)
    .values({
      userId,
      tokenHash: hashToken(sessionToken),
      activeOrgId,
      expiresAt,
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    })
    .returning({ id: authSessions.id });
  if (!inserted[0]) throw new AuthError("session persistence failed", 500);
  return { sessionToken, expiresAt, sessionId: inserted[0].id };
}

export const DEFAULT_SESSION_TTL_MS = 12 * 3600_000;

function toIdentityResult(
  loaded: Awaited<ReturnType<typeof loadIdentity>>,
  sessionId: string,
): IdentityResult {
  return {
    userId: loaded.userId,
    sessionId,
    identity: {
      userId: loaded.userId,
      email: loaded.email,
      displayName: loaded.displayName,
      orgId: loaded.orgId,
      orgSlug: loaded.orgSlug,
      orgDisplayName: loaded.orgDisplayName,
      role: loaded.role,
    },
    orgs: loaded.orgs,
  };
}

/**
 * One-time platform setup (Prompt 00B §A): creates the DESIGNATED owner
 * with a chosen email/password plus their organization, then permanently
 * closes setup. Requires the server-side setup credential; never runs
 * again after completion.
 */
export async function completePlatformSetup(input: {
  db: MoxDb;
  setupTokenHash: string | null | undefined;
  setupCompleted: boolean;
  presentedSetupToken: string;
  expectedSetupTokenHash: string | undefined;
  ownerEmail: string;
  ownerPassword: string;
  orgSlug: string;
  orgDisplayName?: string;
}): Promise<{ userId: string; orgId: string }> {
  if (input.setupCompleted) {
    throw new AuthError("platform setup is closed", 403);
  }
  if (!input.expectedSetupTokenHash) {
    throw new AuthError("server-side setup credential is not configured", 503);
  }
  if (!input.presentedSetupToken || !constantTimeEquals(input.expectedSetupTokenHash, hashToken(input.presentedSetupToken))) {
    throw new AuthError("invalid setup credential", 403);
  }
  if (!EMAIL_RE.test(input.ownerEmail)) throw new AuthError("ownerEmail is invalid", 400);
  assertPasswordPolicy(input.ownerPassword);
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(input.orgSlug)) throw new AuthError("orgSlug is invalid", 400);

  const existingOwnerRows = await input.db.select().from(users).limit(2);
  if (existingOwnerRows.length > 0) {
    throw new AuthError("platform already has accounts; setup is closed", 403);
  }

  const passwordHash = await hashPassword(input.ownerPassword);
  const result = await input.db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({ email: input.ownerEmail, displayName: input.ownerEmail.split("@")[0] })
      .returning();
    if (!user) throw new AuthError("owner creation failed", 500);
    const [org] = await tx
      .insert(organizations)
      .values({ slug: input.orgSlug, displayName: input.orgDisplayName ?? input.orgSlug })
      .returning();
    if (!org) throw new AuthError("organization creation failed", 500);
    await tx.insert(memberships).values({ orgId: org.id, userId: user.id, role: "owner" });
    await tx.insert(authCredentials).values({ userId: user.id, passwordHash });
    await tx
      .insert(platformSetup)
      .values({ id: 1, setupTokenHash: null, completedAt: new Date() })
      .onConflictDoUpdate({
        target: platformSetup.id,
        set: { setupTokenHash: null, completedAt: new Date() },
      });
    return { userId: user.id, orgId: org.id };
  });
  return result;
}

export async function signup(input: {
  db: MoxDb;
  email: string;
  password: string;
  displayName?: string;
  orgName?: string;
  meta?: { ipAddress?: string; userAgent?: string };
}): Promise<IdentityResult & { sessionToken: string; expiresAt: Date }> {
  if (!EMAIL_RE.test(input.email)) throw new AuthError("email is invalid", 400);
  assertPasswordPolicy(input.password);

  const emailTaken = await input.db.select({ id: users.id }).from(users).where(eq(users.email, input.email.toLowerCase())).limit(1);
  if (emailTaken[0]) throw new AuthError("email already registered", 409);

  const passwordHash = await hashPassword(input.password);
  const orgName = input.orgName?.trim() || input.email.split("@")[0]!;
  const slugBase = orgName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "workspace";

  const created = await input.db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({ email: input.email.toLowerCase(), displayName: input.displayName ?? input.email.split("@")[0] })
      .returning();
    if (!user) throw new AuthError("signup failed", 500);
    // Slug uniqueness without leaking existence via retries.
    let org: typeof organizations.$inferSelect | undefined;
    for (let attempt = 0; attempt < 5 && !org; attempt += 1) {
      const slug = attempt === 0 ? slugBase : `${slugBase}-${randomBytes(2).toString("hex")}`;
      const insertedOrg = await tx.insert(organizations).values({ slug, displayName: orgName }).returning();
      org = insertedOrg[0];
    }
    if (!org) throw new AuthError("could not allocate workspace slug", 500);
    await tx.insert(memberships).values({ orgId: org.id, userId: user.id, role: "owner" });
    await tx.insert(authCredentials).values({ userId: user.id, passwordHash });
    return { user, org };
  });

  const session = await issueSession(input.db, created.user.id, created.org.id, input.meta ?? {});
  const loaded = await loadIdentity(input.db, created.user.id, created.org.id);
  return {
    ...toIdentityResult(loaded, session.sessionId),
    sessionToken: session.sessionToken,
    expiresAt: session.expiresAt,
  };
}

export async function login(input: {
  db: MoxDb;
  email: string;
  password: string;
  meta?: { ipAddress?: string; userAgent?: string };
}): Promise<IdentityResult & { sessionToken: string; expiresAt: Date }> {
  if (!input.email) throw new AuthError("email and password are required", 400);
  const userRows = await input.db
    .select()
    .from(users)
    .where(eq(users.email, input.email.toLowerCase()))
    .limit(1);
  const user = userRows[0];
  // Constant-shape behavior: unknown emails cost roughly one KDF run too.
  const credentialRows = user
    ? await input.db.select().from(authCredentials).where(eq(authCredentials.userId, user.id)).limit(1)
    : [];
  const encoded = credentialRows[0]?.passwordHash;
  const ok = encoded ? await verifyPassword(input.password, encoded) : await verifyPassword(input.password, DUMMY_HASH);
  if (!user || !ok) throw new AuthError("invalid credentials", 401);

  const membershipRows = await input.db
    .select({ orgId: memberships.orgId })
    .from(memberships)
    .where(eq(memberships.userId, user.id))
    .limit(1);
  if (!membershipRows[0]) throw new AuthError("user has no organization membership", 403);

  const session = await issueSession(input.db, user.id, membershipRows[0].orgId, input.meta ?? {});
  const loaded = await loadIdentity(input.db, user.id, membershipRows[0].orgId);
  return {
    ...toIdentityResult(loaded, session.sessionId),
    sessionToken: session.sessionToken,
    expiresAt: session.expiresAt,
  };
}

/** Precomputed verifier of an unrecordable random password (timing equalizer). */
const DUMMY_HASH =
  "scrypt$32768$8$1$74696d696e672d657175616c697a6572$" +
  "YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYQ==";

export async function logout(db: MoxDb, sessionToken: string): Promise<void> {
  if (!sessionToken) return;
  await db
    .update(authSessions)
    .set({ revokedAt: new Date(), updatedAt: new Date() })
    .where(eq(authSessions.tokenHash, hashToken(sessionToken)));
}

export async function revokeAllSessions(db: MoxDb, userId: string): Promise<void> {
  await db
    .update(authSessions)
    .set({ revokedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(authSessions.userId, userId), isNull(authSessions.revokedAt)));
}

// ---- Request authentication -----------------------------------------------------

function bearerFrom(header: string | undefined): string {
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
}

/** Extracts the session token from the Authorization header or cookie. */
export function extractSessionToken(headers: {
  authorization?: string | undefined;
  cookie?: string | undefined;
}): string {
  return bearerFrom(headers.authorization) || tokenFromCookieHeader(headers.cookie);
}

/**
 * True when the request rides the browser cookie channel (and therefore
 * needs the custom-header CSRF defense for mutations).
 */
export function isCookieAuthenticated(headers: { authorization?: string | undefined; cookie?: string | undefined }): boolean {
  return !bearerFrom(headers.authorization) && tokenFromCookieHeader(headers.cookie) !== "";
}

/** Authenticates a request and loads authoritative user/org identity. */
export async function authenticate(db: MoxDb, headers: {
  authorization?: string | undefined;
  cookie?: string | undefined;
}): Promise<IdentityResult> {
  const token = extractSessionToken(headers);
  if (!token) throw new AuthError("authentication required");

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

  return toIdentityResult(await loadIdentity(db, session.userId, session.activeOrgId), session.id);
}

/** Membership-verified active-org switch (§C). */
export async function switchActiveOrg(
  db: MoxDb,
  sessionToken: string,
  targetOrgId: string,
): Promise<IdentityResult> {
  const current = await authenticate(db, { authorization: `Bearer ${sessionToken}` });
  if (!current.orgs.some((o) => o.orgId === targetOrgId)) {
    throw new AuthError("not a member of that organization", 403);
  }
  await db
    .update(authSessions)
    .set({ activeOrgId: targetOrgId, updatedAt: new Date() })
    .where(eq(authSessions.id, current.sessionId));
  // Reload so the response reflects the switched context.
  const sessionRows = await db
    .select()
    .from(authSessions)
    .where(eq(authSessions.tokenHash, hashToken(sessionToken)))
    .limit(1);
  const session = sessionRows[0];
  if (!session) throw new AuthError("session invalid or expired");
  return toIdentityResult(await loadIdentity(db, session.userId, session.activeOrgId), session.id);
}
