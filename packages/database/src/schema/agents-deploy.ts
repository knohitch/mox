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
import { organizations, users } from "./identity-users.js";

/**
 * Agents domain, part 2: deployments, agent rooms and room members.
 * Adapted from OpenBot `channels`/`channelMemberships`/`channelAgents`.
 */

export const deploymentKind = pgEnum("deployment_kind", [
  "sandbox",
  "shared_host",
  "dedicated_vps",
  "customer_vps",
]);

export const agentDeployments = pgTable(
  "agent_deployments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    kind: deploymentKind("kind").notNull().default("sandbox"),
    /** Reference to the compute instance shell (operations domain). */
    computeInstanceId: uuid("compute_instance_id"),
    desiredRevision: integer("desired_revision").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("agent_deployments_org_agent_idx").on(t.orgId, t.agentId)],
);

export const agentRooms = pgTable(
  "agent_rooms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    suggestedPrompts: jsonb("suggested_prompts").notNull().default([]),
    lastMessage: text("last_message"),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("agent_rooms_org_name_key").on(t.orgId, t.name)],
);

export const roomMembers = pgTable(
  "room_members",
  {
    roomId: uuid("room_id")
      .notNull()
      .references(() => agentRooms.id, { onDelete: "cascade" }),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("room_members_key").on(t.roomId, t.userId, t.agentId)],
);