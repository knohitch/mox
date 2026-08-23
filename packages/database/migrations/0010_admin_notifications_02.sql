-- Prompt 02: durable notification inbox fields + admin job machinery.

ALTER TABLE "in_app_notifications"
	ADD COLUMN IF NOT EXISTS "audience_type" text DEFAULT 'user' NOT NULL,
	ADD COLUMN IF NOT EXISTS "category" text DEFAULT 'system' NOT NULL,
	ADD COLUMN IF NOT EXISTS "created_by" text,
	ADD COLUMN IF NOT EXISTS "scheduled_at" timestamp with time zone,
	ADD COLUMN IF NOT EXISTS "delivery_state" text DEFAULT 'ready' NOT NULL,
	ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "in_app_notifications_user_inbox_idx"
	ON "in_app_notifications" USING btree ("org_id","user_id","created_at" DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notification_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid,
	"audience_type" text NOT NULL,
	"audience_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"severity" text DEFAULT 'info' NOT NULL,
	"category" text DEFAULT 'system' NOT NULL,
	"resource_type" text,
	"resource_id" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"scheduled_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"fanout_total" integer DEFAULT 0 NOT NULL,
	"fanout_done" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_by" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "notification_jobs"
		ADD CONSTRAINT "notification_jobs_org_id_organizations_id_fk"
		FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "notification_jobs_idem_key"
	ON "notification_jobs" USING btree ("idempotency_key");
CREATE INDEX IF NOT EXISTS "notification_jobs_status_idx"
	ON "notification_jobs" USING btree ("status","scheduled_at");
