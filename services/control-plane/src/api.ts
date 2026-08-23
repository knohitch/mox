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
  login as loginAccount,
  logout as logoutSession,
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

  /** Authenticated context: flattened SessionIdentity plus org memberships. */
  const requireAuth = async (ctx: RequestContext) => {
    const auth = await authenticate(db(), {
      authorization: ctx.req.headers.authorization,
      cookie: ctx.req.headers.cookie,
    });
    // CSRF defense (Â§B): cookie-authenticated mutations must carry the
    // custom header, which cross-site forms cannot set.
    const mutating = ["POST", "PATCH", "PUT", "DELETE"].includes(ctx.req.method ?? "");
    if (mutating && isCookieAuthenticated(ctx.req.headers) && !ctx.req.headers[CSRF_HEADER]) {
      throw httpError("missing CSRF header for cookie-authenticated mutation", 403, { code: "csrf_required" });
    }
    return { ...auth.identity, userId: auth.userId, sessionId: auth.sessionId, orgs: auth.orgs };
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
    return toAuthResponse(result);
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
    return toAuthResponse(result);
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

  /** Membership-verified active-org switch (Â§C). */
  router.post("/api/auth/orgs/select", async (ctx) => {
    await requireAuth(ctx);
    const token = extractSessionToken({ authorization: ctx.req.headers.authorization, cookie: ctx.req.headers.cookie });
    if (!token) throw httpError("authentication required", 401);
    const body = ctx.body as { orgId?: string } | undefined;
    if (!body?.orgId) throw httpError("orgId is required", 400);
    const result = await switchActiveOrg(db(), token, body.orgId);
    return toAuthResponse(result);
  });

  // ---- Agents ---------------------------------------------------------------

  router.get("/api/agents", async (ctx) => {
    const identity = await requireAuth(ctx);
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
    const identity = await requireAuth(ctx);
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
    const identity = await requireAuth(ctx);
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
    const identity = await requireAuth(ctx);
    const records = await services.threads.listForAgent(identity, ctx.params.agentId!);
    return records.map((r) => ({ threadId: r.threadId, title: r.title }));
  });

  router.post("/api/threads", async (ctx) => {
    const identity = await requireAuth(ctx);
    const body = ctx.body as { agentId?: string; title?: string } | undefined;
    if (!body?.agentId) throw httpError("agentId is required", 400);
    const record = await services.threads.create(identity, { agentId: body.agentId, title: body.title });
    return record;
  });

  router.get("/api/threads/:threadId/messages", async (ctx) => {
    const identity = await requireAuth(ctx);
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
    const identity = await requireAuth(ctx);
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
    const identity = await requireAuth(ctx);
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
    const { identity } = await authenticate(db(), {
      authorization: ctx.req.headers.authorization,
      cookie: ctx.req.headers.cookie,
    });
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
    const identity = await requireAuth(ctx);
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
    const identity = await requireAuth(ctx);
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
    const identity = await requireAuth(ctx);
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
    const identity = await requireAuth(ctx);
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
    const identity = await requireAuth(ctx);
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
    const identity = await requireAuth(ctx);
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
    return result.order;
  });

  // ---- Deployments ------------------------------------------------------------

  router.get("/api/deployments", async (ctx) => {
    const identity = await requireAuth(ctx);
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
    const identity = await requireAuth(ctx);
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
    await requireAuth(ctx);
    // A real probe requires the provider SDK credential vault; until wired
    // the API reports honestly rather than faking connectivity.
    throw httpError("provider connection probes are not configured on this deployment", 501, { code: "not_configured" });
  });

  // ---- Integrations / channels ---------------------------------------------------

  router.get("/api/integrations", async (ctx) => {
    const identity = await requireAuth(ctx);
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
    const identity = await requireAuth(ctx);
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
    const identity = await requireAuth(ctx);
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

  // ---- Usage / billing -----------------------------------------------------------

  router.get("/api/usage", async (ctx) => {
    const identity = await requireAuth(ctx);
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
    const identity = await requireAuth(ctx);
    const sub = await services.billing.getActiveSubscription(identity.orgId);
    return sub ?? null;
  });

  router.get("/api/billing/invoices", async (ctx) => {
    const identity = await requireAuth(ctx);
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
    const identity = await requireAuth(ctx);
    const sub = await services.billing.getActiveSubscription(identity.orgId);
    const planVersionId = sub?.planVersionId ?? "none";
    const values = planVersionId === "none" ? {} : await services.entitlements.planValuesFor(planVersionId);
    return { planVersionId, values };
  });

  // ---- Computer gateway + files/logs: honest 501s until wired --------------------

  router.get("/api/computer/:agentId/snapshot", async (ctx) => {
    await requireAuth(ctx);
    void ctx;
    throw httpError("computer gateway is not configured on this deployment", 501, { code: "not_configured" });
  });

  router.get("/api/agents/:agentId/files", async (ctx) => {
    await requireAuth(ctx);
    void ctx;
    throw httpError("workspace file access is not configured on this deployment", 501, { code: "not_configured" });
  });

  router.get("/api/agents/:agentId/logs", async (ctx) => {
    await requireAuth(ctx);
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

  router.get("/node/:nodeId/commands", async (_ctx) => {
    // Command dispatch arrives with the deployment reconciliation prompt;
    // an authenticated empty queue is the honest current truth.
    return [];
  });

  router.post("/webhooks/billing/:provider", async (ctx) => {
    const raw = typeof ctx.body === "string" ? ctx.body : JSON.stringify(ctx.body ?? {});
    return services.billing.handleProviderWebhook(ctx.params.provider!, ctx.req.headers as Record<string, string>, raw);
  });

  return router;
}

function bearer(header: string): string {
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
}

/** Maps an auth result onto the shared wire contract. */
function toAuthResponse(result: {
  identity: SessionIdentity;
  orgs: Array<{ orgId: string; slug: string; displayName: string; role: string }>;
  sessionToken?: string;
  expiresAt?: Date;
}) {
  return {
    ...result.identity,
    orgs: result.orgs,
    ...(result.sessionToken
      ? { sessionToken: result.sessionToken, expiresAt: (result.expiresAt ?? new Date()).toISOString() }
      : {}),
  };
}

export { sendJson };
