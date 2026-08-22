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
 
/** 
 * Computer domain: managed computers, sessions, action policies and 
 * actions. Adapted from OpenBot agent-computer + audit event types 
 * (computer.action_*) into org-scoped rows. Customer VPS machines are 
 * UNTRUSTED: they may only push signed telemetry, never pull secrets. 
 */ 
 
export const computerTrust = pgEnum("computer_trust", ["managed", "customer_vps"]); 
export const sessionState = pgEnum("session_state", ["open", "closed"]); 
export const policyEffect = pgEnum("policy_effect", ["allow", "deny", "require_approval"]); 
 
export const computers = pgTable( 
  "computers", 
  { 
    id: uuid("id").primaryKey().defaultRandom(), 
    orgId: uuid("org_id") 
      .notNull() 
      .references(() => organizations.id, { onDelete: "cascade" }), 
    slug: text("slug").notNull(), 
    displayName: text("display_name").notNull(), 
    trust: computerTrust("trust").notNull().default("managed"), 
    platform: text("platform"), 
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }), 
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), 
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(), 
  }, 
  (t) => [uniqueIndex("computers_org_slug_key").on(t.orgId, t.slug)], 
); 
 
export const computerSessions = pgTable( 
  "computer_sessions", 
  { 
    id: uuid("id").primaryKey().defaultRandom(), 
    orgId: uuid("org_id") 
      .notNull() 
      .references(() => organizations.id, { onDelete: "cascade" }), 
    computerId: uuid("computer_id") 
      .notNull() 
      .references(() => computers.id, { onDelete: "cascade" }), 
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }), 
    state: sessionState("state").notNull().default("open"), 
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(), 
    closedAt: timestamp("closed_at", { withTimezone: true }), 
  }, 
  (t) => [index("computer_sessions_computer_idx").on(t.computerId, t.openedAt)], 
); 
 
export const computerPolicies = pgTable( 
  "computer_policies", 
  { 
    id: uuid("id").primaryKey().defaultRandom(), 
    orgId: uuid("org_id") 
      .notNull() 
      .references(() => organizations.id, { onDelete: "cascade" }), 
    name: text("name").notNull(), 
    /** Glob-style action pattern, e.g. browser.navigate or shell.*. */ 
    actionPattern: text("action_pattern").notNull(), 
    effect: policyEffect("effect").notNull().default("require_approval"), 
    priority: integer("priority").notNull().default(100), 
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), 
  }, 
  (t) => [uniqueIndex("computer_policies_org_name_key").on(t.orgId, t.name)], 
); 
 
export const computerActions = pgTable( 
  "computer_actions", 
  { 
    id: uuid("id").primaryKey().defaultRandom(), 
    orgId: uuid("org_id") 
      .notNull() 
      .references(() => organizations.id, { onDelete: "cascade" }), 
    sessionId: uuid("session_id") 
      .notNull() 
      .references(() => computerSessions.id, { onDelete: "cascade" }), 
    action: text("action").notNull(), 
    params: jsonb("params"), 
    result: text("result").notNull(), 
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(), 
  }, 
  (t) => [index("computer_actions_session_idx").on(t.sessionId, t.at)], 
); 
