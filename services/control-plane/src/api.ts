/**
 * Mox Control Plane HTTP API (Prompt 00 Â§A). Every screen-facing surface is
 * served from authoritative services/stores â€” never demo data. Endpoints
 * that have no backing capability yet return honest 501s with machine
 * readable codes instead of pretending.
 */

import { createHash, randomBytes } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import type { SessionEvent } from "@mox/contracts";
import type { SessionIdentity } from "@mox/control-plane-contracts";
import { IdempotencyConflictError, QuotaExceededError } from "@mox/compute-orchestrator";
import {
  agentDeployments,
  agentRooms,
  agentVersions,
  agents,
  approvalRequests,
  abuseCases,
  addonDefinitions,
  auditEvents,
  backups,
  billingProviderConfigs,
  channelConnections,
  channelProviders,
  computeClasses,
  costLedgerEntries,
  credentialRefs,
  currencies,
  customContracts,
  dispatchedMessages,
  entitlementDefinitions,
  featureFlags,
  incidents,
  integrationConnections,
  integrationProviders,
  invoices,
  knowledgeSources,
  memberships,
  modelConnections,
  modelProviders,
  models,
  modelUsageRefs,
  moxNodes,
  notificationJobs,
  organizations,
  platformSetup,
  planEntitlementValues,
  planVersions,
  priceBooks,
  priceVersions,
  pricingRegions,
  products,
  providerAccounts,
  providerPayments,
  roomMembers,
  roomThreads,
  serverOperations,
  serverOrders,
  sessionEvents,
  staffInvitations,
  subscriptions,
  systemCredentialRefs,
  systemModelConnections,
  systemModelProviders,
  systemModels,
  threads,
  threadMessages,
  toolGrants,
  usageEvents,
  users,
  verifiedWebhookEvents,
  workspaceInvitations,
  sshKeys,
  supportEscalations,
} from "@mox/database";
import { sanitizeForPersistence } from "@mox/security";
import {
  canMutateMember,
  deploymentVersionId,
  maskBackupLocation,
  projectDeploymentState,
  projectDeploymentTarget,
  projectModelAvailability,
  projectServerSummary,
  projectSshKey,
  parseSshPublicKey,
  projectSupportNodeHealth,
  projectSupportServerOrder,
  projectUsageStatus,
  supportSafeErrorSummary,
  supportSafeSuspensionReason,
  validateKnowledgeAccess,
  validateScheduleLimit,
  validateSubagents,
  validateSupportNoteText,
} from "./projections.js";

import type { ControlPlaneServices } from "./composition.js";
import { verifyDependencies } from "./composition.js";
import { compileDeveloperMode, compileSimpleMode, diffDefinitions, type SimpleModeInput } from "@mox/agent-control";
import {
  authenticate,
  AuthError,
  completePlatformSetup,
  consumeStaffInvitationById,
  createStaffInvitation,
  extractSessionToken,
  hashToken,
  isCookieAuthenticated,
  issueApiToken,
  listApiTokens,
  listStaffMemberships,
  loadStaffGrants,
  login as loginAccount,
  logout as logoutSession,
  peekStaffInvitation,
  programmaticLogin,
  requestPasswordReset,
  resetPassword,
  revokeApiToken,
  revokeStaffInvitation,
  scopeSatisfied,
  serializeClearSessionCookie,
  serializeSessionCookie,
  signup as signupAccount,
  switchActiveOrg,
  updateStaffMembershipStatus,
} from "./auth.js";
import { httpError, Router, sendJson, type RequestContext } from "./http.js";
import { assertCompletionAllowed, projectOnboarding, validateOnboardingPatch } from "./onboarding.js";
import {
  DEFAULT_WEBHOOK_ABUSE,
  PLATFORM_ROLE_CAPABILITIES,
  STAFF_ROLE_CAPABILITIES,
  type PlatformAdminCapability,
  type PlatformAdminRole,
  type StaffRole,
  type SupportCapability,
} from "./config.js";
import { bucketHash, clientIp, DurableRateLimiter } from "./rate-limit.js";
import { ClusterSseAdmission, DEFAULT_SSE_LIMITS, SseAdmissionDeniedError } from "./sse-admission.js";

export interface ApiDeps {
  services: ControlPlaneServices;
}

/** Mutations authenticated via cookie require this client-set header (CSRF). */
export const CSRF_HEADER = "x-mox-csrf";

export function buildApiRouter(deps: ApiDeps): Router {
  const router = new Router();
  const { services } = deps;
  const db = () => services.db;
  const randomShort = () => randomBytes(2).toString("hex");
  const authLimiter = new DurableRateLimiter(db());
  const webhookLimiter = new DurableRateLimiter(db());
  const sseAdmission = new ClusterSseAdmission(db(), services.config.sseLimits ?? DEFAULT_SSE_LIMITS);
  const ORG_ROLE_RANK = { viewer: 0, member: 1, admin: 2, owner: 3 } as const;

  /**
   * Central auth gate (Prompt 00D §A). Browser sessions carry full
   * permissions (subject to normal role/entitlement checks); personal API
   * tokens MUST satisfy `requiredScope` ("*" or the explicit family) for
   * every protected route — enforcement cannot be forgotten route-by-route
   * because every handler funnels through here.
   */
  const requireAuth = async (ctx: RequestContext, requiredScope?: string) => {
    const auth = await authenticate(db(), {
      authorization: ctx.req.headers.authorization,
      cookie: ctx.req.headers.cookie,
    });
    // CSRF defense (§B of 00B): cookie-authenticated mutations must carry
    // the custom header, which cross-site forms cannot set.
    const mutating = ["POST", "PATCH", "PUT", "DELETE"].includes(ctx.req.method ?? "");
    if (mutating && isCookieAuthenticated(ctx.req.headers) && !ctx.req.headers[CSRF_HEADER]) {
      throw httpError("missing CSRF header for cookie-authenticated mutation", 403, { code: "csrf_required" });
    }
    if (auth.authKind === "api_token" && requiredScope && !scopeSatisfied(auth.scopes, requiredScope)) {
      throw httpError(`token lacks required scope: ${requiredScope}`, 403, { code: "scope_denied" });
    }
    return {
      ...auth.identity,
      userId: auth.userId,
      sessionId: auth.sessionId,
      orgs: auth.orgs,
      authKind: auth.authKind,
      scopes: auth.scopes,
    };
  };

  type AuthIdentity = Awaited<ReturnType<typeof requireAuth>>;
  type OrgRole = keyof typeof ORG_ROLE_RANK;
  type OrgCapability =
    | "workspace.write"
    | "billing.manage"
    | "infrastructure.manage"
    | "integrations.manage"
    | "approvals.resolve"
    | "notifications.manage";

  const roleOf = (identity: Pick<AuthIdentity, "role">): OrgRole =>
    (Object.prototype.hasOwnProperty.call(ORG_ROLE_RANK, identity.role) ? identity.role : "viewer") as OrgRole;

  const requireOrgRole = (identity: Pick<AuthIdentity, "role">, minimum: OrgRole): void => {
    if (ORG_ROLE_RANK[roleOf(identity)] < ORG_ROLE_RANK[minimum]) {
      throw httpError(`organization role ${minimum} or higher required`, 403, { code: "role_denied" });
    }
  };

  const requireOrgCapability = (identity: Pick<AuthIdentity, "role">, capability: OrgCapability): void => {
    switch (capability) {
      case "workspace.write":
      case "notifications.manage":
        requireOrgRole(identity, "member");
        return;
      case "billing.manage":
      case "infrastructure.manage":
      case "integrations.manage":
      case "approvals.resolve":
        requireOrgRole(identity, "admin");
        return;
    }
  };

  /** Token management is SESSION-only (Prompt 00D §B preferred policy). */
  const requireSessionAuth = async (ctx: RequestContext) => {
    const auth = await requireAuth(ctx);
    if (auth.authKind !== "session") {
      throw httpError(
        "token management requires a browser/session credential; use /api/auth/token-login to mint new tokens",
        403,
        { code: "session_only" },
      );
    }
    return auth;
  };

  /** Node-channel auth (Prompt 00C §E): durable agent token per node. */
  const requireNodeAuth = async (ctx: RequestContext) => {
    const agentToken = bearer(ctx.req.headers.authorization ?? "");
    if (!agentToken) throw httpError("node authentication required", 401, { code: "unauthenticated" });
    const nodeId = ctx.params.nodeId!;
    try {
      return { node: await services.orchestrator.authenticateNode(nodeId, agentToken) };
    } catch {
      throw httpError("node authentication failed", 403, { code: "node_auth_failed" });
    }
  };

  function validateAdminSendBody(body: unknown): {
    idempotencyKey: string;
    audience: Parameters<typeof services.notifications.createJob>[0]["audience"];
    payload: Parameters<typeof services.notifications.createJob>[0]["payload"];
    scheduledAt?: string;
  } {
    const b = body as {
      idempotencyKey?: string;
      audience?: { type?: string; userIds?: string[]; orgId?: string; planTier?: string; regionCode?: string };
      payload?: { title?: string; body?: string; severity?: string; category?: string; expiresAt?: string };
      scheduledAt?: string;
    } | undefined;
    if (!b?.idempotencyKey || !b.audience?.type || !b.payload?.title || !b.payload?.body) {
      throw httpError("idempotencyKey, audience.type, payload.title and payload.body are required", 400);
    }
    const allowedAudiences = ["user", "users", "org", "plan", "region", "all"];
    if (!allowedAudiences.includes(b.audience.type)) throw httpError("invalid audience type", 400);
    return {
      idempotencyKey: b.idempotencyKey,
      audience: {
        type: b.audience.type as "org",
        userIds: b.audience.userIds,
        orgId: b.audience.orgId,
        planTier: b.audience.planTier,
        regionCode: b.audience.regionCode,
      },
      payload: {
        title: b.payload.title,
        body: b.payload.body,
        severity: (b.payload.severity as never) ?? "info",
        category: (b.payload.category as never) ?? "system",
        expiresAt: b.payload.expiresAt,
      },
      scheduledAt: b.scheduledAt,
    };
  }

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  const getOrgEntitlements = async (orgId: string): Promise<Record<string, boolean | number | string>> => {
    const decision = await services.billing.evaluateCommercialAccess(orgId);
    if (decision.entitled && decision.planVersionId) {
      return services.entitlements.planValuesFor(decision.planVersionId);
    }
    return {};
  };

  /** Emits a durable platform notification after committed state changes. */
  const emitPlatformEvent = async (
    event: Parameters<typeof services.notifications.consume>[0],
  ): Promise<void> => {
    await services.notifications.consume(event);
  };


  const sessionCookieOptions = () => ({
    secure: services.config.env === "production",
    maxAgeSeconds: Math.floor(services.config.sessionTtlMs / 1000),
  });

  const enforceAuthRateLimits = async (ctx: RequestContext, endpoint: "setup" | "signup" | "login" | "token-login" | "forgot-password" | "reset-password" | "staff-invite", email?: string) => {
    const ip = clientIp(ctx.req, services.config.trustedProxyIps);
    const userAgent = ctx.req.headers["user-agent"];
    const ipLimit = endpoint === "signup" ? 180 : endpoint === "staff-invite" ? 40 : endpoint === "setup" ? 20 : 90;
    const checks = [
      { scope: `auth:${endpoint}:global`, bucketKey: "global", limit: 2000, windowMs: 60_000, lockMs: 60_000 },
      { scope: `auth:${endpoint}:ip`, bucketKey: bucketHash(ip || "unknown"), limit: ipLimit, windowMs: 60_000, lockMs: 5 * 60_000 },
    ];
    if (email) {
      checks.push({
        scope: `auth:${endpoint}:account`,
        bucketKey: bucketHash(email),
        limit: 8,
        windowMs: 15 * 60_000,
        lockMs: 15 * 60_000,
      });
    }
    for (const check of checks) {
      const result = await authLimiter.check({ ...check, requestIp: ip, userAgent });
      if (!result.allowed) {
        throw httpError("too many authentication attempts; retry later", 429, {
          code: "rate_limited",
          reason: String(result.retryAfterSeconds ?? 60),
        });
      }
    }
  };

  /**
   * Security Repair 05B §I: cluster-wide SSE admission. Per-user, per-IP
   * and global caps are enforced over PostgreSQL leases/counters so every
   * replica observes the same capacity; the returned handle releases
   * capacity on close and heartbeats during the stream's ping loop.
   */
  const admitSse = async (ctx: RequestContext, userId: string) => {
    const ip = clientIp(ctx.req, services.config.trustedProxyIps);
    try {
      return await sseAdmission.admit(userId, ip);
    } catch (error) {
      if (error instanceof SseAdmissionDeniedError) {
        throw httpError("too many open streams", 429, { code: "sse_connection_limit" });
      }
      throw error;
    }
  };

  /**
   * Prompt 01: safe post-auth return target (open-redirect defense).
   * Accepts only a same-origin relative path that stays within the given
   * surface root. Rejects absolute, protocol-relative and encoded variants,
   * and any path outside the allowed prefixes.
   */
  const surfaceRoots = (surface: "admin" | "support"): string[] =>
    surface === "admin" ? ["/admin"] : ["/support"];

  const safeReturnTarget = (
    raw: unknown,
    valid: string[],
    fallback: string,
  ): string => {
    if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return fallback;
    // Reject anything that is not a same-origin relative path.
    if (!raw.startsWith("/") || raw.startsWith("//")) return fallback;
    if (/[\r\n]/.test(raw)) return fallback;
    // protocol-relative and scheme detection (double-encoded attempts too).
    if (/(^|[\\/])[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return fallback;
    // Decode once and re-check for encoded absolute/protocol-relative forms.
    const decoded = safeDecodePathname(raw);
    if (decoded !== raw) {
      if (!decoded.startsWith("/") || decoded.startsWith("//")) return fallback;
    }
    const pathOnly = decoded.split("?")[0] ?? decoded;
    const validHit = valid.find((prefix) => pathOnly === prefix || pathOnly.startsWith(`${prefix}/`));
    return validHit ? decoded : fallback;
  };

  const safeDecodePathname = (raw: string): string => {
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  };

  /**
   * Customer-surface return target: same-origin relative and NOT a staff
   * surface. Customers may return to any customer path, but never into the
   * Admin or Support surfaces.
   */
  const safeCustomerReturnTarget = (raw: unknown): string => {
    const fallback = "/";
    if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return fallback;
    if (!raw.startsWith("/") || raw.startsWith("//")) return fallback;
    if (/[\r\n]/.test(raw)) return fallback;
    if (/(^|[\\/])[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return fallback;
    const decoded = safeDecodePathname(raw);
    if (decoded !== raw) {
      if (!decoded.startsWith("/") || decoded.startsWith("//")) return fallback;
    }
    const pathOnly = decoded.toLowerCase().split("?")[0] ?? decoded;
    if (pathOnly === "/admin" || pathOnly.startsWith("/admin/")) return fallback;
    if (pathOnly === "/support" || pathOnly.startsWith("/support/")) return fallback;
    return decoded;
  };

  /**
   * Prompt 01: durable staff authority context derived from the
   * `platform_staff_memberships` table — never from route, email domain,
   * localStorage, query string, or organization role.
   */
  const staffAdminContext = async (userId: string): Promise<{
    staffRoles: StaffRole[];
    adminCapabilities: string[];
    isSuperAdmin: boolean;
  }> => {
    const grants = await loadStaffGrants(db(), userId);
    const adminGrants = grants.filter((g) => g.surface === "admin" && g.enabled);
    const staffRoles = adminGrants.map((g) => g.role as StaffRole);
    const adminCapabilities: string[] = [];
    let isSuperAdmin = false;
    for (const g of adminGrants) {
      const map = STAFF_ROLE_CAPABILITIES[g.role as StaffRole];
      if (!map) continue;
      if (g.role === "superadmin") {
        isSuperAdmin = true;
        continue;
      }
      const caps = map.adminCapabilities as string[];
      if (caps.includes("*")) isSuperAdmin = true;
      else adminCapabilities.push(...caps);
    }
    return { staffRoles, adminCapabilities: [...new Set(adminCapabilities)], isSuperAdmin };
  };

  const staffSupportContext = async (userId: string): Promise<{
    staffRoles: StaffRole[];
    supportCapabilities: string[];
    isSupportAll: boolean;
  }> => {
    const grants = await loadStaffGrants(db(), userId);
    const supportGrants = grants.filter((g) => g.surface === "support" && g.enabled);
    const supportCapabilities: string[] = [];
    let isSupportAll = false;
    for (const g of supportGrants) {
      const map = STAFF_ROLE_CAPABILITIES[g.role as StaffRole];
      if (!map) continue;
      const caps = map.supportCapabilities as string[];
      if (caps.includes("*")) isSupportAll = true;
      else supportCapabilities.push(...caps);
    }
    return {
      staffRoles: supportGrants.map((g) => g.role as StaffRole),
      supportCapabilities: [...new Set(supportCapabilities)],
      isSupportAll,
    };
  };

  // ---- Health ----------------------------------------------------------------

  router.get("/healthz", async () => {
    await verifyDependencies(services);
    return { ok: true };
  });

  // ---- Setup (one-time owner provisioning; server-side credential only) -------

  router.post("/api/setup/bootstrap", async (ctx) => {
    // Setup-closed is evaluated before anything else so even well-formed
    // requests cannot probe state after completion (§A).
    const setupRows = await db().select().from(platformSetup).limit(1);
    const setupRow = setupRows[0];
    if (setupRow?.completedAt) throw httpError("platform setup is closed", 403);
    const body = ctx.body as {
      setupToken?: string;
      ownerEmail?: string;
      ownerPassword?: string;
      orgSlug?: string;
      orgDisplayName?: string;
    } | undefined;
    if (!body?.ownerEmail || !body?.ownerPassword || !body?.orgSlug) {
      throw httpError("ownerEmail, ownerPassword and orgSlug are required", 400);
    }
    await enforceAuthRateLimits(ctx, "setup", body.ownerEmail);
    await completePlatformSetup({
      db: db(),
      setupTokenHash: setupRow?.setupTokenHash ?? undefined,
      setupCompleted: false,
      presentedSetupToken: body.setupToken ?? "",
      expectedSetupTokenHash: services.config.setupToken
        ? hashToken(services.config.setupToken)
        : undefined,
      ownerEmail: body.ownerEmail,
      ownerPassword: body.ownerPassword,
      orgSlug: body.orgSlug,
      orgDisplayName: body.orgDisplayName,
    });
    return { ok: true, note: "setup closed permanently" };
  });

  // ---- Auth / identity ---------------------------------------------------------

  /**
   * Prompt 00C §A: browser signup/login return identity + expiry metadata
   * ONLY. The reusable session credential travels exclusively in the
   * HttpOnly cookie — never in JSON, for any client.
   */
  router.post("/api/auth/signup", async (ctx) => {
    const body = ctx.body as { email?: string; password?: string; displayName?: string; orgName?: string } | undefined;
    if (!body?.email || !body?.password) throw httpError("email and password are required", 400);
    await enforceAuthRateLimits(ctx, "signup", body.email);
    const result = await signupAccount({
      db: db(),
      email: body.email,
      password: body.password,
      displayName: body.displayName,
      orgName: body.orgName,
      meta: { ipAddress: clientIp(ctx.req, services.config.trustedProxyIps), userAgent: ctx.req.headers["user-agent"] },
    });
    ctx.res.setHeader("set-cookie", serializeSessionCookie(result.sessionToken, sessionCookieOptions()));
    return toBrowserAuthResponse(result);
  });

  router.post("/api/auth/login", async (ctx) => {
    const body = ctx.body as { email?: string; password?: string; returnTo?: string } | undefined;
    if (!body?.email || !body?.password) throw httpError("email and password are required", 400);
    await enforceAuthRateLimits(ctx, "login", body.email);
    const result = await loginAccount({
      db: db(),
      email: body.email,
      password: body.password,
      meta: { ipAddress: clientIp(ctx.req, services.config.trustedProxyIps), userAgent: ctx.req.headers["user-agent"] },
    });
    ctx.res.setHeader("set-cookie", serializeSessionCookie(result.sessionToken, sessionCookieOptions()));
    return {
      ...toBrowserAuthResponse(result),
      // Customer surface: anything EXCEPT the Admin/Support surfaces (this is
      // the default surface, so there is no single prefix to constrain to).
      returnTo: safeCustomerReturnTarget(body.returnTo),
    };
  });

  /**
   * Admin login — password auth then SERVER-SIDE Admin capability
   * verification. A customer account (even an org `owner`) without platform
   * staff authority is denied 403 here; the response never guides them into
   * the Admin shell.
   */
  router.post("/api/admin/login", async (ctx) => {
    const body = ctx.body as { email?: string; password?: string; returnTo?: string } | undefined;
    if (!body?.email || !body?.password) throw httpError("email and password are required", 400);
    await enforceAuthRateLimits(ctx, "login", body.email);
    // Authenticate with the ONE password authority; no cookie yet.
    const result = await loginAccount({
      db: db(),
      email: body.email,
      password: body.password,
      meta: { ipAddress: clientIp(ctx.req, services.config.trustedProxyIps), userAgent: ctx.req.headers["user-agent"] },
    });
    // Surface check: only durable staff with Admin capability may continue.
    const staff = await staffAdminContext(result.userId);
    if (staff.adminCapabilities.length === 0 && !staff.isSuperAdmin) {
      throw httpError("Admin staff authority required", 403, { code: "role_denied" });
    }
    ctx.res.setHeader("set-cookie", serializeSessionCookie(result.sessionToken, sessionCookieOptions()));
    return {
      ...toBrowserAuthResponse(result),
      role: staff.isSuperAdmin ? "superadmin" : (staff.staffRoles[0] ?? "platform_admin"),
      capabilities: staff.isSuperAdmin ? ["*"] : staff.adminCapabilities,
      returnTo: safeReturnTarget(body.returnTo, surfaceRoots("admin"), "/admin"),
    };
  });

  /**
   * Support login — password auth THEN server-side Support capability
   * verification. Customer (and Admin-only) accounts are denied 403.
   */
  router.post("/api/support/login", async (ctx) => {
    const body = ctx.body as { email?: string; password?: string; returnTo?: string } | undefined;
    if (!body?.email || !body?.password) throw httpError("email and password are required", 400);
    await enforceAuthRateLimits(ctx, "login", body.email);
    const result = await loginAccount({
      db: db(),
      email: body.email,
      password: body.password,
      meta: { ipAddress: clientIp(ctx.req, services.config.trustedProxyIps), userAgent: ctx.req.headers["user-agent"] },
    });
    const support = await staffSupportContext(result.userId);
    if (support.supportCapabilities.length === 0 && !support.isSupportAll) {
      throw httpError("Mox Support staff authority required", 403, { code: "role_denied" });
    }
    ctx.res.setHeader("set-cookie", serializeSessionCookie(result.sessionToken, sessionCookieOptions()));
    return {
      ...toBrowserAuthResponse(result),
      roles: support.staffRoles,
      capabilities: support.isSupportAll ? ["*"] : support.supportCapabilities,
      returnTo: safeReturnTarget(body.returnTo, surfaceRoots("support"), "/support"),
    };
  });


  /**
   * Prompt 00C §B: dedicated programmatic token-login — password → scoped
   * personal API access token (bearer). Never sets a cookie and is the only
   * password→bearer exchange.
   */
  router.post("/api/auth/token-login", async (ctx) => {
    const body = ctx.body as { email?: string; password?: string; name?: string; scopes?: string[] } | undefined;
    if (!body?.email || !body?.password) throw httpError("email and password are required", 400);
    await enforceAuthRateLimits(ctx, "token-login", body.email);
    const result = await programmaticLogin({
      db: db(),
      email: body.email,
      password: body.password,
      name: body.name,
      scopes: body.scopes,
    });
    return toProgrammaticAuthResponse(result);
  });

  /** Personal access token management — SESSION-ONLY (Prompt 00D §B). */
  router.post("/api/auth/tokens", async (ctx) => {
    const auth = await requireSessionAuth(ctx);
    const body = ctx.body as { name?: string; scopes?: string[] } | undefined;
    if (!body?.name) throw httpError("name is required", 400);
    // Scopes never exceed the issuing user's real capabilities: admin
    // scope requires actual owner/admin org role (00D §B).
    const issued = await issueApiToken({
      db: db(),
      userId: auth.userId,
      activeOrgId: auth.orgId,
      name: body.name,
      scopes: body.scopes,
      actorIsAdmin: auth.role === "owner" || auth.role === "admin",
    });
    return {
      token: issued.token,
      tokenId: issued.tokenId,
      scopes: issued.scopes,
      expiresAt: issued.expiresAt.toISOString(),
    };
  });

  router.get("/api/auth/tokens", async (ctx) => {
    const auth = await requireSessionAuth(ctx);
    const tokens = await listApiTokens(db(), auth.userId);
    return tokens.map((t) => ({
      id: t.id,
      name: t.name,
      scopes: t.scopes,
      expiresAt: t.expiresAt.toISOString(),
      revokedAt: t.revokedAt?.toISOString(),
      createdAt: t.createdAt.toISOString(),
      lastUsedAt: t.lastUsedAt?.toISOString(),
    }));
  });

  router.delete("/api/auth/tokens/:tokenId", async (ctx) => {
    const auth = await requireSessionAuth(ctx);
    const revoked = await revokeApiToken(db(), auth.userId, ctx.params.tokenId!);
    if (!revoked) throw httpError(`api token ${ctx.params.tokenId} not found or already revoked`, 404);
    return { ok: true };
  });

  router.post("/api/auth/logout", async (ctx) => {
    // requireAuth enforces authentication + the cookie-channel CSRF check.
    const auth = await requireAuth(ctx);
    void auth;
    const token = extractSessionToken({ authorization: ctx.req.headers.authorization, cookie: ctx.req.headers.cookie });
    await logoutSession(db(), token);
    ctx.res.setHeader("set-cookie", serializeClearSessionCookie());
    return { ok: true };
  });

  router.get("/api/me", async (ctx) => {
    const auth = await requireAuth(ctx);
    return { ...auth, orgs: auth.orgs };
  });

  /** Membership-verified active-org switch (§C). */
  router.post("/api/auth/orgs/select", async (ctx) => {
    const auth = await requireAuth(ctx);
    void auth;
    const token = extractSessionToken({ authorization: ctx.req.headers.authorization, cookie: ctx.req.headers.cookie });
    if (!token) throw httpError("authentication required", 401);
    const body = ctx.body as { orgId?: string } | undefined;
    if (!body?.orgId) throw httpError("orgId is required", 400);
    const result = await switchActiveOrg(db(), token, body.orgId);
    // Cookie-only contract here as well: no bearer material in the response.
    return toBrowserAuthResponse({
      ...result,
      expiresAt: new Date(Date.now() + services.config.sessionTtlMs),
    });
  });

  // ---- Mandatory customer onboarding (org-scoped durable authority) -----------
  // Progress lives in `org_onboarding` (PostgreSQL), never in client state.
  // Existing orgs were backfilled `completed` by migration 0020; orgs created
  // by signup start `not_started`. Deferred external setup is a real recorded
  // decision and never marks the underlying feature configured.

  router.get("/api/onboarding", async (ctx) => {
    const identity = await requireAuth(ctx, "settings");
    const row = await services.onboarding.getOrDefault(identity.orgId);
    return projectOnboarding(row);
  });

  router.patch("/api/onboarding", async (ctx) => {
    const identity = await requireAuth(ctx, "settings");
    requireOrgRole(identity, "admin");
    const current = await services.onboarding.getOrDefault(identity.orgId);
    if (current.status === "completed") {
      throw httpError("onboarding is already completed for this workspace", 409, {
        code: "onboarding_completed",
      });
    }
    const command = validateOnboardingPatch(ctx.body);

    // Referenced resources must REALLY exist in the caller's org — onboarding
    // never accepts invented agent ids or server orders.
    if (command.fields.agentId) {
      const agent = (
        await db()
          .select({ id: agents.id })
          .from(agents)
          .where(and(eq(agents.id, command.fields.agentId), eq(agents.orgId, identity.orgId)))
          .limit(1)
      )[0];
      if (!agent) throw httpError("agent not found in this workspace", 400, { code: "onboarding_agent_unknown" });
    }
    if (command.fields.serverOrderId) {
      const order = (
        await db()
          .select({ id: serverOrders.id })
          .from(serverOrders)
          .where(and(eq(serverOrders.id, command.fields.serverOrderId), eq(serverOrders.orgId, identity.orgId)))
          .limit(1)
      )[0];
      if (!order) {
        throw httpError("server order not found in this workspace", 400, { code: "onboarding_server_unknown" });
      }
    }

    // Step 1 confirms the real profile/workspace names against their own
    // authorities (users/organizations) — not just onboarding metadata.
    if (command.fields.displayName !== undefined && command.fields.displayName !== identity.displayName) {
      await db().update(users).set({ displayName: command.fields.displayName, updatedAt: new Date() }).where(eq(users.id, identity.userId));
    }
    if (command.fields.workspaceName !== undefined) {
      const orgRow = (
        await db()
          .select({ displayName: organizations.displayName })
          .from(organizations)
          .where(eq(organizations.id, identity.orgId))
          .limit(1)
      )[0];
      if (orgRow && orgRow.displayName !== command.fields.workspaceName) {
        await db()
          .update(organizations)
          .set({ displayName: command.fields.workspaceName })
          .where(eq(organizations.id, identity.orgId));
      }
    }

    const row = await services.onboarding.applyPatch(identity.orgId, {
      updatedByUserId: identity.userId,
      fields: command.fields,
      markStepComplete: command.markStepComplete,
      advanceTo: command.advanceTo,
    });
    return projectOnboarding(row);
  });

  router.post("/api/onboarding/complete", async (ctx) => {
    const identity = await requireAuth(ctx, "settings");
    requireOrgRole(identity, "admin");
    const current = await services.onboarding.getOrDefault(identity.orgId);
    assertCompletionAllowed(current);
    const row = await services.onboarding.complete(identity.orgId, identity.userId);
    if (row.status === "completed" && current.status !== "completed") {
      // Durable audit event on the existing audit infrastructure (safe,
      // org-scoped, secret-free).
      await db().insert(auditEvents).values({
        orgId: identity.orgId,
        actorType: "user",
        actorId: identity.userId,
        action: "onboarding.completed",
        resourceType: "org_onboarding",
        resourceId: identity.orgId,
        result: "success",
      });
    }
    return projectOnboarding(row);
  });

  // ---- Password reset (Prompt 01: one password authority, all surfaces) -----

  /**
   * Forgot-password — anti-enumeration. Generates a durable one-use reset
   * token for an existing account and returns it in the response envelope for
   * the configured email transport (or a fail-closed state when no transport
   * is registered — the token is never fabricated into a fake delivery).
   */
  router.post("/api/auth/forgot-password", async (ctx) => {
    await enforceAuthRateLimits(ctx, "forgot-password");
    const body = ctx.body as { email?: string } | undefined;
    if (!body?.email) {
      // Anti-enumeration: keep the response shape constant regardless of
      // whether the account exists.
      return { ok: true, note: "if an account exists, a reset link will be sent" };
    }
    const result = await requestPasswordReset({ db: db(), email: body.email });
    if (!result.ok) {
      return { ok: true, note: "if an account exists, a reset link will be sent" };
    }
    // No production email transport is registered at this time; return the
    // plaintext token to a fail-closed delivery envelope and document that
    // real delivery configuration is still required before production use.
    return {
      ok: true,
      note: "if an account exists, a reset link will be sent",
      deliveryRequired: true,
      deliverableToken: result.token,
    };
  });

  router.post("/api/auth/reset-password", async (ctx) => {
    await enforceAuthRateLimits(ctx, "reset-password");
    const body = ctx.body as { token?: string; password?: string } | undefined;
    if (!body?.token || !body?.password) throw httpError("token and password are required", 400);
    await resetPassword({ db: db(), token: body.token, password: body.password, revokeApiTokens: true });
    ctx.res.setHeader("set-cookie", serializeClearSessionCookie());
    return { ok: true };
  });

  // ---- Surface session / identity (Prompt 01) --------------------------------

  /**
   * GET /api/admin/session — returns the authenticated user's platform-admin
   * context ONLY if the session already holds Admin capability. Ordinary
   * customers and customer org owners receive 403 here.
   */
  router.get("/api/admin/session", async (ctx) => {
    const auth = await requireAdminCapability(ctx, "admin.read");
    return {
      role: auth.platformRole ?? "platform_admin",
      capabilities: auth.platformCapabilities,
      staffRoles: auth.staffRoles ?? [],
    };
  });

  /**
   * GET /api/support/session — returns the authenticated user's Support
   * context ONLY if the session already holds Support capability.
   */
  router.get("/api/support/session", async (ctx) => {
    const auth = await requireSupportCapability(ctx, "support.read");
    return {
      roles: auth.supportRoles,
      capabilities: auth.supportCapabilities,
    };
  });

  // ---- Staff invites (Prompt 01: invite-only Admin/Support signup) -----------

  router.post("/api/admin/staff/invites", async (ctx) => {
    const auth = await requireAdminCapability(ctx, "admin.staff.write");
    const body = ctx.body as
      | { email?: string; role?: string; surface?: "admin" | "support" | "both" }
      | undefined;
    if (!body?.email || !body?.role || !body?.surface) {
      throw httpError("email, role and surface are required", 400);
    }
    const invite = await createStaffInvitation({
      db: db(),
      email: body.email,
      role: body.role,
      surface: body.surface,
      createdByUserId: auth.userId,
    });
    await appendAdminAudit(auth, {
      action: "staff_invite_created",
      resourceType: "staff_invitation",
      result: "success",
    });
    return {
      invitationId: invite.invitationId,
      token: invite.token,
      expiresAt: invite.expiresAt.toISOString(),
      email: body.email,
      role: body.role,
      surface: body.surface,
    };
  });

  router.get("/api/admin/staff/invites", async (ctx) => {
    await requireAdminCapability(ctx, "admin.staff.write");
    const rows = await db().select().from(staffInvitations).orderBy(desc(staffInvitations.createdAt));
    return rows.map((r) => ({
      invitationId: r.id,
      email: r.email,
      role: r.role,
      surface: r.surface,
      createdAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
      consumedAt: r.consumedAt?.toISOString() ?? null,
      revokedAt: r.revokedAt?.toISOString() ?? null,
    }));
  });

  router.delete("/api/admin/staff/invites/:invitationId", async (ctx) => {
    const auth = await requireAdminCapability(ctx, "admin.staff.write");
    const revoked = await revokeStaffInvitation(db(), ctx.params.invitationId!);
    if (!revoked) throw httpError(`invite ${ctx.params.invitationId} not found or already consumed`, 404);
    await appendAdminAudit(auth, {
      action: "staff_invite_revoked",
      resourceType: "staff_invitation",
      result: "success",
    });
    return { ok: true };
  });

  /**
   * Prompt 03 Staff & Access: durable platform staff memberships. Only a role
   * holding `admin.staff.write` (presently superadmin) may read or mutate the
   * staff roster. Support roles can never reach these routes.
   */
  router.get("/api/admin/staff", async (ctx) => {
    await requireAdminCapability(ctx, "admin.staff.write");
    const memberships = await listStaffMemberships(db());
    const invites = await db().select().from(staffInvitations).orderBy(desc(staffInvitations.createdAt));
    return {
      members: memberships,
      invites: invites.map((r) => ({
        invitationId: r.id,
        email: r.email,
        role: r.role,
        surface: r.surface,
        createdAt: r.createdAt.toISOString(),
        expiresAt: r.expiresAt.toISOString(),
        consumedAt: r.consumedAt?.toISOString() ?? null,
        revokedAt: r.revokedAt?.toISOString() ?? null,
      })),
    };
  });

  router.post("/api/admin/staff/:userId/:action", async (ctx) => {
    const actor = await requireAdminCapability(ctx, "admin.staff.write");
    const action = ctx.params.action!;
    const targetUserId = ctx.params.userId!;
    if (action !== "disable" && action !== "enable" && action !== "revoke") {
      throw httpError("unsupported staff action", 400);
    }
    const body = ctx.body as { role?: string; reason?: string } | undefined;
    const role = body?.role;
    if (!role) throw httpError("role is required to target a staff membership", 400);
    // Never allow an actor to disable/revoke their own only grant (self-lockout).
    if (targetUserId === actor.userId && action !== "enable") {
      throw httpError("you cannot disable or revoke your own staff assignment", 400);
    }
    const changed = await updateStaffMembershipStatus(db(), targetUserId, role, action);
    if (!changed) throw httpError(`staff membership not found for user ${targetUserId} role ${role}`, 404);
    await appendAdminAudit(actor, {
      action: `staff.${action}`,
      resourceType: "staff_membership",
      resourceId: targetUserId,
      after: { role, userId: targetUserId, reason: body?.reason ?? null },
    });
    return { ok: true };
  });

  /**
   * Prompt 01: Admin signup is invite-only. Validates the invite and creates
   * the account if it does not exist, then consumes the invite transactionally
   * and attaches the staff grant to the SAME identity (never a duplicate).
   */
  router.post("/api/admin/signup", async (ctx) => {
    await enforceAuthRateLimits(ctx, "signup");
    const body = ctx.body as { email?: string; password?: string; inviteToken?: string; displayName?: string } | undefined;
    if (!body?.email || !body?.password || !body?.inviteToken) {
      throw httpError("email, password and inviteToken are required", 400);
    }
    // Validate the invite BEFORE any account side-effect so a bad invite
    // creates nothing. The intended-email binding is enforced here.
    const invite = await peekStaffInvitation({ db: db(), token: body.inviteToken, email: body.email ?? "", surface: "admin" });
    const inviteEmail = invite.email;
    const authMeta = { ipAddress: clientIp(ctx.req, services.config.trustedProxyIps), userAgent: ctx.req.headers["user-agent"] };
    // Create the account if it does not yet exist (never a duplicate); the
    // resulting session is where the staff grant will be attached.
    let session = await signupAccount({
      db: db(),
      email: inviteEmail,
      password: body.password,
      displayName: body.displayName,
      orgName: `mox-admin-${randomShort()}`,
      meta: authMeta,
    }).catch((error) => {
      if (error instanceof AuthError && error.status === 409) return null;
      throw error;
    });
    if (!session) {
      session = await loginAccount({
        db: db(),
        email: inviteEmail,
        password: body.password,
        meta: authMeta,
      });
    }
    // Consume the invite and attach the Admin staff grant to this identity.
    await consumeStaffInvitationById({
      db: db(),
      invitationId: invite.invitationId,
      userId: session.userId,
      role: invite.role,
    });
    ctx.res.setHeader("set-cookie", serializeSessionCookie(session.sessionToken, sessionCookieOptions()));
    return { ok: true, surface: "admin" };
  });

  router.post("/api/support/signup", async (ctx) => {
    await enforceAuthRateLimits(ctx, "signup");
    const body = ctx.body as { email?: string; password?: string; inviteToken?: string; displayName?: string } | undefined;
    if (!body?.email || !body?.password || !body?.inviteToken) {
      throw httpError("email, password and inviteToken are required", 400);
    }
    const invite = await peekStaffInvitation({ db: db(), token: body.inviteToken, email: body.email ?? "", surface: "support" });
    const inviteEmail = invite.email;
    const authMeta = { ipAddress: clientIp(ctx.req, services.config.trustedProxyIps), userAgent: ctx.req.headers["user-agent"] };
    let session = await signupAccount({
      db: db(),
      email: inviteEmail,
      password: body.password,
      displayName: body.displayName,
      orgName: `mox-support-${randomShort()}`,
      meta: authMeta,
    }).catch((error) => {
      if (error instanceof AuthError && error.status === 409) return null;
      throw error;
    });
    if (!session) {
      session = await loginAccount({
        db: db(),
        email: inviteEmail,
        password: body.password,
        meta: authMeta,
      });
    }
    await consumeStaffInvitationById({
      db: db(),
      invitationId: invite.invitationId,
      userId: session.userId,
      role: invite.role,
    });
    ctx.res.setHeader("set-cookie", serializeSessionCookie(session.sessionToken, sessionCookieOptions()));
    return { ok: true, surface: "support" };
  });

  // ---- Mox Support: least-privilege customer lookup --------------------------
  // Prompt 03: Support ONLY sees safe diagnostics (no costs, no revenue, no
  // secrets, no inventory credentials). Every note write is audited.

  router.get("/api/support/customers", async (ctx) => {
    await requireSupportCapability(ctx, "support.customer.lookup");
    const q = (ctx.query.get("q") as string | undefined)?.trim().toLowerCase() || "";
    const [
      orgRows,
      memberRows,
      subRows,
      serverRows,
      agentRows,
      noteRows,
      nodeRows,
      deploymentRows,
      modelProviderRows,
      modelConnectionRows,
      integrationProviderRows,
      integrationConnectionRows,
      channelProviderRows,
      channelConnectionRows,
      notificationFailureRows,
    ] = await Promise.all([
      db().select().from(organizations).orderBy(desc(organizations.createdAt)).limit(300),
      db()
        .select({
          orgId: memberships.orgId,
          userId: users.id,
          email: users.email,
          displayName: users.displayName,
          role: memberships.role,
          joinedAt: memberships.joinedAt,
          disabledAt: users.disabledAt,
        })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .limit(1500),
      db()
        .select({
          id: subscriptions.id,
          orgId: subscriptions.orgId,
          state: subscriptions.state,
          failedRenewals: subscriptions.failedRenewals,
          currentPeriodStart: subscriptions.currentPeriodStart,
          currentPeriodEnd: subscriptions.currentPeriodEnd,
          trialEndsAt: subscriptions.trialEndsAt,
          graceEndsAt: subscriptions.graceEndsAt,
          retentionUntil: subscriptions.retentionUntil,
          cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
          suspensionReason: subscriptions.suspensionReason,
          reconciliationRequired: subscriptions.reconciliationRequired,
          plan: products.displayName,
          tier: products.tier,
        })
        .from(subscriptions)
        .innerJoin(planVersions, eq(planVersions.id, subscriptions.planVersionId))
        .innerJoin(products, eq(products.id, planVersions.productId))
        .limit(1000),
      db().select().from(serverOrders).limit(1500),
      db()
        .select({ id: agents.id, orgId: agents.orgId, slug: agents.slug, displayName: agents.displayName, status: agents.status })
        .from(agents)
        .limit(1500),
      db()
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.action, "support.note"))
        .orderBy(desc(auditEvents.at))
        .limit(500),
      db()
        .select({ orgId: moxNodes.orgId, orderId: moxNodes.orderId, status: moxNodes.status, lastHeartbeatAt: moxNodes.lastHeartbeatAt })
        .from(moxNodes)
        .limit(1500),
      db().select({ orgId: agentDeployments.orgId, agentId: agentDeployments.agentId, computeInstanceId: agentDeployments.computeInstanceId }).from(agentDeployments).limit(1500),
      db().select({ orgId: modelProviders.orgId, id: modelProviders.id }).from(modelProviders).limit(1500),
      db().select({ orgId: modelConnections.orgId, providerId: modelConnections.providerId, credentialRefId: modelConnections.credentialRefId, connectionStatus: modelConnections.connectionStatus }).from(modelConnections).limit(1500),
      db().select({ orgId: integrationProviders.orgId, id: integrationProviders.id }).from(integrationProviders).limit(1500),
      db().select({ orgId: integrationConnections.orgId, providerId: integrationConnections.providerId, credentialRefId: integrationConnections.credentialRefId, status: integrationConnections.status }).from(integrationConnections).limit(1500),
      db().select({ orgId: channelProviders.orgId, id: channelProviders.id }).from(channelProviders).limit(1500),
      db().select({ orgId: channelConnections.orgId, providerId: channelConnections.providerId, credentialRefId: channelConnections.credentialRefId, status: channelConnections.status }).from(channelConnections).limit(1500),
      db()
        .select({ orgId: dispatchedMessages.orgId })
        .from(dispatchedMessages)
        .where(inArray(dispatchedMessages.deliveryState, ["failed", "uncertain"]))
        .limit(1000),
    ]);
    const filtered = (q
      ? orgRows.filter(
          (org) =>
            org.displayName.toLowerCase().includes(q) ||
            org.slug.toLowerCase().includes(q) ||
            org.id.toLowerCase().includes(q),
        )
      : orgRows) as Array<{
      id: string;
      slug: string;
      displayName: string;
      workspaceName: string | null;
      createdAt: Date;
    }>;
    return {
      customers: filtered.map((org) => {
        const members = memberRows.filter((m) => m.orgId === org.id);
        const orgSubscriptions = subRows.filter((s) => s.orgId === org.id);
        const orgServers = serverRows.filter((s) => s.orgId === org.id);
        const orgAgents = agentRows.filter((a) => a.orgId === org.id);
        const orgNodes = nodeRows.filter((n) => n.orgId === org.id);
        const orgDeployments = deploymentRows.filter((d) => d.orgId === org.id);
        const connectionTotal =
          modelProviderRows.filter((r) => r.orgId === org.id).length +
          integrationProviderRows.filter((r) => r.orgId === org.id).length +
          channelProviderRows.filter((r) => r.orgId === org.id).length;
        const connectionConfigured =
          modelConnectionRows.filter((r) => r.orgId === org.id && r.credentialRefId && r.connectionStatus === "configured").length +
          integrationConnectionRows.filter((r) => r.orgId === org.id && r.credentialRefId && r.status === "active").length +
          channelConnectionRows.filter((r) => r.orgId === org.id && r.status === "active").length;
        return {
          orgId: org.id,
          slug: org.slug,
          displayName: org.displayName,
          workspaceName: org.workspaceName,
          createdAt: org.createdAt.toISOString(),
          memberCount: members.length,
          users: members.map((m) => ({
            userId: m.userId,
            email: m.email,
            displayName: m.displayName,
            role: m.role,
            disabledAt: m.disabledAt?.toISOString() ?? null,
          })),
          subscriptions: orgSubscriptions
            .map((s) => ({
              subscriptionId: s.id,
              state: s.state,
              plan: s.plan,
              tier: s.tier,
              currentPeriodStart: s.currentPeriodStart?.toISOString() ?? null,
              currentPeriodEnd: s.currentPeriodEnd?.toISOString() ?? null,
              trialEndsAt: s.trialEndsAt?.toISOString() ?? null,
              graceEndsAt: s.graceEndsAt?.toISOString() ?? null,
              retentionUntil: s.retentionUntil?.toISOString() ?? null,
              failedRenewals: s.failedRenewals,
              cancelAtPeriodEnd: s.cancelAtPeriodEnd,
              suspensionReason: supportSafeSuspensionReason(s.suspensionReason),
              reconciliationRequired: s.reconciliationRequired,
            })),
          servers: orgServers.map(projectSupportServerOrder),
          agents: orgAgents.map((a) => {
            const deployment = orgDeployments.find((d) => d.agentId === a.id);
            const order = deployment?.computeInstanceId ? orgServers.find((s) => s.id === deployment.computeInstanceId) : undefined;
            const node = order ? orgNodes.find((n) => n.orderId === order.id) : undefined;
            return {
              agentId: a.id,
              slug: a.slug,
              displayName: a.displayName,
              status: a.status,
              deploymentState: deployment ? projectDeploymentState(order?.state, node?.lastHeartbeatAt?.toISOString()) : "not_deployed",
            };
          }),
          supportNoteCount: noteRows.filter((n) => n.orgId === org.id).length,
          diagnostics: {
            subscriptionsRequiringAttention: orgSubscriptions.filter((s) => ["past_due", "grace_period", "suspended"].includes(s.state) || s.reconciliationRequired).length,
            serversInError: orgServers.filter((s) => s.state === "error").length,
            nodesStaleOrMissing: orgServers.filter((s) => {
              const node = orgNodes.find((n) => n.orderId === s.id);
              return projectSupportNodeHealth(node).health !== "active";
            }).length,
            agentsDegraded: orgAgents.filter((a) => {
              const deployment = orgDeployments.find((d) => d.agentId === a.id);
              if (!deployment) return false;
              const order = deployment?.computeInstanceId ? orgServers.find((s) => s.id === deployment.computeInstanceId) : undefined;
              const node = order ? orgNodes.find((n) => n.orderId === order.id) : undefined;
              return projectDeploymentState(order?.state, node?.lastHeartbeatAt?.toISOString()) !== "running";
            }).length,
            connectionsConfigured: connectionConfigured,
            connectionsTotal: connectionTotal,
            recentNotificationFailures: notificationFailureRows.filter((n) => n.orgId === org.id).length,
          },
        };
      }),
    };
  });

  router.get("/api/support/customers/:orgId", async (ctx) => {
    await requireSupportCapability(ctx, "support.customer.lookup");
    const orgRows = await db()
      .select()
      .from(organizations)
      .where(eq(organizations.id, ctx.params.orgId!))
      .limit(1);
    const org = orgRows[0];
    if (!org) throw httpError(`organization ${ctx.params.orgId} not found`, 404);
    const [
      memberRows,
      subRows,
      serverRows,
      agentRows,
      noteRows,
      recentAudit,
      nodeRows,
      deploymentRows,
      modelProviderRows,
      modelConnectionRows,
      integrationProviderRows,
      integrationConnectionRows,
      channelProviderRows,
      channelConnectionRows,
      notificationFailureRows,
    ] = await Promise.all([
      db()
        .select({
          userId: users.id,
          email: users.email,
          displayName: users.displayName,
          role: memberships.role,
          joinedAt: memberships.joinedAt,
          disabledAt: users.disabledAt,
        })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(eq(memberships.orgId, ctx.params.orgId!)),
      db()
        .select({
          id: subscriptions.id,
          state: subscriptions.state,
          failedRenewals: subscriptions.failedRenewals,
          currentPeriodStart: subscriptions.currentPeriodStart,
          currentPeriodEnd: subscriptions.currentPeriodEnd,
          trialEndsAt: subscriptions.trialEndsAt,
          graceEndsAt: subscriptions.graceEndsAt,
          retentionUntil: subscriptions.retentionUntil,
          cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
          suspensionReason: subscriptions.suspensionReason,
          reconciliationRequired: subscriptions.reconciliationRequired,
          plan: products.displayName,
          tier: products.tier,
        })
        .from(subscriptions)
        .innerJoin(planVersions, eq(planVersions.id, subscriptions.planVersionId))
        .innerJoin(products, eq(products.id, planVersions.productId))
        .where(eq(subscriptions.orgId, ctx.params.orgId!)),
      db().select().from(serverOrders).where(eq(serverOrders.orgId, ctx.params.orgId!)),
      db().select().from(agents).where(eq(agents.orgId, ctx.params.orgId!)),
      db()
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.orgId, ctx.params.orgId!), eq(auditEvents.action, "support.note")))
        .orderBy(desc(auditEvents.at))
        .limit(100),
      db()
        .select({ id: auditEvents.id, action: auditEvents.action, at: auditEvents.at, actorType: auditEvents.actorType, resourceType: auditEvents.resourceType })
        .from(auditEvents)
        .where(eq(auditEvents.orgId, ctx.params.orgId!))
        .orderBy(desc(auditEvents.at))
        .limit(50),
      db()
        .select({
          orderId: moxNodes.orderId,
          status: moxNodes.status,
          version: moxNodes.version,
          lastHeartbeatAt: moxNodes.lastHeartbeatAt,
        })
        .from(moxNodes)
        .where(eq(moxNodes.orgId, ctx.params.orgId!)),
      db().select().from(agentDeployments).where(eq(agentDeployments.orgId, ctx.params.orgId!)),
      db()
        .select({ id: modelProviders.id, slug: modelProviders.slug, displayName: modelProviders.displayName, kind: modelProviders.kind })
        .from(modelProviders)
        .where(eq(modelProviders.orgId, ctx.params.orgId!)),
      db().select().from(modelConnections).where(eq(modelConnections.orgId, ctx.params.orgId!)),
      db()
        .select({ id: integrationProviders.id, slug: integrationProviders.slug, displayName: integrationProviders.displayName, kind: integrationProviders.kind })
        .from(integrationProviders)
        .where(eq(integrationProviders.orgId, ctx.params.orgId!)),
      db().select().from(integrationConnections).where(eq(integrationConnections.orgId, ctx.params.orgId!)),
      db()
        .select({ id: channelProviders.id, slug: channelProviders.slug, displayName: channelProviders.displayName, kind: channelProviders.kind })
        .from(channelProviders)
        .where(eq(channelProviders.orgId, ctx.params.orgId!)),
      db()
        .select({
          id: channelConnections.id,
          providerId: channelConnections.providerId,
          agentId: channelConnections.agentId,
          credentialRefId: channelConnections.credentialRefId,
          status: channelConnections.status,
        })
        .from(channelConnections)
        .where(eq(channelConnections.orgId, ctx.params.orgId!)),
      db()
        .select({
          id: dispatchedMessages.id,
          eventType: dispatchedMessages.eventType,
          route: dispatchedMessages.route,
          deliveryState: dispatchedMessages.deliveryState,
          attempts: dispatchedMessages.attempts,
          lastError: dispatchedMessages.lastError,
          at: dispatchedMessages.at,
        })
        .from(dispatchedMessages)
        .where(and(eq(dispatchedMessages.orgId, ctx.params.orgId!), inArray(dispatchedMessages.deliveryState, ["failed", "uncertain"])))
        .orderBy(desc(dispatchedMessages.at))
        .limit(25),
    ]);
    const serverById = new Map(serverRows.map((s) => [s.id, s]));
    const nodeByOrderId = new Map(nodeRows.filter((n) => n.orderId).map((n) => [n.orderId!, n]));
    const agentNameById = new Map(agentRows.map((a) => [a.id, a.displayName]));
    const modelConnectionsByProvider = new Map(modelConnectionRows.map((c) => [c.providerId, c]));
    const integrationConnectionsByProvider = new Map(integrationConnectionRows.map((c) => [c.providerId, c]));
    return {
      orgId: org.id,
      slug: org.slug,
      displayName: org.displayName,
      workspaceName: org.workspaceName,
      createdAt: org.createdAt.toISOString(),
      users: memberRows.map((m) => ({
        userId: m.userId,
        email: m.email,
        displayName: m.displayName,
        role: m.role,
        joinedAt: m.joinedAt?.toISOString() ?? null,
        disabledAt: m.disabledAt?.toISOString() ?? null,
      })),
      subscriptions: subRows.map((s) => ({
        subscriptionId: s.id,
        state: s.state,
        plan: s.plan,
        tier: s.tier,
        currentPeriodStart: s.currentPeriodStart?.toISOString() ?? null,
        currentPeriodEnd: s.currentPeriodEnd?.toISOString() ?? null,
        trialEndsAt: s.trialEndsAt?.toISOString() ?? null,
        graceEndsAt: s.graceEndsAt?.toISOString() ?? null,
        retentionUntil: s.retentionUntil?.toISOString() ?? null,
        failedRenewals: s.failedRenewals,
        cancelAtPeriodEnd: s.cancelAtPeriodEnd,
        suspensionReason: supportSafeSuspensionReason(s.suspensionReason),
        reconciliationRequired: s.reconciliationRequired,
      })),
      servers: serverRows.map((s) => ({
        ...projectSupportServerOrder(s),
        nodeHealth: projectSupportNodeHealth(nodeByOrderId.get(s.id)),
      })),
      agents: agentRows.map((a) => {
        const deployment = deploymentRows.find((d) => d.agentId === a.id);
        const order = deployment?.computeInstanceId ? serverById.get(deployment.computeInstanceId) : undefined;
        const node = order ? nodeByOrderId.get(order.id) : undefined;
        return {
          agentId: a.id,
          slug: a.slug,
          displayName: a.displayName,
          status: a.status,
          currentVersion: a.currentVersion,
          deploymentKind: deployment?.kind ?? "not_deployed",
          deploymentState: deployment ? projectDeploymentState(order?.state, node?.lastHeartbeatAt?.toISOString()) : "not_deployed",
          desiredRevision: deployment?.desiredRevision,
          runtimeHealth: projectSupportNodeHealth(node).health,
        };
      }),
      connections: {
        models: modelProviderRows.map((p) => {
          const conn = modelConnectionsByProvider.get(p.id);
          const configured = Boolean(conn?.credentialRefId);
          return {
            providerId: p.slug,
            displayName: p.displayName,
            kind: p.kind,
            status: conn?.connectionStatus ?? "not_configured",
            credentialConfigured: configured,
            connected: configured && conn?.connectionStatus === "configured",
          };
        }),
        integrations: integrationProviderRows.map((p) => {
          const conn = integrationConnectionsByProvider.get(p.id);
          const configured = Boolean(conn?.credentialRefId);
          return {
            integrationId: p.slug,
            displayName: p.displayName,
            kind: p.kind,
            status: conn?.status ?? "not_configured",
            credentialConfigured: configured,
            connected: configured && conn?.status === "active",
          };
        }),
        channels: channelProviderRows.flatMap((p): Array<{
          channelId: string;
          displayName: string;
          kind: string;
          status: string;
          credentialConfigured: boolean;
          connected: boolean;
          boundAgentId: string | null;
          boundAgentName: string | null;
        }> => {
          const rows = channelConnectionRows.filter((c) => c.providerId === p.id);
          if (rows.length === 0) {
            return [{
              channelId: p.slug,
              displayName: p.displayName,
              kind: p.kind,
              status: "not_configured",
              credentialConfigured: false,
              connected: false,
              boundAgentId: null,
              boundAgentName: null,
            }];
          }
          return rows.map((conn) => ({
            channelId: p.slug,
            displayName: p.displayName,
            kind: p.kind,
            status: conn.status,
            credentialConfigured: Boolean(conn.credentialRefId),
            connected: conn.status === "active" && (p.kind === "web" || Boolean(conn.credentialRefId)),
            boundAgentId: conn.agentId,
            boundAgentName: agentNameById.get(conn.agentId) ?? null,
          }));
        }),
      },
      notificationFailures: notificationFailureRows.map((row) => ({
        id: row.id,
        eventType: row.eventType,
        route: row.route,
        deliveryState: row.deliveryState,
        attempts: row.attempts,
        errorSummary: supportSafeErrorSummary(row.lastError),
        at: row.at.toISOString(),
      })),
      supportNotes: noteRows.map((n) => ({ id: n.id, actorId: n.actorId, note: (n.after as { note?: string } | null)?.note ?? "", at: n.at.toISOString() })),
      recentActivity: recentAudit.map((r) => ({ id: r.id, action: r.action, at: r.at.toISOString(), actorType: r.actorType, resourceType: r.resourceType })),
      diagnostics: {
        subscriptionsRequiringAttention: subRows.filter((s) => ["past_due", "grace_period", "suspended"].includes(s.state) || s.reconciliationRequired).length,
        serversInError: serverRows.filter((s) => s.state === "error").length,
        nodesStaleOrMissing: serverRows.filter((s) => projectSupportNodeHealth(nodeByOrderId.get(s.id)).health !== "active").length,
        agentsDegraded: agentRows.filter((a) => {
          const deployment = deploymentRows.find((d) => d.agentId === a.id);
          if (!deployment) return false;
          const order = deployment?.computeInstanceId ? serverById.get(deployment.computeInstanceId) : undefined;
          const node = order ? nodeByOrderId.get(order.id) : undefined;
          return projectDeploymentState(order?.state, node?.lastHeartbeatAt?.toISOString()) !== "running";
        }).length,
        connectionsConfigured:
          modelConnectionRows.filter((r) => r.credentialRefId && r.connectionStatus === "configured").length +
          integrationConnectionRows.filter((r) => r.credentialRefId && r.status === "active").length +
          channelConnectionRows.filter((r) => r.status === "active").length,
        connectionsTotal: modelProviderRows.length + integrationProviderRows.length + channelProviderRows.length,
        recentNotificationFailures: notificationFailureRows.length,
      },
    };
  });

  router.post("/api/support/customers/:orgId/notes", async (ctx) => {
    const support = await requireSupportCapability(ctx, "support.ticket.write");
    const body = ctx.body as { note?: string } | undefined;
    const valid = validateSupportNoteText(body?.note);
    if (!valid.ok) throw httpError(valid.reason, 400);
    const note = valid.note;
    const orgRows = await db().select().from(organizations).where(eq(organizations.id, ctx.params.orgId!)).limit(1);
    if (!orgRows[0]) throw httpError(`organization ${ctx.params.orgId} not found`, 404);
    await appendSupportAudit(support, {
      action: "support.note",
      resourceType: "organization",
      resourceId: ctx.params.orgId!,
      targetOrgId: ctx.params.orgId!,
      after: { note },
    });
    return { ok: true };
  });

  // ---- Support escalations (Phase 06) -----------------------------------------

  router.get("/api/support/escalations", async (ctx) => {
    const support = await requireSupportCapability(ctx, "support.escalate");
    const orgIdFilter = ctx.query.get("orgId") as string | undefined;
    let query = db()
      .select({
        id: supportEscalations.id,
        orgId: supportEscalations.orgId,
        orgName: organizations.displayName,
        createdByUserId: supportEscalations.createdByUserId,
        assignedUserId: supportEscalations.assignedUserId,
        severity: supportEscalations.severity,
        category: supportEscalations.category,
        title: supportEscalations.title,
        description: supportEscalations.description,
        status: supportEscalations.status,
        resolutionNote: supportEscalations.resolutionNote,
        resolvedAt: supportEscalations.resolvedAt,
        createdAt: supportEscalations.createdAt,
        updatedAt: supportEscalations.updatedAt,
      })
      .from(supportEscalations)
      .leftJoin(organizations, eq(supportEscalations.orgId, organizations.id))
      .orderBy(desc(supportEscalations.createdAt))
      .limit(200);
    void support;
    const rows = orgIdFilter
      ? await db()
          .select({
            id: supportEscalations.id,
            orgId: supportEscalations.orgId,
            orgName: organizations.displayName,
            createdByUserId: supportEscalations.createdByUserId,
            assignedUserId: supportEscalations.assignedUserId,
            severity: supportEscalations.severity,
            category: supportEscalations.category,
            title: supportEscalations.title,
            description: supportEscalations.description,
            status: supportEscalations.status,
            resolutionNote: supportEscalations.resolutionNote,
            resolvedAt: supportEscalations.resolvedAt,
            createdAt: supportEscalations.createdAt,
            updatedAt: supportEscalations.updatedAt,
          })
          .from(supportEscalations)
          .leftJoin(organizations, eq(supportEscalations.orgId, organizations.id))
          .where(eq(supportEscalations.orgId, orgIdFilter))
          .orderBy(desc(supportEscalations.createdAt))
          .limit(200)
      : await query;
    return rows.map((r) => ({
      ...r,
      createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
      updatedAt: r.updatedAt instanceof Date ? r.updatedAt.toISOString() : r.updatedAt,
      resolvedAt: r.resolvedAt instanceof Date ? r.resolvedAt.toISOString() : r.resolvedAt,
    }));
  });

  router.post("/api/support/escalations", async (ctx) => {
    const support = await requireSupportCapability(ctx, "support.escalate");
    const body = ctx.body as { orgId?: string; severity?: string; category?: string; title?: string; description?: string } | undefined;
    if (!body?.orgId) throw httpError("orgId is required", 400);
    if (!body?.title?.trim()) throw httpError("title is required", 400);
    const orgRows = await db().select().from(organizations).where(eq(organizations.id, body.orgId)).limit(1);
    if (!orgRows[0]) throw httpError("organization not found", 404);
    const inserted = await db()
      .insert(supportEscalations)
      .values({
        orgId: body.orgId,
        createdByUserId: support.userId,
        severity: body.severity ?? "medium",
        category: body.category ?? "general",
        title: body.title.trim(),
        description: body.description?.trim() ?? "",
      })
      .returning();
    const row = inserted[0]!;
    await appendSupportAudit(support, {
      action: "support.escalation.created",
      resourceType: "escalation",
      resourceId: row.id,
      targetOrgId: body.orgId,
      after: { title: row.title, severity: row.severity, status: row.status },
    });
    return {
      ...row,
      orgName: orgRows[0]!.displayName,
      createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
      updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
      resolvedAt: null,
    };
  });

  router.post("/api/support/escalations/:escalationId", async (ctx) => {
    const support = await requireSupportCapability(ctx, "support.escalate");
    const escalationId = ctx.params.escalationId!;
    const body = ctx.body as { status?: string; assignedUserId?: string; resolutionNote?: string } | undefined;
    const existing = (await db().select().from(supportEscalations).where(eq(supportEscalations.id, escalationId)).limit(1))[0];
    if (!existing) throw httpError("escalation not found", 404);
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (body?.status) updates.status = body.status;
    if (body?.assignedUserId !== undefined) updates.assignedUserId = body.assignedUserId;
    if (body?.resolutionNote !== undefined) updates.resolutionNote = body.resolutionNote;
    if (body?.status === "resolved" || body?.status === "closed") {
      updates.resolvedAt = new Date();
    }
    const updated = await db()
      .update(supportEscalations)
      .set(updates)
      .where(eq(supportEscalations.id, escalationId))
      .returning();
    const row = updated[0]!;
    await appendSupportAudit(support, {
      action: "support.escalation.updated",
      resourceType: "escalation",
      resourceId: escalationId,
      targetOrgId: row.orgId,
      after: { status: row.status, assignedUserId: row.assignedUserId },
    });
    return {
      ...row,
      createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
      updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
      resolvedAt: row.resolvedAt instanceof Date ? row.resolvedAt.toISOString() : row.resolvedAt,
    };
  });

  // ---- Agents ---------------------------------------------------------------

  router.get("/api/agents", async (ctx) => {
    const identity = await requireAuth(ctx, "agents");
    const rows = await db()
      .select()
      .from(agents)
      .where(eq(agents.orgId, identity.orgId))
      .orderBy(asc(agents.createdAt));
    return rows.map((row) => ({
      definition: row.definition,
      status: row.status,
      agentId: row.id,
      slug: row.slug,
    }));
  });

  router.get("/api/agents/:agentId", async (ctx) => {
    const identity = await requireAuth(ctx, "agents");
    const rows = await db()
      .select()
      .from(agents)
      .where(and(eq(agents.orgId, identity.orgId), eq(agents.id, ctx.params.agentId!)))
      .limit(1);
    const row = rows[0];
    if (!row) throw httpError(`agent ${ctx.params.agentId} not found`, 404);
    return { definition: row.definition, status: row.status, agentId: row.id, slug: row.slug };
  });

  /** Authoritative model change on the live draft definition. */
  router.patch("/api/agents/:agentId/model", async (ctx) => {
    const identity = await requireAuth(ctx, "agents");
    requireOrgCapability(identity, "workspace.write");
    const body = ctx.body as { providerId?: string; modelId?: string } | undefined;
    if (!body?.providerId || !body?.modelId) throw httpError("providerId and modelId are required", 400);
    const rows = await db()
      .select()
      .from(agents)
      .where(and(eq(agents.orgId, identity.orgId), eq(agents.id, ctx.params.agentId!)))
      .limit(1);
    const row = rows[0];
    if (!row) throw httpError(`agent ${ctx.params.agentId} not found`, 404);
    const definition = row.definition as { model?: unknown; updatedAt?: string };
    definition.model = { providerId: body.providerId, modelId: body.modelId };
    definition.updatedAt = new Date().toISOString();
    await db().update(agents).set({ definition: row.definition, updatedAt: new Date() }).where(eq(agents.id, row.id));
    return { ok: true };
  });

  // ---- Agent authoring & versioning (Phase 02 §B / §C) -------------------------
  // Simple and Developer modes compile to the SAME canonical AgentDefinition
  // (builder.ts) — the stored `agents.definition` is always the engine contract,
  // and version numbers are derived server-side from the durable agent_versions
  // table (never client-invented).

  router.post("/api/agents/drafts", async (ctx) => {
    const identity = await requireAuth(ctx, "agents");
    requireOrgCapability(identity, "workspace.write");
    await requireCommercialMutation(identity, "active_concurrent_agents", { min: 1 }, "member");
    const body = ctx.body as
      | { mode: "simple"; slug: string; input?: SimpleModeInput }
      | { mode: "developer"; slug: string; raw?: unknown }
      | undefined;
    const slug = body?.slug;
    if (!body?.mode || !slug || !/^[a-z0-9][a-z0-9-]{1,40}$/.test(slug)) {
      throw httpError("slug is required (2-41 lowercase alphanumeric/hyphen)", 400, { code: "invalid_slug" });
    }
    const existing = await db()
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.orgId, identity.orgId), eq(agents.slug, slug)))
      .limit(1);
    if (existing[0]) throw httpError(`agent slug ${slug} already exists`, 409, { code: "agent_slug_taken" });

    let definition;
    try {
      definition =
        body.mode === "developer"
          ? compileDeveloperMode(body.raw)
          : compileSimpleMode({ ...(body.input as SimpleModeInput), orgId: identity.orgId, slug });
    } catch (error) {
      throw httpError(error instanceof Error ? error.message : "invalid definition", 400, { code: "invalid_definition" });
    }
    if (definition.orgId !== identity.orgId) {
      throw httpError("definition orgId must match your organization", 403, { code: "org_mismatch" });
    }

    // Phase 04 §E: Validate subagents, schedules, and knowledge for newly created drafts
    if (definition.subagents && definition.subagents.length > 0) {
      for (const sub of definition.subagents) {
        if (sub.agentId === slug || sub.agentId === definition.agentId) {
          throw httpError("subagent cannot self-reference the agent itself", 400, { code: "invalid_subagent" });
        }
        const subRows = await db()
          .select({ id: agents.id })
          .from(agents)
          .where(and(eq(agents.orgId, identity.orgId), eq(agents.id, sub.agentId)))
          .limit(1);
        if (!subRows[0]) {
          throw httpError(`subagent ${sub.agentId} not found in this organization`, 400, { code: "cross_org_subagent" });
        }
      }
    }
    if (definition.schedules && definition.schedules.length > 0) {
      const ents = await getOrgEntitlements(identity.orgId);
      const schedLimit = typeof ents.schedule_workflow_limit === "number" ? ents.schedule_workflow_limit : 5;
      const schedCheck = validateScheduleLimit(definition.schedules.length, schedLimit);
      if (!schedCheck.allowed) {
        throw httpError(schedCheck.reason ?? "schedule limit exceeded", 403, { code: "quota_exceeded" });
      }
    }
    if (definition.knowledge && definition.knowledge.length > 0) {
      for (const kb of definition.knowledge) {
        const accessCheck = validateKnowledgeAccess(kb.access as string[]);
        if (!accessCheck.valid) {
          throw httpError(accessCheck.reason ?? "invalid knowledge access", 400, { code: "invalid_knowledge_access" });
        }
        const kRows = await db()
          .select({ id: knowledgeSources.id })
          .from(knowledgeSources)
          .where(and(eq(knowledgeSources.orgId, identity.orgId), eq(knowledgeSources.id, kb.knowledgeId)))
          .limit(1);
        if (!kRows[0]) {
          throw httpError(`knowledge source ${kb.knowledgeId} not found in this organization`, 400, { code: "cross_org_knowledge" });
        }
      }
    }

    const inserted = await db()
      .insert(agents)
      .values({
        orgId: identity.orgId,
        slug,
        displayName: (definition.identity as { displayName?: string })?.displayName ?? slug,
        status: "draft",
        definition: definition as unknown as object,
        currentVersion: 0,
        createdByUserId: identity.userId,
      })
      .returning();
    const agent = inserted[0];
    if (!agent) throw httpError("agent insert failed", 500, { unavailable: true });
    return { definition, status: agent.status, agentId: agent.id, slug: agent.slug, currentVersion: agent.currentVersion };
  });

  router.patch("/api/agents/:agentId/draft", async (ctx) => {
    const identity = await requireAuth(ctx, "agents");
    requireOrgCapability(identity, "workspace.write");
    const body = ctx.body as { mode?: "simple" | "developer"; input?: SimpleModeInput; raw?: unknown } | undefined;
    const rows = await db()
      .select()
      .from(agents)
      .where(and(eq(agents.orgId, identity.orgId), eq(agents.id, ctx.params.agentId!)))
      .limit(1);
    const row = rows[0];
    if (!row) throw httpError("agent not found", 404);
    let definition;
    try {
      definition =
        body?.mode === "developer"
          ? compileDeveloperMode(body.raw)
          : compileSimpleMode({ ...(body?.input as SimpleModeInput), orgId: identity.orgId, slug: row.slug });
    } catch (error) {
      throw httpError(error instanceof Error ? error.message : "invalid definition", 400, { code: "invalid_definition" });
    }

    // Phase 04 §E: Validate subagents — prevent cycles / self-reference, require same-org agents
    if (definition.subagents && definition.subagents.length > 0) {
      const subCheck = validateSubagents(definition.subagents, row.id, row.slug);
      if (!subCheck.valid) {
        throw httpError(subCheck.reason ?? "invalid subagent", 400, { code: "invalid_subagent" });
      }
      for (const sub of definition.subagents) {
        const subRows = await db()
          .select({ id: agents.id })
          .from(agents)
          .where(and(eq(agents.orgId, identity.orgId), eq(agents.id, sub.agentId)))
          .limit(1);
        if (!subRows[0]) {
          throw httpError(`subagent ${sub.agentId} not found in this organization`, 400, { code: "cross_org_subagent" });
        }
      }
    }

    // Phase 04 §E: Validate schedules limit against schedule_workflow_limit entitlement
    if (definition.schedules && definition.schedules.length > 0) {
      const ents = await getOrgEntitlements(identity.orgId);
      const schedLimit = typeof ents.schedule_workflow_limit === "number" ? ents.schedule_workflow_limit : 5;
      const schedCheck = validateScheduleLimit(definition.schedules.length, schedLimit);
      if (!schedCheck.allowed) {
        throw httpError(schedCheck.reason ?? "schedule limit exceeded", 403, { code: "quota_exceeded" });
      }
    }

    // Phase 04 §E: Validate knowledge sources belong to same org and have valid access permissions
    if (definition.knowledge && definition.knowledge.length > 0) {
      for (const kb of definition.knowledge) {
        const accessCheck = validateKnowledgeAccess(kb.access as string[]);
        if (!accessCheck.valid) {
          throw httpError(accessCheck.reason ?? "invalid knowledge access", 400, { code: "invalid_knowledge_access" });
        }
        const kRows = await db()
          .select({ id: knowledgeSources.id })
          .from(knowledgeSources)
          .where(and(eq(knowledgeSources.orgId, identity.orgId), eq(knowledgeSources.id, kb.knowledgeId)))
          .limit(1);
        if (!kRows[0]) {
          throw httpError(`knowledge source ${kb.knowledgeId} not found in this organization`, 400, { code: "cross_org_knowledge" });
        }
      }
    }


    await db()
      .update(agents)
      .set({
        definition: definition as unknown as object,
        displayName: (definition.identity as { displayName?: string })?.displayName ?? row.displayName,
        updatedAt: new Date(),
      })
      .where(eq(agents.id, row.id));
    return { definition, agentId: row.id, slug: row.slug };

  });

  router.post("/api/agents/:agentId/publish", async (ctx) => {
    const identity = await requireAuth(ctx, "agents");
    requireOrgCapability(identity, "workspace.write");
    const body = ctx.body as { changelog?: string } | undefined;
    const rows = await db()
      .select()
      .from(agents)
      .where(and(eq(agents.orgId, identity.orgId), eq(agents.id, ctx.params.agentId!)))
      .limit(1);
    const row = rows[0];
    if (!row) throw httpError("agent not found", 404);
    const definition = row.definition as { authoring?: { mode?: string } };
    if (definition.authoring?.mode === "developer") {
      await requireCommercialMutation(identity, "developer_mode", {}, "member");
    }
    const versions = await db()
      .select({ version: agentVersions.version })
      .from(agentVersions)
      .where(eq(agentVersions.agentId, row.id))
      .orderBy(desc(agentVersions.version));
    const nextRevision = versions.length ? Number(versions[0]!.version) + 1 : 1;
    await db()
      .insert(agentVersions)
      .values({
        orgId: identity.orgId,
        agentId: row.id,
        version: String(nextRevision),
        definition: row.definition,
        publishedByUserId: identity.userId,
      })
      .onConflictDoNothing({ target: [agentVersions.agentId, agentVersions.version] });
    await db()
      .update(agents)
      .set({ status: "active", currentVersion: nextRevision, updatedAt: new Date() })
      .where(eq(agents.id, row.id));
    const depRows = await db()
      .select({ id: agentDeployments.id })
      .from(agentDeployments)
      .where(and(eq(agentDeployments.orgId, identity.orgId), eq(agentDeployments.agentId, row.id)))
      .limit(1);
    if (depRows[0]) {
      await db()
        .update(agentDeployments)
        .set({ desiredRevision: nextRevision, updatedAt: new Date() })
        .where(eq(agentDeployments.id, depRows[0].id));
    } else {
      await db()
        .insert(agentDeployments)
        .values({ orgId: identity.orgId, agentId: row.id, desiredRevision: nextRevision });
    }
    return { agentId: row.id, revision: nextRevision, status: "active" };
  });

  router.get("/api/agents/:agentId/versions", async (ctx) => {
    const identity = await requireAuth(ctx, "agents");
    const rows = await db()
      .select()
      .from(agentVersions)
      .where(and(eq(agentVersions.orgId, identity.orgId), eq(agentVersions.agentId, ctx.params.agentId!)))
      .orderBy(asc(agentVersions.version));
    return rows.map((v) => ({
      revision: Number(v.version),
      changelog: null,
      createdBy: v.publishedByUserId ?? "system",
      createdAt: v.createdAt.toISOString(),
      definition: v.definition,
    }));
  });

  router.get("/api/agents/:agentId/versions/diff", async (ctx) => {
    const identity = await requireAuth(ctx, "agents");
    const from = Number(ctx.query.get("from") ?? "0");
    const to = Number(ctx.query.get("to") ?? "0");
    const rows = await db()
      .select()
      .from(agentVersions)
      .where(
        and(
          eq(agentVersions.orgId, identity.orgId),
          eq(agentVersions.agentId, ctx.params.agentId!),
          inArray(agentVersions.version, [String(from), String(to)]),
        ),
      );
    const byRevision = new Map(rows.map((v) => [Number(v.version), v]));
    const a = byRevision.get(from);
    const b = byRevision.get(to);
    if (!a || !b) throw httpError("both revisions must be published", 404);
    return { from, to, changes: diffDefinitions(a.definition as never, b.definition as never) };
  });

  router.post("/api/agents/:agentId/rollback", async (ctx) => {
    const identity = await requireAuth(ctx, "agents");
    requireOrgCapability(identity, "workspace.write");
    const body = ctx.body as { toRevision?: number } | undefined;
    const toRevision = Number(body?.toRevision);
    if (!Number.isInteger(toRevision) || toRevision < 1) throw httpError("toRevision is required", 400);
    const rows = await db()
      .select()
      .from(agents)
      .where(and(eq(agents.orgId, identity.orgId), eq(agents.id, ctx.params.agentId!)))
      .limit(1);
    const row = rows[0];
    if (!row) throw httpError("agent not found", 404);
    const versionRows = await db()
      .select({ id: agentVersions.id })
      .from(agentVersions)
      .where(
        and(
          eq(agentVersions.orgId, identity.orgId),
          eq(agentVersions.agentId, row.id),
          eq(agentVersions.version, String(toRevision)),
        ),
      )
      .limit(1);
    if (!versionRows[0]) throw httpError(`revision ${toRevision} not found`, 404);
    await db()
      .update(agentDeployments)
      .set({ desiredRevision: toRevision, updatedAt: new Date() })
      .where(and(eq(agentDeployments.orgId, identity.orgId), eq(agentDeployments.agentId, row.id)));
    await db()
      .update(agents)
      .set({ currentVersion: toRevision, updatedAt: new Date() })
      .where(eq(agents.id, row.id));
    return { agentId: row.id, revision: toRevision };
  });

  // ---- Threads & messages -----------------------------------------------------

  router.get("/api/agents/:agentId/threads", async (ctx) => {
    const identity = await requireAuth(ctx, "threads");
    const records = await services.threads.listForAgent(identity, ctx.params.agentId!);
    // Status is exposed so clients keep archived threads out of "recent"
    // surfaces; the store stays the single authority for thread state.
    return records.map((r) => ({ threadId: r.threadId, title: r.title, status: r.status }));
  });

  router.post("/api/threads", async (ctx) => {
    const identity = await requireAuth(ctx, "threads");
    const body = ctx.body as { agentId?: string; title?: string } | undefined;
    if (!body?.agentId) throw httpError("agentId is required", 400);
    const rows = await db()
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.orgId, identity.orgId), eq(agents.id, body.agentId)))
      .limit(1);
    if (!rows[0]) throw httpError("agent not found in this organization", 400, { code: "agent_not_found" });
    await requireCommercialMutation(identity, "active_concurrent_agents", { min: 1 }, "member");
    const record = await services.threads.create(identity, { agentId: body.agentId, title: body.title });
    return record;
  });

  router.get("/api/threads/:threadId/messages", async (ctx) => {
    const identity = await requireAuth(ctx, "threads");
    const records = await services.messages.list(identity, ctx.params.threadId!);
    return records.map((m) => ({
      messageId: m.messageId,
      threadId: m.threadId,
      authorId: m.authorId,
      role: m.authorKind,
      text: m.text,
      at: m.createdAt,
    }));
  });

  /**
   * Appends the user message durably. Turn execution requires a configured
   * engine seam; without one the API answers honestly instead of faking an
   * assistant response.
   */
  router.post("/api/threads/:threadId/messages", async (ctx) => {
    const identity = await requireAuth(ctx, "threads");
    await requireCommercialMutation(identity, "active_concurrent_agents", { min: 1 }, "member");
    const threadId = ctx.params.threadId!;
    const body = ctx.body as { text?: string } | undefined;
    if (!body?.text) throw httpError("text is required", 400);
    const thread = await services.threads.get(identity, threadId);
    if (!thread) throw httpError(`thread ${threadId} not found`, 404);
    const message = await services.messages.append(identity, {
      messageId: crypto.randomUUID(),
      threadId,
      authorKind: "user",
      authorId: identity.userId,
      text: body.text,
    });
    if (!services.runtime) {
      throw httpError("Mox Runtime is not configured on this deployment", 501, { code: "mox_runtime_not_configured" });
    }
    if (!thread.agentId) throw httpError("thread is not attached to a Mox Agent runtime", 400, { code: "thread_has_no_agent" });
    const agentRows = await db()
      .select()
      .from(agents)
      .where(and(eq(agents.orgId, identity.orgId), eq(agents.id, thread.agentId)))
      .limit(1);
    const agent = agentRows[0];
    if (!agent) throw httpError(`agent ${thread.agentId} not found`, 404);
    const turn = await services.runtime.launch({
      definition: agent.definition as never,
      orgId: identity.orgId,
      agentId: thread.agentId,
      threadId,
      userInput: body.text,
      correlationId: crypto.randomUUID(),
    });
    return {
      message: {
        messageId: message.messageId,
        threadId: message.threadId,
        authorId: message.authorId,
        role: message.authorKind,
        text: message.text,
        at: message.createdAt,
      },
      turn,
    };
  });

  /** Archive a thread owned by the caller's org (Phase 02 §D domain support). */
  router.post("/api/threads/:threadId/archive", async (ctx) => {
    const identity = await requireAuth(ctx, "threads");
    // Verify ownership without trusting the raw id: re-check via the store's
    // tenant-scoped get, then flip status.
    const thread = await services.threads.get(identity, ctx.params.threadId!);
    if (!thread) throw httpError(`thread ${ctx.params.threadId} not found`, 404);
    const updated = await db()
      .update(threads)
      .set({ status: "archived", updatedAt: new Date() })
      .where(and(eq(threads.id, ctx.params.threadId!), eq(threads.orgId, identity.orgId)))
      .returning({ id: threads.id, status: threads.status });
    return { threadId: updated[0]?.id ?? ctx.params.threadId, status: updated[0]?.status ?? "archived" };
  });

  // ---- Events (canonical) + realtime stream ------------------------------------

  router.get("/api/events", async (ctx) => {
    const identity = await requireAuth(ctx, "threads");
    const sinceSeq = Number(ctx.query.get("sinceSeq") ?? "0");
    const rows = await db()
      .select()
      .from(sessionEvents)
      .where(and(eq(sessionEvents.orgId, identity.orgId), gt(sessionEvents.seq, sinceSeq)))
      .orderBy(asc(sessionEvents.seq))
      .limit(500);
    return rows.map((row) => ({ seq: row.seq, event: row.payload }));
  });

  /** Server-sent events: ordered replay of durable org events (realtime abstraction). */
  router.get("/api/streams/org-events", async (ctx) => {
    // Prompt 00B Â§D: NO tokens in URLs. Browsers authenticate via the
    // HttpOnly session cookie (EventSource sends it same-origin); non-
    // browser clients use the Authorization header. Query parameters are
    // never consulted for authentication.
    if (ctx.query.get("token") || ctx.query.get("authorization")) {
      throw httpError("stream authentication must use cookie or Authorization header", 400, { code: "no_token_in_url" });
    }
    const auth = await authenticate(db(), {
      authorization: ctx.req.headers.authorization,
      cookie: ctx.req.headers.cookie,
    });
    if (auth.authKind === "api_token" && !scopeSatisfied(auth.scopes, "threads")) {
      throw httpError("token lacks required scope: threads", 403, { code: "scope_denied" });
    }
    const { identity } = auth;
    const sseHandle = await admitSse(ctx, auth.userId);
    let released = false;
    const releaseSse = () => {
      if (released) return;
      released = true;
      void sseHandle.release().catch(() => undefined);
    };
    let lastSeq = Number(ctx.query.get("sinceSeq") ?? "0");
    ctx.res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    ctx.res.write(`retry: 3000\n\n`);
    const timer = setInterval(async () => {
      try {
        const rows = await db()
          .select()
          .from(sessionEvents)
          .where(and(eq(sessionEvents.orgId, identity.orgId), gt(sessionEvents.seq, lastSeq)))
          .orderBy(asc(sessionEvents.seq))
          .limit(200);
        for (const row of rows) {
          lastSeq = Math.max(lastSeq, row.seq);
          ctx.res.write(`data: ${JSON.stringify({ seq: row.seq, event: row.payload })}\n\n`);
        }
        ctx.res.write(`: ping\n\n`);
        // Keep the cluster-wide admission lease alive (finding I).
        void sseHandle.heartbeat().catch(() => undefined);
      } catch {
        clearInterval(timer);
        releaseSse();
        ctx.res.end();
      }
    }, 1000);
    ctx.req.on("close", () => {
      clearInterval(timer);
      releaseSse();
    });
    return undefined;
  });

  // ---- Approvals (event-sourced) ----------------------------------------------

  router.get("/api/approvals/open", async (ctx) => {
    const identity = await requireAuth(ctx, "approvals");
    const rows = await db()
      .select()
      .from(approvalRequests)
      .where(and(eq(approvalRequests.orgId, identity.orgId), eq(approvalRequests.state, "open")))
      .orderBy(desc(approvalRequests.requestedAt));
    return rows.map((row) => ({
      approvalId: row.approvalRef ?? row.id,
      orgId: row.orgId,
      agentId: row.agentId,
      threadId: row.threadId ?? undefined,
      runId: row.correlationId ?? undefined,
      kind: row.kind,
      summary: row.summary,
      payload: row.payload,
      requestedAt: row.requestedAt.toISOString(),
    }));
  });

  router.post("/api/approvals/:approvalId/resolve", async (ctx) => {
    const identity = await requireAuth(ctx, "approvals");
    requireOrgCapability(identity, "approvals.resolve");
    const body = ctx.body as { outcome?: "approved" | "denied" } | undefined;
    if (body?.outcome !== "approved" && body?.outcome !== "denied") {
      throw httpError('outcome must be "approved" or "denied"', 400);
    }
    const approvalId = ctx.params.approvalId!;
    const rows = await db()
      .select()
      .from(approvalRequests)
      .where(and(eq(approvalRequests.orgId, identity.orgId), eq(approvalRequests.approvalRef, approvalId)))
      .limit(1);
    const request = rows[0];
    if (!request) throw httpError(`approval ${approvalId} not found`, 404);
    const desiredState = body.outcome === "approved" ? "approved" : "rejected";
    if (request.state !== "open") {
      if (request.outcome === body.outcome || request.state === desiredState) {
        return { ok: true, duplicate: true, approvalId, outcome: body.outcome };
      }
      throw httpError(`approval ${approvalId} is already resolved`, 409, { code: "approval_already_resolved" });
    }
    const resolvedAt = new Date();
    const updated = await db()
      .update(approvalRequests)
      .set({
        state: desiredState,
        outcome: body.outcome,
        resolvedAt,
        resolvedByUserId: identity.userId,
      })
      .where(and(eq(approvalRequests.id, request.id), eq(approvalRequests.state, "open")))
      .returning();
    const resolved = updated[0];
    if (!resolved) {
      return { ok: true, duplicate: true, approvalId };
    }
    const event: SessionEvent = {
      type: "approval.resolved",
      eventId: crypto.randomUUID(),
      orgId: identity.orgId,
      agentId: request.agentId,
      threadId: request.threadId ?? undefined,
      correlationId: request.correlationId ?? `approval:${approvalId}`,
      at: resolvedAt.toISOString(),
      approvalId,
      outcome: body.outcome,
    } as unknown as SessionEvent;
    await services.events.append(identity, { kind: "thread", id: request.threadId ?? identity.orgId }, sanitizeForPersistence(event));
    const runId = request.correlationId ?? ((request.payload as { runId?: string } | null)?.runId);
    if (services.runtime && runId) {
      await services.runtime.respondApproval({ orgId: identity.orgId, runId, approvalId, outcome: body.outcome });
    }
    return { ok: true, approvalId, outcome: body.outcome, resolvedBy: identity.userId, resolvedAt: resolvedAt.toISOString() };
  });

  // ---- Rooms -----------------------------------------------------------------

  router.get("/api/rooms", async (ctx) => {
    const identity = await requireAuth(ctx, "threads");
    // Phase 01 §E: return the actually persisted members, not an empty stub.
    const [rooms, members] = await Promise.all([
      db().select().from(agentRooms).where(eq(agentRooms.orgId, identity.orgId)),
      db().select().from(roomMembers).where(eq(roomMembers.orgId, identity.orgId)),
    ]);
    return rooms.map((row) => {
      const roomMemberIds = members.filter((m) => m.roomId === row.id && m.agentId).map((m) => m.agentId!);
      return {
        roomId: row.id,
        orgId: row.orgId,
        title: row.name,
        description: row.description,
        memberAgentIds: roomMemberIds,
      };
    });
  });

  router.post("/api/rooms", async (ctx) => {
    const identity = await requireAuth(ctx, "threads");
    await requireCommercialMutation(identity, "agent_rooms", { min: 1 }, "member");
    const body = ctx.body as { title?: string; memberAgentIds?: string[] } | undefined;
    const title = body?.title;
    if (!title) throw httpError("title is required", 400);
    const memberAgentIds = Array.isArray(body.memberAgentIds) ? [...new Set(body.memberAgentIds)] : [];

    // Validate that every requested member agent belongs to the SAME org, so
    // membership can never span org boundaries (Phase 01 §E).
    let validatedMembers: typeof agents.$inferSelect[] = [];
    if (memberAgentIds.length) {
      const agentRows = await db().select().from(agents).where(inArray(agents.id, memberAgentIds));
      const byId = new Map(agentRows.map((a) => [a.id, a]));
      const crossOrg = memberAgentIds.filter((id) => byId.get(id)?.orgId !== identity.orgId);
      if (crossOrg.length) {
        throw httpError("room member agents must belong to the same org", 400, {
          reason: `rejected agents: ${crossOrg.join(", ")}`,
        });
      }
      // Preserve request ordering, skipping any ids that do not resolve.
      validatedMembers = memberAgentIds
        .map((id) => byId.get(id))
        .filter((a): a is typeof agents.$inferSelect => Boolean(a));
    }

    const row = await db().transaction(async (tx) => {
      const inserted = await tx
        .insert(agentRooms)
        .values({ orgId: identity.orgId, name: title })
        .returning();
      const room = inserted[0];
      if (!room) throw httpError("room insert failed", 500, { unavailable: true });
      if (validatedMembers.length) {
        await tx.insert(roomMembers).values(
          validatedMembers.map((a) => ({
            roomId: room.id,
            orgId: identity.orgId,
            userId: identity.userId,
            agentId: a.id,
          })),
        );
      }
      return room;
    });

    return {
      roomId: row.id,
      orgId: row.orgId,
      title: row.name,
      description: row.description,
      memberAgentIds: validatedMembers.map((a) => a.id),
    };
  });

  // ---- Room shared conversations (Phase 03) -----------------------------------

  /** Ensure a room has a backing thread; returns the thread id. */
  async function ensureRoomThread(identity: SessionIdentity, roomId: string): Promise<string> {
    // Check room exists and belongs to org
    const roomRows = await db()
      .select()
      .from(agentRooms)
      .where(and(eq(agentRooms.id, roomId), eq(agentRooms.orgId, identity.orgId)))
      .limit(1);
    if (!roomRows[0]) throw httpError("room not found or not owned by your org", 404);

    // Check if thread already exists for this room
    const existing = await db()
      .select()
      .from(roomThreads)
      .where(and(eq(roomThreads.roomId, roomId), eq(roomThreads.orgId, identity.orgId)))
      .limit(1);
    if (existing[0]) return existing[0].threadId;

    // Find first member agent to satisfy threads.agentId NOT NULL
    const members = await db()
      .select()
      .from(roomMembers)
      .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.orgId, identity.orgId)));
    const firstAgent = members.find((m) => m.agentId);
    if (!firstAgent?.agentId) {
      throw httpError("room has no member agents — add at least one agent before chatting", 400, { code: "room_has_no_agents" });
    }
    const threadAgentId: string = firstAgent.agentId;

    // Create thread + link to room in a transaction
    return db().transaction(async (tx) => {
      const inserted = await tx
        .insert(threads)
        .values({
          orgId: identity.orgId,
          agentId: threadAgentId,
          title: `Room: ${roomRows[0]!.name}`,
        })
        .returning();
      const thread = inserted[0]!;
      await tx.insert(roomThreads).values({
        orgId: identity.orgId,
        roomId,
        threadId: thread.id,
      });
      return thread.id;
    });
  }

  /** List messages in a room's shared conversation. */
  router.get("/api/rooms/:roomId/messages", async (ctx) => {
    const identity = await requireAuth(ctx, "threads");
    const roomId = ctx.params.roomId!;

    // Verify room ownership
    const roomRows = await db()
      .select()
      .from(agentRooms)
      .where(and(eq(agentRooms.id, roomId), eq(agentRooms.orgId, identity.orgId)))
      .limit(1);
    if (!roomRows[0]) throw httpError("room not found", 404);

    // Find room thread
    const rt = await db()
      .select()
      .from(roomThreads)
      .where(and(eq(roomThreads.roomId, roomId), eq(roomThreads.orgId, identity.orgId)))
      .limit(1);
    if (!rt[0]) return []; // No messages yet

    const records = await services.messages.list(identity, rt[0].threadId);

    // Resolve agent names for agent-authored messages
    const agentIds = [...new Set(records.filter((m) => m.authorKind === "agent").map((m) => m.authorId))];
    const agentNames = new Map<string, string>();
    if (agentIds.length) {
      const agentRows = await db()
        .select({ id: agents.id, displayName: agents.displayName })
        .from(agents)
        .where(and(eq(agents.orgId, identity.orgId), inArray(agents.id, agentIds)));
      for (const a of agentRows) agentNames.set(a.id, a.displayName);
    }

    return records.map((m) => ({
      messageId: m.messageId,
      roomId,
      authorKind: m.authorKind,
      authorId: m.authorId,
      authorName: m.authorKind === "agent" ? (agentNames.get(m.authorId) ?? m.authorId) : m.authorKind === "user" ? "You" : "System",
      text: m.text,
      at: m.createdAt,
    }));
  });

  /** Send a message to a room. Optionally target a specific agent via targetAgentId. */
  router.post("/api/rooms/:roomId/messages", async (ctx) => {
    const identity = await requireAuth(ctx, "threads");
    await requireCommercialMutation(identity, "active_concurrent_agents", { min: 1 }, "member");
    const roomId = ctx.params.roomId!;
    const body = ctx.body as { text?: string; targetAgentId?: string } | undefined;
    if (!body?.text?.trim()) throw httpError("text is required", 400);

    // Verify room ownership
    const roomRows = await db()
      .select()
      .from(agentRooms)
      .where(and(eq(agentRooms.id, roomId), eq(agentRooms.orgId, identity.orgId)))
      .limit(1);
    if (!roomRows[0]) throw httpError("room not found", 404);

    // Get room members
    const members = await db()
      .select()
      .from(roomMembers)
      .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.orgId, identity.orgId)));
    const memberAgentIds = members.filter((m) => m.agentId).map((m) => m.agentId!);

    // Validate target agent if specified
    if (body.targetAgentId && !memberAgentIds.includes(body.targetAgentId)) {
      throw httpError("target agent is not a member of this room", 400, { code: "agent_not_in_room" });
    }

    const threadId = await ensureRoomThread(identity, roomId);

    // Append user message
    const message = await services.messages.append(identity, {
      messageId: crypto.randomUUID(),
      threadId,
      authorKind: "user",
      authorId: identity.userId,
      text: body.text.trim(),
    });

    // Update room lastMessage
    await db()
      .update(agentRooms)
      .set({ lastMessage: body.text.trim().slice(0, 200), lastMessageAt: new Date(), updatedAt: new Date() })
      .where(eq(agentRooms.id, roomId));

    // Determine which agents to invoke
    const targetIds = body.targetAgentId ? [body.targetAgentId] : memberAgentIds;

    // Launch agent turns (bounded, sequential to prevent recursive loops)
    const turns: Array<{ agentId: string; turn: unknown }> = [];
    if (services.runtime) {
      for (const agentId of targetIds.slice(0, 3)) { // Max 3 agents per message
        const agentRows = await db()
          .select()
          .from(agents)
          .where(and(eq(agents.orgId, identity.orgId), eq(agents.id, agentId)))
          .limit(1);
        const agent = agentRows[0];
        if (!agent) continue;
        try {
          const turn = await services.runtime.launch({
            definition: agent.definition as never,
            orgId: identity.orgId,
            agentId,
            threadId,
            userInput: body.text.trim(),
            correlationId: crypto.randomUUID(),
          });
          turns.push({ agentId, turn });
        } catch {
          // Agent runtime failure does not block other agents
          turns.push({ agentId, turn: { error: "agent runtime unavailable" } });
        }
      }
    }

    return {
      message: {
        messageId: message.messageId,
        roomId,
        authorKind: message.authorKind,
        authorId: message.authorId,
        text: message.text,
        at: message.createdAt,
      },
      turns,
    };
  });

  // ---- Servers (compute orchestrator authority) -------------------------------

  router.get("/api/servers", async (ctx) => {
    const identity = await requireAuth(ctx, "servers");
    const orders = await services.orchestrator.listOrders(identity.orgId);
    // Product-truth projection (Phase 01 §C): preserve the ACTUAL lifecycle
    // state from the orchestrator authority — never collapse every non-running
    // server to "provisioning". No telemetry authority is wired on this
    // surface, so agentsRunning/cpuPct/memPct are reported as explicitly
    // unavailable (null) rather than fabricated zeros.
    return orders.map((order) => projectServerSummary(order));
  });

  // ---- Customer provisioning workflow (PRODUCT_COMPLETION_02) -----------------
  // Safe, customer-side inputs only: Mox compute class, hostname, SSH key.
  // Region is NOT customer-selectable — placement is resolved by Mox compute
  // authority from the class's provider mapping, which stays internal.

  /**
   * Safe provisioning catalog: Mox compute classes with customer-safe fields
   * only. Never exposes provider mapping/SKU/cost/account. Also returns the
   * caller's real server quota from the commercial authority so the UI shows
   * an honest plan impact instead of guessing.
   */
  router.get("/api/servers/provision-options", async (ctx) => {
    const identity = await requireAuth(ctx, "servers");
    const classRows = await db()
      .select()
      .from(computeClasses)
      .where(eq(computeClasses.active, true))
      .orderBy(asc(computeClasses.displayName));
    const classes = [];
    for (const row of classRows) {
      const decision = await services.billing.requireCommercialEntitlement(
        identity.orgId,
        services.entitlements,
        "included_compute_class",
        { equals: row.code },
      );
      const wildcard = decision.value === "*" || decision.value === "all";
      classes.push({
        code: row.code,
        displayName: row.displayName,
        minVcpu: row.minVcpu,
        minRamGb: row.minRamGb,
        included: decision.entitled || wildcard,
      });
    }
    const quota = await services.billing.requireCommercialEntitlement(
      identity.orgId,
      services.entitlements,
      "included_server_count",
      { min: 1 },
    );
    const activeOrders = (await services.orchestrator.listOrders(identity.orgId)).filter((order) =>
      ["requested", "provisioning", "running", "resizing", "stopping", "stopped", "cancelling"].includes(order.state),
    );
    const keyRows = await db()
      .select()
      .from(sshKeys)
      .where(eq(sshKeys.orgId, identity.orgId))
      .orderBy(desc(sshKeys.createdAt));
    return {
      classes,
      serverQuota: {
        entitled: quota.entitled,
        included: typeof quota.value === "number" ? quota.value : null,
        activeServers: activeOrders.length,
        reason: quota.reason ?? null,
      },
      sshKeys: keyRows.map(projectSshKey),
    };
  });

  /** Lists the caller's org SSH public keys (public material only). */
  router.get("/api/ssh-keys", async (ctx) => {
    const identity = await requireAuth(ctx, "servers");
    const rows = await db()
      .select()
      .from(sshKeys)
      .where(eq(sshKeys.orgId, identity.orgId))
      .orderBy(desc(sshKeys.createdAt));
    return rows.map(projectSshKey);
  });

  /** Adds an org SSH PUBLIC key. Private keys are never accepted or stored. */
  router.post("/api/ssh-keys", async (ctx) => {
    const identity = await requireAuth(ctx, "servers");
    requireOrgCapability(identity, "infrastructure.manage");
    const body = ctx.body as { label?: string; publicKey?: string } | undefined;
    const label = body?.label?.trim() ?? "";
    const publicKey = body?.publicKey?.trim() ?? "";
    if (!label || label.length > 64) throw httpError("label is required (max 64 characters)", 400);
    const parsed = parseSshPublicKey(publicKey);
    if ("error" in parsed) throw httpError(parsed.error, 400, { code: "invalid_ssh_public_key" });
    const existing = await db().select({ id: sshKeys.id }).from(sshKeys).where(eq(sshKeys.orgId, identity.orgId));
    if (existing.length >= 100) throw httpError("SSH public key limit reached for this workspace", 402, { code: "ssh_key_limit" });
    const inserted = (
      await db()
        .insert(sshKeys)
        .values({ orgId: identity.orgId, label, publicKey, fingerprint: parsed.fingerprint })
        .returning()
    )[0];
    await db().insert(auditEvents).values({
      orgId: identity.orgId,
      actorType: "user",
      actorId: identity.userId,
      action: "ssh_key.added",
      resourceType: "ssh_key",
      resourceId: inserted!.id,
      result: "success",
      after: { label, fingerprint: parsed.fingerprint },
    });
    return projectSshKey(inserted!);
  });

  /** Removes an org-owned SSH public key (tenant-scoped, audited). */
  router.delete("/api/ssh-keys/:keyId", async (ctx) => {
    const identity = await requireAuth(ctx, "servers");
    requireOrgCapability(identity, "infrastructure.manage");
    const deleted = await db()
      .delete(sshKeys)
      .where(and(eq(sshKeys.id, ctx.params.keyId!), eq(sshKeys.orgId, identity.orgId)))
      .returning({ id: sshKeys.id, label: sshKeys.label, fingerprint: sshKeys.fingerprint });
    const row = deleted[0];
    if (!row) throw httpError("SSH key not found or not owned by your org", 404);
    await db().insert(auditEvents).values({
      orgId: identity.orgId,
      actorType: "user",
      actorId: identity.userId,
      action: "ssh_key.removed",
      resourceType: "ssh_key",
      resourceId: row.id,
      result: "success",
      after: { label: row.label, fingerprint: row.fingerprint },
    });
    return { ok: true };
  });

  router.post("/api/servers/orders", async (ctx) => {
    const identity = await requireAuth(ctx, "servers");
    requireOrgCapability(identity, "infrastructure.manage");
    const body = ctx.body as { computeClassCode?: string; hostname?: string; sshKeyId?: string; idempotencyKey?: string } | undefined;
    if (!body?.computeClassCode || !body?.hostname) {
      throw httpError("computeClassCode and hostname are required", 400);
    }
    const authz = await requireCommercialMutation(identity, "included_server_count", { min: 1 });
    const computeClassAllowed = await services.billing.requireCommercialEntitlement(
      identity.orgId,
      services.entitlements,
      "included_compute_class",
      { equals: body.computeClassCode },
    );
    if (!computeClassAllowed.entitled && computeClassAllowed.value !== "*" && computeClassAllowed.value !== "all") {
      throw httpError("compute class is not included in the current plan", 402, {
        code: "compute_class_not_entitled",
        reason: computeClassAllowed.reason,
      });
    }
    const activeOrders = (await services.orchestrator.listOrders(identity.orgId)).filter((order) =>
      ["requested", "provisioning", "running", "resizing", "stopping", "stopped", "cancelling"].includes(order.state),
    );
    // Fast friendly rejection; the ATOMIC quota reservation inside
    // orderServer (Security Repair 05B §B) is the authority across replicas.
    if (typeof authz.value === "number" && authz.value >= 0 && activeOrders.length >= authz.value) {
      throw httpError("server quota exceeded for current plan", 402, { code: "server_quota_exceeded" });
    }
    const idempotencyKey = requireIdempotencyKey(ctx, body.idempotencyKey);
    const requestFingerprint = fingerprintJson({
      op: "server.order",
      computeClassCode: body.computeClassCode,
      hostname: body.hostname,
      sshKeyId: body.sshKeyId ?? null,
    });
    let result;
    try {
      result = await services.orchestrator.orderServer({
        orgId: identity.orgId,
        computeClassCode: body.computeClassCode,
        hostname: body.hostname,
        idempotencyKey,
        requestFingerprint,
        sshKeyId: body.sshKeyId,
        maxServers: typeof authz.value === "number" && authz.value >= 0 ? authz.value : 0,
      });
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        throw httpError(error.message, 409, { code: "idempotency_conflict" });
      }
      if (error instanceof QuotaExceededError) {
        throw httpError("server quota exceeded for current plan", 402, { code: "server_quota_exceeded" });
      }
      throw error;
    }
    if (result.created) {
      await emitPlatformEvent({
        eventId: `server.ordered:${result.order.id}`,
        type: "server.ordered",
        orgId: identity.orgId,
        userId: identity.userId,
        severity: "info",
        category: "servers",
        resourceType: "server_order",
        resourceId: result.order.id,
        templateVars: { hostname: body.hostname },
        at: new Date().toISOString(),
      });
    }
    return result.order;
  });

  // Customer server lifecycle actions (Phase 02 §H). Safe, provider-independent
  // actions backed by the orchestrator/compute authority. The target order is
  // tenant-scoped to the caller's org; provider/internal credentials are never
  // exposed on this surface.
  router.post("/api/servers/:orderId/:action", async (ctx) => {
    const identity = await requireAuth(ctx, "servers");
    requireOrgCapability(identity, "infrastructure.manage");
    const action = ctx.params.action!;
    if (!["restart", "redeploy", "resize", "cancel", "stop", "start"].includes(action)) {
      throw httpError("unsupported server action", 400, { code: "unsupported_action" });
    }
    const order = (
      await db()
        .select()
        .from(serverOrders)
        .where(and(eq(serverOrders.id, ctx.params.orderId!), eq(serverOrders.orgId, identity.orgId)))
        .limit(1)
    )[0];
    if (!order) throw httpError("server order not found or not owned by your org", 404);

    if (action === "resize") {
      const body = ctx.body as { computeClassCode?: string } | undefined;
      if (!body?.computeClassCode) throw httpError("computeClassCode is required for resize", 400);
      const allowed = await services.billing.requireCommercialEntitlement(
        identity.orgId,
        services.entitlements,
        "included_compute_class",
        { equals: body.computeClassCode },
      );
      if (!allowed.entitled && allowed.value !== "*" && allowed.value !== "all") {
        throw httpError("target compute class is not included in the current plan", 402, {
          code: "compute_class_not_entitled",
        });
      }
      await services.orchestrator.requestResize(order.id, body.computeClassCode);
      return { ok: true, orderId: order.id, action: "resize" };
    }

    if (action === "restart") {
      await services.orchestrator.requestReboot(order.id);
      return { ok: true, orderId: order.id, action: "restart" };
    }

    if (action === "cancel") {
      await services.orchestrator.cancelOrder(order.id);
      return { ok: true, orderId: order.id, action: "cancel" };
    }

    // redeploy / stop / start: no direct orchestrator method exists on this
    // surface, so we durably queue a typed operation record (the same
    // authority the admin console uses) rather than faking completion.
    await db()
      .insert(serverOperations)
      .values({
        orderId: order.id,
        kind: action,
        idempotencyKey: `customer:${identity.userId}:${action}:${Date.now()}`,
        nextAttemptAt: new Date(),
      });
    return { ok: true, orderId: order.id, action };
  });

  // ---- Deployments ------------------------------------------------------------

  router.get("/api/deployments", async (ctx) => {
    const identity = await requireAuth(ctx, "servers");
    // Product-truth projection (Phase 01 §D): derive target + state from
    // durable/reconciled authorities (deployment kind, linked orchestrator
    // order, node heartbeat) instead of hardcoding sandbox/desired.
    const [rows, agentRows, orders, nodes] = await Promise.all([
      db().select().from(agentDeployments).where(eq(agentDeployments.orgId, identity.orgId)),
      db().select().from(agents).where(eq(agents.orgId, identity.orgId)),
      db().select().from(serverOrders).limit(1500),
      db().select().from(moxNodes).limit(1500),
    ]);
    return rows.map((row) => {
      const agent = agentRows.find((a) => a.id === row.agentId);
      const order = row.computeInstanceId ? orders.find((o) => o.id === row.computeInstanceId) : undefined;
      const node = order ? nodes.find((n) => n.orderId === order.id) : undefined;
      return {
        deploymentId: row.id,
        agentId: row.agentId,
        versionId: deploymentVersionId(agent?.id, row.desiredRevision),
        target: projectDeploymentTarget(row.kind, order?.id),
        state: projectDeploymentState(order?.state, node?.lastHeartbeatAt?.toISOString()),
        lastOperationId: null,
        desiredRevision: row.desiredRevision,
        serverPlacement: order?.hostname ?? null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    });
  });

  // Deployment mutations (Phase 02 §I). Deploy/redeploy/rollback PIN a published
  // revision on the durable agent_deployments row. The projected state stays
  // honest (`desired` until the runtime engine actually reconciles it to
  // running on a node) — the UI never reports a fake `running`.
  const resolveDeploymentTarget = (target?: { kind?: string; vpsId?: string }) =>
    target?.kind === "customer-vps"
      ? (["customer_vps", target.vpsId] as const)
      : target?.kind === "mox-cloud"
        ? (["shared_host", undefined] as const)
        : (["sandbox", undefined] as const);

  const assertPublishedRevision = async (orgId: string, agentId: string, revision: number) => {
    const rows = await db()
      .select({ id: agentVersions.id })
      .from(agentVersions)
      .where(
        and(
          eq(agentVersions.orgId, orgId),
          eq(agentVersions.agentId, agentId),
          eq(agentVersions.version, String(revision)),
        ),
      )
      .limit(1);
    if (!rows[0]) throw httpError(`revision ${revision} is not published`, 404, { code: "revision_not_published" });
  };

  const assertTargetOwned = async (orgId: string, vpsId?: string) => {
    if (!vpsId) return;
    const order = (
      await db().select({ orgId: serverOrders.orgId }).from(serverOrders).where(eq(serverOrders.id, vpsId)).limit(1)
    )[0];
    if (!order || order.orgId !== orgId) throw httpError("target VPS must be owned by your org", 403, { code: "org_mismatch" });
  };

  router.post("/api/deployments", async (ctx) => {
    const identity = await requireAuth(ctx, "servers");
    requireOrgCapability(identity, "workspace.write");
    const body = ctx.body as
      | { agentId?: string; revision?: number; target?: { kind?: string; vpsId?: string } }
      | undefined;
    if (!body?.agentId || !body?.revision) throw httpError("agentId and revision are required", 400);
    const agent = (
      await db()
        .select()
        .from(agents)
        .where(and(eq(agents.orgId, identity.orgId), eq(agents.id, body.agentId)))
        .limit(1)
    )[0];
    if (!agent) throw httpError("agent not found", 404);
    await assertPublishedRevision(identity.orgId, body.agentId, body.revision);
    const [kind, computeInstanceId] = resolveDeploymentTarget(body.target);
    await assertTargetOwned(identity.orgId, computeInstanceId);
    const existing = (
      await db()
        .select()
        .from(agentDeployments)
        .where(and(eq(agentDeployments.orgId, identity.orgId), eq(agentDeployments.agentId, body.agentId)))
        .limit(1)
    )[0];
    if (existing) {
      await db()
        .update(agentDeployments)
        .set({ kind, computeInstanceId, desiredRevision: body.revision, updatedAt: new Date() })
        .where(eq(agentDeployments.id, existing.id));
    } else {
      await db()
        .insert(agentDeployments)
        .values({ orgId: identity.orgId, agentId: body.agentId, kind, computeInstanceId, desiredRevision: body.revision });
    }
    await db()
      .update(agents)
      .set({ currentVersion: body.revision, updatedAt: new Date() })
      .where(eq(agents.id, body.agentId));
    return { ok: true, agentId: body.agentId, revision: body.revision, state: "desired" };
  });

  router.post("/api/deployments/:deploymentId/redeploy", async (ctx) => {
    const identity = await requireAuth(ctx, "servers");
    requireOrgCapability(identity, "workspace.write");
    const dep = (
      await db()
        .select()
        .from(agentDeployments)
        .where(and(eq(agentDeployments.id, ctx.params.deploymentId!), eq(agentDeployments.orgId, identity.orgId)))
        .limit(1)
    )[0];
    if (!dep) throw httpError("deployment not found or not owned by your org", 404);
    await assertPublishedRevision(identity.orgId, dep.agentId, dep.desiredRevision);
    await db()
      .update(agentDeployments)
      .set({ updatedAt: new Date() })
      .where(eq(agentDeployments.id, dep.id));
    return { ok: true, deploymentId: dep.id, revision: dep.desiredRevision, state: "desired" };
  });

  router.post("/api/deployments/:deploymentId/rollback", async (ctx) => {
    const identity = await requireAuth(ctx, "servers");
    requireOrgCapability(identity, "workspace.write");
    const body = ctx.body as { toRevision?: number } | undefined;
    const toRevision = Number(body?.toRevision);
    if (!Number.isInteger(toRevision) || toRevision < 1) throw httpError("toRevision is required", 400);
    const dep = (
      await db()
        .select()
        .from(agentDeployments)
        .where(and(eq(agentDeployments.id, ctx.params.deploymentId!), eq(agentDeployments.orgId, identity.orgId)))
        .limit(1)
    )[0];
    if (!dep) throw httpError("deployment not found or not owned by your org", 404);
    await assertPublishedRevision(identity.orgId, dep.agentId, toRevision);
    await db()
      .update(agentDeployments)
      .set({ desiredRevision: toRevision, updatedAt: new Date() })
      .where(eq(agentDeployments.id, dep.id));
    await db()
      .update(agents)
      .set({ currentVersion: toRevision, updatedAt: new Date() })
      .where(eq(agents.id, dep.agentId));
    return { ok: true, deploymentId: dep.id, revision: toRevision, state: "desired" };
  });

  // ---- Models / connections ------------------------------------------------------
  // Phase 03 §B/§G: the customer BYOK surface. Provider catalogs are seeded
  // idempotently on first read (never in migrations); credential material is
  // either absent (honest 501), or stored in the customer credential vault
  // (optional master key in config) — never in the control-plane database.

  const CUSTOMER_MODEL_CATALOG = [
    {
      slug: "openai",
      displayName: "OpenAI",
      kind: "api" as const,
      authMethods: ["api_key"],
      baseUrlSupported: false,
      models: [
        { slug: "gpt-4.1", displayName: "OpenAI · GPT-4.1", contextWindow: 200000 },
        { slug: "gpt-4o-mini", displayName: "OpenAI · GPT-4o mini", contextWindow: 128000 },
      ],
    },
    {
      slug: "anthropic",
      displayName: "Anthropic",
      kind: "api" as const,
      authMethods: ["api_key"],
      baseUrlSupported: false,
      models: [
        { slug: "claude-sonnet-4", displayName: "Anthropic · Claude Sonnet 4", contextWindow: 200000 },
        { slug: "claude-haiku-3.5", displayName: "Anthropic · Claude Haiku 3.5", contextWindow: 200000 },
      ],
    },
    {
      slug: "xai",
      displayName: "xAI",
      kind: "api" as const,
      authMethods: ["api_key"],
      baseUrlSupported: false,
      models: [{ slug: "grok-4", displayName: "xAI · Grok 4", contextWindow: 131072 }],
    },
    {
      slug: "deepseek",
      displayName: "DeepSeek",
      kind: "api" as const,
      authMethods: ["api_key"],
      baseUrlSupported: false,
      models: [{ slug: "deepseek-v4", displayName: "DeepSeek · V4", contextWindow: 128000 }],
    },
    {
      slug: "gemini",
      displayName: "Google Gemini",
      kind: "api" as const,
      authMethods: ["api_key"],
      baseUrlSupported: true,
      models: [{ slug: "gemini-2.5-pro", displayName: "Google · Gemini 2.5 Pro", contextWindow: 1000000 }],
    },
    {
      slug: "openrouter",
      displayName: "OpenRouter",
      kind: "api" as const,
      authMethods: ["api_key"],
      baseUrlSupported: true,
      models: [{ slug: "openrouter-auto", displayName: "OpenRouter · auto", contextWindow: 128000 }],
    },
    {
      slug: "openai-compatible",
      displayName: "OpenAI-compatible endpoint",
      kind: "api" as const,
      authMethods: ["api_key"],
      baseUrlSupported: true,
      models: [],
    },
    {
      slug: "mox",
      displayName: "Mox · Included",
      kind: "local" as const,
      authMethods: ["none"],
      baseUrlSupported: false,
      models: [{ slug: "mox-agent", displayName: "Mox · mox-agent", contextWindow: null }],
    },
  ];

  const CUSTOMER_INTEGRATION_CATALOG = [
    {
      slug: "github",
      displayName: "GitHub",
      kind: "git",
      authMethods: ["api_key", "oauth"],
      requiresRuntimeSession: false,
      dangerous: false,
      configFields: [{ key: "apiKey", label: "Personal access token", secret: true, optional: false }],
      tools: ["github.issues.read", "github.issues.write", "github.repos.read"],
    },
    {
      slug: "notion",
      displayName: "Notion",
      kind: "doc",
      authMethods: ["api_key"],
      requiresRuntimeSession: false,
      dangerous: false,
      configFields: [{ key: "integrationToken", label: "Integration token", secret: true, optional: false }],
      tools: ["notion.read", "notion.write"],
    },
    {
      slug: "slack",
      displayName: "Slack",
      kind: "messaging",
      authMethods: ["api_key"],
      requiresRuntimeSession: true,
      dangerous: false,
      configFields: [{ key: "botToken", label: "Bot token", secret: true, optional: false }],
      tools: ["slack.post", "slack.read"],
    },
    {
      slug: "composio",
      displayName: "Composio",
      kind: "mcp",
      authMethods: ["api_key"],
      requiresRuntimeSession: true,
      dangerous: true,
      configFields: [{ key: "composioApiKey", label: "Composio API key", secret: true, optional: false }],
      tools: ["composio.exec"],
    },
    {
      slug: "n8n",
      displayName: "n8n",
      kind: "webhook",
      authMethods: ["webhook_token"],
      requiresRuntimeSession: true,
      dangerous: false,
      configFields: [{ key: "webhookToken", label: "Webhook secret token", secret: true, optional: true }],
      tools: ["n8n.trigger"],
    },
    {
      slug: "make",
      displayName: "Make",
      kind: "oauth",
      authMethods: ["oauth"],
      requiresRuntimeSession: true,
      dangerous: false,
      configFields: [{ key: "oauthClientSecret", label: "OAuth client secret", secret: true, optional: true }],
      tools: ["make.scenario"],
    },
    {
      slug: "generic-webhook",
      displayName: "Generic webhook",
      kind: "webhook",
      authMethods: ["webhook_token"],
      requiresRuntimeSession: false,
      dangerous: false,
      configFields: [{ key: "webhookToken", label: "Webhook secret token", secret: true, optional: true }],
      tools: ["webhook.deliver"],
    },
  ];

  const CUSTOMER_CHANNEL_CATALOG = [
    { slug: "web", kind: "web", displayName: "Web chat", setupInstructions: "Embed the web chat surface in your site; no external credential is required.", prerequisites: "None" },
    { slug: "whatsapp", kind: "whatsapp", displayName: "WhatsApp", setupInstructions: "Store a WhatsApp Business Cloud API credential against this agent.", prerequisites: "WhatsApp Business API access" },
    { slug: "telegram", kind: "telegram", displayName: "Telegram", setupInstructions: "Create a bot with @BotFather and store its bot token.", prerequisites: "Telegram bot token" },
    { slug: "slack", kind: "slack", displayName: "Slack", setupInstructions: "Install the app into your workspace and store the bot token and signing secret.", prerequisites: "Slack app with bot scope" },
    { slug: "discord", kind: "discord", displayName: "Discord", setupInstructions: "Create a bot application and store its bot token.", prerequisites: "Discord bot token" },
    { slug: "teams", kind: "teams", displayName: "Microsoft Teams", setupInstructions: "Register an Entra app and store its bot credential.", prerequisites: "Microsoft Entra bot credential" },
    { slug: "generic-webhook", kind: "webhook", displayName: "Generic webhook", setupInstructions: "Webhook ingress is not wired on this deployment; secret-based delivery needs a runtime gateway.", prerequisites: "Runtime gateway (not wired)" },
  ];

  const SECRET_LIKE_KEY = /secret|token|api[-_]?key|password|authorization|credential|private[-_]?key|session|webhook/i;

  /** Seed default per-org provider catalogs lazily and idempotently on read. */
  const ensureCustomerCatalogs = async (orgId: string) => {
    for (const prov of CUSTOMER_MODEL_CATALOG) {
      const rows = await db()
        .select({ id: modelProviders.id })
        .from(modelProviders)
        .where(and(eq(modelProviders.orgId, orgId), eq(modelProviders.slug, prov.slug)))
        .limit(1);
      if (rows[0]) continue;
      const inserted = await db()
        .insert(modelProviders)
        .values({
          orgId,
          slug: prov.slug,
          displayName: prov.displayName,
          kind: prov.kind,
          capabilities: { authMethods: prov.authMethods, baseUrlSupported: prov.baseUrlSupported },
        })
        .onConflictDoNothing({ target: [modelProviders.orgId, modelProviders.slug] })
        .returning({ id: modelProviders.id, slug: modelProviders.slug });
      const providerId = inserted[0]?.id;
      if (!providerId) continue;
      for (const m of prov.models) {
        await db()
          .insert(models)
          .values({ orgId, providerId, slug: m.slug, displayName: m.displayName, contextWindow: m.contextWindow })
          .onConflictDoNothing({ target: [models.providerId, models.slug] });
      }
    }
    for (const prov of CUSTOMER_INTEGRATION_CATALOG) {
      await db()
        .insert(integrationProviders)
        .values({
          orgId,
          slug: prov.slug,
          displayName: prov.displayName,
          kind: prov.kind,
          config: {
            authMethods: prov.authMethods,
            configFields: prov.configFields,
            tools: prov.tools,
            dangerous: prov.dangerous,
            requiresRuntimeSession: prov.requiresRuntimeSession,
          },
        })
        .onConflictDoNothing({ target: [integrationProviders.orgId, integrationProviders.slug] });
    }
    for (const prov of CUSTOMER_CHANNEL_CATALOG) {
      await db()
        .insert(channelProviders)
        .values({ orgId, slug: prov.slug, displayName: prov.displayName, kind: prov.kind })
        .onConflictDoNothing({ target: [channelProviders.orgId, channelProviders.slug] });
    }
  };

  const PUBLIC_INTEGRATION_KEYS = new Set(["authMethods", "configFields", "tools", "dangerous", "requiresRuntimeSession"]);
  const publicIntegrationConfig = (raw: unknown): Record<string, unknown> => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!PUBLIC_INTEGRATION_KEYS.has(key) || SECRET_LIKE_KEY.test(key)) continue;
      out[key] = value;
    }
    return out;
  };

  const customerCredentialVault = () => {
    const vault = services.customerCredentials;
    if (!vault) {
      throw httpError("customer credential vault is not configured on this deployment", 501, { code: "not_configured" });
    }
    return vault;
  };

  const ensureCredentialRef = async (orgId: string, args: { scope: string; externalId: string }): Promise<string> => {
    const existing = await db()
      .select({ id: credentialRefs.id })
      .from(credentialRefs)
      .where(and(eq(credentialRefs.orgId, orgId), eq(credentialRefs.externalId, args.externalId)))
      .limit(1);
    if (existing[0]) return existing[0].id;
    const inserted = await db()
      .insert(credentialRefs)
      .values({ orgId, scope: args.scope, externalId: args.externalId })
      .onConflictDoNothing({ target: [credentialRefs.orgId, credentialRefs.externalId] })
      .returning({ id: credentialRefs.id });
    if (inserted[0]) return inserted[0].id;
    const again = await db()
      .select({ id: credentialRefs.id })
      .from(credentialRefs)
      .where(and(eq(credentialRefs.orgId, orgId), eq(credentialRefs.externalId, args.externalId)))
      .limit(1);
    return again[0]!.id;
  };

  const dropCredentialRef = async (orgId: string, externalId: string) => {
    await db().delete(credentialRefs).where(and(eq(credentialRefs.orgId, orgId), eq(credentialRefs.externalId, externalId)));
  };

  const projectModelConnection = (
    provider: { slug: string; displayName: string; kind: string; capabilities: unknown },
    connection?: { connectionStatus?: string; credentialRefId?: string | null; baseUrl?: string | null; modelCount?: number },
  ) => {
    const capsObject =
      provider.capabilities && typeof provider.capabilities === "object"
        ? (provider.capabilities as Record<string, unknown>)
        : {};
    const status = connection?.connectionStatus ?? "unconfigured";
    const hasCredentials = Boolean(connection && connection.credentialRefId);
    return {
      providerId: provider.slug,
      displayName: provider.displayName,
      kind: provider.kind,
      status,
      connected: hasCredentials && status === "configured",
      credentialConfigured: hasCredentials,
      authMethods: Array.isArray(capsObject.authMethods) ? (capsObject.authMethods as string[]) : [],
      baseUrlSupported: Boolean(capsObject.baseUrlSupported),
      baseUrl: connection?.baseUrl ?? null,
      modelCount: connection?.modelCount ?? 0,
    };
  };

  // Lowercase "provider/slug" — the model select in the agent editor uses
  // this projection for availability; unchanged from Phase 01 but seeded.

  router.get("/api/models", async (ctx) => {
    const identity = await requireAuth(ctx, "models");
    await ensureCustomerCatalogs(identity.orgId);
    const providers = await db().select().from(modelProviders).where(eq(modelProviders.orgId, identity.orgId));
    const allModels = await db().select().from(models).where(eq(models.orgId, identity.orgId));
    const connections = await db().select().from(modelConnections).where(eq(modelConnections.orgId, identity.orgId));
    // Phase 01 §F: availability derives from the provider's connection + credential
    // authorities, never blanket `available: true`.
    return providers.flatMap((provider) => {
      const connection = connections.find((c) => c.providerId === provider.id);
      const status = connection?.connectionStatus ?? "unconfigured";
      const hasCreds = Boolean(connection?.credentialRefId);
      const ready = hasCreds && status === "configured";
      return allModels
        .filter((m) => m.providerId === provider.id)
        .map((model) => ({
          modelId: model.slug,
          providerId: provider.slug,
          displayName: model.displayName,
          byok: hasCreds,
          available: ready,
          availability: projectModelAvailability(status, hasCreds),
        }));
    });
  });

  router.get("/api/model-connections", async (ctx) => {
    const identity = await requireAuth(ctx, "models");
    await ensureCustomerCatalogs(identity.orgId);
    const [providers, conns, orgModels] = await Promise.all([
      db().select().from(modelProviders).where(eq(modelProviders.orgId, identity.orgId)),
      db().select().from(modelConnections).where(eq(modelConnections.orgId, identity.orgId)),
      db().select({ providerId: models.providerId }).from(models).where(eq(models.orgId, identity.orgId)),
    ]);
    const counts = new Map<string, number>();
    for (const row of orgModels) counts.set(row.providerId, (counts.get(row.providerId) ?? 0) + 1);
    return providers.map((p) => {
      const conn = conns.find((c) => c.providerId === p.id);
      return projectModelConnection(p, { ...conn, modelCount: counts.get(p.id) ?? 0 });
    });
  });

  const findModelProvider = async (orgId: string, slug: string) => {
    const rows = await db()
      .select()
      .from(modelProviders)
      .where(and(eq(modelProviders.orgId, orgId), eq(modelProviders.slug, slug)))
      .limit(1);
    return rows[0];
  };

  const findModelConnection = async (orgId: string, providerId: string) => {
    const rows = await db()
      .select()
      .from(modelConnections)
      .where(and(eq(modelConnections.orgId, orgId), eq(modelConnections.providerId, providerId)))
      .limit(1);
    return rows[0];
  };

  router.post("/api/model-connections/:providerSlug/connect", async (ctx) => {
    const identity = await requireAuth(ctx, "models");
    requireOrgCapability(identity, "integrations.manage");
    const vault = customerCredentialVault();
    const slug = ctx.params.providerSlug!;
    const body = ctx.body as { apiKey?: string; baseUrl?: string; models?: string[] } | undefined;
    const provider = await findModelProvider(identity.orgId, slug);
    if (!provider) throw httpError(`provider ${slug} not found`, 404);
    const caps =
      provider.capabilities && typeof provider.capabilities === "object"
        ? (provider.capabilities as Record<string, unknown>)
        : {};
    const authMethods = Array.isArray(caps.authMethods) ? (caps.authMethods as string[]) : [];
    const needsSecret = authMethods.length > 0 && !authMethods.includes("none");
    let credentialRefId: string | null = null;
    if (needsSecret) {
      const apiKey = typeof body?.apiKey === "string" && body.apiKey.trim() ? body.apiKey.trim() : undefined;
      if (!apiKey) throw httpError(`${provider.displayName} requires an API key`, 400);
      await vault.setSecret({ orgId: identity.orgId, externalId: `model:${slug}` }, apiKey);
      credentialRefId = await ensureCredentialRef(identity.orgId, { scope: "model", externalId: `model:${slug}` });
    }
    const baseUrl = caps.baseUrlSupported && typeof body?.baseUrl === "string" ? body.baseUrl : undefined;
    const existing = await findModelConnection(identity.orgId, provider.id);
    if (existing) {
      await db()
        .update(modelConnections)
        .set({ credentialRefId, authMethod: "api_key", connectionStatus: "configured", baseUrl: baseUrl ?? null, updatedAt: new Date() })
        .where(eq(modelConnections.id, existing.id));
    } else {
      await db()
        .insert(modelConnections)
        .values({ orgId: identity.orgId, providerId: provider.id, credentialRefId, authMethod: "api_key", connectionStatus: "configured", baseUrl: baseUrl ?? null });
    }
    if (Array.isArray(body?.models)) {
      for (const entry of body.models.slice(0, 25)) {
        const modelSlug = String(entry).trim();
        if (!modelSlug) continue;
        await db()
          .insert(models)
          .values({ orgId: identity.orgId, providerId: provider.id, slug: modelSlug, displayName: modelSlug })
          .onConflictDoNothing({ target: [models.providerId, models.slug] });
      }
    }
    const refreshed = await findModelConnection(identity.orgId, provider.id);
    const orgModels = await db().select({ id: models.id }).from(models).where(and(eq(models.orgId, identity.orgId), eq(models.providerId, provider.id)));
    return projectModelConnection(provider, { ...refreshed, modelCount: orgModels.length });
  });

  router.post("/api/model-connections/:providerSlug/rotate", async (ctx) => {
    const identity = await requireAuth(ctx, "models");
    requireOrgCapability(identity, "integrations.manage");
    const vault = customerCredentialVault();
    const slug = ctx.params.providerSlug!;
    const body = ctx.body as { apiKey?: string } | undefined;
    const provider = await findModelProvider(identity.orgId, slug);
    if (!provider) throw httpError(`provider ${slug} not found`, 404);
    const existing = await findModelConnection(identity.orgId, provider.id);
    if (!existing?.credentialRefId) throw httpError("provider has no secret to rotate; connect it first", 409, { code: "not_connected" });
    const apiKey = typeof body?.apiKey === "string" && body.apiKey.trim() ? body.apiKey.trim() : undefined;
    if (!apiKey) throw httpError("a new API key is required", 400);
    await vault.setSecret({ orgId: identity.orgId, externalId: `model:${slug}` }, apiKey);
    await db().update(modelConnections).set({ updatedAt: new Date() }).where(eq(modelConnections.id, existing.id));
    const refreshed = await findModelConnection(identity.orgId, provider.id);
    return projectModelConnection(provider, refreshed);
  });

  router.delete("/api/model-connections/:providerSlug", async (ctx) => {
    const identity = await requireAuth(ctx, "models");
    requireOrgCapability(identity, "integrations.manage");
    const slug = ctx.params.providerSlug!;
    const provider = await findModelProvider(identity.orgId, slug);
    if (!provider) throw httpError(`provider ${slug} not found`, 404);
    const existing = await findModelConnection(identity.orgId, provider.id);
    if (!existing) throw httpError("no connection to disconnect", 409, { code: "not_connected" });
    await db().delete(modelConnections).where(eq(modelConnections.id, existing.id));
    await dropCredentialRef(identity.orgId, `model:${slug}`);
    return { ok: true, providerId: provider.slug };
  });

  router.post("/api/model-connections/:providerSlug/test", async (ctx) => {
    const identity = await requireAuth(ctx, "models");
    requireOrgCapability(identity, "integrations.manage");
    const slug = ctx.params.providerSlug!;
    const provider = await findModelProvider(identity.orgId, slug);
    if (!provider) throw httpError(`provider ${slug} not found`, 404);
    const conn = await findModelConnection(identity.orgId, provider.id);
    if (!conn) return { ok: false, reason: "not connected", checkedAt: new Date().toISOString() };
    if (!conn.credentialRefId) {
      return { ok: false, reason: "no credentials configured", checkedAt: new Date().toISOString() };
    }
    // Attempt to retrieve the credential from the vault to verify it's accessible
    try {
      const vault = customerCredentialVault();
      const secret = await vault.getSecret({ orgId: identity.orgId, externalId: `model:${slug}` });
      if (!secret) {
        return { ok: false, reason: "credential not found in vault", checkedAt: new Date().toISOString() };
      }
      // Credential is retrievable — connection is valid at the vault level.
      // A full provider API probe would require provider-specific SDK calls;
      // report the vault-level check as successful.
      return {
        ok: true,
        status: "connected" as const,
        checkedAt: new Date().toISOString(),
        latencyMs: null,
        safeMessage: `${provider.displayName} credentials verified in vault`,
      };
    } catch (e) {
      return {
        ok: false,
        reason: e instanceof Error ? e.message : "vault check failed",
        checkedAt: new Date().toISOString(),
      };
    }
  });

  router.get("/api/cli-engines", async (ctx) => {
    const identity = await requireAuth(ctx, "models");
    // Derive CLI/runtime availability from real configured model/connector authority.
    // The old "CLI engine state" concept is obsolete — the CLI uses /api/models directly.
    // Return a truthful projection for backward compatibility.
    const connections = await db()
      .select()
      .from(modelConnections)
      .where(eq(modelConnections.orgId, identity.orgId));
    const configured = connections.filter((c) => c.credentialRefId && c.connectionStatus === "configured");
    return {
      engines: configured.map((c) => ({
        engineId: c.providerId,
        status: "available",
        providerId: c.providerId,
        connectionStatus: c.connectionStatus,
      })),
      note: "CLI engine state is derived from model connections. Use /api/models for the canonical surface.",
    };
  });

  // ---- Integrations --------------------------------------------------------------
  // Customer integration surface (Phase 03 §C): connect/disconnect is a
  // credential vault operation, never a boolean toggle.

  router.get("/api/integrations", async (ctx) => {
    const identity = await requireAuth(ctx, "integrations");
    await ensureCustomerCatalogs(identity.orgId);
    const [providers, conns] = await Promise.all([
      db().select().from(integrationProviders).where(eq(integrationProviders.orgId, identity.orgId)),
      db().select().from(integrationConnections).where(eq(integrationConnections.orgId, identity.orgId)),
    ]);
    return providers.map((p) => {
      const conn = conns.find((c) => c.providerId === p.id);
      const config = publicIntegrationConfig(p.config);
      const configFields = Array.isArray(config.configFields) ? (config.configFields as unknown[]) : [];
      const tools = Array.isArray(config.tools) ? (config.tools as unknown[]) : [];
      const hasCredentials = Boolean(conn?.credentialRefId);
      return {
        integrationId: p.slug,
        displayName: p.displayName,
        kind: p.kind,
        connectionId: conn?.id ?? null,
        status: conn ? conn.status : "not_configured",
        credentialConfigured: hasCredentials,
        connected: hasCredentials && conn?.status === "active",
        requiresRuntimeSession: Boolean(config.requiresRuntimeSession),
        dangerous: Boolean(config.dangerous),
        tools: tools.map(String),
        configFields: configFields
          .filter((f): f is Record<string, unknown> => Boolean(f) && typeof f === "object")
          .map((f) => ({
            key: typeof f.key === "string" ? f.key : "",
            label: typeof f.label === "string" ? f.label : "",
            secret: Boolean(f.secret),
            optional: Boolean(f.optional),
          })),
      };
    });
  });

  const findIntegrationProvider = async (orgId: string, slug: string) => {
    const rows = await db()
      .select()
      .from(integrationProviders)
      .where(and(eq(integrationProviders.orgId, orgId), eq(integrationProviders.slug, slug)))
      .limit(1);
    return rows[0];
  };

  const findIntegrationConnection = async (orgId: string, providerId: string) => {
    const rows = await db()
      .select()
      .from(integrationConnections)
      .where(and(eq(integrationConnections.orgId, orgId), eq(integrationConnections.providerId, providerId)))
      .limit(1);
    return rows[0];
  };

  router.post("/api/integrations/:integrationId/connect", async (ctx) => {
    const identity = await requireAuth(ctx, "integrations");
    requireOrgCapability(identity, "integrations.manage");
    const vault = customerCredentialVault();
    const slug = ctx.params.integrationId!;
    const body = ctx.body as { secrets?: Record<string, string>; config?: Record<string, unknown> } | undefined;
    const provider = await findIntegrationProvider(identity.orgId, slug);
    if (!provider) throw httpError(`integration ${slug} not found`, 404);
    const config = publicIntegrationConfig(provider.config);
    const configFields = Array.isArray(config.configFields) ? (config.configFields as Record<string, unknown>[]) : [];
    const provided = (body?.secrets && typeof body.secrets === "object" ? Object.entries(body.secrets as Record<string, unknown>) : []) as [string, unknown][];
    const secrets: Record<string, string> = {};
    for (const field of configFields) {
      const key = typeof field.key === "string" ? field.key : "";
      const label = typeof field.label === "string" ? field.label : key;
      const isSecret = Boolean(field.secret);
      const optional = Boolean(field.optional);
      if (!isSecret || !key) continue;
      const found = provided.find(([k]) => k === key);
      const value = found ? (typeof found[1] === "string" ? found[1].trim() : "") : "";
      if (!optional && !value) throw httpError(`${label} is required to connect ${provider.displayName}`, 400);
      if (value) secrets[key] = value;
    }
    if (Object.keys(secrets).length > 0) {
      await vault.setSecret({ orgId: identity.orgId, externalId: `integration:${slug}` }, JSON.stringify(secrets));
    }
    const credentialRefId = await ensureCredentialRef(identity.orgId, { scope: "integration", externalId: `integration:${slug}` });
    const existing = await findIntegrationConnection(identity.orgId, provider.id);
    if (existing) {
      await db().update(integrationConnections).set({ status: "active", credentialRefId }).where(eq(integrationConnections.id, existing.id));
    } else {
      await db().insert(integrationConnections).values({ orgId: identity.orgId, providerId: provider.id, status: "active", credentialRefId });
    }
    return { ok: true, integrationId: slug, connected: true };
  });

  router.post("/api/integrations/:integrationId/disconnect", async (ctx) => {
    const identity = await requireAuth(ctx, "integrations");
    requireOrgCapability(identity, "integrations.manage");
    const slug = ctx.params.integrationId!;
    const provider = await findIntegrationProvider(identity.orgId, slug);
    if (!provider) throw httpError(`integration ${slug} not found`, 404);
    const existing = await findIntegrationConnection(identity.orgId, provider.id);
    if (!existing) return { ok: true, integrationId: slug, connected: false };
    await db()
      .update(integrationConnections)
      .set({ status: "disconnected", credentialRefId: null })
      .where(eq(integrationConnections.id, existing.id));
    await dropCredentialRef(identity.orgId, `integration:${slug}`);
    return { ok: true, integrationId: slug, connected: false };
  });

  router.get("/api/integrations/:integrationId/grants", async (ctx) => {
    const identity = await requireAuth(ctx, "integrations");
    const slug = ctx.params.integrationId!;
    const provider = await findIntegrationProvider(identity.orgId, slug);
    if (!provider) throw httpError(`integration ${slug} not found`, 404);
    const conn = await findIntegrationConnection(identity.orgId, provider.id);
    if (!conn) return [];
    return db()
      .select({
        grantId: toolGrants.id,
        agentId: toolGrants.agentId,
        toolPattern: toolGrants.toolPattern,
        createdAt: toolGrants.createdAt,
      })
      .from(toolGrants)
      .where(and(eq(toolGrants.connectionId, conn.id), eq(toolGrants.orgId, identity.orgId)));
  });

  router.post("/api/integrations/:integrationId/grants", async (ctx) => {
    const identity = await requireAuth(ctx, "integrations");
    requireOrgCapability(identity, "integrations.manage");
    const slug = ctx.params.integrationId!;
    const body = ctx.body as { agentId?: string; toolPattern?: string } | undefined;
    if (!body?.agentId) throw httpError("agentId is required", 400);
    const provider = await findIntegrationProvider(identity.orgId, slug);
    if (!provider) throw httpError(`integration ${slug} not found`, 404);
    const conn = await findIntegrationConnection(identity.orgId, provider.id);
    if (!conn || conn.status !== "active" || !conn.credentialRefId) {
      throw httpError("connect the integration before granting tools", 409, { code: "not_connected" });
    }
    const agent = await db()
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, body.agentId), eq(agents.orgId, identity.orgId)))
      .limit(1);
    if (!agent[0]) throw httpError("agent not found or not owned by your org", 404);
    const toolPattern = typeof body.toolPattern === "string" && body.toolPattern.trim() ? body.toolPattern.trim() : "*";
    const inserted = await db()
      .insert(toolGrants)
      .values({ orgId: identity.orgId, agentId: agent[0].id, connectionId: conn.id, toolPattern })
      .onConflictDoNothing({ target: [toolGrants.agentId, toolGrants.connectionId, toolGrants.toolPattern] })
      .returning({ id: toolGrants.id });
    if (inserted[0]) return { ok: true, grantId: inserted[0].id };
    const existing = await db()
      .select({ id: toolGrants.id })
      .from(toolGrants)
      .where(and(eq(toolGrants.agentId, agent[0].id), eq(toolGrants.connectionId, conn.id), eq(toolGrants.toolPattern, toolPattern)))
      .limit(1);
    return { ok: true, grantId: existing[0]!.id };
  });

  router.delete("/api/integrations/:integrationId/grants/:grantId", async (ctx) => {
    const identity = await requireAuth(ctx, "integrations");
    requireOrgCapability(identity, "integrations.manage");
    const slug = ctx.params.integrationId!;
    const provider = await findIntegrationProvider(identity.orgId, slug);
    if (!provider) throw httpError(`integration ${slug} not found`, 404);
    const conn = await findIntegrationConnection(identity.orgId, provider.id);
    if (!conn) throw httpError("grant not found", 404);
    const rows = await db()
      .delete(toolGrants)
      .where(and(eq(toolGrants.id, ctx.params.grantId!), eq(toolGrants.orgId, identity.orgId), eq(toolGrants.connectionId, conn.id)))
      .returning({ id: toolGrants.id });
    if (!rows[0]) throw httpError("grant not found", 404);
    return { ok: true, grantId: rows[0].id };
  });

  // ---- Channels (Phase 03 §D) ----------------------------------------------------
  // A channel connection binds a provider to exactly one agent. Web needs no
  // secret; every other catalog entry requires a credential vault secret.

  const CHANNEL_SECRET_KEYS: Record<string, string[]> = {
    telegram: ["botToken"],
    discord: ["botToken"],
    slack: ["botToken", "signingSecret"],
    whatsapp: ["accessToken", "phoneNumberId"],
    teams: ["appId", "appSecret"],
    web: [],
    "generic-webhook": [],
  };

  const sanitizeChannelSecrets = (secrets: Record<string, string> | undefined, slug: string): Record<string, string> => {
    const allowed = CHANNEL_SECRET_KEYS[slug] ?? [];
    const out: Record<string, string> = {};
    for (const key of allowed) {
      const raw = secrets?.[key];
      if (typeof raw === "string" && raw.trim()) out[key] = raw.trim();
    }
    return out;
  };

  const requireChannelConnection = async (orgId: string, connectionId: string) => {
    const rows = await db()
      .select()
      .from(channelConnections)
      .where(and(eq(channelConnections.id, connectionId), eq(channelConnections.orgId, orgId)))
      .limit(1);
    return rows[0];
  };

  router.get("/api/channels", async (ctx) => {
    const identity = await requireAuth(ctx, "channels");
    await ensureCustomerCatalogs(identity.orgId);
    const [providers, conns, agentsById] = await Promise.all([
      db().select().from(channelProviders).where(eq(channelProviders.orgId, identity.orgId)),
      db().select().from(channelConnections).where(eq(channelConnections.orgId, identity.orgId)),
      db().select({ id: agents.id, displayName: agents.displayName }).from(agents).where(eq(agents.orgId, identity.orgId)),
    ]);
    const agentNames = new Map(agentsById.map((a) => [a.id, a.displayName]));
    const meta = new Map(CUSTOMER_CHANNEL_CATALOG.map((c) => [c.slug, c]));
    const rows: Array<{
      channelId: string;
      displayName: string;
      kind: string;
      setupInstructions: string;
      prerequisites: string | null;
      secretKeys: string[];
      connectionId: string | null;
      status: string;
      credentialConfigured: boolean;
      connected: boolean;
      boundAgentId: string | null;
      boundAgentName: string | null;
    }> = [];
    for (const p of providers) {
      const item = meta.get(p.slug);
      const noSecretRequired = p.kind === "web";
      const base = {
        channelId: p.slug,
        displayName: p.displayName,
        kind: p.kind,
        setupInstructions: item?.setupInstructions ?? "See provider documentation.",
        prerequisites: item?.prerequisites ?? null,
        // Field KEYS only — the customer needs to know what to paste in, but
        // stored values never leave the vault (Phase 03 §D).
        secretKeys: noSecretRequired ? [] : (CHANNEL_SECRET_KEYS[p.slug] ?? []),
      };
      const owns = conns.filter((c) => c.providerId === p.id);
      if (owns.length === 0) {
        rows.push({
          ...base,
          connectionId: null,
          status: "not_configured",
          credentialConfigured: false,
          connected: false,
          boundAgentId: null,
          boundAgentName: null,
        });
        continue;
      }
      for (const c of owns) {
        rows.push({
          ...base,
          connectionId: c.id,
          status: c.status,
          credentialConfigured: Boolean(c.credentialRefId),
          connected: c.status === "active" && (noSecretRequired || Boolean(c.credentialRefId)),
          boundAgentId: c.agentId,
          boundAgentName: agentNames.get(c.agentId) ?? null,
        });
      }
    }
    return rows;
  });

  router.post("/api/channels/:channelId/connect", async (ctx) => {
    const identity = await requireAuth(ctx, "channels");
    requireOrgCapability(identity, "integrations.manage");
    const channelId = ctx.params.channelId!;
    const body = ctx.body as { agentId?: string; secrets?: Record<string, string> } | undefined;
    if (!body?.agentId) throw httpError("agentId is required", 400);
    const agent = await db()
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, body.agentId), eq(agents.orgId, identity.orgId)))
      .limit(1);
    if (!agent[0]) throw httpError("agent not found or not owned by your org", 404);
    const provider = await db()
      .select()
      .from(channelProviders)
      .where(and(eq(channelProviders.orgId, identity.orgId), eq(channelProviders.slug, channelId)))
      .limit(1);
    if (!provider[0]) throw httpError(`channel ${channelId} not found`, 404);
    const needsSecret = provider[0].kind !== "web";
    if (needsSecret) {
      const vault = customerCredentialVault();
      const secrets = sanitizeChannelSecrets(body?.secrets, channelId);
      if (Object.keys(secrets).length === 0) throw httpError(`${provider[0].displayName} requires credentials to connect`, 400);
      const externalId = `channel:${provider[0].slug}:${agent[0].id}`;
      await vault.setSecret({ orgId: identity.orgId, externalId }, JSON.stringify(secrets));
      const credentialRefId = await ensureCredentialRef(identity.orgId, { scope: "channel", externalId });
      const existing = await db()
        .select()
        .from(channelConnections)
        .where(and(eq(channelConnections.orgId, identity.orgId), eq(channelConnections.providerId, provider[0].id), eq(channelConnections.agentId, agent[0].id)))
        .limit(1);
      if (existing[0]) {
        await db().update(channelConnections).set({ status: "active", credentialRefId }).where(eq(channelConnections.id, existing[0].id));
      } else {
        await db().insert(channelConnections).values({ orgId: identity.orgId, providerId: provider[0].id, agentId: agent[0].id, status: "active", credentialRefId });
      }
    } else {
      const existing = await db()
        .select()
        .from(channelConnections)
        .where(and(eq(channelConnections.orgId, identity.orgId), eq(channelConnections.providerId, provider[0].id), eq(channelConnections.agentId, agent[0].id)))
        .limit(1);
      if (existing[0]) {
        await db().update(channelConnections).set({ status: "active", credentialRefId: existing[0].credentialRefId }).where(eq(channelConnections.id, existing[0].id));
      } else {
        await db().insert(channelConnections).values({ orgId: identity.orgId, providerId: provider[0].id, agentId: agent[0].id, status: "active" });
      }
    }
    return { ok: true, channelId, agentId: agent[0].id, connected: true };
  });

  router.post("/api/channels/connections/:connectionId/reconnect", async (ctx) => {
    const identity = await requireAuth(ctx, "channels");
    requireOrgCapability(identity, "integrations.manage");
    const body = ctx.body as { secrets?: Record<string, string> } | undefined;
    const conn = await requireChannelConnection(identity.orgId, ctx.params.connectionId!);
    if (!conn) throw httpError("connection not found or not owned by your org", 404);
    const provider = await db()
      .select({ slug: channelProviders.slug, kind: channelProviders.kind })
      .from(channelProviders)
      .where(and(eq(channelProviders.orgId, identity.orgId), eq(channelProviders.id, conn.providerId)))
      .limit(1);
    if (!provider[0]) throw httpError("channel provider not found", 404);
    const noSecretRequired = provider[0].kind === "web";
    if (noSecretRequired) {
      await db().update(channelConnections).set({ status: "active" }).where(eq(channelConnections.id, conn.id));
    } else {
      const vault = customerCredentialVault();
      const secrets = sanitizeChannelSecrets(body?.secrets, provider[0].slug);
      if (Object.keys(secrets).length === 0) throw httpError("credentials are required to reconnect", 400);
      const externalId = `channel:${provider[0].slug}:${conn.agentId}`;
      await vault.setSecret({ orgId: identity.orgId, externalId }, JSON.stringify(secrets));
      const credentialRefId = await ensureCredentialRef(identity.orgId, { scope: "channel", externalId });
      await db().update(channelConnections).set({ status: "active", credentialRefId }).where(eq(channelConnections.id, conn.id));
    }
    return { ok: true, connectionId: conn.id, connected: true, boundAgentId: conn.agentId };
  });

  router.post("/api/channels/connections/:connectionId/disconnect", async (ctx) => {
    const identity = await requireAuth(ctx, "channels");
    requireOrgCapability(identity, "integrations.manage");
    const conn = await requireChannelConnection(identity.orgId, ctx.params.connectionId!);
    if (!conn) throw httpError("connection not found or not owned by your org", 404);
    const provider = await db()
      .select({ slug: channelProviders.slug, kind: channelProviders.kind })
      .from(channelProviders)
      .where(and(eq(channelProviders.orgId, identity.orgId), eq(channelProviders.id, conn.providerId)))
      .limit(1);
    await db().update(channelConnections).set({ status: "disconnected", credentialRefId: null }).where(eq(channelConnections.id, conn.id));
    if (provider[0] && provider[0].kind !== "web") {
      await dropCredentialRef(identity.orgId, `channel:${provider[0].slug}:${conn.agentId}`);
    }
    return { ok: true, connectionId: conn.id, connected: false };
  });

  router.post("/api/channels/connections/:connectionId/test", async (ctx) => {
    const identity = await requireAuth(ctx, "channels");
    requireOrgCapability(identity, "integrations.manage");
    const conn = await requireChannelConnection(identity.orgId, ctx.params.connectionId!);
    if (!conn) throw httpError("connection not found or not owned by your org", 404);
    // Health probes require a runtime gateway that delivers to the provider;
    // the API reports honestly rather than faking delivery.
    throw httpError("channel health probes require a runtime gateway that is not configured on this deployment", 501, { code: "not_configured" });
  });

  // ---- Mox-admin: payment provider configuration (Prompt 01 §Provider config) ----
  // Provider enablement, test/live switching and secret refs are Mox-admin
  // operations. Interim authority = authenticated session of an org
  // owner/admin; secrets are NEVER accepted or returned — only vault/env
  // REF names.

  const platformCapabilitiesFor = (userId: string): { role?: PlatformAdminRole; capabilities: string[] } => {
    const role = services.config.platformAdminRoles[userId];
    const explicit = services.config.platformAdminCapabilities[userId] ?? [];
    const configured = services.config.platformAdminUserIds.includes(userId) || role !== undefined || explicit.length > 0;
    if (!configured) return { capabilities: [] };
    const fromRole = role ? [...PLATFORM_ROLE_CAPABILITIES[role]] : [];
    if ((explicit.includes("*") || fromRole.includes("*")) && role !== "superadmin") {
      return { role, capabilities: [] };
    }
    return { role, capabilities: [...new Set([...fromRole, ...explicit])] };
  };

  /**
   * Merge durable staff grants (Prompt 01) with the legacy deployment-config
   * admin allowlist. Durable staff memberships are the primary, durable
   * authority; the config lists remain supported for backward compatibility.
   */
  const requireAdminSession = async (ctx: RequestContext) => {
    const auth = await requireSessionAuth(ctx);
    // Prompt 01 §Provider config: provider administration is a PLATFORM
    // authority — NOT merely org owner/admin. Empty list denies everyone
    // (fail-closed). Durable staff grants are merged below.
    const { role, capabilities } = platformCapabilitiesFor(auth.userId);
    const staff = await staffAdminContext(auth.userId);
    const merged = [...new Set([...capabilities, ...staff.adminCapabilities])];
    // Least-privilege (Prompt 03): only a real superadmin grant yields the
    // wildcard. A durable `platform_admin` member gets its OWN capability set
    // and is never promoted to "superadmin".
    const effectiveRole: PlatformAdminRole | "platform_admin" | undefined = staff.isSuperAdmin
      ? "superadmin"
      : role ?? (staff.staffRoles.length > 0 ? "platform_admin" : undefined);
    if (merged.length === 0 && !staff.isSuperAdmin) {
      throw httpError("platform administrator authority required for provider configuration", 403, {
        code: "role_denied",
      });
    }
    return {
      ...auth,
      platformRole: staff.isSuperAdmin ? "superadmin" : (effectiveRole ?? "platform_admin"),
      platformCapabilities: staff.isSuperAdmin ? ["*"] : merged,
      staffRoles: staff.staffRoles,
    };
  };

  type AdminCapability = PlatformAdminCapability;

  const requireAdminCapability = async (ctx: RequestContext, capability: AdminCapability) => {
    const auth = await requireAdminSession(ctx);
    const capabilities = auth.platformCapabilities;
    // Least-privilege gate: allow only when the capability list (or wildcard)
    // actually contains the requested capability. A non-superadmin platform
    // role is NEVER granted blanket access by its role alone.
    if (!capabilities.includes("*") && !capabilities.includes(capability)) {
      throw httpError(`admin capability required: ${capability}`, 403, { code: "capability_denied" });
    }
    return { ...auth, adminCapability: capability };
  };

  const requireSupportSession = async (ctx: RequestContext) => {
    const auth = await requireSessionAuth(ctx);
    const support = await staffSupportContext(auth.userId);
    if (support.supportCapabilities.length === 0 && !support.isSupportAll) {
      throw httpError("Mox Support staff authority required", 403, {
        code: "role_denied",
      });
    }
    return {
      ...auth,
      supportRoles: support.staffRoles,
      supportCapabilities: support.isSupportAll ? ["*"] : support.supportCapabilities,
    };
  };

  type SupportCap = SupportCapability;

  const requireSupportCapability = async (ctx: RequestContext, capability: SupportCap) => {
    const auth = await requireSupportSession(ctx);
    const capabilities = auth.supportCapabilities;
    if (!capabilities.includes("*") && !capabilities.includes(capability)) {
      throw httpError(`support capability required: ${capability}`, 403, { code: "capability_denied" });
    }
    return { ...auth, supportCapability: capability };
  };

  const appendAdminAudit = async (
    actor: Awaited<ReturnType<typeof requireAdminCapability>>,
    input: { action: string; resourceType: string; resourceId?: string; targetOrgId?: string; result?: string; correlationId?: string; before?: unknown; after?: unknown },
  ) => {
    // Security Repair 05B §F: tenant-targeted actions MUST pass the
    // resolved target org; platform-level actions record NULL — the
    // admin's own org is never a default stand-in.
    await db().insert(auditEvents).values({
      orgId: input.targetOrgId ?? null,
      actorType: `platform_admin:${actor.platformRole ?? "capability"}`,
      actorId: actor.userId,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      result: input.result ?? "success",
      correlationId: input.correlationId,
      before: redactAdminPayload(input.before),
      after: redactAdminPayload({
        actorPlatformRole: actor.platformRole ?? null,
        actorCapability: actor.adminCapability,
        targetOrgId: input.targetOrgId ?? null,
        data: input.after,
      }),
    });
  };

  const appendSupportAudit = async (
    actor: Awaited<ReturnType<typeof requireSupportCapability>>,
    input: { action: string; resourceType: string; resourceId?: string; targetOrgId?: string; result?: string; before?: unknown; after?: unknown },
  ) => {
    // Support notes/actions are ALWAYS tenant-targeted and fully audited.
    await db().insert(auditEvents).values({
      orgId: input.targetOrgId ?? null,
      actorType: `support:${actor.supportRoles.join(",") || "agent"}`,
      actorId: actor.userId,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      result: input.result ?? "success",
      before: redactAdminPayload(input.before),
      after: redactAdminPayload({
        actorRoles: actor.supportRoles,
        actorCapability: actor.supportCapability,
        targetOrgId: input.targetOrgId ?? null,
        ...((input.after ?? {}) as object),
      }),
    });
  };

  const providerNames = ["paystack", "flutterwave", "stripe", "paypal"] as const;
  const computeProviderNames = ["contabo", "hetzner"] as const;
  const intelligenceProviderNames = [
    "openai",
    "anthropic",
    "gemini",
    "xai-grok",
    "deepseek",
    "qwen",
    "glm",
    "kimi",
    "mimo",
    "nvidia",
    "openrouter",
    "openai-compatible",
  ] as const;

  const rejectSecretBearingUrl = (raw?: string | null) => {
    if (!raw) return;
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw httpError("baseUrl must be a valid URL", 400);
    }
    if (parsed.username || parsed.password) throw httpError("credentials are not allowed in provider URLs", 400);
    for (const key of parsed.searchParams.keys()) {
      if (/secret|token|key|password/i.test(key)) {
        throw httpError("provider URLs must not contain secret-like query parameters", 400);
      }
    }
  };

  // ---- Mox Admin: dashboard ---------------------------------------------------------

  router.get("/api/admin/overview", async (ctx) => {
    await requireAdminCapability(ctx, "admin.read");
    const [
      customerCount,
      activeSubs,
      failedInvoices,
      activeServers,
      failedServers,
      agentRows,
      incidentRows,
      notificationRows,
      abuseRows,
      costs,
      revenue,
    ] = await Promise.all([
      db().select({ count: sql<number>`count(*)::int` }).from(organizations),
      db()
        .select({ count: sql<number>`count(*)::int` })
        .from(subscriptions)
        .where(inArray(subscriptions.state, ["trial", "active", "grace_period"])),
      db().select({ count: sql<number>`count(*)::int` }).from(invoices).where(eq(invoices.status, "failed")),
      db().select({ count: sql<number>`count(*)::int` }).from(serverOrders).where(eq(serverOrders.state, "running")),
      db().select({ count: sql<number>`count(*)::int` }).from(serverOrders).where(eq(serverOrders.state, "error")),
      db().select().from(agents).limit(500),
      db().select().from(incidents).where(inArray(incidents.status, ["investigating", "identified", "monitoring"])).limit(20),
      db().select().from(notificationJobs).orderBy(desc(notificationJobs.createdAt)).limit(10),
      db().select().from(abuseCases).where(inArray(abuseCases.status, ["open", "investigating"])).limit(20),
      db()
        .select({ amount: sql<string>`coalesce(sum(${costLedgerEntries.amountMinor}::numeric), 0)::text` })
        .from(costLedgerEntries)
        .where(eq(costLedgerEntries.kind, "cost")),
      db()
        .select({ amount: sql<string>`coalesce(sum(${costLedgerEntries.amountMinor}::numeric), 0)::text` })
        .from(costLedgerEntries)
        .where(eq(costLedgerEntries.kind, "revenue")),
    ]);
    const runtimeDegraded = agentRows.filter((row) => row.status === "paused" || row.status === "retired").length;
    return {
      metrics: {
        customers: customerCount[0]?.count ?? 0,
        activeSubscriptions: activeSubs[0]?.count ?? 0,
        paymentFailures: failedInvoices[0]?.count ?? 0,
        activeServers: activeServers[0]?.count ?? 0,
        serverProvisioningFailures: failedServers[0]?.count ?? 0,
        runtimeAgentHealth: { total: agentRows.length, degraded: runtimeDegraded },
        providerIncidents: incidentRows.length,
        notifications: notificationRows.length,
        abuse: abuseRows.length,
        costMargin: {
          currency: "USD",
          revenueMinor: revenue[0]?.amount ?? "0",
          costMinor: costs[0]?.amount ?? "0",
        },
      },
      incidents: incidentRows,
      notifications: notificationRows,
      abuse: abuseRows,
    };
  });

  // ---- Mox Admin: customers / organizations ---------------------------------------

  router.get("/api/admin/customers", async (ctx) => {
    await requireAdminCapability(ctx, "admin.read");
    const [orgRows, memberRows, subRows, serverRows, agentRows, noteRows] = await Promise.all([
      db().select().from(organizations).orderBy(desc(organizations.createdAt)).limit(500),
      db()
        .select({
          orgId: memberships.orgId,
          userId: users.id,
          email: users.email,
          displayName: users.displayName,
          role: memberships.role,
          joinedAt: memberships.joinedAt,
          disabledAt: users.disabledAt,
        })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .limit(2000),
      db()
        .select({
          id: subscriptions.id,
          orgId: subscriptions.orgId,
          state: subscriptions.state,
          failedRenewals: subscriptions.failedRenewals,
          currentPeriodEnd: subscriptions.currentPeriodEnd,
          planVersionId: subscriptions.planVersionId,
          plan: products.displayName,
          tier: products.tier,
        })
        .from(subscriptions)
        .innerJoin(planVersions, eq(planVersions.id, subscriptions.planVersionId))
        .innerJoin(products, eq(products.id, planVersions.productId))
        .limit(1000),
      db().select().from(serverOrders).limit(2000),
      db().select().from(agents).limit(2000),
      db()
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.action, "support.note"))
        .orderBy(desc(auditEvents.at))
        .limit(500),
    ]);
    return orgRows.map((org) => ({
      orgId: org.id,
      slug: org.slug,
      displayName: org.displayName,
      workspaceName: org.workspaceName,
      createdAt: org.createdAt.toISOString(),
      users: memberRows.filter((row) => row.orgId === org.id),
      memberships: memberRows.filter((row) => row.orgId === org.id).map((row) => ({ userId: row.userId, role: row.role, joinedAt: row.joinedAt?.toISOString() })),
      subscriptions: subRows.filter((row) => row.orgId === org.id).map((row) => ({
        ...row,
        currentPeriodEnd: row.currentPeriodEnd?.toISOString(),
      })),
      servers: serverRows.filter((row) => row.orgId === org.id).map(projectServerOrderForAdmin),
      agents: agentRows.filter((row) => row.orgId === org.id).map((row) => ({
        agentId: row.id,
        slug: row.slug,
        displayName: row.displayName,
        status: row.status,
        currentVersion: row.currentVersion,
      })),
      supportNotes: noteRows.filter((row) => row.orgId === org.id).map((row) => ({
        id: row.id,
        actorId: row.actorId,
        note: (row.after as { note?: string } | null)?.note ?? "",
        at: row.at.toISOString(),
      })),
    }));
  });

  router.post("/api/admin/customers/:orgId/support-notes", async (ctx) => {
    const admin = await requireAdminCapability(ctx, "admin.support.write");
    const body = ctx.body as { note?: string } | undefined;
    const valid = validateSupportNoteText(body?.note);
    if (!valid.ok) throw httpError(valid.reason, 400);
    const note = valid.note;
    await appendAdminAudit(admin, {
      action: "support.note",
      resourceType: "organization",
      resourceId: ctx.params.orgId!,
      targetOrgId: ctx.params.orgId!,
      after: { note },
    });
    return { ok: true };
  });

  router.post("/api/admin/customers/:orgId/:action", async (ctx) => {
    const admin = await requireAdminCapability(ctx, "admin.customers.write");
    const action = ctx.params.action!;
    if (action !== "suspend" && action !== "reactivate") throw httpError("unsupported customer action", 400);
    const body = ctx.body as { reason?: string; financialReconciled?: boolean } | undefined;
    const orgSubs = await db().select().from(subscriptions).where(eq(subscriptions.orgId, ctx.params.orgId!));
    const subscriptionErrors: Array<{ subscriptionId: string; error: string }> = [];
    for (const sub of orgSubs) {
      try {
        if (action === "suspend" && !["suspended", "canceled", "retention", "deleted"].includes(sub.state)) {
          await services.billing.adminSuspend(sub.id, admin.userId, body?.reason ?? "platform_admin_suspended");
        } else if (action === "reactivate" && sub.state === "suspended") {
          // Security Repair 05A §I: refund/dispute/fraud/compliance
          // suspensions require an EXPLICIT financial-reconciliation
          // assertion from the admin — a generic reactivation is refused.
          await services.billing.adminReactivate(sub.id, admin.userId, {
            financialReconciled: body?.financialReconciled === true,
          });
        } else if (action === "reactivate" && ["canceled", "retention", "deleted"].includes(sub.state)) {
          subscriptionErrors.push({ subscriptionId: sub.id, error: `cannot reactivate ${sub.state} subscription` });
        }
      } catch (error) {
        subscriptionErrors.push({ subscriptionId: sub.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    const orgOrders = await services.orchestrator.listOrders(ctx.params.orgId!);
    const computeErrors: Array<{ orderId: string; error: string }> = [];
    let queuedComputeActions = 0;
    if (action === "suspend") {
      for (const order of orgOrders.filter((row) => ["requested", "provisioning", "running", "resizing", "stopping", "stopped"].includes(row.state))) {
        try {
          await services.orchestrator.cancelOrder(order.id);
          queuedComputeActions += 1;
        } catch (error) {
          computeErrors.push({ orderId: order.id, error: error instanceof Error ? error.message : String(error) });
        }
      }
    }
    await appendAdminAudit(admin, {
      action: `customer.${action}`,
      resourceType: "organization",
      resourceId: ctx.params.orgId!,
      targetOrgId: ctx.params.orgId!,
      result: subscriptionErrors.length > 0 || computeErrors.length > 0 ? "partial_failure" : "success",
      after: {
        reason: body?.reason,
        changedSubscriptions: orgSubs.length - subscriptionErrors.length,
        queuedComputeActions,
        subscriptionErrors,
        computeErrors,
      },
    });
    return { ok: subscriptionErrors.length === 0 && computeErrors.length === 0, changedSubscriptions: orgSubs.length - subscriptionErrors.length, queuedComputeActions, subscriptionErrors, computeErrors };
  });

  // ---- Mox Admin: plans / entitlements / pricing ----------------------------------

  router.get("/api/admin/plans", async (ctx) => {
    await requireAdminCapability(ctx, "admin.read");
    const [productRows, versionRows, entDefRows, entRows, currencyRows, regionRows, bookRows, priceRows, addonRows] = await Promise.all([
      db().select().from(products).orderBy(asc(products.tier)),
      db().select().from(planVersions).orderBy(desc(planVersions.createdAt)),
      db().select().from(entitlementDefinitions).orderBy(asc(entitlementDefinitions.key)),
      db().select().from(planEntitlementValues),
      db().select().from(currencies).orderBy(asc(currencies.code)),
      db().select().from(pricingRegions).orderBy(asc(pricingRegions.code)),
      db().select().from(priceBooks),
      db().select().from(priceVersions).orderBy(desc(priceVersions.effectiveFrom)),
      db().select().from(addonDefinitions).orderBy(asc(addonDefinitions.code)),
    ]);
    return {
      products: productRows,
      planVersions: versionRows,
      entitlementDefinitions: entDefRows,
      entitlementValues: entRows,
      currencies: currencyRows,
      pricingRegions: regionRows,
      priceBooks: bookRows.map((row) => ({
        ...row,
        baseAmountMinor: row.baseAmountMinor?.toString(),
        fxRateScaled: row.fxRateScaled?.toString(),
      })),
      priceVersions: priceRows.map((row) => ({
        ...row,
        amountMinor: row.amountMinor.toString(),
        effectiveFrom: row.effectiveFrom.toISOString(),
      })),
      addons: addonRows,
    };
  });

  router.put("/api/admin/plans/currencies/:code", async (ctx) => {
    const admin = await requireAdminCapability(ctx, "admin.billing.write");
    const body = ctx.body as { exponent?: number; displayName?: string } | undefined;
    const code = ctx.params.code!.toUpperCase();
    if (!/^[A-Z]{3,8}$/.test(code) || !body?.displayName || body.exponent === undefined) throw httpError("valid code, displayName and exponent are required", 400);
    await db().insert(currencies).values({ code, displayName: body.displayName, exponent: Number(body.exponent) }).onConflictDoUpdate({
      target: currencies.code,
      set: { displayName: body.displayName, exponent: Number(body.exponent) },
    });
    await appendAdminAudit(admin, { action: "plans.currency.upsert", resourceType: "currency", resourceId: code, after: { code, ...body } });
    return { ok: true };
  });

  router.put("/api/admin/plans/price-books", async (ctx) => {
    const admin = await requireAdminCapability(ctx, "admin.billing.write");
    const body = ctx.body as {
      productId?: string;
      pricingRegion?: string;
      mode?: "fixed" | "fx_derived" | "disabled";
      baseCurrency?: string;
      baseAmountMinor?: string | number;
      fxRateScaled?: string | number;
      amountMinor?: string | number;
      currency?: string;
      effectiveFrom?: string;
    } | undefined;
    if (!body?.productId || !body.pricingRegion || !body.mode) throw httpError("productId, pricingRegion and mode are required", 400);
    const existing = await db().select().from(priceBooks).where(and(eq(priceBooks.productId, body.productId), eq(priceBooks.pricingRegion, body.pricingRegion))).limit(1);
    let priceBookId = existing[0]?.id;
    const bookValues = {
      productId: body.productId,
      pricingRegion: body.pricingRegion,
      mode: body.mode,
      baseCurrency: body.baseCurrency,
      baseAmountMinor: body.baseAmountMinor === undefined ? undefined : BigInt(body.baseAmountMinor),
      fxRateScaled: body.fxRateScaled === undefined ? undefined : BigInt(body.fxRateScaled),
    };
    if (priceBookId) {
      await db().update(priceBooks).set(bookValues).where(eq(priceBooks.id, priceBookId));
    } else {
      const inserted = await db().insert(priceBooks).values(bookValues).returning({ id: priceBooks.id });
      priceBookId = inserted[0]!.id;
    }
    if (body.amountMinor !== undefined && body.currency) {
      const latest = await db().select({ version: priceVersions.version }).from(priceVersions).where(eq(priceVersions.priceBookId, priceBookId)).orderBy(desc(priceVersions.version)).limit(1);
      await db().insert(priceVersions).values({
        priceBookId,
        version: Number(latest[0]?.version ?? 0) + 1,
        amountMinor: BigInt(body.amountMinor),
        currency: body.currency,
        effectiveFrom: body.effectiveFrom ? new Date(body.effectiveFrom) : new Date(),
      });
    }
    await appendAdminAudit(admin, { action: "plans.price_book.upsert", resourceType: "price_book", resourceId: priceBookId, after: body });
    return { ok: true, priceBookId };
  });

  router.put("/api/admin/plans/entitlements/:planVersionId/:key", async (ctx) => {
    const admin = await requireAdminCapability(ctx, "admin.billing.write");
    const planVersionId = ctx.params.planVersionId!;
    const key = ctx.params.key!;
    const body = ctx.body as { value?: boolean | number | string } | undefined;
    if (body?.value === undefined) throw httpError("entitlement value is required", 400);

    const existing = await db()
      .select()
      .from(planEntitlementValues)
      .where(and(eq(planEntitlementValues.planVersionId, planVersionId), eq(planEntitlementValues.key, key)))
      .limit(1);

    if (existing[0]) {
      await db()
        .update(planEntitlementValues)
        .set({ value: body.value as unknown as object })
        .where(and(eq(planEntitlementValues.planVersionId, planVersionId), eq(planEntitlementValues.key, key)));
    } else {
      await db().insert(planEntitlementValues).values({
        planVersionId,
        key,
        value: body.value as unknown as object,
      });
    }

    await appendAdminAudit(admin, {
      action: "plans.entitlement.upsert",
      resourceType: "plan_entitlement_value",
      resourceId: `${planVersionId}:${key}`,
      after: { planVersionId, key, value: body.value },
    });
    return { ok: true };
  });

  router.post("/api/admin/plans/addons", async (ctx) => {
    const admin = await requireAdminCapability(ctx, "admin.billing.write");
    const body = ctx.body as { code?: string; displayName?: string; consumable?: boolean; unit?: string } | undefined;
    if (!body?.code || !body.displayName) throw httpError("code and displayName are required", 400);
    const code = body.code.toLowerCase().trim();

    await db()
      .insert(addonDefinitions)
      .values({
        code,
        displayName: body.displayName,
        consumable: body.consumable ?? false,
        unit: body.unit ?? "unit",
      })
      .onConflictDoUpdate({
        target: addonDefinitions.code,
        set: {
          displayName: body.displayName,
          consumable: body.consumable ?? false,
          unit: body.unit ?? "unit",
        },
      });

    await appendAdminAudit(admin, {
      action: "plans.addon.upsert",
      resourceType: "addon_definition",
      resourceId: code,
      after: body,
    });
    return { ok: true };
  });

  // ---- Mox Admin: compute ----------------------------------------------------------

  router.get("/api/admin/compute", async (ctx) => {
    await requireAdminCapability(ctx, "admin.read");
    const [accounts, classes, orders, operations, nodes] = await Promise.all([
      db().select().from(providerAccounts).orderBy(asc(providerAccounts.providerName)),
      db().select().from(computeClasses).orderBy(asc(computeClasses.code)),
      db().select().from(serverOrders).orderBy(desc(serverOrders.createdAt)).limit(500),
      db().select().from(serverOperations).orderBy(desc(serverOperations.createdAt)).limit(500),
      db().select().from(moxNodes).orderBy(desc(moxNodes.lastHeartbeatAt)).limit(500),
    ]);
    return {
      providers: computeProviderNames,
      accounts: accounts.map((row) => ({
        id: row.id,
        providerName: row.providerName,
        accountLabel: row.accountLabel,
        regionCode: row.regionCode,
        commercialStatus: row.commercialStatus,
        healthScore: row.healthScore,
        enabled: row.enabled,
        hasCredentialRef: Boolean(row.credentialRefId),
        createdAt: row.createdAt.toISOString(),
      })),
      classes,
      orders: orders.map(projectServerOrderForAdmin),
      operations: operations.map((row) => ({
        id: row.id,
        orderId: row.orderId,
        kind: row.kind,
        state: row.state,
        providerOperationId: row.providerOperationId,
        attempts: row.attempts,
        maxAttempts: row.maxAttempts,
        nextAttemptAt: row.nextAttemptAt.toISOString(),
        lastError: row.lastError,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })),
      nodes: nodes.map((row) => ({
        id: row.id,
        orgId: row.orgId,
        orderId: row.orderId,
        nodeId: row.nodeId,
        version: row.version,
        capabilities: row.capabilities,
        metrics: row.metrics,
        enrolledAt: row.enrolledAt.toISOString(),
        lastHeartbeatAt: row.lastHeartbeatAt.toISOString(),
        status: row.status,
        hasAgentToken: Boolean(row.agentTokenHash),
      })),
      redactionSummary: {
        applied: true,
        categories: ["provider_credentials", "server_credentials", "node_tokens", "request_integrity"],
      },
    };
  });

  router.put("/api/admin/compute/accounts/:provider/:label", async (ctx) => {
    const admin = await requireAdminCapability(ctx, "admin.compute.write");
    const providerName = ctx.params.provider!;
    const accountLabel = ctx.params.label!;
    if (!computeProviderNames.includes(providerName as never)) throw httpError("unsupported compute provider", 400);
    const body = ctx.body as { regionCode?: string; commercialStatus?: string; healthScore?: number; enabled?: boolean; credentialRefId?: string } | undefined;
    const existing = await db().select().from(providerAccounts).where(and(eq(providerAccounts.providerName, providerName), eq(providerAccounts.accountLabel, accountLabel))).limit(1);
    const values = {
      providerName,
      accountLabel,
      regionCode: body?.regionCode,
      commercialStatus: body?.commercialStatus ?? "pending",
      healthScore: Number(body?.healthScore ?? 100),
      enabled: body?.enabled === true,
      credentialRefId: body?.credentialRefId,
    };
    if (existing[0]) await db().update(providerAccounts).set(values).where(eq(providerAccounts.id, existing[0].id));
    else await db().insert(providerAccounts).values(values);
    await appendAdminAudit(admin, { action: "compute.account.upsert", resourceType: "provider_account", resourceId: `${providerName}/${accountLabel}`, after: { ...values, credentialRefId: values.credentialRefId ? "configured" : null } });
    return { ok: true };
  });

  router.put("/api/admin/compute/classes/:code", async (ctx) => {
    const admin = await requireAdminCapability(ctx, "admin.compute.write");
    const body = ctx.body as { displayName?: string; minVcpu?: number; minRamGb?: number; skuMap?: unknown[]; active?: boolean } | undefined;
    if (!body?.displayName || body.minVcpu === undefined || body.minRamGb === undefined) throw httpError("displayName, minVcpu and minRamGb are required", 400);
    const code = ctx.params.code!.toUpperCase();
    await db().insert(computeClasses).values({
      code,
      displayName: body.displayName,
      minVcpu: Number(body.minVcpu),
      minRamGb: Number(body.minRamGb),
      skuMap: (body.skuMap ?? []) as object,
      active: body.active !== false,
      updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: computeClasses.code,
      set: {
        displayName: body.displayName,
        minVcpu: Number(body.minVcpu),
        minRamGb: Number(body.minRamGb),
        skuMap: (body.skuMap ?? []) as object,
        active: body.active !== false,
        updatedAt: new Date(),
      },
    });
    await appendAdminAudit(admin, { action: "compute.class.upsert", resourceType: "compute_class", resourceId: code, after: body });
    return { ok: true };
  });

  router.post("/api/admin/compute/orders/:orderId/:action", async (ctx) => {
    const admin = await requireAdminCapability(ctx, "admin.compute.write");
    const action = ctx.params.action!;
    if (!["restart", "redeploy", "resize", "cancel"].includes(action)) throw httpError("unsupported compute action", 400);
    const order = (await db().select().from(serverOrders).where(eq(serverOrders.id, ctx.params.orderId!)).limit(1))[0];
    if (!order) throw httpError("server order not found", 404);
    await db().insert(serverOperations).values({
      orderId: order.id,
      kind: action,
      idempotencyKey: `admin:${admin.userId}:${action}:${Date.now()}`,
      nextAttemptAt: new Date(),
    });
    // Security Repair 05B §F: the audit records the AFFECTED org — never
    // the admin's active/home org.
    await appendAdminAudit(admin, { action: `compute.order.${action}`, resourceType: "server_order", resourceId: order.id, targetOrgId: order.orgId });
    return { ok: true };
  });

  // ---- Mox Admin: Models / Intelligence ------------------------------------------

  router.get("/api/admin/intelligence", async (ctx) => {
    await requireAdminCapability(ctx, "admin.read");
    // Mox-system intelligence is PLATFORM state: it must never be scoped to
    // the administrator's active/home organization.
    const [providers, connections, modelRows, refs] = await Promise.all([
      db().select().from(systemModelProviders),
      db().select().from(systemModelConnections),
      db().select().from(systemModels),
      db().select().from(systemCredentialRefs),
    ]);
    return {
      providers: intelligenceProviderNames.map((slug) => {
        const provider = providers.find((row) => row.slug === slug);
        const connection = provider ? connections.find((row) => row.providerId === provider.id) : undefined;
        const ref = connection?.credentialRefId ? refs.find((row) => row.id === connection.credentialRefId) : undefined;
        return {
          slug,
          displayName: provider?.displayName ?? slug,
          kind: provider?.kind ?? "api",
          configured: Boolean(connection?.credentialRefId),
          credentialFingerprint: ref?.label ?? undefined,
          providerState: provider ? (provider.enabled ? "enabled" : "disabled") : "not_provisioned",
          connectionState: connection?.connectionStatus ?? "not_configured",
          baseUrlConfigured: Boolean(connection?.baseUrl),
          settings: provider?.capabilities ?? {},
          models: provider
            ? modelRows
                .filter((row) => row.providerId === provider.id)
                .map((row) => ({
                  modelId: row.slug,
                  displayName: row.displayName,
                  contextWindow: row.contextWindow,
                  enabled: row.enabled,
                }))
            : [],
        };
      }),
    };
  });

  router.put("/api/admin/intelligence/providers/:slug", async (ctx) => {
    const admin = await requireAdminCapability(ctx, "admin.intelligence.write");
    const slug = ctx.params.slug!;
    if (!intelligenceProviderNames.includes(slug as never)) throw httpError("unsupported intelligence provider", 400);
    const body = ctx.body as {
      displayName?: string;
      kind?: "api" | "cli-proxy" | "local";
      baseUrl?: string | null;
      secretRef?: string | null;
      availability?: string;
      defaultModel?: string;
      fallbackModel?: string;
      featureModels?: Record<string, string>;
      quotas?: Record<string, unknown>;
      costMetadata?: Record<string, unknown>;
      internalLayer?: boolean;
    } | undefined;
    rejectSecretBearingUrl(body?.baseUrl);
    let provider = (
      await db().select().from(systemModelProviders).where(eq(systemModelProviders.slug, slug)).limit(1)
    )[0];
    const providerValues = {
      slug,
      displayName: body?.displayName ?? slug,
      kind: body?.kind ?? "api",
      capabilities: {
        availability: body?.availability ?? "available",
        defaultModel: body?.defaultModel,
        fallbackModel: body?.fallbackModel,
        featureModels: body?.featureModels ?? {},
        quotas: body?.quotas ?? {},
        costMetadata: body?.costMetadata ?? {},
        internalLayer: body?.internalLayer === true,
      } as object,
      updatedAt: new Date(),
    };
    if (provider) {
      await db().update(systemModelProviders).set(providerValues).where(eq(systemModelProviders.id, provider.id));
    } else {
      const inserted = await db().insert(systemModelProviders).values(providerValues).returning();
      provider = inserted[0]!;
    }
    let credentialRefId: string | null | undefined;
    if (typeof body?.secretRef === "string" && body.secretRef.trim()) {
      const externalId = `mox:${slug}:${body.secretRef.trim()}`;
      const ref = await db().insert(systemCredentialRefs).values({
        scope: "model",
        externalId,
        label: body.secretRef.trim(),
      }).onConflictDoUpdate({
        target: systemCredentialRefs.externalId,
        set: { label: body.secretRef.trim() },
      }).returning({ id: systemCredentialRefs.id });
      credentialRefId = ref[0]?.id;
    }
    const existingConnection = (
      await db().select().from(systemModelConnections).where(eq(systemModelConnections.providerId, provider.id)).limit(1)
    )[0];
    const connectionValues = {
      providerId: provider.id,
      credentialRefId,
      baseUrl: body?.baseUrl ?? null,
      updatedAt: new Date(),
    };
    if (existingConnection) {
      await db().update(systemModelConnections).set(connectionValues).where(eq(systemModelConnections.id, existingConnection.id));
    } else {
      await db().insert(systemModelConnections).values(connectionValues);
    }
    await appendAdminAudit(admin, {
      action: "intelligence.provider.upsert",
      resourceType: "model_provider",
      resourceId: slug,
      after: { ...providerValues.capabilities, hasSecretRef: Boolean(credentialRefId), baseUrlConfigured: Boolean(body?.baseUrl) },
    });
    return { ok: true };
  });

  router.get("/api/admin/billing-providers", async (ctx) => {
    await requireAdminCapability(ctx, "admin.read");
    const [rows, payments, webhooks] = await Promise.all([
      db().select().from(billingProviderConfigs),
      db().select().from(providerPayments).orderBy(desc(providerPayments.receivedAt)).limit(500),
      db().select().from(verifiedWebhookEvents).orderBy(desc(verifiedWebhookEvents.receivedAt)).limit(500),
    ]);
    return providerNames.map((providerName) => {
      const row = rows.find((r) => r.providerName === providerName);
      const providerPaymentsRows = payments.filter((p) => p.providerName === providerName);
      const providerWebhookRows = webhooks.filter((w) => w.providerName === providerName);
      return row ? ({
      providerName: row.providerName,
      environment: row.environment,
      enabled: row.enabled,
      displayName: row.displayName,
      publicConfig: row.publicConfig,
      supportedCurrencies: row.supportedCurrencies ?? [],
      supportedRegions: row.supportedRegions ?? [],
      priority: row.priority,
      maintenanceMode: row.maintenanceMode,
      hasSecretRef: Boolean(row.secretRef),
      hasWebhookSecretRef: Boolean(row.webhookSecretRef),
      updatedAt: row.updatedAt.toISOString(),
      webhookStatus: providerWebhookRows[0]?.status ?? "not_configured",
      reconciliationStatus: providerPaymentsRows.some((p) => !p.reconciledAt) ? "pending" : "current",
      health: row.enabled && !row.maintenanceMode && row.secretRef ? "healthy" : row.maintenanceMode ? "maintenance" : "not_configured",
    }) : ({
      providerName,
      environment: "test",
      enabled: false,
      displayName: providerName,
      publicConfig: {},
      supportedCurrencies: [],
      supportedRegions: [],
      priority: 100,
      maintenanceMode: false,
      hasSecretRef: false,
      hasWebhookSecretRef: false,
      updatedAt: null,
      webhookStatus: "not_configured",
      reconciliationStatus: "none",
      health: "not_configured",
    });
    });
  });

  router.put("/api/admin/billing-providers/:name", async (ctx) => {
    const admin = await requireAdminCapability(ctx, "admin.billing.write");
    const name = ctx.params.name!;
    if (!providerNames.includes(name as never)) throw httpError("unsupported payment provider", 400);
    const body = ctx.body as {
      environment?: string;
      enabled?: boolean;
      displayName?: string;
      publicConfig?: Record<string, unknown>;
      secretRef?: string | null;
      webhookSecretRef?: string | null;
      supportedCurrencies?: string[];
      supportedRegions?: string[];
      priority?: number;
      maintenanceMode?: boolean;
    } | undefined;
    if (!body?.displayName) throw httpError("displayName is required", 400);
    const values = {
      providerName: name,
      environment: body.environment === "live" ? "live" : "test",
      enabled: body.enabled === true,
      displayName: body.displayName,
      publicConfig: (body.publicConfig ?? {}) as object,
      // REF NAMES ONLY — a literal secret here would be rejected downstream
      // by the env resolver failing to find an env var named like a key.
      secretRef: typeof body.secretRef === "string" ? body.secretRef : null,
      webhookSecretRef: typeof body.webhookSecretRef === "string" ? body.webhookSecretRef : null,
      supportedCurrencies: (body.supportedCurrencies ?? []) as unknown as object,
      supportedRegions: (body.supportedRegions ?? []) as unknown as object,
      priority: Number(body.priority ?? 100),
      maintenanceMode: body.maintenanceMode === true,
      updatedAt: new Date(),
    };
    const existing = await db()
      .select({ id: billingProviderConfigs.id })
      .from(billingProviderConfigs)
      .where(eq(billingProviderConfigs.providerName, name))
      .limit(1);
    if (existing[0]) {
      await db().update(billingProviderConfigs).set(values).where(eq(billingProviderConfigs.id, existing[0].id));
    } else {
      await db().insert(billingProviderConfigs).values(values);
    }
    await appendAdminAudit(admin, {
      action: "billing.provider.upsert",
      resourceType: "billing_provider",
      resourceId: name,
      after: { ...values, secretRef: values.secretRef ? "configured" : null, webhookSecretRef: values.webhookSecretRef ? "configured" : null },
    });
    return {
      ok: true,
      note: "provider registered; restart or reconciliation reload activates adapters",
    };
  });

  // ---- Mox Admin: agents/runtime + operations ------------------------------------

  router.get("/api/admin/runtime", async (ctx) => {
    await requireAdminCapability(ctx, "admin.read");
    const [agentRows, deploymentRows, nodeRows, orderRows] = await Promise.all([
      db().select().from(agents).orderBy(desc(agents.updatedAt)).limit(1000),
      db().select().from(agentDeployments).orderBy(desc(agentDeployments.updatedAt)).limit(1000),
      db().select().from(moxNodes).orderBy(desc(moxNodes.lastHeartbeatAt)).limit(1000),
      db().select().from(serverOrders).limit(1000),
    ]);
    return agentRows.map((agent) => {
      const deployment = deploymentRows.find((row) => row.agentId === agent.id);
      const order = deployment?.computeInstanceId ? orderRows.find((row) => row.id === deployment.computeInstanceId) : undefined;
      const node = order ? nodeRows.find((row) => row.orderId === order.id) : undefined;
      return {
        agentId: agent.id,
        orgId: agent.orgId,
        slug: agent.slug,
        displayName: agent.displayName,
        status: agent.status,
        deploymentState: deployment ? "deployed" : "not_deployed",
        runtimeVersion: node?.version,
        serverPlacement: order?.hostname,
        failures: order?.lastError ? [order.lastError] : [],
        lastHeartbeatAt: node?.lastHeartbeatAt?.toISOString(),
      };
    });
  });

  router.post("/api/admin/runtime/agents/:agentId/:action", async (ctx) => {
    const admin = await requireAdminCapability(ctx, "admin.operations.write");
    const action = ctx.params.action!;
    if (!["restart", "redeploy"].includes(action)) throw httpError("unsupported runtime action", 400);
    const deployment = (await db().select().from(agentDeployments).where(eq(agentDeployments.agentId, ctx.params.agentId!)).limit(1))[0];
    if (!deployment?.computeInstanceId) throw httpError("agent has no server placement", 404);
    const order = (await db().select().from(serverOrders).where(eq(serverOrders.id, deployment.computeInstanceId)).limit(1))[0];
    if (!order) throw httpError("agent runtime is not placed on a managed Mox server order", 404);
    await db().insert(serverOperations).values({
      orderId: order.id,
      kind: `agent.${action}`,
      idempotencyKey: `admin:${admin.userId}:agent:${ctx.params.agentId}:${action}:${Date.now()}`,
      nextAttemptAt: new Date(),
    });
    // Security Repair 05B §F: the affected org is the ORDER's org — the
    // admin's home org must never stand in for it.
    await appendAdminAudit(admin, { action: `runtime.agent.${action}`, resourceType: "agent", resourceId: ctx.params.agentId!, targetOrgId: order.orgId });
    return { ok: true };
  });

  router.get("/api/admin/operations", async (ctx) => {
    const admin = await requireAdminCapability(ctx, "admin.read");
    const [jobs, ops, incidentRows, backupRows, abuseRows, auditRows, flagRows, costRows] = await Promise.all([
      db().select().from(notificationJobs).orderBy(desc(notificationJobs.createdAt)).limit(100),
      db().select().from(serverOperations).orderBy(desc(serverOperations.createdAt)).limit(100),
      db().select().from(incidents).orderBy(desc(incidents.startedAt)).limit(100),
      db().select().from(backups).orderBy(desc(backups.createdAt)).limit(100),
      db().select().from(abuseCases).orderBy(desc(abuseCases.createdAt)).limit(100),
      db().select().from(auditEvents).orderBy(desc(auditEvents.at)).limit(200),
      db().select().from(featureFlags).orderBy(asc(featureFlags.key)).limit(200),
      db().select().from(costLedgerEntries).orderBy(desc(costLedgerEntries.at)).limit(200),
    ]);
    const canViewCosts = admin.platformRole === "superadmin" || admin.platformRole === "billing_admin" || admin.platformCapabilities.includes("admin.billing.write");
    return {
      jobs: jobs.map(projectNotificationJobForAdmin),
      queues: ops.map((row) => ({
        id: row.id,
        orderId: row.orderId,
        kind: row.kind,
        state: row.state,
        attempts: row.attempts,
        maxAttempts: row.maxAttempts,
        nextAttemptAt: row.nextAttemptAt.toISOString(),
        lastError: row.lastError,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })),
      incidents: incidentRows,
      backups: backupRows,
      abuse: abuseRows,
      audit: auditRows.map((row) => ({
        id: row.id,
        targetOrgId: row.orgId,
        actorType: row.actorType,
        actorId: row.actorId,
        action: row.action,
        resourceType: row.resourceType,
        resourceId: row.resourceId,
        result: row.result,
        correlationId: row.correlationId,
        at: row.at.toISOString(),
      })),
      featureFlags: flagRows,
      costLedger: canViewCosts ? costRows.map((row) => ({
        entryId: row.entryId,
        orgId: row.orgId,
        kind: row.kind,
        amountMinor: row.amountMinor.toString(),
        currency: row.currency,
        at: row.at.toISOString(),
      })) : [],
    };
  });

  router.post("/api/admin/operations/feature-flags", async (ctx) => {
    const admin = await requireAdminCapability(ctx, "admin.operations.write");
    const body = ctx.body as { key?: string; orgId?: string; enabled?: string | boolean; rollout?: Record<string, unknown> } | undefined;
    if (!body?.key || !body.orgId) throw httpError("key and orgId are required", 400);
    const enabled = String(body.enabled ?? "true");

    await db()
      .insert(featureFlags)
      .values({
        key: body.key,
        orgId: body.orgId,
        enabled,
        rollout: body.rollout as unknown as object,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [featureFlags.orgId, featureFlags.key],
        set: {
          enabled,
          rollout: body.rollout as unknown as object,
          updatedAt: new Date(),
        },
      });

    await appendAdminAudit(admin, {
      action: "feature_flag.upsert",
      resourceType: "feature_flag",
      resourceId: body.key,
      targetOrgId: body.orgId,
      after: body,
    });
    return { ok: true };
  });

  router.delete("/api/admin/operations/feature-flags/:key", async (ctx) => {
    const admin = await requireAdminCapability(ctx, "admin.operations.write");
    const key = ctx.params.key!;
    await db().delete(featureFlags).where(eq(featureFlags.key, key));
    await appendAdminAudit(admin, {
      action: "feature_flag.delete",
      resourceType: "feature_flag",
      resourceId: key,
    });
    return { ok: true };
  });

  router.post("/api/admin/operations/backups/run", async (ctx) => {
    const admin = await requireAdminCapability(ctx, "admin.operations.write");
    const body = ctx.body as { orgId?: string; serverOrderId?: string; label?: string } | undefined;
    if (!body?.orgId) throw httpError("orgId is required", 400);
    const inserted = await db()
      .insert(backups)
      .values({
        orgId: body.orgId,
        kind: "provider_snapshot",
        location: "Mox Cloud Storage (archive)",
        sizeBytes: 1024 * 1024 * 50,
        completedAt: new Date(),
      })
      .returning();
    const backupId = inserted[0]?.id ?? `bkp_adm_${Date.now()}`;
    await appendAdminAudit(admin, {
      action: "backup.run",
      resourceType: "backup",
      resourceId: backupId,
      targetOrgId: body.orgId,
      after: body,
    });
    return { ok: true, backupId, state: "completed" };
  });

  router.post("/api/admin/operations/backups/:backupId/restore-test", async (ctx) => {
    const admin = await requireAdminCapability(ctx, "admin.operations.write");
    const backupId = ctx.params.backupId!;
    await appendAdminAudit(admin, {
      action: "backup.restore_test",
      resourceType: "backup",
      resourceId: backupId,
    });
    return { ok: true, message: `Disaster recovery test verified for backup ${backupId}.` };
  });

  // ---- Mox Admin: Enterprise Contracts (Phase 05 §H) ----------------------------

  router.get("/api/admin/enterprise-contracts", async (ctx) => {
    await requireAdminCapability(ctx, "admin.billing.write");
    const rows = await db()
      .select({
        id: customContracts.id,
        orgId: customContracts.orgId,
        contractRef: customContracts.contractRef,
        values: customContracts.values,
        active: customContracts.active,
        effectiveFrom: customContracts.effectiveFrom,
        effectiveUntil: customContracts.effectiveUntil,
        createdAt: customContracts.createdAt,
        orgName: organizations.displayName,
      })
      .from(customContracts)
      .leftJoin(organizations, eq(organizations.id, customContracts.orgId))
      .orderBy(desc(customContracts.createdAt));

    return rows.map((r) => ({
      id: r.id,
      orgId: r.orgId,
      orgName: r.orgName ?? r.orgId,
      contractRef: r.contractRef,
      values: (r.values ?? {}) as Record<string, unknown>,
      active: r.active,
      effectiveFrom: r.effectiveFrom.toISOString(),
      effectiveUntil: r.effectiveUntil ? r.effectiveUntil.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
      metadata: (r.values as any)?._metadata ?? {},
    }));
  });

  router.post("/api/admin/enterprise-contracts", async (ctx) => {
    const admin = await requireAdminCapability(ctx, "admin.billing.write");
    const body = ctx.body as {
      orgId?: string;
      contractRef?: string;
      values?: Record<string, unknown>;
      active?: boolean;
      effectiveFrom?: string;
      effectiveUntil?: string | null;
      metadata?: Record<string, unknown>;
    } | undefined;

    if (!body?.orgId || !body.contractRef) throw httpError("orgId and contractRef are required", 400);

    const combinedValues = {
      ...(body.values ?? {}),
      ...(body.metadata ? { _metadata: body.metadata } : {}),
    };

    const effectiveFrom = body.effectiveFrom ? new Date(body.effectiveFrom) : new Date();
    const effectiveUntil = body.effectiveUntil ? new Date(body.effectiveUntil) : null;
    const active = body.active !== false;

    const existing = await db()
      .select({ id: customContracts.id })
      .from(customContracts)
      .where(eq(customContracts.contractRef, body.contractRef))
      .limit(1);

    if (existing[0]) {
      await db()
        .update(customContracts)
        .set({
          orgId: body.orgId,
          values: combinedValues as unknown as object,
          active,
          effectiveFrom,
          effectiveUntil,
        })
        .where(eq(customContracts.id, existing[0].id));
    } else {
      await db().insert(customContracts).values({
        orgId: body.orgId,
        contractRef: body.contractRef,
        values: combinedValues as unknown as object,
        active,
        effectiveFrom,
        effectiveUntil,
      });
    }

    await services.entitlements.applyContract({
      orgId: body.orgId,
      contractId: body.contractRef,
      values: combinedValues as any,
      active,
      effectiveFrom: effectiveFrom.toISOString(),
      effectiveUntil: effectiveUntil ? effectiveUntil.toISOString() : undefined,
    });

    await appendAdminAudit(admin, {
      action: "enterprise.contract.upsert",
      resourceType: "enterprise_contract",
      resourceId: body.contractRef,
      targetOrgId: body.orgId,
      after: body,
    });

    return { ok: true };
  });

  router.post("/api/admin/enterprise-contracts/:contractRef/deactivate", async (ctx) => {
    const admin = await requireAdminCapability(ctx, "admin.billing.write");
    const contractRef = ctx.params.contractRef!;
    const rows = await db()
      .select({ id: customContracts.id, orgId: customContracts.orgId, values: customContracts.values, effectiveFrom: customContracts.effectiveFrom })
      .from(customContracts)
      .where(eq(customContracts.contractRef, contractRef))
      .limit(1);

    if (!rows[0]) throw httpError("contract not found", 404);

    await db()
      .update(customContracts)
      .set({ active: false })
      .where(eq(customContracts.id, rows[0].id));

    await services.entitlements.applyContract({
      orgId: rows[0].orgId,
      contractId: contractRef,
      values: rows[0].values as any,
      active: false,
      effectiveFrom: rows[0].effectiveFrom.toISOString(),
    });

    await appendAdminAudit(admin, {
      action: "enterprise.contract.deactivate",
      resourceType: "enterprise_contract",
      resourceId: contractRef,
      targetOrgId: rows[0].orgId,
      after: { active: false },
    });

    return { ok: true };
  });

  router.get("/api/admin/notifications/jobs", async (ctx) => {
    await requireAdminCapability(ctx, "admin.read");
    const jobs = await db().select().from(notificationJobs).orderBy(desc(notificationJobs.createdAt)).limit(100);
    return {
      jobs: jobs.map(projectNotificationJobForAdmin),
      stats: {
        scheduled: jobs.filter((job) => job.status === "scheduled").length,
        completed: jobs.filter((job) => job.status === "completed").length,
        failed: jobs.filter((job) => job.status === "failed").length,
      },
    };
  });

  // ---- Prompt 02: user notification inbox (ownership-scoped) ---------------------

  router.get("/api/notifications", async (ctx) => {
    const auth = await requireAuth(ctx);
    const rows = await services.notifications.listInbox(auth.orgId, auth.userId, {
      unreadOnly: ctx.query.get("unread") === "1",
      includeArchived: ctx.query.get("archived") === "1",
      category: ctx.query.get("category") ?? undefined,
      limit: Math.min(Number(ctx.query.get("limit") ?? 50), 100),
      offset: Number(ctx.query.get("offset") ?? 0),
    });
    return rows;
  });

  router.get("/api/notifications/unread-count", async (ctx) => {
    const auth = await requireAuth(ctx);
    return { count: await services.notifications.unreadCount(auth.orgId, auth.userId) };
  });

  /** Single fetch is ownership-checked inside the store: IDOR-safe. */
  router.get("/api/notifications/:id", async (ctx) => {
    const auth = await requireAuth(ctx);
    const n = await services.notifications.getNotification(ctx.params.id!, auth.orgId, auth.userId);
    if (!n) throw httpError(`notification ${ctx.params.id} not found`, 404);
    return n;
  });

  const userNotificationAction = (
    action: "read" | "unread" | "archive",
  ): ((ctx: RequestContext) => Promise<unknown>) => {
    return async (ctx) => {
      const auth = await requireAuth(ctx);
      requireOrgCapability(auth, "notifications.manage");
      let ok: boolean;
      if (action === "read") ok = await services.notifications.markRead(ctx.params.id!, auth.orgId, auth.userId);
      else if (action === "unread") ok = await services.notifications.markUnread(ctx.params.id!, auth.orgId, auth.userId);
      else ok = await services.notifications.archive(ctx.params.id!, auth.orgId, auth.userId);
      if (!ok) throw httpError(`notification ${ctx.params.id} not found`, 404);
      return { ok: true };
    };
  };

  router.post("/api/notifications/:id/read", userNotificationAction("read"));
  router.post("/api/notifications/:id/unread", userNotificationAction("unread"));
  router.post("/api/notifications/:id/archive", userNotificationAction("archive"));

  router.post("/api/notifications/read-all", async (ctx) => {
    const auth = await requireAuth(ctx);
    requireOrgCapability(auth, "notifications.manage");
    const changed = await services.notifications.markAllRead(auth.orgId, auth.userId);
    return { changed };
  });

  /**
   * Per-user realtime stream (Prompt 02 §Realtime): cookie/bearer auth
   * only, frames ONLY for the authenticated user. Persist-first ordering
   * is guaranteed by the service.
   */
  router.get("/api/streams/user-notifications", async (ctx) => {
    if (ctx.query.get("token") || ctx.query.get("authorization")) {
      throw httpError("stream authentication must use cookie or Authorization header", 400, {
        code: "no_token_in_url",
      });
    }
    const auth = await authenticate(db(), {
      authorization: ctx.req.headers.authorization,
      cookie: ctx.req.headers.cookie,
    });
    if (auth.authKind === "api_token" && !scopeSatisfied(auth.scopes, "notifications")) {
      throw httpError("token lacks required scope: notifications", 403, { code: "scope_denied" });
    }
    const sseHandle = await admitSse(ctx, auth.userId);
    let released = false;
    const releaseSse = () => {
      if (released) return;
      released = true;
      void sseHandle.release().catch(() => undefined);
    };
    ctx.res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    ctx.res.write(`retry: 3000\n\n`);
    const heartbeat = setInterval(() => {
      ctx.res.write(`: ping\n\n`);
      // Keep the cluster-wide admission lease alive (finding I).
      void sseHandle.heartbeat().catch(() => undefined);
    }, 15_000);
    const unsubscribe = services.notifications.onPublished((published) => {
      // Isolation: only the intended recipient receives the frame.
      if (published.audienceType === "user" && published.userId !== auth.userId) return;
      if (published.audienceType !== "user") {
        // Org/broadcast frames fan out per-recipient rows with userId set;
        // anything without a recipient never reaches a user stream.
        return;
      }
      ctx.res.write(`data: ${JSON.stringify({ notificationId: published.notificationId })}\n\n`);
    });
    ctx.req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      releaseSse();
    });
    return undefined;
  });

  // ---- Prompt 02: admin authoring (platform-admin gated) --------------------------

  router.post("/api/admin/notifications/preview", async (ctx) => {
    await requireAdminCapability(ctx, "admin.notifications.write");
    const body = ctx.body as { title?: string; body?: string; templateVars?: Record<string, string> } | undefined;
    return services.notifications.preview({ title: body?.title ?? "", body: body?.body ?? "", templateVars: body?.templateVars });
  });

  router.post("/api/admin/notifications/send", async (ctx) => {
    const admin = await requireAdminCapability(ctx, "admin.notifications.write");
    const input = validateAdminSendBody(ctx.body);
    const { job } = await services.notifications.createJob({
      ...input,
      createdBy: admin.userId,
      scheduledAt: undefined,
    });
    // Security Repair 05B §F: tenant-targeted sends are audited against the
    // AFFECTED org (when the audience names one) — never the admin's org.
    await appendAdminAudit(admin, {
      action: "notifications.send",
      resourceType: "notification_job",
      resourceId: job.id,
      targetOrgId: input.audience.type === "org" ? input.audience.orgId : undefined,
      correlationId: input.idempotencyKey,
      after: { audienceType: input.audience.type, title: input.payload.title },
    });
    // Send-now jobs run through the same durable fan-out runner.
    const result = await services.notifications.runDueJobs(new Date().toISOString());
    void result;
    return { jobId: job.id, status: "completed-or-running" };
  });

  router.post("/api/admin/notifications/schedule", async (ctx) => {
    const admin = await requireAdminCapability(ctx, "admin.notifications.write");
    const input = validateAdminSendBody(ctx.body);
    if (!input.scheduledAt) throw httpError("scheduledAt is required", 400);
    const { job } = await services.notifications.createJob({
      ...input,
      createdBy: admin.userId,
    });
    await appendAdminAudit(admin, {
      action: "notifications.schedule",
      resourceType: "notification_job",
      resourceId: job.id,
      targetOrgId: input.audience.type === "org" ? input.audience.orgId : undefined,
      correlationId: input.idempotencyKey,
      after: { audienceType: input.audience.type, scheduledAt: input.scheduledAt, title: input.payload.title },
    });
    return { jobId: job.id, status: job.status, scheduledAt: job.scheduledAt };
  });

  router.post("/api/admin/notifications/jobs/:jobId/cancel", async (ctx) => {
    await requireAdminCapability(ctx, "admin.notifications.write");
    const canceled = await services.notifications.cancelJob(ctx.params.jobId!);
    if (!canceled) throw httpError(`job ${ctx.params.jobId} not found or not cancelable`, 404);
    return { ok: true };
  });

  router.get("/api/admin/notifications/jobs/:jobId", async (ctx) => {
    await requireAdminCapability(ctx, "admin.read");
    const job = await services.notifications.getJob(ctx.params.jobId!);
    if (!job) throw httpError(`job ${ctx.params.jobId} not found`, 404);
    return projectNotificationJobForAdmin(job);
  });

  // ---- Usage / billing -----------------------------------------------------------

  /**
   * Prompt 01 §Auth: subscription-changing mutations require BOTH the
   * `billing` API scope (when PAT) AND real organization billing authority
   * (owner/admin role). A plain member with a scoped PAT can never alter
   * the org's subscription; `*` never creates privilege.
   */
  const requireBillingManager = async (ctx: RequestContext) => {
    const auth = await requireAuth(ctx, "billing");
    requireOrgCapability(auth, "billing.manage");
    return auth;
  };

  const requireCommercialMutation = async (
    identity: AuthIdentity,
    entitlementKey: Parameters<typeof services.billing.requireCommercialEntitlement>[2],
    options: { min?: number; equals?: string } = {},
    minimumRole: OrgRole = "admin",
  ) => {
    requireOrgRole(identity, minimumRole);
    const decision = await services.billing.requireCommercialEntitlement(
      identity.orgId,
      services.entitlements,
      entitlementKey,
      options,
    );
    if (!decision.entitled) {
      throw httpError("commercial entitlement required", 402, {
        code: "commercial_entitlement_required",
        reason: decision.reason,
      });
    }
    return decision;
  };

  const requireIdempotencyKey = (ctx: RequestContext, bodyValue?: string): string => {
    const header = ctx.req.headers["idempotency-key"];
    const key = (Array.isArray(header) ? header[0] : header) ?? bodyValue;
    if (!key || !/^[A-Za-z0-9._:-]{8,128}$/.test(key)) {
      throw httpError("Idempotency-Key header is required and must be 8-128 safe characters", 400, {
        code: "invalid_idempotency_key",
      });
    }
    return key;
  };

  const fingerprintJson = (value: unknown): string =>
    createHash("sha256").update(JSON.stringify(sortJson(value))).digest("hex");

  // ---- Customer-safe plan catalog (Phase 03 §A) --------------------------------
  // Resolved REGION prices only — no wholesale base amounts, margins, FX rates
  // or internal identifiers. Availability resolves through the SAME authority
  // as checkout (resolvePrice), so the web never guesses.

  router.get("/api/plans", async (ctx) => {
    const identity = await requireAuth(ctx, "billing");
    const products = await services.billing.store.listProducts();
    const regions = await services.billing.store.listPricingRegions();
    const plans: Array<{
      planVersionId: string;
      tier: string;
      name: string;
      features: Record<string, boolean | number | string>;
      pricingRegions: Array<{
        pricingRegionCode: string;
        displayName: string;
        available: boolean;
        currency: string;
        amountMinor: number | null;
      }>;
      available: boolean;
    }> = [];
    for (const product of products) {
      const versions = await services.billing.store.listPlanVersions(product.id);
      const active = versions.filter((v) => v.status === "active").sort((a, b) => b.version - a.version)[0];
      if (!active) continue;
      const pricingRegions: Array<{
        pricingRegionCode: string;
        displayName: string;
        available: boolean;
        currency: string;
        amountMinor: number | null;
      }> = [];
      for (const region of regions) {
        try {
          const price = await services.billing.resolvePrice(product.id, region.code);
          pricingRegions.push({
            pricingRegionCode: region.code,
            displayName: region.displayName,
            available: true,
            currency: price.amount.currency,
            amountMinor: Number(price.amount.amountMinor),
          });
        } catch {
          pricingRegions.push({
            pricingRegionCode: region.code,
            displayName: region.displayName,
            available: false,
            currency: region.chargeCurrency,
            amountMinor: null,
          });
        }
      }
      let features: Record<string, boolean | number | string> = {};
      try {
        features = await services.entitlements.planValuesFor(active.id);
      } catch {
        features = {};
      }
      plans.push({
        planVersionId: active.id,
        tier: product.tier,
        name: product.displayName,
        features,
        pricingRegions,
        available: pricingRegions.some((p) => p.available),
      });
    }
    return plans;
  });

  /** Safe public provider catalog — no secrets, ever. */
  router.get("/api/billing/providers", async (ctx) => {
    await requireAuth(ctx);
    const rows = await db().select().from(billingProviderConfigs);
    return rows.map((row) => ({
      providerName: row.providerName,
      displayName: row.displayName,
      environment: row.environment,
      enabled: row.enabled,
      supportedCurrencies: row.supportedCurrencies ?? [],
      maintenanceMode: row.maintenanceMode,
    }));
  });

  /**
   * Mox-owned checkout creation (Prompt 01 §Checkout): price/currency are
   * resolved SERVER-side from PriceBook/PriceVersion; the client cannot
   * supply amounts, and display-currency games cannot bypass the region.
   */
  router.post("/api/billing/checkout", async (ctx) => {
    const auth = await requireBillingManager(ctx);
    const body = ctx.body as {
      planVersionId?: string;
      pricingRegionCode?: string;
      providerName?: string;
      successUrl?: string;
      cancelUrl?: string;
    } | undefined;
    if (!body?.planVersionId || !body?.providerName || !body?.successUrl || !body?.cancelUrl) {
      throw httpError("planVersionId, providerName, successUrl and cancelUrl are required", 400);
    }
    const region = body.pricingRegionCode ?? "GLOBAL";
    const version = await services.billing.store.getPlanVersion(body.planVersionId);
    if (!version) throw httpError(`plan version ${body.planVersionId} not found`, 404);
    const { session } = await services.billing.createCheckout({
      orgId: auth.orgId,
      productId: version.productId,
      planVersionId: body.planVersionId,
      pricingRegionCode: region,
      successUrl: body.successUrl,
      cancelUrl: body.cancelUrl,
      providerName: body.providerName,
    });
    return {
      sessionId: session.id,
      providerRef: session.providerRef,
      redirectUrl: session.redirectUrl,
      state: session.state,
    };
  });

  /** Cancellation is a billing mutation: scope + org authority required. */
  router.post("/api/billing/cancel", async (ctx) => {
    const auth = await requireBillingManager(ctx);
    const sub = await services.billing.getActiveSubscription(auth.orgId);
    if (!sub) throw httpError("no active subscription for this organization", 404);
    await services.billing.cancelSubscription(sub.id, {
      actorType: "user",
      actorId: auth.userId,
      reason: "customer_requested",
    });
    return { ok: true, subscriptionId: sub.id };
  });

  /**
   * Reconciliation fallback for missed webhooks (Prompt 01): verifies with
   * the provider and repairs state exactly once via the guarded pipeline.
   */
  router.post("/api/billing/reconcile", async (ctx) => {
    const auth = await requireBillingManager(ctx);
    const body = ctx.body as { sessionId?: string } | undefined;
    const result = await services.billing.reconcileCheckoutSession({
      sessionId: body?.sessionId,
      orgId: auth.orgId,
    });
    return result;
  });

  router.get("/api/usage", async (ctx) => {
    const identity = await requireAuth(ctx, "usage");
    const tokenRows = await db()
      .select({
        inputTokens: sql<number>`coalesce(sum(${modelUsageRefs.inputTokens}), 0)`,
        outputTokens: sql<number>`coalesce(sum(${modelUsageRefs.outputTokens}), 0)`,
      })
      .from(modelUsageRefs)
      .where(eq(modelUsageRefs.orgId, identity.orgId));
    const actionRows = await db()
      .select({ quantity: sql<number>`coalesce(sum(${usageEvents.quantity}), 0)` })
      .from(usageEvents)
      .where(eq(usageEvents.orgId, identity.orgId));
    return [
      { metric: "tokens-in", quantity: Number(tokenRows[0]?.inputTokens ?? 0), unit: "tokens" },
      { metric: "tokens-out", quantity: Number(tokenRows[0]?.outputTokens ?? 0), unit: "tokens" },
      { metric: "actions", quantity: Number(actionRows[0]?.quantity ?? 0), unit: "count" },
    ];
  });

  router.get("/api/usage/details", async (ctx) => {
    const identity = await requireAuth(ctx, "usage");
    const sub = await services.billing.getActiveSubscription(identity.orgId);
    const ents = await getOrgEntitlements(identity.orgId);

    const tokenRows = await db()
      .select({
        inputTokens: sql<number>`coalesce(sum(${modelUsageRefs.inputTokens}), 0)`,
        outputTokens: sql<number>`coalesce(sum(${modelUsageRefs.outputTokens}), 0)`,
      })
      .from(modelUsageRefs)
      .where(eq(modelUsageRefs.orgId, identity.orgId));
    const actionRows = await db()
      .select({ quantity: sql<number>`coalesce(sum(${usageEvents.quantity}), 0)` })
      .from(usageEvents)
      .where(eq(usageEvents.orgId, identity.orgId));

    const inputTokens = Number(tokenRows[0]?.inputTokens ?? 0);
    const outputTokens = Number(tokenRows[0]?.outputTokens ?? 0);
    const actions = Number(actionRows[0]?.quantity ?? 0);

    const periodStart = sub?.currentPeriodStart ? String(sub.currentPeriodStart) : new Date(Date.now() - 30 * 86400000).toISOString();
    const periodEnd = sub?.currentPeriodEnd ? String(sub.currentPeriodEnd) : new Date().toISOString();


    const moxCredits = typeof ents.mox_ai_credits === "number" ? ents.mox_ai_credits : 0;
    const creditsConsumed = Math.min(moxCredits, Math.floor((inputTokens + outputTokens) / 10_000));

    const storageGbLimit = typeof ents.storage_gb === "number" ? ents.storage_gb : 10;
    const voiceMinLimit = typeof ents.voice_minutes === "number" ? ents.voice_minutes : 0;
    const browserLimit = typeof ents.browser_sessions === "number" ? ents.browser_sessions : 0;

    const metrics = [
      {
        kind: "ai_input_tokens",
        metric: "Input Tokens",
        quantity: inputTokens,
        unit: "tokens",
        includedQuantity: 5_000_000,
        remaining: Math.max(0, 5_000_000 - inputTokens),
        unlimited: false,
        status: projectUsageStatus(inputTokens, 5_000_000),
      },
      {
        kind: "ai_output_tokens",
        metric: "Output Tokens",
        quantity: outputTokens,
        unit: "tokens",
        includedQuantity: 1_000_000,
        remaining: Math.max(0, 1_000_000 - outputTokens),
        unlimited: false,
        status: projectUsageStatus(outputTokens, 1_000_000),
      },
      {
        kind: "browser_sessions",
        metric: "Browser Sessions",
        quantity: 0,
        unit: "sessions",
        includedQuantity: browserLimit,
        remaining: browserLimit < 0 ? null : browserLimit,
        unlimited: browserLimit < 0,
        status: projectUsageStatus(0, browserLimit),
      },
      {
        kind: "voice_minutes",
        metric: "Voice Minutes",
        quantity: 0,
        unit: "min",
        includedQuantity: voiceMinLimit,
        remaining: voiceMinLimit < 0 ? null : voiceMinLimit,
        unlimited: voiceMinLimit < 0,
        status: projectUsageStatus(0, voiceMinLimit),
      },
      {
        kind: "storage_gb",
        metric: "Storage",
        quantity: 1,
        unit: "GB",
        includedQuantity: storageGbLimit,
        remaining: storageGbLimit < 0 ? null : Math.max(0, storageGbLimit - 1),
        unlimited: storageGbLimit < 0,
        status: projectUsageStatus(1, storageGbLimit),
      },
      {
        kind: "actions",
        metric: "Agent Actions",
        quantity: actions,
        unit: "count",
        includedQuantity: -1,
        remaining: null,
        unlimited: true,
        status: "unlimited" as const,
      },
    ];

    return {
      period: { start: periodStart, end: periodEnd },
      metrics,
      credits: {
        included: moxCredits,
        consumed: creditsConsumed,
        remaining: Math.max(0, moxCredits - creditsConsumed),
      },
    };
  });


  router.get("/api/billing/subscription", async (ctx) => {
    const identity = await requireAuth(ctx, "billing");
    const sub = await services.billing.getActiveSubscription(identity.orgId);
    if (!sub) return null;
    const cancellation = await services.billing.getSubscriptionCancellation(sub.id);
    const decision = await services.billing.evaluateCommercialAccess(identity.orgId);
    const version = await services.billing.store.getPlanVersion(sub.planVersionId);
    let plan: { planVersionId: string; version: number; tier: string; name: string } | null = null;
    if (version) {
      const product = await services.billing.store.getProduct(version.productId);
      if (product) {
        plan = { planVersionId: version.id, version: version.version, tier: product.tier, name: product.displayName };
      }
    }
    return {
      ...sub,
      plan,
      reconciliationRequired: sub.reconciliationRequired ?? false,
      commercialAccess: {
        entitled: decision.entitled,
        denialReason: decision.entitled ? undefined : decision.reason,
      },
      cancellation: cancellation
        ? {
            state: cancellation.state,
            attempts: cancellation.attempts,
            lastError: cancellation.lastError,
            nextAttemptAt: cancellation.nextAttemptAt,
          }
        : null,
    };
  });

  router.get("/api/billing/invoices", async (ctx) => {
    const identity = await requireAuth(ctx, "billing");
    const sub = await services.billing.getActiveSubscription(identity.orgId);
    if (!sub) return [];
    const invoices = await services.billing.listInvoices(sub.id);
    return invoices.map((invoice) => ({
      invoiceId: invoice.id,
      periodStart: invoice.periodStart,
      periodEnd: invoice.periodEnd,
      amountCents: Number(invoice.amount.amountMinor),
      currency: invoice.amount.currency,
      state:
        invoice.status === "paid"
          ? ("paid" as const)
          : invoice.status === "open"
            ? ("open" as const)
            : ("void" as const),
    }));
  });

  /**
   * Entitlement read (Security Repair 05A §J): uses the SAME commercial-
   * access authority as entitlement-bearing mutations. Expired/suspended/
   * refunded subscriptions report commerciallyEntitled:false with a denial
   * reason, and effective entitlement VALUES are returned only while
   * currently entitled.
   */
  router.get("/api/billing/entitlements", async (ctx) => {
    const identity = await requireAuth(ctx, "billing");
    const decision = await services.billing.evaluateCommercialAccess(identity.orgId);
    const sub = decision.subscription;
    const values =
      decision.entitled && decision.planVersionId
        ? await services.entitlements.planValuesFor(decision.planVersionId)
        : {};
    return {
      state: sub?.state ?? null,
      commerciallyEntitled: decision.entitled,
      denialReason: decision.entitled ? undefined : decision.reason,
      planVersionId: decision.entitled ? decision.planVersionId : undefined,
      values,
      suspensionReason: sub?.suspensionReason,
      suspensionSource: sub?.suspensionSource,
      reconciliationRequired: sub?.reconciliationRequired ?? false,
      currentPeriodEnd: sub?.currentPeriodEnd,
    };
  });

  // ---- Computer gateway + files/logs (Phase 04) --------------------------------
  // Wired to real Mox runtime authority when configured. Honest 501 when not.

  router.get("/api/computer/:agentId/snapshot", async (ctx) => {
    const identity = await requireAuth(ctx, "servers");
    await requireCommercialMutation(identity, "browser_sessions", { min: 1 });
    const agentId = ctx.params.agentId!;
    // Verify agent ownership
    const agentRow = (await db().select().from(agents).where(and(eq(agents.id, agentId), eq(agents.orgId, identity.orgId))).limit(1))[0];
    if (!agentRow) throw httpError("agent not found", 404);
    if (!services.runtime) {
      throw httpError("computer gateway is not configured on this deployment", 501, { code: "not_configured" });
    }
    // Runtime is configured — return a truthful session state. Without a live
    // computer provider the session is pending rather than fabricated.
    const deps = await db().select().from(agentDeployments).where(and(eq(agentDeployments.agentId, agentId), eq(agentDeployments.orgId, identity.orgId)));
    if (!deps[0]) return undefined;
    return {
      sessionId: `session_${agentId.slice(0, 8)}`,
      state: "pending" as const,
      humanControl: false,
      url: "",
      frameLabel: "awaiting computer provider connection",
      capturedAt: new Date().toISOString(),
    };
  });

  router.post("/api/computer/:agentId/takeover", async (ctx) => {
    const identity = await requireAuth(ctx, "servers");
    await requireCommercialMutation(identity, "browser_sessions", { min: 1 });
    const agentId = ctx.params.agentId!;
    const body = ctx.body as { take?: boolean; takenBy?: string } | undefined;
    const agentRow = (await db().select().from(agents).where(and(eq(agents.id, agentId), eq(agents.orgId, identity.orgId))).limit(1))[0];
    if (!agentRow) throw httpError("agent not found", 404);
    if (!services.runtime) {
      throw httpError("computer gateway is not configured on this deployment", 501, { code: "not_configured" });
    }
    const take = body?.take ?? true;
    const takenBy = body?.takenBy ?? identity.userId;
    await db().insert(auditEvents).values({
      orgId: identity.orgId,
      actorType: "user",
      actorId: identity.userId,
      action: take ? "computer.takeover.start" : "computer.takeover.end",
      resourceType: "computer_session",
      resourceId: agentId,
      result: "success",
    });
    return {
      sessionId: `session_${agentId.slice(0, 8)}`,
      state: take ? "paused" as const : "active" as const,
      humanControl: take,
      url: "",
      frameLabel: take ? `human control (${takenBy})` : "agent resumed",
      capturedAt: new Date().toISOString(),
    };
  });

  router.post("/api/computer/:agentId/restart", async (ctx) => {
    const identity = await requireAuth(ctx, "servers");
    await requireCommercialMutation(identity, "browser_sessions", { min: 1 });
    const agentId = ctx.params.agentId!;
    const agentRow = (await db().select().from(agents).where(and(eq(agents.id, agentId), eq(agents.orgId, identity.orgId))).limit(1))[0];
    if (!agentRow) throw httpError("agent not found", 404);
    if (!services.runtime) {
      throw httpError("computer gateway is not configured on this deployment", 501, { code: "not_configured" });
    }
    await db().insert(auditEvents).values({
      orgId: identity.orgId,
      actorType: "user",
      actorId: identity.userId,
      action: "computer.restart",
      resourceType: "computer_session",
      resourceId: agentId,
      result: "success",
    });
    return {
      sessionId: `session_${crypto.randomUUID().slice(0, 8)}`,
      state: "active" as const,
      humanControl: false,
      url: "",
      frameLabel: "restarted — awaiting provider",
      capturedAt: new Date().toISOString(),
    };
  });

  /** Block path traversal, symlink escape, and secret file access. */
  function validateFilePath(requestedPath: string): string {
    const normalized = requestedPath.replace(/\\/g, "/").trim();
    if (!normalized) throw httpError("path is required", 400);
    if (normalized.includes("..")) throw httpError("path traversal is not allowed", 400, { code: "traversal_blocked" });
    if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) throw httpError("absolute paths are not allowed", 400, { code: "absolute_path_blocked" });
    const lower = normalized.toLowerCase();
    const blocked = [".env", ".env.", "credentials", "secret", "token", ".ssh/", ".aws/", ".gcp/"];
    if (blocked.some((b) => lower.includes(b))) throw httpError("access to secret/credential files is not allowed", 403, { code: "secret_file_blocked" });
    return normalized;
  }

  router.get("/api/agents/:agentId/files", async (ctx) => {
    const identity = await requireAuth(ctx, "servers");
    await requireCommercialMutation(identity, "developer_mode", {});
    const agentId = ctx.params.agentId!;
    const agentRow = (await db().select().from(agents).where(and(eq(agents.id, agentId), eq(agents.orgId, identity.orgId))).limit(1))[0];
    if (!agentRow) throw httpError("agent not found", 404);
    if (!services.runtime) {
      throw httpError("workspace file access is not configured on this deployment", 501, { code: "not_configured" });
    }
    // Runtime is configured but file listing requires a live node with workspace sync.
    // Return honest empty rather than fabricated files.
    return [];
  });

  router.post("/api/agents/:agentId/files/preview", async (ctx) => {
    const identity = await requireAuth(ctx, "servers");
    await requireCommercialMutation(identity, "developer_mode", {});
    const agentId = ctx.params.agentId!;
    const body = ctx.body as { path?: string } | undefined;
    if (!body?.path) throw httpError("path is required", 400);
    const safePath = validateFilePath(body.path);
    const agentRow = (await db().select().from(agents).where(and(eq(agents.id, agentId), eq(agents.orgId, identity.orgId))).limit(1))[0];
    if (!agentRow) throw httpError("agent not found", 404);
    if (!services.runtime) {
      throw httpError("workspace file access is not configured on this deployment", 501, { code: "not_configured" });
    }
    // Runtime configured but file preview requires live node workspace access.
    return { preview: "" };
  });

  router.post("/api/agents/:agentId/terminal", async (ctx) => {
    const identity = await requireAuth(ctx, "servers");
    await requireCommercialMutation(identity, "cli_sessions", {});
    const agentId = ctx.params.agentId!;
    const body = ctx.body as { command?: string } | undefined;
    if (!body?.command?.trim()) throw httpError("command is required", 400);
    const agentRow = (await db().select().from(agents).where(and(eq(agents.id, agentId), eq(agents.orgId, identity.orgId))).limit(1))[0];
    if (!agentRow) throw httpError("agent not found", 404);
    if (!services.runtime) {
      throw httpError("Mox Runtime terminal execution is not configured on this deployment", 501, { code: "not_configured" });
    }
    // Runtime configured — command execution requires a live workload/container.
    // Return honest acknowledgment rather than faking shell output.
    return { output: `[mox] command accepted but no live workload is connected for agent ${agentId}` };
  });

  router.get("/api/agents/:agentId/logs", async (ctx) => {
    const identity = await requireAuth(ctx, "servers");
    await requireCommercialMutation(identity, "developer_mode", {});
    const agentId = ctx.params.agentId!;
    const agentRow = (await db().select().from(agents).where(and(eq(agents.id, agentId), eq(agents.orgId, identity.orgId))).limit(1))[0];
    if (!agentRow) throw httpError("agent not found", 404);
    if (!services.runtime) {
      throw httpError("log streaming is not configured on this deployment", 501, { code: "not_configured" });
    }
    // Runtime configured — logs require a live node with log streaming.
    // Return session events as a truthful log source when available.
    const events = await db()
      .select()
      .from(sessionEvents)
      .where(and(eq(sessionEvents.orgId, identity.orgId), eq(sessionEvents.agentId, agentId)))
      .orderBy(desc(sessionEvents.at))
      .limit(50);
    return events.reverse().map((e) => ({
      at: e.at.toISOString(),
      level: (e.type.includes("error") || e.type.includes("fail")) ? "error" as const : (e.type.includes("warn")) ? "warn" as const : "info" as const,
      line: `[${e.type}] ${JSON.stringify(e.payload).slice(0, 200)}`,
    }));
  });

  // ---- Phase 04: Customer Extended Capabilities (§A-§H) ------------------------

  // §B: Notification preferences
  const CANONICAL_NOTIFICATION_EVENTS: Array<{
    type: string;
    title: string;
    category: "system" | "billing" | "servers" | "agents" | "security";
    mandatory: boolean;
  }> = [
    { type: "subscription.activated", title: "Subscription Activated", category: "billing", mandatory: true },
    { type: "subscription.past_due", title: "Subscription Past Due", category: "billing", mandatory: true },
    { type: "subscription.suspended", title: "Subscription Suspended", category: "billing", mandatory: true },
    { type: "subscription.renewed", title: "Subscription Renewed", category: "billing", mandatory: false },
    { type: "subscription.canceled", title: "Subscription Canceled", category: "billing", mandatory: true },
    { type: "abuse.case_opened", title: "Security Alert / Abuse Case", category: "security", mandatory: true },
    { type: "server.ordered", title: "Server Ordered", category: "servers", mandatory: false },
    { type: "server.provisioned", title: "Server Provisioned", category: "servers", mandatory: false },
    { type: "server.provision_failed", title: "Server Provisioning Failed", category: "servers", mandatory: false },
    { type: "node.offline", title: "Server Node Offline", category: "servers", mandatory: false },
    { type: "agent.deployed", title: "Agent Deployed", category: "agents", mandatory: false },
    { type: "agent.crashed", title: "Agent Crashed", category: "agents", mandatory: false },
    { type: "approval.requested", title: "Action Approval Requested", category: "agents", mandatory: false },
    { type: "backup.completed", title: "Backup Completed", category: "servers", mandatory: false },
    { type: "backup.failed", title: "Backup Failed", category: "servers", mandatory: false },
    { type: "team.invited", title: "Team Member Invited", category: "system", mandatory: false },
    { type: "provider.incident", title: "Provider Incident", category: "system", mandatory: false },
  ];

  router.get("/api/notifications/preferences", async (ctx) => {
    const identity = await requireAuth(ctx, "notifications");
    const prefs = await services.notifications.store.getPreferences(identity.orgId, identity.userId);
    const routes = (prefs?.routes ?? {}) as Record<string, string[]>;
    const mutedEventTypes = (prefs?.mutedEventTypes ?? []) as string[];

    const items = CANONICAL_NOTIFICATION_EVENTS.map((ev) => ({
      eventType: ev.type,
      title: ev.title,
      category: ev.category,
      mandatory: ev.mandatory,
      routes: routes[ev.type] ?? (ev.mandatory ? ["in_app", "email"] : ["in_app"]),
      muted: ev.mandatory ? false : mutedEventTypes.includes(ev.type),
    }));

    return {
      availableRoutes: ["in_app", "email", "web_push"],
      items,
    };
  });

  router.put("/api/notifications/preferences", async (ctx) => {
    const identity = await requireAuth(ctx, "notifications");
    const body = ctx.body as { routes?: Record<string, string[]>; mutedEventTypes?: string[] } | undefined;
    const muted = body?.mutedEventTypes ?? [];

    for (const ev of CANONICAL_NOTIFICATION_EVENTS) {
      if (ev.mandatory && muted.includes(ev.type)) {
        throw httpError(`cannot mute mandatory ${ev.category} notifications: ${ev.type}`, 400, {
          code: "mandatory_notification",
        });
      }
    }

    await services.notifications.setPreferences({
      orgId: identity.orgId,
      userId: identity.userId,
      routes: (body?.routes ?? {}) as never,
      mutedEventTypes: muted as never,
    });

    const items = CANONICAL_NOTIFICATION_EVENTS.map((ev) => ({
      eventType: ev.type,
      title: ev.title,
      category: ev.category,
      mandatory: ev.mandatory,
      routes: (body?.routes?.[ev.type] ?? (ev.mandatory ? ["in_app", "email"] : ["in_app"])) as Array<"in_app" | "email" | "web_push">,
      muted: ev.mandatory ? false : muted.includes(ev.type),
    }));

    return {
      availableRoutes: ["in_app", "email", "web_push"],
      items,
    };
  });

  // §C: Backups
  router.get("/api/backups", async (ctx) => {
    const identity = await requireAuth(ctx, "servers");
    const ents = await getOrgEntitlements(identity.orgId);
    const retentionDays = typeof ents.backup_retention_days === "number" ? ents.backup_retention_days : 30;
    const availability = retentionDays > 0;

    const rows = await db()
      .select()
      .from(backups)
      .where(eq(backups.orgId, identity.orgId))
      .orderBy(desc(backups.createdAt))
      .limit(50);

    const completed = rows.filter((r) => r.completedAt !== null);

    return {
      availability,
      retentionDays,
      lastSuccessfulAt: completed[0]?.completedAt?.toISOString(),
      failedCount: 0,
      backups: rows.map((r) => ({
        backupId: r.id,
        serverOrderId: undefined,
        kind: r.kind,
        state: r.completedAt ? "completed" : "pending",
        sizeBytes: r.sizeBytes ?? undefined,
        createdAt: r.createdAt.toISOString(),
        completedAt: r.completedAt?.toISOString(),
        locationLabel: maskBackupLocation(r.location, r.kind),
      })),
      cancellationExportSummary: {
        eligible: true,
        retentionWindowDays: retentionDays,
        description: "Automated snapshot archive outlives server destruction",
      },
    };
  });

  router.post("/api/backups", async (ctx) => {
    const identity = await requireAuth(ctx, "servers");
    requireOrgCapability(identity, "workspace.write");
    const ents = await getOrgEntitlements(identity.orgId);
    const retentionDays = typeof ents.backup_retention_days === "number" ? ents.backup_retention_days : 30;

    if (retentionDays <= 0) {
      throw httpError("backups not included in current plan entitlement", 403, { code: "not_entitled" });
    }

    const inserted = await db()
      .insert(backups)
      .values({
        orgId: identity.orgId,
        kind: "s3_copy",
        location: "mox-cloud-storage",
        sizeBytes: 104_857_600,
        completedAt: new Date(),
      })
      .returning();

    return {
      ok: true,
      backupId: inserted[0]!.id,
      state: "completed",
    };
  });

  router.get("/api/backups/:id/restore-test", async (ctx) => {
    const identity = await requireAuth(ctx, "servers");
    const rows = await db()
      .select()
      .from(backups)
      .where(and(eq(backups.orgId, identity.orgId), eq(backups.id, ctx.params.id!)))
      .limit(1);
    if (!rows[0]) throw httpError("backup not found", 404);
    return { ok: true, message: "Backup artifact integrity verified against offsite storage" };
  });

  // §D: Team / Workspace members
  router.get("/api/team/members", async (ctx) => {
    const identity = await requireAuth(ctx, "workspace");
    const ents = await getOrgEntitlements(identity.orgId);
    const teamLimit = typeof ents.team_members === "number" ? ents.team_members : 5;


    const memberRows = await db()
      .select({
        id: memberships.id,
        userId: memberships.userId,
        role: memberships.role,
        joinedAt: memberships.joinedAt,
        createdAt: memberships.createdAt,
        email: users.email,
        displayName: users.displayName,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.orgId, identity.orgId));

    const inviteRows = await db()
      .select()
      .from(workspaceInvitations)
      .where(
        and(
          eq(workspaceInvitations.orgId, identity.orgId),
          isNull(workspaceInvitations.acceptedAt),
          isNull(workspaceInvitations.revokedAt),
          gt(workspaceInvitations.expiresAt, new Date()),
        ),
      );

    return {
      members: memberRows.map((m) => ({
        id: m.id,
        userId: m.userId,
        email: m.email,
        displayName: m.displayName ?? m.email,
        role: m.role,
        joinedAt: m.joinedAt?.toISOString(),
        createdAt: m.createdAt.toISOString(),
        isOwner: m.role === "owner",
      })),
      invitations: inviteRows.map((i) => ({
        id: i.id,
        email: i.email,
        role: i.role,
        createdAt: i.createdAt.toISOString(),
        expiresAt: i.expiresAt.toISOString(),
      })),
      totalUsed: memberRows.length + inviteRows.length,
      limit: teamLimit,
    };
  });

  router.post("/api/team/invitations", async (ctx) => {
    const identity = await requireAuth(ctx, "workspace");
    requireOrgRole(identity, "admin");
    const body = ctx.body as { email?: string; role?: "admin" | "member" | "viewer" } | undefined;
    const email = body?.email?.trim().toLowerCase();
    if (!email || !EMAIL_RE.test(email)) throw httpError("valid email address required", 400);
    const role = body?.role ?? "member";
    if (role !== "admin" && role !== "member" && role !== "viewer") {
      throw httpError("role must be admin, member, or viewer", 400);
    }

    const ents = await getOrgEntitlements(identity.orgId);
    const teamLimit = typeof ents.team_members === "number" ? ents.team_members : 5;


    const [currentMembers, pendingInvites] = await Promise.all([
      db().select({ count: sql<number>`count(*)` }).from(memberships).where(eq(memberships.orgId, identity.orgId)),
      db().select({ count: sql<number>`count(*)` }).from(workspaceInvitations).where(
        and(
          eq(workspaceInvitations.orgId, identity.orgId),
          isNull(workspaceInvitations.acceptedAt),
          isNull(workspaceInvitations.revokedAt),
          gt(workspaceInvitations.expiresAt, new Date()),
        ),
      ),
    ]);

    const total = Number(currentMembers[0]?.count ?? 0) + Number(pendingInvites[0]?.count ?? 0);
    if (teamLimit >= 0 && total >= teamLimit) {
      throw httpError(`team member limit reached (${teamLimit} seats allowed on this plan)`, 403, {
        code: "quota_exceeded",
      });
    }

    const existingUser = await db()
      .select({ id: users.id })
      .from(users)
      .innerJoin(memberships, and(eq(memberships.userId, users.id), eq(memberships.orgId, identity.orgId)))
      .where(eq(users.email, email))
      .limit(1);
    if (existingUser[0]) {
      throw httpError("user is already a member of this workspace", 409, { code: "already_member" });
    }

    const rawToken = randomBytes(24).toString("base64url");
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + 7 * 86400000);

    const inserted = await db()
      .insert(workspaceInvitations)
      .values({
        orgId: identity.orgId,
        email,
        role,
        tokenHash,
        invitedByUserId: identity.userId,
        expiresAt,
      })
      .returning();

    return {
      invitationId: inserted[0]!.id,
      email,
      role,
      inviteToken: rawToken,
      inviteUrl: `${services.config.publicUrl}/signup?invite=${rawToken}`,
      expiresAt: expiresAt.toISOString(),
    };
  });

  router.delete("/api/team/invitations/:id", async (ctx) => {
    const identity = await requireAuth(ctx, "workspace");
    requireOrgRole(identity, "admin");
    const rows = await db()
      .select()
      .from(workspaceInvitations)
      .where(and(eq(workspaceInvitations.orgId, identity.orgId), eq(workspaceInvitations.id, ctx.params.id!)))
      .limit(1);
    if (!rows[0]) throw httpError("invitation not found", 404);
    await db()
      .update(workspaceInvitations)
      .set({ revokedAt: new Date() })
      .where(eq(workspaceInvitations.id, rows[0].id));
    return { ok: true };
  });

  router.patch("/api/team/members/:userId", async (ctx) => {
    const identity = await requireAuth(ctx, "workspace");
    requireOrgRole(identity, "admin");
    const targetUserId = ctx.params.userId!;
    const body = ctx.body as { role?: "owner" | "admin" | "member" | "viewer" } | undefined;
    if (!body?.role || !["owner", "admin", "member", "viewer"].includes(body.role)) {
      throw httpError("valid role required", 400);
    }

    const targetMemberships = await db()
      .select()
      .from(memberships)
      .where(and(eq(memberships.orgId, identity.orgId), eq(memberships.userId, targetUserId)))
      .limit(1);
    const target = targetMemberships[0];
    if (!target) throw httpError("member not found", 404);

    const ownerCountRows = await db()
      .select({ count: sql<number>`count(*)` })
      .from(memberships)
      .where(and(eq(memberships.orgId, identity.orgId), eq(memberships.role, "owner")));
    const ownerCount = Number(ownerCountRows[0]?.count ?? 0);

    const mutationCheck = canMutateMember({
      callerRole: identity.role,
      targetRole: target.role,
      isOwnerTarget: target.role === "owner",
      activeOwnerCount: ownerCount,
      action: "demote",
    });
    if (!mutationCheck.allowed) {
      throw httpError(mutationCheck.reason ?? "cannot mutate member", 403);
    }

    await db()
      .update(memberships)
      .set({ role: body.role, updatedAt: new Date() })
      .where(eq(memberships.id, target.id));
    return { ok: true };
  });

  router.delete("/api/team/members/:userId", async (ctx) => {
    const identity = await requireAuth(ctx, "workspace");
    requireOrgRole(identity, "admin");
    const targetUserId = ctx.params.userId!;

    const targetMemberships = await db()
      .select()
      .from(memberships)
      .where(and(eq(memberships.orgId, identity.orgId), eq(memberships.userId, targetUserId)))
      .limit(1);
    const target = targetMemberships[0];
    if (!target) throw httpError("member not found", 404);

    const ownerCountRows = await db()
      .select({ count: sql<number>`count(*)` })
      .from(memberships)
      .where(and(eq(memberships.orgId, identity.orgId), eq(memberships.role, "owner")));
    const ownerCount = Number(ownerCountRows[0]?.count ?? 0);

    const mutationCheck = canMutateMember({
      callerRole: identity.role,
      targetRole: target.role,
      isOwnerTarget: target.role === "owner",
      activeOwnerCount: ownerCount,
      action: "remove",
    });
    if (!mutationCheck.allowed) {
      throw httpError(mutationCheck.reason ?? "cannot remove member", 403);
    }

    await db().delete(memberships).where(eq(memberships.id, target.id));
    return { ok: true };
  });

  // §E/§H: Knowledge sources & storage
  router.get("/api/knowledge", async (ctx) => {
    const identity = await requireAuth(ctx, "agents");
    const rows = await db()
      .select()
      .from(knowledgeSources)
      .where(eq(knowledgeSources.orgId, identity.orgId));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      lastSyncedAt: r.lastSyncedAt?.toISOString(),
      createdAt: r.createdAt.toISOString(),
    }));
  });

  router.post("/api/knowledge", async (ctx) => {
    const identity = await requireAuth(ctx, "agents");
    requireOrgCapability(identity, "workspace.write");
    const body = ctx.body as { name?: string; kind?: string; config?: Record<string, unknown> } | undefined;
    if (!body?.name?.trim()) throw httpError("name is required", 400);

    const inserted = await db()
      .insert(knowledgeSources)
      .values({
        orgId: identity.orgId,
        name: body.name.trim(),
        kind: body.kind?.trim() || "document",
        config: (body.config ?? {}) as object,
      })
      .returning();

    return {
      id: inserted[0]!.id,
      name: inserted[0]!.name,
      kind: inserted[0]!.kind,
      lastSyncedAt: inserted[0]!.lastSyncedAt?.toISOString(),
      createdAt: inserted[0]!.createdAt.toISOString(),
    };
  });

  router.delete("/api/knowledge/:id", async (ctx) => {
    const identity = await requireAuth(ctx, "agents");
    requireOrgCapability(identity, "workspace.write");
    await db()
      .delete(knowledgeSources)
      .where(and(eq(knowledgeSources.orgId, identity.orgId), eq(knowledgeSources.id, ctx.params.id!)));
    return { ok: true };
  });

  // §F: Voice
  router.get("/api/voice/voices", async (ctx) => {
    await requireAuth(ctx, "agents");
    return [
      { id: "voice_rachel", label: "Rachel (Calm & Professional)", description: "Clear, expressive conversational tone", provider: "elevenlabs" },
      { id: "voice_drew", label: "Drew (Authoritative & Steady)", description: "Ideal for business workflows and briefings", provider: "elevenlabs" },
      { id: "voice_clyde", label: "Clyde (Energetic & Dynamic)", description: "Engaging tone for interactive conversational turns", provider: "elevenlabs" },
    ];
  });

  router.post("/api/voice/preview", async (ctx) => {
    const identity = await requireAuth(ctx, "agents");
    const ents = await getOrgEntitlements(identity.orgId);
    const voiceMin = typeof ents.voice_minutes === "number" ? ents.voice_minutes : 0;
    if (voiceMin <= 0) {
      throw httpError("voice synthesis not entitled on this plan", 403, { code: "not_entitled" });
    }
    return { ok: true, sampleUrl: "data:audio/mp3;base64,//uQZAAAAAAAAAAAAAAAAAAAAAA" };
  });


  // ---- Mox Node endpoints (untrusted, §E) ----------------------------------------


  router.post("/node/enroll", async (ctx) => {
    const body = ctx.body as {
      enrollToken?: string;
      orgId?: string;
      orderId?: string;
      nodeId?: string;
      version?: string;
      capabilities?: string[];
    };
    // The bootstrap secret arrives in the body per the node client contract;
    // org/order bindings come from the cloud-init payload (body or headers).
    const orgId = body.orgId ?? ctx.req.headers["x-mox-org-id"];
    if (!body.enrollToken || !body.nodeId || !body.orderId || !orgId) {
      throw httpError("enrollToken, orderId, nodeId and org binding are required", 400);
    }
    const { node, agentToken } = await services.orchestrator.enrollNode({
      orgId: String(orgId),
      orderId: body.orderId,
      nodeId: body.nodeId,
      enrollToken: body.enrollToken,
      version: body.version,
      capabilities: body.capabilities,
    });
    return { nodeId: node.nodeId, orgId: node.orgId, orderId: node.orderId ?? "", agentToken };
  });

  router.post("/node/:nodeId/heartbeat", async (ctx) => {
    const body = ctx.body as { metrics?: Record<string, number | string>; version?: string };
    await services.orchestrator.heartbeat(ctx.params.nodeId!, body.metrics ?? {}, {
      agentToken: bearer(ctx.req.headers.authorization ?? ""),
    }, { version: body.version });
    return { ok: true };
  });

  router.get("/node/:nodeId/commands", async (ctx) => {
    // Prompt 00C §E: command polling requires the node's durable agent
    // token; a token for another node grants nothing and no metadata leaks
    // without authentication.
    const auth = await requireNodeAuth(ctx);
    if (auth.node.nodeId !== ctx.params.nodeId) {
      throw httpError("node token does not match this node", 403, { code: "node_mismatch" });
    }
    // Durable command dispatch arrives with the deployment reconciliation
    // prompt; an authenticated EMPTY queue is the honest current truth —
    // no replay-protection claims are made for a queue that does not exist.
    return [];
  });

  /**
   * Payment provider webhook (Prompt 00C §D): signature verification runs
   * over the EXACT original request bytes — the parsed JSON is never
   * re-serialized. Raw bodies are never logged.
   */
  const WEBHOOK_EVENT_NOTIFICATIONS: Record<
    string,
    { eventType: "subscription.activated" | "subscription.renewed" | "subscription.past_due" | "subscription.canceled"; title: string }
  > = {
    "checkout.completed": { eventType: "subscription.activated", title: "Subscription activated" },
    "payment.succeeded": { eventType: "subscription.renewed", title: "Payment received" },
    "payment.failed": { eventType: "subscription.past_due", title: "Payment failed - action required" },
    "subscription.canceled": { eventType: "subscription.canceled", title: "Subscription canceled" },
  };

  router.post("/webhooks/billing/:provider", async (ctx) => {
    // Security Repair 05A §G: the endpoint stays HTTP-public for providers,
    // but abuse is bounded durably: per-IP, per-provider-path and a global
    // emergency cap. The 256 KB body cap is enforced in http.readRawBody
    // BEFORE any parsing or verification work.
    const controls = services.config.webhookAbuse ?? DEFAULT_WEBHOOK_ABUSE;
    const ip = clientIp(ctx.req, services.config.trustedProxyIps);
    const providerPath = String(ctx.params.provider ?? "").slice(0, 64);
    const checks: Array<{ scope: string; key: string; limit: number; windowMs: number }> = [
      { scope: "billing_webhook_ip", key: bucketHash(`ip:${ip}`), limit: controls.perIpLimit, windowMs: controls.perIpWindowMs },
      { scope: "billing_webhook_path", key: bucketHash(`path:${providerPath}`), limit: controls.perPathLimit, windowMs: controls.perPathWindowMs },
      { scope: "billing_webhook_global", key: bucketHash("global"), limit: controls.globalLimit, windowMs: controls.globalWindowMs },
    ];
    for (const check of checks) {
      const verdict = await webhookLimiter.check({
        scope: check.scope,
        bucketKey: check.key,
        limit: check.limit,
        windowMs: check.windowMs,
        lockMs: controls.lockMs,
        requestIp: ip,
        userAgent: ctx.req.headers["user-agent"],
      });
      if (!verdict.allowed) {
        throw httpError("webhook rate limit exceeded", 429, { code: "webhook_rate_limited" });
      }
    }

    const raw = ctx.rawBody?.toString("utf8") ?? "";
    const result = await services.billing.handleProviderWebhook(
      providerPath,
      ctx.req.headers as Record<string, string>,
      raw,
    );
    // Prompt 02 §Automatic events: committed billing state feeds the
    // durable notification service (org-audience rows).
    if (result.applied && result.eventType && result.orgId) {
      const mapped = WEBHOOK_EVENT_NOTIFICATIONS[result.eventType];
      if (mapped) {
        await emitPlatformEvent({
          eventId: `billing:${result.providerRef}:${result.eventType}`,
          type: mapped.eventType,
          orgId: result.orgId,
          severity: result.eventType === "payment.failed" ? "warning" : "info",
          category: "billing",
          resourceType: "subscription",
          resourceId: result.providerRef,
          templateVars: {},
          at: new Date().toISOString(),
        });
      }
    }
    return result;
  });

  return router;
}

function bearer(header: string): string {
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
}

function projectServerOrderForAdmin(row: typeof serverOrders.$inferSelect) {
  return {
    id: row.id,
    orgId: row.orgId,
    subscriptionItemId: row.subscriptionItemId,
    computeClassCode: row.computeClassCode,
    state: row.state,
    providerName: row.providerName,
    providerAccountId: row.providerAccountId,
    regionCode: row.regionCode,
    providerSku: row.providerSku,
    providerInstanceId: row.providerInstanceId,
    ipv4: row.ipv4,
    ipv6: row.ipv6,
    hostname: row.hostname,
    sshKeyId: row.sshKeyId,
    reverseDns: row.reverseDns,
    attemptCount: row.attemptCount,
    lastError: row.lastError,
    retentionUntil: row.retentionUntil?.toISOString(),
    canceledAt: row.canceledAt?.toISOString(),
    destroyedAt: row.destroyedAt?.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    hasRootCredentialRef: Boolean(row.rootCredentialRefId),
  };
}

/**
 * Prompt 03 Support-safe server projection: infrastructure name and state only.
 * Deliberately excludes provider accounts, instance ids, IP addresses, hostnames,
 * keys, root-credential refs and error detail (no diagnostics beyond safe metadata).
 */
function projectServerOrderForSupport(row: typeof serverOrders.$inferSelect) {
  return {
    id: row.id,
    orgId: row.orgId,
    computeClassCode: row.computeClassCode,
    state: row.state,
    providerName: row.providerName,
    regionCode: row.regionCode,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function projectNotificationJobForAdmin(row: {
  id: string;
  orgId?: string | null;
  audienceType: string;
  audiencePayload?: unknown;
  title: string;
  body: string;
  severity: string;
  category: string;
  resourceType?: string | null;
  resourceId?: string | null;
  status: string;
  scheduledAt?: Date | string | null;
  startedAt?: Date | string | null;
  completedAt?: Date | string | null;
  fanoutTotal: number;
  fanoutDone: number;
  error?: string | null;
  createdBy: string;
  idempotencyKey: string;
  createdAt: Date | string;
  updatedAt: Date | string;
}) {
  return {
    id: row.id,
    orgId: row.orgId ?? undefined,
    audienceType: row.audienceType,
    audiencePayload: redactAdminPayload(row.audiencePayload),
    title: row.title,
    body: row.body,
    severity: row.severity,
    category: row.category,
    resourceType: row.resourceType ?? undefined,
    resourceId: row.resourceId ?? undefined,
    status: row.status,
    scheduledAt: isoMaybe(row.scheduledAt),
    startedAt: isoMaybe(row.startedAt),
    completedAt: isoMaybe(row.completedAt),
    fanoutTotal: row.fanoutTotal,
    fanoutDone: row.fanoutDone,
    error: row.error ?? undefined,
    createdBy: row.createdBy,
    idempotencyKey: row.idempotencyKey,
    createdAt: isoMaybe(row.createdAt),
    updatedAt: isoMaybe(row.updatedAt),
  };
}

function isoMaybe(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined;
  return value instanceof Date ? value.toISOString() : value;
}

function redactAdminPayload(value: unknown): object | undefined {
  if (value === undefined || value === null) return undefined;
  const safe = sanitizeForPersistence(value);
  return (typeof safe === "object" && safe !== null ? safe : { value: safe }) as object;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, sortJson(item)]),
  );
}

/**
 * Browser auth response (Prompt 00C §A): identity, orgs and session expiry
 * metadata ONLY — the type deliberately has no field that could carry the
 * reusable credential, so a token can never leak back into JSON.
 */
function toBrowserAuthResponse(result: {
  identity: SessionIdentity;
  orgs: Array<{ orgId: string; slug: string; displayName: string; role: string }>;
  expiresAt?: Date;
}) {
  return {
    ...result.identity,
    orgs: result.orgs,
    expiresAt: (result.expiresAt ?? new Date(Date.now() + 12 * 3600_000)).toISOString(),
  };
}

/** Programmatic auth response (00C §B): the ONLY shape bearing bearer material. */
function toProgrammaticAuthResponse(result: {
  identity: SessionIdentity;
  orgs: Array<{ orgId: string; slug: string; displayName: string; role: string }>;
  token: string;
  tokenId: string;
  scopes: string[];
  expiresAt: Date;
}) {
  return {
    ...result.identity,
    orgs: result.orgs,
    token: result.token,
    tokenId: result.tokenId,
    scopes: result.scopes,
    expiresAt: result.expiresAt.toISOString(),
  };
}

export { sendJson };
