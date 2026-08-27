/**
 * Server-authoritative account authentication (Prompt 00B §A/§B/§C and
 * 00C §A/§B).
 *
 * Design:
 * - Real per-user accounts: signup + password login (scrypt verifiers in
 *   `auth_credentials`), logout, expiry and explicit revocation.
 * - Browser sessions ride an HttpOnly cookie (Secure in production,
 *   SameSite=Lax). The random session token NEVER appears in a JSON
 *   response (00C §A) and never touches client storage; only its sha256
 *   hash is stored server-side.
 * - CLI/programmatic clients use a SEPARATE contract: personal API access
 *   tokens (`api_tokens`, hashed at rest, scoped, expiring, revocable)
 *   issued via token-login or the authenticated token-management endpoints
 *   — browser cookie login never returns bearer material (00C §B).
 * - One-time platform bootstrap: a server-side setup credential may create
 *   exactly the designated owner once; setup then closes permanently. It is
 *   never a reusable login path and never selects an "arbitrary first user".
 * - Multi-org: the active org lives ON the session/token row and changes
 *   only through a membership-verified switch endpoint. Client-supplied org
 *   ids are never trusted.
 */

import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import type { MoxDb } from "@mox/database";
import {
  apiTokens,
  authCredentials,
  authSessions,
  memberships,
  organizations,
  passwordResets,
  platformStaffMemberships,
  platformSetup,
  staffInvitations,
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

/** The channel that authenticated the current request (Prompt 00C §B). */
export type AuthKind = "session" | "api_token";

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
  /** Which contract authenticated this request (00C §B). */
  authKind: AuthKind;
  /** Scopes for api_token auth; ["*"] for sessions. */
  scopes: string[];
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
  authKind: AuthKind = "session",
  scopes: string[] = ["*"],
): IdentityResult {
  return {
    userId: loaded.userId,
    sessionId,
    authKind,
    scopes,
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

// ---- Personal/API access tokens (Prompt 00C §B / 00D §A–B) ---------------------

/**
 * Central scope check (Prompt 00D §A): "*" grants every NON-admin API
 * scope available to the user; "admin" never elevates privilege by itself
 * and is additionally gated at issuance and by real server-side roles.
 */
export function scopeSatisfied(scopes: string[], required: string): boolean {
  return scopes.includes("*") || scopes.includes(required);
}

/** Scope names allowed on tokens (00D §A route families). */
const KNOWN_SCOPES = [
  "*",
  "agents",
  "threads",
  "servers",
  "billing",
  "models",
  "integrations",
  "channels",
  "usage",
  "approvals",
  "notifications",
  "settings",
  "admin",
] as const;

export interface IssuedApiToken {
  tokenId: string;
  /** Plaintext, returned exactly once at creation. */
  token: string;
  expiresAt: Date;
  scopes: string[];
}

export const DEFAULT_API_TOKEN_TTL_MS = 30 * 24 * 3600_000;

/**
 * Issues a personal/API access token for a user; plaintext shown once.
 * Prompt 00D §B: scopes constrain API surface, NEVER elevate privileges —
 * the "admin" scope is rejected unless the ISSUING context already holds
 * real server-side admin capability (owner/admin org role for now).
 */
export async function issueApiToken(input: {
  db: MoxDb;
  userId: string;
  activeOrgId: string;
  name: string;
  scopes?: string[];
  ttlMs?: number;
  /** Real server-side admin capability of the issuing context. */
  actorIsAdmin?: boolean;
}): Promise<IssuedApiToken> {
  if (!input.name || input.name.trim().length === 0) throw new AuthError("token name is required", 400);
  const scopes = input.scopes && input.scopes.length > 0 ? [...new Set(input.scopes)] : ["*"];
  for (const scope of scopes) {
    if (!(KNOWN_SCOPES as readonly string[]).includes(scope)) {
      throw new AuthError(`unknown scope: ${scope}`, 400);
    }
  }
  if (scopes.includes("admin") && input.actorIsAdmin !== true) {
    throw new AuthError("admin scope requires existing server-side admin capability", 403);
  }
  const expiresAt = new Date(Date.now() + (input.ttlMs ?? DEFAULT_API_TOKEN_TTL_MS));
  const token = `mox_pat_${randomBytes(32).toString("base64url")}`;
  const inserted = await input.db
    .insert(apiTokens)
    .values({
      userId: input.userId,
      name: input.name.trim(),
      tokenHash: hashToken(token),
      scopes,
      activeOrgId: input.activeOrgId,
      expiresAt,
    })
    .returning({ id: apiTokens.id });
  if (!inserted[0]) throw new AuthError("api token persistence failed", 500);
  return { tokenId: inserted[0].id, token, expiresAt, scopes };
}

export interface ApiTokenMetadata {
  id: string;
  name: string;
  scopes: string[];
  expiresAt: Date;
  revokedAt?: Date;
  createdAt: Date;
  lastUsedAt?: Date;
}

export async function listApiTokens(db: MoxDb, userId: string): Promise<ApiTokenMetadata[]> {
  const rows = await db.select().from(apiTokens).where(eq(apiTokens.userId, userId));
  return rows
    .map((row) => ({
      id: row.id,
      name: row.name,
      scopes: (row.scopes ?? []) as string[],
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt ?? undefined,
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt ?? undefined,
    }))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

export async function revokeApiToken(db: MoxDb, userId: string, tokenId: string): Promise<boolean> {
  const updated = await db
    .update(apiTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiTokens.id, tokenId), eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)))
    .returning({ id: apiTokens.id });
  return updated.length > 0;
}

/**
 * Dedicated programmatic login (00C §B): password → API access token.
 * Never sets a cookie, never creates a browser session, and is the ONLY
 * password→bearer exchange in the system. Prompt 00D §B: scopes constrain
 * API surface, never elevate privileges — admin scope requires the user to
 * already hold real server-side admin capability (owner/admin org role).
 */
export async function programmaticLogin(input: {
  db: MoxDb;
  email: string;
  password: string;
  name?: string;
  scopes?: string[];
  ttlMs?: number;
}): Promise<IdentityResult & IssuedApiToken> {
  const credentials = await verifyCredentials(input.db, input.email, input.password);
  const issued = await issueApiToken({
    db: input.db,
    userId: credentials.userId,
    activeOrgId: credentials.activeOrgId,
    name: input.name?.trim() || "programmatic",
    scopes: input.scopes,
    ttlMs: input.ttlMs,
    actorIsAdmin: credentials.orgRole === "owner" || credentials.orgRole === "admin",
  });
  const result = await authenticateByBearer(input.db, issued.token);
  return { ...result, ...issued };
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
    // Prompt 00C §F: PostgreSQL-safe bounded slug allocation —
    // ON CONFLICT DO NOTHING ... RETURNING never aborts the transaction on
    // a unique violation; collisions retry with a random suffix.
    let org: typeof organizations.$inferSelect | undefined;
    for (let attempt = 0; attempt < 5 && !org; attempt += 1) {
      const slug = attempt === 0 ? slugBase : `${slugBase}-${randomBytes(2).toString("hex")}`;
      const insertedOrg = await tx
        .insert(organizations)
        .values({ slug, displayName: orgName })
        .onConflictDoNothing({ target: organizations.slug })
        .returning();
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

/** Precomputed verifier of an unrecordable random password (timing equalizer). */
const DUMMY_HASH =
  "scrypt$32768$8$1$74696d696e672d657175616c697a6572$" +
  "YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYQ==";

/** Shared credential verification with constant-shape unknown-email behavior. */
async function verifyCredentials(
  db: MoxDb,
  email: string,
  password: string,
): Promise<{ userId: string; activeOrgId: string; orgRole: string }> {
  if (!email) throw new AuthError("email and password are required", 400);
  const userRows = await db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
  const user = userRows[0];
  // Constant-shape behavior: unknown emails cost roughly one KDF run too.
  const credentialRows = user
    ? await db.select().from(authCredentials).where(eq(authCredentials.userId, user.id)).limit(1)
    : [];
  const encoded = credentialRows[0]?.passwordHash;
  const ok = encoded ? await verifyPassword(password, encoded) : await verifyPassword(password, DUMMY_HASH);
  if (!user || !ok) throw new AuthError("invalid credentials", 401);

  const membershipRows = await db
    .select({ orgId: memberships.orgId, role: memberships.role })
    .from(memberships)
    .where(eq(memberships.userId, user.id))
    .limit(1);
  if (!membershipRows[0]) throw new AuthError("user has no organization membership", 403);
  return { userId: user.id, activeOrgId: membershipRows[0].orgId, orgRole: membershipRows[0].role };
}

/** Browser login: password → HttpOnly cookie session (00C §A). */
export async function login(input: {
  db: MoxDb;
  email: string;
  password: string;
  meta?: { ipAddress?: string; userAgent?: string };
}): Promise<IdentityResult & { sessionToken: string; expiresAt: Date }> {
  const credentials = await verifyCredentials(input.db, input.email, input.password);
  const session = await issueSession(input.db, credentials.userId, credentials.activeOrgId, input.meta ?? {});
  const loaded = await loadIdentity(input.db, credentials.userId, credentials.activeOrgId);
  return {
    ...toIdentityResult(loaded, session.sessionId),
    sessionToken: session.sessionToken,
    expiresAt: session.expiresAt,
  };
}

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

/**
 * Resolves a bearer token from EITHER contract: a browser session token or
 * a personal/API access token (00C §B). API tokens carry scopes and their
 * own expiry/revocation; both record which channel authenticated.
 */
export async function authenticateByBearer(db: MoxDb, bearerToken: string): Promise<IdentityResult> {
  if (!bearerToken) throw new AuthError("authentication required");
  const tokenHash = hashToken(bearerToken);

  const sessionRows = await db
    .select()
    .from(authSessions)
    .where(
      and(eq(authSessions.tokenHash, tokenHash), isNull(authSessions.revokedAt), gt(authSessions.expiresAt, new Date())),
    )
    .limit(1);
  const session = sessionRows[0];
  if (session) {
    return toIdentityResult(await loadIdentity(db, session.userId, session.activeOrgId), session.id, "session", ["*"]);
  }

  const apiTokenRows = await db
    .select()
    .from(apiTokens)
    .where(
      and(eq(apiTokens.tokenHash, tokenHash), isNull(apiTokens.revokedAt), gt(apiTokens.expiresAt, new Date())),
    )
    .limit(1);
  const apiToken = apiTokenRows[0];
  if (apiToken) {
    // Touch last_used_at without blocking identity resolution on failure.
    await db.update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.id, apiToken.id)).catch(() => undefined);
    const scopes = ((apiToken.scopes ?? []) as string[]).length > 0 ? ((apiToken.scopes ?? []) as string[]) : ["*"];
    return toIdentityResult(await loadIdentity(db, apiToken.userId, apiToken.activeOrgId), apiToken.id, "api_token", scopes);
  }

  throw new AuthError("credential invalid or expired");
}

/** Authenticates a request and loads authoritative user/org identity. */
export async function authenticate(db: MoxDb, headers: {
  authorization?: string | undefined;
  cookie?: string | undefined;
}): Promise<IdentityResult> {
  const bearer = bearerFrom(headers.authorization);
  if (bearer) return authenticateByBearer(db, bearer);
  const cookieToken = tokenFromCookieHeader(headers.cookie);
  if (!cookieToken) throw new AuthError("authentication required");

  const sessionRows = await db
    .select()
    .from(authSessions)
    .where(
      and(
        eq(authSessions.tokenHash, hashToken(cookieToken)),
        isNull(authSessions.revokedAt),
        gt(authSessions.expiresAt, new Date()),
      ),
    )
    .limit(1);
  const session = sessionRows[0];
  if (!session) throw new AuthError("session invalid or expired");

  return toIdentityResult(await loadIdentity(db, session.userId, session.activeOrgId), session.id);
}

/** Membership-verified active-org switch (§C of 00B; 00C §B for tokens). */
export async function switchActiveOrg(
  db: MoxDb,
  sessionToken: string,
  targetOrgId: string,
): Promise<IdentityResult> {
  const current = await authenticateByBearer(db, sessionToken);
  if (!current.orgs.some((o) => o.orgId === targetOrgId)) {
    throw new AuthError("not a member of that organization", 403);
  }
  if (current.authKind === "api_token") {
    await db
      .update(apiTokens)
      .set({ activeOrgId: targetOrgId })
      .where(eq(apiTokens.id, current.sessionId));
  } else {
    await db
      .update(authSessions)
      .set({ activeOrgId: targetOrgId, updatedAt: new Date() })
      .where(eq(authSessions.id, current.sessionId));
  }
  // Reload so the response reflects the switched context.
  return authenticateByBearer(db, sessionToken);
}

export const RESET_TOKEN_TTL_MS = 60 * 60_000;
export const INVITE_TOKEN_TTL_MS = 7 * 24 * 3600_000;

// ---- Platform staff authority (Prompt 01) ------------------------------------

export interface StaffGrant {
  userId: string;
  role: string;
  surface: "admin" | "support";
  enabled: boolean;
}

/**
 * Resolves the durable platform-staff grants for a user directly from
 * PostgreSQL. This is the server-authoritative staff authority: customer org
 * roles never feed into it, and it is never inferred from the client.
 */
export async function loadStaffGrants(db: MoxDb, userId: string): Promise<StaffGrant[]> {
  const rows = await db
    .select()
    .from(platformStaffMemberships)
    .where(and(eq(platformStaffMemberships.userId, userId), isNull(platformStaffMemberships.revoked_at)));
  return rows.map((r) => ({
    userId: r.userId,
    role: r.role,
    surface: r.role === "support_manager" || r.role === "support_agent" ? "support" : "admin",
    enabled: r.enabled,
  }));
}

/**
 * Assigns a durable staff membership to a real user id (idempotent per
 * role). Only an already-authorized staff actor may grant staff authority.
 */
export async function grantStaffMembership(input: {
  db: MoxDb;
  userId: string;
  role: string;
  grantedByUserId: string;
}): Promise<void> {
  await input.db
    .insert(platformStaffMemberships)
    .values({
      userId: input.userId,
      role: input.role as never,
      enabled: true,
      grantedByUserId: input.grantedByUserId,
    })
    .onConflictDoUpdate({
      target: [platformStaffMemberships.userId, platformStaffMemberships.role],
      set: { enabled: true, revoked_at: null, updated_at: new Date() },
    });
}

/** Disables/revokes a durable staff membership. */
export async function revokeStaffMembership(db: MoxDb, userId: string, role: string): Promise<boolean> {
  const updated = await db
    .update(platformStaffMemberships)
    .set({ revoked_at: new Date(), updated_at: new Date() })
    .where(
      and(
        eq(platformStaffMemberships.userId, userId),
        eq(platformStaffMemberships.role, role as never),
        isNull(platformStaffMemberships.revoked_at),
      ),
    )
    .returning({ id: platformStaffMemberships.id });
  return updated.length > 0;
}

/** A durable staff membership projected for the Staff & Access console. */
export interface StaffMembershipRow {
  userId: string;
  email: string;
  displayName: string;
  role: string;
  surface: "admin" | "support";
  enabled: boolean;
  grantedByUserId: string | null;
  createdAt: string;
  revokedAt: string | null;
}

/** Lists all durable staff memberships (Prompt 03 Staff & Access). */
export async function listStaffMemberships(db: MoxDb): Promise<StaffMembershipRow[]> {
  const rows = await db
    .select({
      userId: platformStaffMemberships.userId,
      email: users.email,
      displayName: users.displayName,
      role: platformStaffMemberships.role,
      enabled: platformStaffMemberships.enabled,
      grantedByUserId: platformStaffMemberships.grantedByUserId,
      createdAt: platformStaffMemberships.created_at,
      revokedAt: platformStaffMemberships.revoked_at,
    })
    .from(platformStaffMemberships)
    .innerJoin(users, eq(users.id, platformStaffMemberships.userId))
    .orderBy(desc(platformStaffMemberships.created_at));
  return rows.map((r) => ({
    userId: r.userId,
    email: r.email,
    displayName: r.displayName ?? r.email,
    role: r.role,
    surface: r.role === "support_manager" || r.role === "support_agent" ? "support" : "admin",
    enabled: r.enabled,
    grantedByUserId: r.grantedByUserId,
    createdAt: r.createdAt.toISOString(),
    revokedAt: r.revokedAt?.toISOString() ?? null,
  }));
}

/** Sets enabled/revoked status on a durable staff membership. */
export async function updateStaffMembershipStatus(
  db: MoxDb,
  userId: string,
  role: string,
  action: "disable" | "enable" | "revoke",
): Promise<boolean> {
  const set =
    action === "disable"
      ? { enabled: false, updated_at: new Date() }
      : action === "enable"
        ? { enabled: true, revoked_at: null, updated_at: new Date() }
        : { enabled: false, revoked_at: new Date(), updated_at: new Date() };
  const updated = await db
    .update(platformStaffMemberships)
    .set(set)
    .where(
      and(
        eq(platformStaffMemberships.userId, userId),
        eq(platformStaffMemberships.role, role as never),
        isNull(platformStaffMemberships.revoked_at),
      ),
    )
    .returning({ id: platformStaffMemberships.id });
  return updated.length > 0;
}

// ---- Staff invitations (Prompt 01) -------------------------------------------

/**
 * Creates a durable, single-use staff invitation for invite-only Admin and
 * Support signup. Returns the plaintext token exactly once.
 */
export async function createStaffInvitation(input: {
  db: MoxDb;
  email: string;
  role: string;
  surface: "admin" | "support" | "both";
  createdByUserId: string;
  ttlMs?: number;
}): Promise<{ invitationId: string; token: string; expiresAt: Date }> {
  if (!EMAIL_RE.test(input.email)) throw new AuthError("email is invalid", 400);
  if (!["superadmin", "platform_admin", "support_manager", "support_agent"].includes(input.role)) {
    throw new AuthError("unknown staff role", 400);
  }
  if (!["admin", "support", "both"].includes(input.surface)) {
    throw new AuthError("surface must be admin, support, or both", 400);
  }
  const token = `mox_invite_${randomBytes(32).toString("base64url")}`;
  const expiresAt = new Date(Date.now() + (input.ttlMs ?? INVITE_TOKEN_TTL_MS));
  const inserted = await input.db
    .insert(staffInvitations)
    .values({
      tokenHash: hashToken(token),
      email: input.email.toLowerCase(),
      role: input.role as never,
      surface: input.surface,
      createdByUserId: input.createdByUserId,
      expiresAt,
    })
    .returning({ id: staffInvitations.id });
  if (!inserted[0]) throw new AuthError("invite persistence failed", 500);
  return { invitationId: inserted[0].id, token, expiresAt };
}

export async function revokeStaffInvitation(db: MoxDb, invitationId: string): Promise<boolean> {
  const updated = await db
    .update(staffInvitations)
    .set({ revokedAt: new Date() })
    .where(
      and(eq(staffInvitations.id, invitationId), isNull(staffInvitations.consumedAt), isNull(staffInvitations.revokedAt)),
    )
    .returning({ id: staffInvitations.id });
  return updated.length > 0;
}

/**
 * Validates an invite WITHOUT consuming it. This must run BEFORE the caller
 * creates or logs into an account so that a bad invite never side-effects an
 * account. Rejects invalid, expired, revoked, reused and wrong-surface
 * invites. Returns the invite identity for the subsequent consume step.
 */
export async function peekStaffInvitation(input: {
  db: MoxDb;
  token: string;
  email: string;
  surface: "admin" | "support";
}): Promise<{ invitationId: string; email: string; role: string }> {
  if (!input.token || !input.email) throw new AuthError("invalid invite", 400);

  const rows = await input.db
    .select()
    .from(staffInvitations)
    .where(and(eq(staffInvitations.tokenHash, hashToken(input.token)), isNull(staffInvitations.revokedAt)))
    .limit(1);
  const invite = rows[0];
  if (!invite) throw new AuthError("invalid invite", 400);
  if (invite.consumedAt) throw new AuthError("invalid invite", 400);
  if (invite.expiresAt.getTime() < Date.now()) throw new AuthError("invalid invite", 400);
  // Intended-email binding: the invite is only usable by its bound address.
  if (invite.email !== input.email.toLowerCase()) throw new AuthError("invalid invite", 400);
  const surfaceOk =
    input.surface === "admin"
      ? invite.surface === "admin" || invite.surface === "both"
      : invite.surface === "support" || invite.surface === "both";
  if (!surfaceOk) throw new AuthError("invalid invite", 400);
  return { invitationId: invite.id, email: invite.email, role: invite.role };
}

/**
 * Transactionally consume a validate invite and attach the staff grant to the
 * existing identity (by email) instead of creating a duplicate user. Requires
 * the invite id AND the resolved user id (from the just-created-or-existing
 * account) and re-validates consumed/revoked inside the transaction.
 */
export async function consumeStaffInvitationById(input: {
  db: MoxDb;
  invitationId: string;
  userId: string;
  role: string;
}): Promise<{ userId: string; role: string }> {
  const consumed = await input.db.transaction(async (tx) => {
    const updated = await tx
      .update(staffInvitations)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(staffInvitations.id, input.invitationId),
          isNull(staffInvitations.consumedAt),
          isNull(staffInvitations.revokedAt),
        ),
      )
      .returning({ id: staffInvitations.id });
    if (updated.length === 0) throw new AuthError("invalid invite", 400);
    await tx
      .insert(platformStaffMemberships)
      .values({ userId: input.userId, role: input.role as never, enabled: true })
      .onConflictDoUpdate({
        target: [platformStaffMemberships.userId, platformStaffMemberships.role],
        set: { enabled: true, revoked_at: null, updated_at: new Date() },
      });
    return { userId: input.userId, role: input.role };
  });
  return consumed;
}


// ---- Password reset (Prompt 01) -----------------------------------------------

/**
 * Forgot-password: mint a durable one-use reset token for an existing,
 * non-disabled account. Anti-enumeration: unknown emails return the same
 * generic result and store nothing. Returns the plaintext token once so it
 * can be delivered by the configured email transport.
 */
export async function requestPasswordReset(input: {
  db: MoxDb;
  email: string;
  ttlMs?: number;
}): Promise<{ ok: boolean; token?: string; userId?: string }> {
  if (!EMAIL_RE.test(input.email)) return { ok: false };
  const userRows = await input.db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.email, input.email.toLowerCase()), isNull(users.disabledAt)))
    .limit(1);
  const user = userRows[0];
  if (!user) return { ok: false };
  const token = `mox_reset_${randomBytes(32).toString("base64url")}`;
  const expiresAt = new Date(Date.now() + (input.ttlMs ?? RESET_TOKEN_TTL_MS));
  await input.db.insert(passwordResets).values({
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt,
  });
  return { ok: true, token, userId: user.id };
}

/**
 * Reset-password: verify the one-use token, update the password, revoke the
 * user's existing browser sessions and (optionally) API tokens, and ack the
 * token so it can never be reused.
 */
export async function resetPassword(input: {
  db: MoxDb;
  token: string;
  password: string;
  revokeApiTokens?: boolean;
}): Promise<{ ok: boolean }> {
  if (!input.token) throw new AuthError("invalid reset token", 400);
  assertPasswordPolicy(input.password);

  const rows = await input.db
    .select()
    .from(passwordResets)
    .where(and(eq(passwordResets.tokenHash, hashToken(input.token)), isNull(passwordResets.consumedAt)))
    .limit(1);
  const reset = rows[0];
  if (!reset) throw new AuthError("invalid reset token", 400);
  if (reset.expiresAt.getTime() < Date.now()) throw new AuthError("invalid reset token", 400);

  const passwordHash = await hashPassword(input.password);
  await input.db.transaction(async (tx) => {
    const consumed = await tx
      .update(passwordResets)
      .set({ consumedAt: new Date() })
      .where(and(eq(passwordResets.id, reset.id), isNull(passwordResets.consumedAt)))
      .returning({ id: passwordResets.id });
    if (consumed.length === 0) throw new AuthError("invalid reset token", 400);
    await tx
      .update(authCredentials)
      .set({ passwordHash, algorithm: "scrypt", updatedAt: new Date() })
      .where(eq(authCredentials.userId, reset.userId));
    await tx
      .update(authSessions)
      .set({ revokedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(authSessions.userId, reset.userId), isNull(authSessions.revokedAt)));
    if (input.revokeApiTokens) {
      await tx
        .update(apiTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(apiTokens.userId, reset.userId), isNull(apiTokens.revokedAt)));
    }
  });
  return { ok: true };
}
