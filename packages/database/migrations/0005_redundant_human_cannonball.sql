CREATE TABLE "cost_ledger_entries" (
	"entry_id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"category" text,
	"amount_minor" text NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"recurring" boolean DEFAULT false NOT NULL,
	"org_id" text,
	"plan_tier" text,
	"region_code" text,
	"provider_name" text,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incidents" (
	"incident_id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"severity" text NOT NULL,
	"status" text DEFAULT 'investigating' NOT NULL,
	"affected_scope" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"updates" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_dispatches" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text,
	"event_type" text NOT NULL,
	"route" text NOT NULL,
	"recipient" text NOT NULL,
	"title" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text,
	"routes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"muted_event_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_templates" (
	"event_type" text NOT NULL,
	"locale" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_limits" (
	"org_id" text NOT NULL,
	"plan_version_id" text DEFAULT '*' NOT NULL,
	"kind" text NOT NULL,
	"included_quantity" integer DEFAULT -1 NOT NULL,
	"soft_limit_quantity" integer,
	"hard_limit_quantity" integer,
	"overage_price_ref" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "cost_ledger_kind_at_idx" ON "cost_ledger_entries" USING btree ("kind","at");--> statement-breakpoint
CREATE INDEX "cost_ledger_org_idx" ON "cost_ledger_entries" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "incidents_status_idx" ON "incidents" USING btree ("status","started_at");--> statement-breakpoint
CREATE INDEX "notification_dispatches_org_idx" ON "notification_dispatches" USING btree ("org_id","at");--> statement-breakpoint
CREATE INDEX "notification_preferences_org_idx" ON "notification_preferences" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_templates_key" ON "notification_templates" USING btree ("event_type","locale");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_limits_key" ON "usage_limits" USING btree ("org_id","kind","plan_version_id");