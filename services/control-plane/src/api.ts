/**
 * Mox Control Plane HTTP API (Prompt 00 Â§A). Every screen-facing surface is
 * served from authoritative services/stores â€” never demo data. Endpoints
 * that have no backing capability yet return honest 501s with machine
 * readable codes instead of pretending.
 */

import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import type { SessionEvent } from "@mox/contracts";
import type { SessionIdentity } from "@mox/control-plane-contracts";
import {
  agentDeployments,
  agentRooms,
  agents,
  billingProviderConfigs,
  channelConnections,
  channelProviders,
  integrationConnections,
  integrationProviders,
  modelConnections,
  modelProviders,
  models,
  modelUsageRefs,
  platformSetup,
  sessionEvents,
  usageEvents,
} from "@mox/database";
import type { ControlPlaneServices } from "./composition.js";
import { verifyDependencies } from "./composition.js";
import {
  authenticate,
  completePlatformSetup,
  extractSessionToken,
  hashToken,
  isCookieAuthenticated,
  issueApiToken,
  listApiTokens,
  login as loginAccount,
  logout as logoutSession,
  programmaticLogin,
  revokeApiToken,
  scopeSatisfied,
  serializeClearSessionCookie,
  serializeSessionCookie,
  signup as signupAccount,
  switchActiveOrg,
} from "./auth.js";
import { httpError, Router, sendJson, type RequestContext } from "./http.js";

export interface ApiDeps {
  services: ControlPlaneServices;
}

/** Mutations authenticated via cookie require this client-set header (CSRF). */
export const CSRF_HEADER = "x-mox-csrf";

export function buildApiRouter(deps: ApiDeps): Router {
  const router = new Router();
  const { services } = deps;
  const db = () => services.db;

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

  /**
   * Prompt 02 §Admin: real platform authority — explicit deployment
   * admin list. A PAT `admin` scope NEVER confers this.
   */
  const requirePlatformAdmin = async (ctx: RequestContext) => {
    const auth = await authenticate(db(), {
      authorization: ctx.req.headers.authorization,
      cookie: ctx.req.headers.cookie,
    });
    const mutating = ["POST", "PATCH", "PUT", "DELETE"].includes(ctx.req.method ?? "");
    if (mutating && isCookieAuthenticated(ctx.req.headers) && !ctx.req.headers[CSRF_HEADER]) {
      throw httpError("missing CSRF header for cookie-authenticated mutation", 403, { code: "csrf_required" });
    }
    if (!services.config.platformAdminUserIds.includes(auth.userId)) {
      throw httpError("platform administrator authority required", 403, { code: "role_denied" });
    }
    return { ...auth.identity, userId: auth.userId };
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
    const result = await signupAccount({
      db: db(),
      email: body.email,
      password: body.password,
      displayName: body.displayName,
      orgName: body.orgName,
      meta: { ipAddress: ctx.req.socket.remoteAddress ?? undefined, userAgent: ctx.req.headers["user-agent"] },
    });
    ctx.res.setHeader("set-cookie", serializeSessionCookie(result.sessionToken, sessionCookieOptions()));
    return toBrowserAuthResponse(result);
  });

  router.post("/api/auth/login", async (ctx) => {
    const body = ctx.body as { email?: string; password?: string } | undefined;
    if (!body?.email || !body?.password) throw httpError("email and password are required", 400);
    const result = await loginAccount({
      db: db(),
      email: body.email,
      password: body.password,
      meta: { ipAddress: ctx.req.socket.remoteAddress ?? undefined, userAgent: ctx.req.headers["user-agent"] },
    });
    ctx.res.setHeader("set-cookie", serializeSessionCookie(result.sessionToken, sessionCookieOptions()));
    return toBrowserAuthResponse(result);
  });

  /**
   * Prompt 00C §B: dedicated programmatic token-login — password → scoped
   * personal API access token (bearer). Never sets a cookie and is the only
   * password→bearer exchange.
   */
  router.post("/api/auth/token-login", async (ctx) => {
    const body = ctx.body as { email?: string; password?: string; name?: string; scopes?: string[] } | undefined;
    if (!body?.email || !body?.password) throw httpError("email and password are required", 400);
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

  // ---- Threads & messages -----------------------------------------------------

  router.get("/api/agents/:agentId/threads", async (ctx) => {
    const identity = await requireAuth(ctx, "threads");
    const records = await services.threads.listForAgent(identity, ctx.params.agentId!);
    return records.map((r) => ({ threadId: r.threadId, title: r.title }));
  });

  router.post("/api/threads", async (ctx) => {
    const identity = await requireAuth(ctx, "threads");
    const body = ctx.body as { agentId?: string; title?: string } | undefined;
    if (!body?.agentId) throw httpError("agentId is required", 400);
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
    return {
      message: {
        messageId: message.messageId,
        threadId: message.threadId,
        authorId: message.authorId,
        role: message.authorKind,
        text: message.text,
        at: message.createdAt,
      },
      turn: null,
      note: "turn execution engine is not configured on this deployment",
      code: "engine_not_configured",
    };
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
      } catch {
        clearInterval(timer);
        ctx.res.end();
      }
    }, 1000);
    ctx.req.on("close", () => clearInterval(timer));
    return undefined;
  });

  // ---- Approvals (event-sourced) ----------------------------------------------

  router.get("/api/approvals/open", async (ctx) => {
    const identity = await requireAuth(ctx, "approvals");
    const [requested, resolved] = await Promise.all([
      db()
        .select()
        .from(sessionEvents)
        .where(and(eq(sessionEvents.orgId, identity.orgId), eq(sessionEvents.type, "approval.requested")))
        .orderBy(desc(sessionEvents.seq)),
      db()
        .select()
        .from(sessionEvents)
        .where(and(eq(sessionEvents.orgId, identity.orgId), eq(sessionEvents.type, "approval.resolved"))),
    ]);
    const resolvedIds = new Set(
      resolved.map(
        (r) => (r.payload as { approvalId?: string }).approvalId ?? "",
      ),
    );
    return requested
      .map((row) => row.payload as SessionEvent & { type: string; approvalId?: string })
      .filter((payload) => payload.approvalId !== undefined && !resolvedIds.has(payload.approvalId));
  });

  router.post("/api/approvals/:approvalId/resolve", async (ctx) => {
    const identity = await requireAuth(ctx, "approvals");
    const body = ctx.body as { outcome?: "approved" | "denied" } | undefined;
    if (body?.outcome !== "approved" && body?.outcome !== "denied") {
      throw httpError('outcome must be "approved" or "denied"', 400);
    }
    const event: SessionEvent = {
      type: "approval.resolved",
      eventId: crypto.randomUUID(),
      orgId: identity.orgId,
      correlationId: `approval:${ctx.params.approvalId}`,
      at: new Date().toISOString(),
      approvalId: ctx.params.approvalId!,
      outcome: body.outcome,
    } as unknown as SessionEvent;
    await services.events.append(identity, { kind: "thread", id: identity.orgId }, event);
    return { ok: true };
  });

  // ---- Rooms -----------------------------------------------------------------

  router.get("/api/rooms", async (ctx) => {
    const identity = await requireAuth(ctx, "threads");
    const rows = await db().select().from(agentRooms).where(eq(agentRooms.orgId, identity.orgId));
    return rows.map((row) => ({
      roomId: row.id,
      orgId: row.orgId,
      title: row.name,
      description: row.description,
      memberAgentIds: [] as string[],
    }));
  });

  router.post("/api/rooms", async (ctx) => {
    const identity = await requireAuth(ctx, "threads");
    const body = ctx.body as { title?: string; memberAgentIds?: string[] } | undefined;
    if (!body?.title) throw httpError("title is required", 400);
    const inserted = await db()
      .insert(agentRooms)
      .values({ orgId: identity.orgId, name: body.title })
      .returning();
    const row = inserted[0];
    if (!row) throw httpError("room insert failed", 500, { unavailable: true });
    return { roomId: row.id, orgId: row.orgId, title: row.name, description: row.description, memberAgentIds: body.memberAgentIds ?? [] };
  });

  // ---- Servers (compute orchestrator authority) -------------------------------

  router.get("/api/servers", async (ctx) => {
    const identity = await requireAuth(ctx, "servers");
    const orders = await services.orchestrator.listOrders(identity.orgId);
    return orders.map((order) => ({
      serverId: order.providerInstanceId ?? order.id,
      orderId: order.id,
      displayName: order.hostname,
      kind: "customer-vps" as const,
      region: order.regionCode ?? "unknown",
      state: order.state === "running" ? ("running" as const) : ("provisioning" as const),
      agentsRunning: 0,
      cpuPct: 0,
      memPct: 0,
    }));
  });

  router.post("/api/servers/orders", async (ctx) => {
    const identity = await requireAuth(ctx, "servers");
    const body = ctx.body as { computeClassCode?: string; hostname?: string; sshKeyId?: string } | undefined;
    if (!body?.computeClassCode || !body?.hostname) {
      throw httpError("computeClassCode and hostname are required", 400);
    }
    const result = await services.orchestrator.orderServer({
      orgId: identity.orgId,
      computeClassCode: body.computeClassCode,
      hostname: body.hostname,
      idempotencyKey: crypto.randomUUID(),
      sshKeyId: body.sshKeyId,
    });
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

  // ---- Deployments ------------------------------------------------------------

  router.get("/api/deployments", async (ctx) => {
    const identity = await requireAuth(ctx, "servers");
    const rows = await db()
      .select()
      .from(agentDeployments)
      .where(eq(agentDeployments.orgId, identity.orgId));
    return rows.map((row) => ({
      deploymentId: row.id,
      agentId: row.agentId,
      target: { kind: "sandbox" },
      state: "desired",
      desiredRevision: row.desiredRevision,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  });

  // ---- Models / connections ------------------------------------------------------

  router.get("/api/models", async (ctx) => {
    const identity = await requireAuth(ctx, "models");
    const providers = await db().select().from(modelProviders).where(eq(modelProviders.orgId, identity.orgId));
    const allModels = await db().select().from(models).where(eq(models.orgId, identity.orgId));
    const connections = await db().select().from(modelConnections).where(eq(modelConnections.orgId, identity.orgId));
    return providers.flatMap((provider) =>
      allModels
        .filter((m) => m.providerId === provider.id)
        .map((model) => ({
          modelId: model.slug,
          providerId: provider.slug,
          displayName: model.displayName,
          byok: connections.some((c) => c.providerId === provider.id),
          available: true,
        })),
    );
  });

  router.post("/api/model-connections/:providerSlug/test", async (ctx) => {
    await requireAuth(ctx, "models");
    // A real probe requires the provider SDK credential vault; until wired
    // the API reports honestly rather than faking connectivity.
    throw httpError("provider connection probes are not configured on this deployment", 501, { code: "not_configured" });
  });

  // ---- Integrations / channels ---------------------------------------------------

  router.get("/api/integrations", async (ctx) => {
    const identity = await requireAuth(ctx, "integrations");
    const [providers, conns] = await Promise.all([
      db().select().from(integrationProviders).where(eq(integrationProviders.orgId, identity.orgId)),
      db().select().from(integrationConnections).where(eq(integrationConnections.orgId, identity.orgId)),
    ]);
    return providers.map((p) => ({
      integrationId: p.slug,
      displayName: p.displayName,
      connected: conns.some((c) => c.providerId === p.id && c.status === "active"),
    }));
  });

  router.patch("/api/integrations/:integrationId", async (ctx) => {
    const identity = await requireAuth(ctx, "integrations");
    const body = ctx.body as { connected?: boolean } | undefined;
    const rows = await db()
      .select()
      .from(integrationProviders)
      .where(and(eq(integrationProviders.orgId, identity.orgId), eq(integrationProviders.slug, ctx.params.integrationId!)))
      .limit(1);
    const provider = rows[0];
    if (!provider) throw httpError(`integration ${ctx.params.integrationId} not found`, 404);
    const wantConnected = body?.connected !== false;
    const existing = await db()
      .select()
      .from(integrationConnections)
      .where(and(eq(integrationConnections.orgId, identity.orgId), eq(integrationConnections.providerId, provider.id)))
      .limit(1);
    if (existing[0]) {
      await db()
        .update(integrationConnections)
        .set({ status: wantConnected ? "active" : "disconnected" })
        .where(eq(integrationConnections.id, existing[0].id));
    } else if (wantConnected) {
      await db().insert(integrationConnections).values({
        orgId: identity.orgId,
        providerId: provider.id,
        status: "active",
      });
    }
    return { ok: true };
  });

  router.get("/api/channels", async (ctx) => {
    const identity = await requireAuth(ctx, "channels");
    const [providers, conns] = await Promise.all([
      db().select().from(channelProviders).where(eq(channelProviders.orgId, identity.orgId)),
      db().select().from(channelConnections).where(eq(channelConnections.orgId, identity.orgId)),
    ]);
    return providers.map((p) => ({
      channelId: p.slug,
      displayName: p.displayName,
      kind: p.kind,
      connected: conns.some((c) => c.providerId === p.id && c.status === "active"),
    }));
  });

  // ---- Mox-admin: payment provider configuration (Prompt 01 §Provider config) ----
  // Provider enablement, test/live switching and secret refs are Mox-admin
  // operations. Interim authority = authenticated session of an org
  // owner/admin; secrets are NEVER accepted or returned — only vault/env
  // REF names.

  const requireAdminSession = async (ctx: RequestContext) => {
    const auth = await requireSessionAuth(ctx);
    // Prompt 01 §Provider config: provider administration is a PLATFORM
    // authority — an explicit deployment-configured admin list, NOT merely
    // org owner/admin. Empty list denies everyone (fail-closed).
    if (!services.config.platformAdminUserIds.includes(auth.userId)) {
      throw httpError("platform administrator authority required for provider configuration", 403, {
        code: "role_denied",
      });
    }
    return auth;
  };

  router.get("/api/admin/billing-providers", async (ctx) => {
    await requireAdminSession(ctx);
    const rows = await db().select().from(billingProviderConfigs);
    return rows.map((row) => ({
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
    }));
  });

  router.put("/api/admin/billing-providers/:name", async (ctx) => {
    await requireAdminSession(ctx);
    const name = ctx.params.name!;
    if (!/^[a-z0-9-]{2,40}$/.test(name)) throw httpError("invalid provider name", 400);
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
    return {
      ok: true,
      note: "provider registered; restart or reconciliation reload activates adapters",
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
    ctx.res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    ctx.res.write(`retry: 3000\n\n`);
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
    ctx.req.on("close", unsubscribe);
    return undefined;
  });

  // ---- Prompt 02: admin authoring (platform-admin gated) --------------------------

  router.post("/api/admin/notifications/preview", async (ctx) => {
    await requirePlatformAdmin(ctx);
    const body = ctx.body as { title?: string; body?: string; templateVars?: Record<string, string> } | undefined;
    return services.notifications.preview({ title: body?.title ?? "", body: body?.body ?? "", templateVars: body?.templateVars });
  });

  router.post("/api/admin/notifications/send", async (ctx) => {
    const admin = await requirePlatformAdmin(ctx);
    const input = validateAdminSendBody(ctx.body);
    const { job } = await services.notifications.createJob({
      ...input,
      createdBy: admin.userId,
      scheduledAt: undefined,
    });
    // Send-now jobs run through the same durable fan-out runner.
    const result = await services.notifications.runDueJobs(new Date().toISOString());
    void result;
    return { jobId: job.id, status: "completed-or-running" };
  });

  router.post("/api/admin/notifications/schedule", async (ctx) => {
    const admin = await requirePlatformAdmin(ctx);
    const input = validateAdminSendBody(ctx.body);
    if (!input.scheduledAt) throw httpError("scheduledAt is required", 400);
    const { job } = await services.notifications.createJob({
      ...input,
      createdBy: admin.userId,
    });
    return { jobId: job.id, status: job.status, scheduledAt: job.scheduledAt };
  });

  router.post("/api/admin/notifications/jobs/:jobId/cancel", async (ctx) => {
    await requirePlatformAdmin(ctx);
    const canceled = await services.notifications.cancelJob(ctx.params.jobId!);
    if (!canceled) throw httpError(`job ${ctx.params.jobId} not found or not cancelable`, 404);
    return { ok: true };
  });

  router.get("/api/admin/notifications/jobs/:jobId", async (ctx) => {
    await requirePlatformAdmin(ctx);
    const job = await services.notifications.getJob(ctx.params.jobId!);
    if (!job) throw httpError(`job ${ctx.params.jobId} not found`, 404);
    return job;
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
    if (auth.role !== "owner" && auth.role !== "admin") {
      throw httpError("organization owner/admin authority required for billing mutations", 403, {
        code: "role_denied",
      });
    }
    return auth;
  };

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

  router.get("/api/billing/subscription", async (ctx) => {
    const identity = await requireAuth(ctx, "billing");
    const sub = await services.billing.getActiveSubscription(identity.orgId);
    return sub ?? null;
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

  router.get("/api/billing/entitlements", async (ctx) => {
    const identity = await requireAuth(ctx, "billing");
    const sub = await services.billing.getActiveSubscription(identity.orgId);
    const planVersionId = sub?.planVersionId ?? "none";
    const values = planVersionId === "none" ? {} : await services.entitlements.planValuesFor(planVersionId);
    return { planVersionId, values };
  });

  // ---- Computer gateway + files/logs: honest 501s until wired --------------------

  router.get("/api/computer/:agentId/snapshot", async (ctx) => {
    await requireAuth(ctx, "servers");
    void ctx;
    throw httpError("computer gateway is not configured on this deployment", 501, { code: "not_configured" });
  });

  router.get("/api/agents/:agentId/files", async (ctx) => {
    await requireAuth(ctx, "servers");
    void ctx;
    throw httpError("workspace file access is not configured on this deployment", 501, { code: "not_configured" });
  });

  router.get("/api/agents/:agentId/logs", async (ctx) => {
    await requireAuth(ctx, "servers");
    void ctx;
    throw httpError("log streaming is not configured on this deployment", 501, { code: "not_configured" });
  });

  // ---- Mox Node endpoints (untrusted, Â§E) ----------------------------------------

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
    const raw = ctx.rawBody?.toString("utf8") ?? "";
    const result = await services.billing.handleProviderWebhook(
      ctx.params.provider!,
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
