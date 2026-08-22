import { 
  index, 
  jsonb, 
  pgTable, 
  text, 
  timestamp, 
  uniqueIndex, 
  uuid, 
} from "drizzle-orm/pg-core"; 
import { agents } from "./agents-core.js";
import { organizations } from "./identity-users.js";
 
/** 
 * Agents domain, part 3: skills, bindings and knowledge sources. 
 * Org-scoped extension of OpenBot knowledge model; embeddings stay in 
 * the vector store, not here. 
 */ 
 
export const skills = pgTable( 
  "skills", 
  { 
    id: uuid("id").primaryKey().defaultRandom(), 
    orgId: uuid("org_id") 
      .notNull() 
      .references(() => organizations.id, { onDelete: "cascade" }), 
    slug: text("slug").notNull(), 
    displayName: text("display_name").notNull(), 
    manifest: jsonb("manifest").notNull(), 
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), 
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(), 
  }, 
  (t) => [uniqueIndex("skills_org_slug_key").on(t.orgId, t.slug)], 
); 
 
export const agentSkills = pgTable( 
  "agent_skills", 
  { 
    agentId: uuid("agent_id") 
      .notNull() 
      .references(() => agents.id, { onDelete: "cascade" }), 
    skillId: uuid("skill_id") 
      .notNull() 
      .references(() => skills.id, { onDelete: "cascade" }), 
    orgId: uuid("org_id") 
      .notNull() 
      .references(() => organizations.id, { onDelete: "cascade" }), 
    enabled: text("enabled").notNull().default("true"), 
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), 
  }, 
  (t) => [ 
    uniqueIndex("agent_skills_key").on(t.agentId, t.skillId), 
    index("agent_skills_org_idx").on(t.orgId), 
  ], 
); 
 
export const knowledgeSources = pgTable( 
  "knowledge_sources", 
  { 
    id: uuid("id").primaryKey().defaultRandom(), 
    orgId: uuid("org_id") 
      .notNull() 
      .references(() => organizations.id, { onDelete: "cascade" }), 
    name: text("name").notNull(), 
    kind: text("kind").notNull(), 
    config: jsonb("config").notNull(), 
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }), 
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), 
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(), 
  }, 
  (t) => [uniqueIndex("knowledge_sources_org_name_key").on(t.orgId, t.name)], 
); 
