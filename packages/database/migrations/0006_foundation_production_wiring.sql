-- Prompt 00 §D/§E/§C: production wiring foundation upgrade.
-- Preserves all legitimate history; only unused shell tables are replaced.

-- ===== §D1: subscription history-preserving uniqueness ======================
-- The old index allowed exactly ONE row per org for ALL states, blocking
-- cancel → resubscribe. Replace with a partial unique index over LIVE
-- states so canceled/deleted rows remain as history.
DROP INDEX IF EXISTS "subscriptions_org_active_key";
CREATE UNIQUE INDEX IF NOT EXISTS "subscriptions_org_live_key"
	ON "subscriptions" USING btree ("org_id")
	WHERE "state" in ('trial', 'active', 'past_due', 'grace_period', 'suspended');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscriptions_org_idx" ON "subscriptions" USING btree ("org_id");

-- ===== §D2: checkout provider reference ======================================
ALTER TABLE "checkout_sessions" ADD COLUMN "provider_ref" text;
CREATE UNIQUE INDEX IF NOT EXISTS "checkout_sessions_provider_ref_key"
	ON "checkout_sessions" USING btree ("provider_ref");

-- ===== §D3: FX/base pricing agreement (integer-scaled rate) ==================
ALTER TABLE "price_books" ADD COLUMN "base_amount_minor" bigint;
ALTER TABLE "price_books" ADD COLUMN "fx_rate_scaled" bigint;
-- Migrate legacy jsonb rates into the integer representation (rate × 1e9).
UPDATE "price_books"
	SET "fx_rate_scaled" = round(("fx_rate"::text)::numeric * 1000000000)::bigint
	WHERE "fx_rate" IS NOT NULL
	  AND jsonb_typeof("fx_rate") = 'number';
ALTER TABLE "price_books" DROP COLUMN IF EXISTS "fx_rate";

-- ===== §E: durable node identity + enrollment tokens =========================
ALTER TABLE "mox_nodes" ADD COLUMN "agent_token_hash" text;
CREATE INDEX IF NOT EXISTS "mox_nodes_agent_token_key" ON "mox_nodes" USING btree ("agent_token_hash");
--> statement-breakpoint
DO $$ BEGIN
	CREATE TYPE "enrollment_token_state" AS ENUM ('issued', 'consumed', 'expired', 'revoked');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "node_enrollment_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"org_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"provider_instance_id" text,
	"state" "enrollment_token_state" DEFAULT 'issued' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "node_enrollment_tokens"
		ADD CONSTRAINT "node_enrollment_tokens_org_id_organizations_id_fk"
		FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
	ALTER TABLE "node_enrollment_tokens"
		ADD CONSTRAINT "node_enrollment_tokens_order_id_server_orders_id_fk"
		FOREIGN KEY ("order_id") REFERENCES "public"."server_orders"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "node_enrollment_tokens_hash_key" ON "node_enrollment_tokens" USING btree ("token_hash");
CREATE INDEX IF NOT EXISTS "node_enrollment_tokens_order_idx" ON "node_enrollment_tokens" USING btree ("order_id","state");

-- ===== §C: authoritative notification tables =================================
-- Supersedes the unreleased platform-ops shells (no legitimate history):
-- drop the old shells, then create the richer durable model.
DROP TABLE IF EXISTS "notification_dispatches";
DROP TABLE IF EXISTS "notification_preferences";
DROP TABLE IF EXISTS "notification_templates";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "message_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_type" text NOT NULL,
	"locale" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notification_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid,
	"routes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"muted_event_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "notification_preferences"
		ADD CONSTRAINT "notification_preferences_org_id_organizations_id_fk"
		FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "in_app_notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid,
	"event_type" text NOT NULL,
	"severity" text DEFAULT 'info' NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"resource_type" text,
	"resource_id" text,
	"dedupe_key" text,
	"read_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "in_app_notifications"
		ADD CONSTRAINT "in_app_notifications_org_id_organizations_id_fk"
		FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "in_app_notifications_org_dedupe_key"
	ON "in_app_notifications" USING btree ("org_id","dedupe_key");
CREATE INDEX IF NOT EXISTS "in_app_notifications_org_created_idx"
	ON "in_app_notifications" USING btree ("org_id","created_at");
CREATE INDEX IF NOT EXISTS "message_templates_event_locale_idx"
	ON "message_templates" USING btree ("event_type","locale");
CREATE INDEX IF NOT EXISTS "notification_prefs_org_user_idx"
	ON "notification_preferences" USING btree ("org_id","user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dispatched_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid,
	"event_type" text NOT NULL,
	"route" text NOT NULL,
	"recipient" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "dispatched_messages"
		ADD CONSTRAINT "dispatched_messages_org_id_organizations_id_fk"
		FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dispatched_messages_org_idx" ON "dispatched_messages" USING btree ("org_id");
