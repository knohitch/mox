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

import { sql } from "drizzle-orm";
import {
  createDb,
  PgBillingStore,
  PgEntitlementStore,
  PgMemoryStore,
  PgMessageStore,
  PgNotificationStore,
  PgOrchestratorStore,
  PgSessionEventStore,
  PgThreadStore,
} from "@mox/database";
import { BillingService } from "@mox/billing";
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
  const orchestrator = new ComputeOrchestrator(new PgOrchestratorStore(db), {
    controlPlaneUrl: config.publicUrl,
  });
  const entitlements = new EntitlementService(new PgEntitlementStore(db));
  const notifications = new NotificationService(new PgNotificationStore(db));

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

/** Re-checks durable dependencies; used by /healthz and periodic probes. */
export async function verifyDependencies(services: ControlPlaneServices): Promise<void> {
  await services.db.execute(sql`SELECT 1`);
}
