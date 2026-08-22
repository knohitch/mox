import { 
  index, 
  integer, 
  jsonb, 
  pgEnum, 
  pgTable, 
  text, 
  timestamp, 
  uniqueIndex, 
  uuid, 
} from "drizzle-orm/pg-core"; 
import { agents } from "./agents-core.js";
import { organizations } from "./identity-users.js";
import { threads } from "./runtime-threads.js"; 
 
/** 
 * Runtime domain, part 2: runs, tool-call metadata, approval requests and 
 * jobs. Adapted from OpenBot audit event types (agent.invoked, 
 * computer.action_*) into first-class queryable rows. 
 */ 
 
export const runStatus = pgEnum("run_status", ["queued", "running", "succeeded", "failed", "cancelled"]); 
export const approvalState = pgEnum("approval_state", ["open", "approved", "rejected", "expired"]); 
export const jobStatus = pgEnum("job_status", ["pending", "running", "succeeded", "failed"]); 
 
export const runtimeRuns = pgTable( 
  "runtime_runs", 
  { 
    id: uuid("id").primaryKey().defaultRandom(), 
    orgId: uuid("org_id") 
      .notNull() 
      .references(() => organizations.id, { onDelete: "cascade" }), 
    agentId: uuid("agent_id") 
      .notNull() 
      .references(() => agents.id, { onDelete: "cascade" }), 
    threadId: uuid("thread_id").references(() => threads.id, { onDelete: "set null" }), 
    status: runStatus("status").notNull().default("queued"), 
    correlationId: text("correlation_id"), 
    startedAt: timestamp("started_at", { withTimezone: true }), 
    finishedAt: timestamp("finished_at", { withTimezone: true }), 
    error: text("error"), 
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), 
  }, 
  (t) => [ 
    index("runtime_runs_org_agent_idx").on(t.orgId, t.agentId), 
    uniqueIndex("runtime_runs_correlation_key").on(t.correlationId), 
  ], 
); 
 
export const toolCalls = pgTable( 
  "tool_calls", 
  { 
    id: uuid("id").primaryKey().defaultRandom(), 
    orgId: uuid("org_id") 
      .notNull() 
      .references(() => organizations.id, { onDelete: "cascade" }), 
    runId: uuid("run_id") 
      .notNull() 
      .references(() => runtimeRuns.id, { onDelete: "cascade" }), 
    toolName: text("tool_name").notNull(), 
    /** Redacted arguments; raw arguments never enter durable storage. */ 
    arguments: jsonb("arguments"), 
    outcome: text("outcome").notNull(), 
    providerRequestId: text("provider_request_id"), 
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(), 
  }, 
  (t) => [index("tool_calls_run_idx").on(t.runId, t.at)], 
); 
 
export const approvalRequests = pgTable( 
  "approval_requests", 
  { 
    id: uuid("id").primaryKey().defaultRandom(), 
    orgId: uuid("org_id") 
      .notNull() 
      .references(() => organizations.id, { onDelete: "cascade" }), 
    agentId: uuid("agent_id") 
      .notNull() 
      .references(() => agents.id, { onDelete: "cascade" }), 
    runId: uuid("run_id").references(() => runtimeRuns.id, { onDelete: "set null" }), 
    kind: text("kind").notNull(), 
    summary: text("summary").notNull(), 
    payload: jsonb("payload"), 
    state: approvalState("state").notNull().default("open"), 
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(), 
    resolvedAt: timestamp("resolved_at", { withTimezone: true }), 
    resolvedByUserId: uuid("resolved_by_user_id"), 
  }, 
  (t) => [index("approval_requests_org_state_idx").on(t.orgId, t.state)], 
); 
 
export const jobs = pgTable( 
  "jobs", 
  { 
    id: uuid("id").primaryKey().defaultRandom(), 
    orgId: uuid("org_id") 
      .notNull() 
      .references(() => organizations.id, { onDelete: "cascade" }), 
    kind: text("kind").notNull(), 
    status: jobStatus("status").notNull().default("pending"), 
    idempotencyKey: text("idempotency_key").notNull(), 
    payload: jsonb("payload"), 
    attempts: integer("attempts").notNull().default(0), 
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), 
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(), 
  }, 
  (t) => [uniqueIndex("jobs_org_idempotency_key").on(t.orgId, t.idempotencyKey)], 
); 
