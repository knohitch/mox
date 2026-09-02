-- Mandatory customer onboarding: durable, org-scoped onboarding authority.
--
-- ESTABLISHES one onboarding row per customer organization so progress
-- survives refresh, logout/login, control-plane restarts and org switches.
-- Status/step/decision semantics are enforced by the control-plane onboarding
-- service; this migration only creates the durable state and backfills.
--
-- EXISTING CUSTOMER SAFETY: every organization that exists BEFORE this
-- migration is backfilled as `completed`, so no pre-existing account can be
-- locked out of the product. Organizations created afterwards (customer
-- signup) are inserted as `not_started` by the signup authority.
--
-- Forward-only and additive: nothing existing is dropped or rewritten.

DO $$ BEGIN
  CREATE TYPE "public"."org_onboarding_status" AS ENUM ('not_started', 'in_progress', 'completed');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "org_onboarding" (
  "org_id" uuid PRIMARY KEY,
  "status" "public"."org_onboarding_status" DEFAULT 'not_started' NOT NULL,
  "current_step" integer DEFAULT 1 NOT NULL,
  "completed_steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "persona" text,
  "goals" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "display_name" text,
  "workspace_name" text,
  "model_setup_choice" text,
  "model_provider_id" text,
  "agent_setup_choice" text,
  "agent_id" uuid,
  "infrastructure_setup_choice" text,
  "server_order_id" uuid,
  "connections_setup_choice" text,
  "started_at" timestamptz,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  "completed_at" timestamptz,
  "updated_by_user_id" uuid,
  CONSTRAINT "org_onboarding_current_step_range" CHECK ("current_step" BETWEEN 1 AND 6),
  CONSTRAINT "org_onboarding_model_setup_choice_check" CHECK ("model_setup_choice" IS NULL OR "model_setup_choice" IN ('mox_managed', 'own_provider', 'deferred')),
  CONSTRAINT "org_onboarding_agent_setup_choice_check" CHECK ("agent_setup_choice" IS NULL OR "agent_setup_choice" IN ('created', 'deferred')),
  CONSTRAINT "org_onboarding_infrastructure_setup_choice_check" CHECK ("infrastructure_setup_choice" IS NULL OR "infrastructure_setup_choice" IN ('provisioned', 'deferred')),
  CONSTRAINT "org_onboarding_connections_setup_choice_check" CHECK ("connections_setup_choice" IS NULL OR "connections_setup_choice" IN ('configured', 'deferred')),
  CONSTRAINT "org_onboarding_org_id_organizations_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id")
    ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "org_onboarding_agent_id_agents_id_fk"
    FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id")
    ON DELETE set null ON UPDATE no action,
  CONSTRAINT "org_onboarding_server_order_id_server_orders_id_fk"
    FOREIGN KEY ("server_order_id") REFERENCES "public"."server_orders"("id")
    ON DELETE set null ON UPDATE no action,
  CONSTRAINT "org_onboarding_updated_by_user_id_users_id_fk"
    FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id")
    ON DELETE set null ON UPDATE no action
);

-- Existing organizations predate onboarding: they must never be trapped by
-- the mandatory flow, so they resume as already-completed.
INSERT INTO "org_onboarding"
  ("org_id", "status", "current_step", "completed_steps", "goals", "completed_at")
SELECT o."id", 'completed', 6, '[1,2,3,4,5,6]'::jsonb, '[]'::jsonb, now()
FROM "organizations" o
ON CONFLICT ("org_id") DO NOTHING;
