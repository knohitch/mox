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

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  createDb,
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
  users,
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
    events: new PgSessionEventStore(db),
    memory: new PgMemoryStore(db),
  };
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
