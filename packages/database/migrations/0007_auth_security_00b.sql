-- Prompt 00B: authentication security, multi-org sessions and node
-- enrollment retry hardening.

-- ===== §B/C: password credentials + active-org session context ==============
CREATE TABLE IF NOT EXISTS "auth_credentials" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"password_hash" text NOT NULL,
	"algorithm" text DEFAULT 'scrypt' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "auth_credentials"
		ADD CONSTRAINT "auth_credentials_user_id_users_id_fk"
		FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD COLUMN IF NOT EXISTS "active_org_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "auth_sessions"
		ADD CONSTRAINT "auth_sessions_active_org_id_organizations_id_fk"
		FOREIGN KEY ("active_org_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ===== §A: one-time platform setup state =====================================
CREATE TABLE IF NOT EXISTS "platform_setup" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"setup_token_hash" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_setup_singleton" CHECK ("id" = 1)
);

-- ===== §F: at most one valid issued enrollment token per server order =======
CREATE UNIQUE INDEX IF NOT EXISTS "node_enrollment_tokens_one_issued_per_order"
	ON "node_enrollment_tokens" USING btree ("order_id")
	WHERE "state" = 'issued';
