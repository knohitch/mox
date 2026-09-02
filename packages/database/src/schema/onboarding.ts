import { integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agents } from "./agents-core.js";
import { serverOrders } from "./compute.js";
import { organizations, users } from "./identity-users.js";

/**
 * Mandatory customer onboarding (durable authority).
 *
 * One row per organization; the control-plane onboarding service owns the
 * step/decision semantics. Existing organizations were backfilled to
 * `completed` by migration 0020 — they are never trapped by the flow.
 */
export const orgOnboardingStatus = pgEnum("org_onboarding_status", [
  "not_started",
  "in_progress",
  "completed",
]);

export const orgOnboarding = pgTable("org_onboarding", {
  orgId: uuid("org_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  status: orgOnboardingStatus("status").notNull().default("not_started"),
  currentStep: integer("current_step").notNull().default(1),
  completedSteps: jsonb("completed_steps")
    .$type<number[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  persona: text("persona"),
  goals: jsonb("goals")
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  displayName: text("display_name"),
  workspaceName: text("workspace_name"),
  modelSetupChoice: text("model_setup_choice"),
  modelProviderId: text("model_provider_id"),
  agentSetupChoice: text("agent_setup_choice"),
  agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
  infrastructureSetupChoice: text("infrastructure_setup_choice"),
  serverOrderId: uuid("server_order_id").references(() => serverOrders.id, {
    onDelete: "set null",
  }),
  connectionsSetupChoice: text("connections_setup_choice"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  updatedByUserId: uuid("updated_by_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
});
