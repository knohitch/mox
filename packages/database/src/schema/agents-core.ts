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
import { organizations } from "./identity-users.js";

/**
 * Agents domain, part 1: agents and immutable agent versions. The live
 * AgentDefinition (see @mox/contracts) is the authority; these rows are its
 * durable projection. Adapted from OpenBot `agents`/`deployment_packages`.
 */

export const agentStatus = pgEnum("agent_status", ["draft", "active", "paused", "retired"]);

export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    displayName: text("display_name").notNull(),
    status: agentStatus("status").notNull().default("draft"),
    /** Current AgentDefinition JSON (canonical shape from @mox/contracts). */
    definition: jsonb("definition").notNull(),
    currentVersion: integer("current_version").notNull().default(1),
    createdByUserId: uuid("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("agents_org_slug_key").on(t.orgId, t.slug),
    index("agents_org_status_idx").on(t.orgId, t.status),
  ],
);

export const agentVersions = pgTable(
  "agent_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    version: text("version").notNull(),
    definition: jsonb("definition").notNull(),
    publishedByUserId: uuid("published_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("agent_versions_agent_version_key").on(t.agentId, t.version)],
);