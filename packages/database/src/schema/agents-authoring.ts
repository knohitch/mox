import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations, users } from "./identity-users.js";

/**
 * Agent authoring/deployment extras (Prompt 10): browser terminal session
 * audit for entitled plans. Sessions target customer VPS only; Mox
 * control-plane hosts are never addressable.
 */

export const browserTerminalSessions = pgTable(
  "browser_terminal_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Must reference a server owned by orgId (validated in the service). */
    serverOrderId: uuid("server_order_id"),
    state: text("state").notNull().default("open"),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    commandCount: integer("command_count").notNull().default(0),
    metadata: jsonb("metadata"),
  },
  (t) => [index("terminal_sessions_org_idx").on(t.orgId, t.openedAt)],
);
