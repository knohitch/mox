/**
 * Production composition root for the Mox Control Plane (Prompt 00 §B).
 *
 * This is the ONLY place where the production service graph is assembled.
 * Rules enforced here:
 *
 * 1. PostgreSQL is business truth. Billing, compute orchestration,
 *    notifications, entitlements and runtime persistence use Pg* stores.
 * 2. Missing durable dependencies fail startup loudly (loadControlPlaneConfig
 *    throws; verifyDependencies pings the database before listening).
 * 3. There is NO fallback to demo/in-memory authoritative state. Every
 *    remaining `new InMemory*` occurrence repository-wide is classified in
 *    docs/inmemory-authority-classification.md:
 *      - tests/**            → test fixtures only;
 *      - store defaults      → non-authoritative ephemeral seams, never
 *                              wired by this composition root;
 *      - production wiring   → forbidden here (lint/review gate).
 */

import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { AgentEvent, SessionEvent } from "@mox/contracts";
import {
  createDb,
  approvalRequests,
  billingProviderConfigs,
  PgBillingStore,
  PgEntitlementStore,
  PgMemoryStore,
  PgMessageStore,
  PgNotificationStore,
  PgOrchestratorStore,
  PgSessionEventStore,
  PgThreadStore,
  memberships,
} from "@mox/database";
import { BillingService } from "@mox/billing";
import type { BillingProvider } from "@mox/billing";
import {
  FlutterwaveProvider,
  PayPalProvider,
  PaystackProvider,
  StripeProvider,
} from "@mox/billing";
import { ComputeOrchestrator } from "@mox/compute-orchestrator";
import { EntitlementService } from "@mox/entitlements";
import { NotificationService } from "@mox/notification-service";
import { AgentRuntime, assertMoxRuntimeMode, verifyFullMoxRuntime, type SessionEventStoreLike } from "@mox/agent-runtime";
import { launchStdioRuntime } from "@mox/runtime-client";
import { sanitizeForPersistence } from "@mox/security";
import type { ControlPlaneConfig } from "./config.js";

export interface ControlPlaneServices {
  config: ControlPlaneConfig;
  db: ReturnType<typeof createDb>["db"];
  pool: ReturnType<typeof createDb>["pool"];
  billing: BillingService;
  orchestrator: ComputeOrchestrator;
  entitlements: EntitlementService;
  notifications: NotificationService;
  threads: PgThreadStore;
  messages: PgMessageStore;
  events: PgSessionEventStore;
  memory: PgMemoryStore;
  runtime?: AgentRuntime;
}

export async function composeControlPlane(config: ControlPlaneConfig): Promise<ControlPlaneServices> {
  const { db, pool } = createDb({ connectionString: config.databaseUrl });

  // Fail fast when PostgreSQL is unreachable — never serve a fake system.
  await pool.query("SELECT 1");

  const billing = new BillingService(new PgBillingStore(db));
  // §F: the public URL is validated deployment configuration passed to node
  // bootstraps; https is enforced by the config validator in production.
  // Non-production deployments may bind plain-http endpoints for tests.
  const orchestrator = new ComputeOrchestrator(new PgOrchestratorStore(db), {
    controlPlaneUrl: config.publicUrl,
    allowInsecureControlPlaneUrl: config.env !== "production",
  });
  const entitlements = new EntitlementService(new PgEntitlementStore(db));
  const notifications = new NotificationService(new PgNotificationStore(db), async (audience) => {
    // Durable fan-out resolver (Prompt 02): resolves recipients from
    // PostgreSQL according to the admin-selected audience.
    const { users, subscriptions, planVersions, products, billingCustomers } = await import(
      "@mox/database"
    );
    const base = () =>
      db
        .select({ orgId: memberships.orgId, userId: users.id })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId));
    if (audience.type === "user" || audience.type === "users") {
      const ids = audience.userIds ?? [];
      if (ids.length === 0) return [];
      return base().where(and(isNull(users.disabledAt), inArray(users.id, ids)));
    }
    if (audience.type === "org") {
      if (!audience.orgId) return [];
      return base().where(and(isNull(users.disabledAt), eq(memberships.orgId, audience.orgId)));
    }
    if (audience.type === "all") {
      return base().where(isNull(users.disabledAt));
    }
    if (audience.type === "plan") {
      if (!audience.planTier) return [];
      const rows = await db
        .select({ orgId: subscriptions.orgId, userId: memberships.userId })
        .from(subscriptions)
        .innerJoin(planVersions, eq(planVersions.id, subscriptions.planVersionId))
        .innerJoin(products, eq(products.id, planVersions.productId))
        .innerJoin(memberships, eq(memberships.orgId, subscriptions.orgId))
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(and(eq(products.tier, audience.planTier as "plus"), isNull(users.disabledAt)));
      return rows;
    }
    if (audience.type === "region") {
      if (!audience.regionCode) return [];
      const rows = await db
        .select({ orgId: billingCustomers.orgId, userId: memberships.userId })
        .from(billingCustomers)
        .innerJoin(memberships, eq(memberships.orgId, billingCustomers.orgId))
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(and(eq(billingCustomers.billingRegion, audience.regionCode), isNull(users.disabledAt)));
      return rows;
    }
    return [];
  });

  // Prompt 01: DB-driven payment-provider registration. Secrets resolve
  // from environment variables NAMED by admin-configured refs — never
  // stored in the database, never logged.
  await registerBillingProvidersFromDb(db, billing);
  assertMoxRuntimeMode({
    nodeEnv: config.env,
    mode: config.runtimeMode,
    runtimeCommand: config.runtimeCommand,
  });

  let runtime: AgentRuntime | undefined;
  const events = new PgSessionEventStore(db);
  if (config.runtimeMode === "full") {
    const runtimeClient = launchStdioRuntime(config.runtimeCommand!, config.runtimeArgs, {
      cwd: config.runtimeCwd,
      timeoutMs: config.runtimeRequestTimeoutMs,
    });
    await verifyFullMoxRuntime(runtimeClient, config.env);
    runtime = new AgentRuntime({
      client: runtimeClient,
      events: new RuntimeEventStoreAdapter(events, db),
      maxRestartsPerRun: 2,
    });
  }

  return {
    config,
    db,
    pool,
    billing,
    orchestrator,
    entitlements,
    notifications,
    threads: new PgThreadStore(db),
    messages: new PgMessageStore(db),
    events,
    memory: new PgMemoryStore(db),
    runtime,
  };
}

class RuntimeEventStoreAdapter implements SessionEventStoreLike {
  constructor(
    private readonly store: PgSessionEventStore,
    private readonly db: ReturnType<typeof createDb>["db"],
  ) {}

  async append(orgId: string, runId: string, event: AgentEvent): Promise<void> {
    const sessionEvent = sanitizeForPersistence(agentEventToSessionEvent(orgId, runId, event));
    const subject = sessionEvent.roomId
      ? ({ kind: "room" as const, id: sessionEvent.roomId })
      : ({ kind: "thread" as const, id: sessionEvent.threadId ?? orgId });
    await this.store.append({ orgId }, subject, sessionEvent);
    if (sessionEvent.type === "approval.requested" && sessionEvent.agentId) {
      await this.db
        .insert(approvalRequests)
        .values({
          approvalRef: sessionEvent.approvalId,
          orgId,
          agentId: sessionEvent.agentId,
          threadId: sessionEvent.threadId ?? null,
          kind: "runtime",
          summary: sessionEvent.summary,
          payload: sanitizeForPersistence({
            approvalId: sessionEvent.approvalId,
            runId,
            threadId: sessionEvent.threadId,
            agentId: sessionEvent.agentId,
            policyReason: sessionEvent.summary,
          }) as object,
          policyReason: sessionEvent.summary,
          correlationId: runId,
        })
        .onConflictDoNothing({ target: approvalRequests.approvalRef });
    }
  }

  async replay(orgId: string, runId: string): Promise<AgentEvent[]> {
    const rows = await this.store.replayCorrelation({ orgId }, runId);
    return rows.map((event) => sessionEventToAgentEvent(event)).filter((event): event is AgentEvent => event !== undefined);
  }
}

function baseSessionFields(orgId: string, runId: string, event: AgentEvent) {
  return {
    eventId: event.eventId,
    orgId,
    agentId: event.agentId,
    threadId: "threadId" in event ? event.threadId : undefined,
    roomId: "roomId" in event ? event.roomId : undefined,
    runId,
    turnId: "turnId" in event ? event.turnId : undefined,
    correlationId: runId,
    at: event.at,
  };
}

function agentEventToSessionEvent(orgId: string, runId: string, event: AgentEvent): SessionEvent {
  const base = baseSessionFields(orgId, runId, event);
  switch (event.type) {
    case "turn.started":
      return { ...base, type: "run.started", input: event.input };
    case "turn.completed":
      return { ...base, type: "run.completed", output: event.output };
    case "turn.failed":
      return { ...base, type: "run.failed", error: event.error, retryable: false };
    case "message.delta":
      return { ...base, type: "assistant.delta", messageId: event.messageId, delta: event.delta };
    case "message.completed":
      return { ...base, type: "assistant.final", messageId: event.messageId, text: event.text };
    case "tool.requested":
      return { ...base, type: "tool.requested", toolName: event.toolName, input: event.input };
    case "tool.completed":
      return { ...base, type: event.ok ? "tool.completed" : "tool.failed", toolName: event.toolName, outputSummary: event.ok ? event.output : undefined, error: event.ok ? undefined : JSON.stringify(event.output), ok: event.ok } as SessionEvent;
    case "approval.opened":
      return { ...base, type: "approval.requested", approvalId: event.approvalId, summary: event.summary };
    case "approval.resolved":
      return { ...base, type: "approval.resolved", approvalId: event.approvalId, outcome: event.outcome };
    case "error":
      return { ...base, type: "run.failed", error: event.error, retryable: false };
  }
}

function sessionEventToAgentEvent(event: SessionEvent): AgentEvent | undefined {
  const base = {
    eventId: randomUUID(),
    agentId: event.agentId ?? "unknown",
    threadId: event.threadId,
    roomId: event.roomId,
    turnId: event.turnId,
    at: event.at,
  };
  switch (event.type) {
    case "run.started":
      return { ...base, type: "turn.started", input: event.input } as unknown as AgentEvent;
    case "run.completed":
      return { ...base, type: "turn.completed", output: event.output } as unknown as AgentEvent;
    case "run.failed":
      return { ...base, type: "turn.failed", error: event.error } as unknown as AgentEvent;
    case "assistant.delta":
      return { ...base, type: "message.delta", messageId: event.messageId, delta: event.delta } as unknown as AgentEvent;
    case "assistant.final":
      return { ...base, type: "message.completed", messageId: event.messageId, text: event.text } as unknown as AgentEvent;
    case "tool.requested":
      return { ...base, type: "tool.requested", toolName: event.toolName, input: event.input } as unknown as AgentEvent;
    case "tool.completed":
      return { ...base, type: "tool.completed", toolName: event.toolName, output: event.outputSummary, ok: event.ok } as unknown as AgentEvent;
    case "tool.failed":
      return { ...base, type: "tool.completed", toolName: event.toolName, output: { error: event.error }, ok: false } as unknown as AgentEvent;
    case "approval.requested":
      return { ...base, type: "approval.opened", approvalId: event.approvalId, summary: event.summary } as unknown as AgentEvent;
    case "approval.resolved":
      return { ...base, type: "approval.resolved", approvalId: event.approvalId, outcome: event.outcome === "cancelled" ? "expired" : event.outcome } as unknown as AgentEvent;
    default:
      return undefined;
  }
}

/**
 * Builds configured BillingProvider instances from durable
 * `billing_provider_configs` rows and registers them with the service.
 * Secret refs name environment variables; missing secrets yield an
 * UNCONFIGURED provider that fails honestly rather than a silent skip.
 */
export async function registerBillingProvidersFromDb(
  db: ReturnType<typeof createDb>["db"],
  billing: BillingService,
): Promise<string[]> {
  const rows = await db.select().from(billingProviderConfigs);
  const registered: string[] = [];
  for (const row of rows) {
    if (!row.enabled) continue;
    const env = row.environment === "live" ? "live" : "test";
    const secret = row.secretRef ? process.env[row.secretRef] : undefined;
    const webhookSecret = row.webhookSecretRef ? process.env[row.webhookSecretRef] : undefined;
    let provider: BillingProvider;
    switch (row.providerName) {
      case "paystack":
        provider = new PaystackProvider({ environment: env, secretKey: secret });
        break;
      case "flutterwave":
        provider = new FlutterwaveProvider({
          environment: env,
          secretKey: secret,
          secretHash: webhookSecret,
        });
        break;
      case "stripe":
        provider = new StripeProvider({ environment: env, secretKey: secret, webhookSecret });
        break;
      case "paypal":
        provider = new PayPalProvider({
          environment: env,
          clientId: secret,
          clientSecret: webhookSecret ?? undefined,
          webhookId: process.env[`${row.secretRef ?? ""}_WEBHOOK_ID`] ?? process.env["PAYPAL_WEBHOOK_ID"],
        });
        break;
      default:
        // Unknown adapter names stay unregistered (honest no-op) until code
        // support exists — configuration alone cannot conjure an adapter.
        continue;
    }
    if (!provider.configured) {
      billing.registerBlockedProvider(row.providerName, provider.blocker ?? "not configured");
      continue;
    }
    billing.registerProvider(provider);
    registered.push(row.providerName);
  }
  return registered;
}

/** Re-checks durable dependencies; used by /healthz and periodic probes. */
export async function verifyDependencies(services: ControlPlaneServices): Promise<void> {
  await services.db.execute(sql`SELECT 1`);
}
