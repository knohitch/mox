-- Prompt 00C §B: personal/API access tokens for CLI and programmatic
-- clients — a separate contract from browser cookie sessions.

CREATE TABLE IF NOT EXISTS "api_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"scopes" jsonb DEFAULT '["*"]'::jsonb NOT NULL,
	"active_org_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "api_tokens"
		ADD CONSTRAINT "api_tokens_user_id_users_id_fk"
		FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "api_tokens"
		ADD CONSTRAINT "api_tokens_active_org_id_organizations_id_fk"
		FOREIGN KEY ("active_org_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "api_tokens_token_hash_key" ON "api_tokens" USING btree ("token_hash");
CREATE INDEX IF NOT EXISTS "api_tokens_user_idx" ON "api_tokens" USING btree ("user_id");
