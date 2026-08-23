-- Prompt 01: durable payment-provider configuration, plan mappings,
-- provider customers and the normalized provider-payment ledger.

CREATE TABLE IF NOT EXISTS "billing_provider_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_name" text NOT NULL,
	"environment" text DEFAULT 'test' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"display_name" text NOT NULL,
	"public_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret_ref" text,
	"webhook_secret_ref" text,
	"supported_currencies" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"supported_regions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"maintenance_mode" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "billing_provider_configs_name_key"
	ON "billing_provider_configs" USING btree ("provider_name");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provider_plan_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_name" text NOT NULL,
	"environment" text DEFAULT 'test' NOT NULL,
	"product_id" uuid NOT NULL,
	"mox_price_version_id" uuid NOT NULL,
	"provider_plan_ref" text NOT NULL,
	"currency" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "provider_plan_mappings"
		ADD CONSTRAINT "provider_plan_mappings_product_id_products_id_fk"
		FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;
	ALTER TABLE "provider_plan_mappings"
		ADD CONSTRAINT "provider_plan_mappings_mox_price_version_id_price_versions_id_fk"
		FOREIGN KEY ("mox_price_version_id") REFERENCES "public"."price_versions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "provider_plan_mappings_key"
	ON "provider_plan_mappings" USING btree ("provider_name","environment","mox_price_version_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provider_customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_name" text NOT NULL,
	"environment" text DEFAULT 'test' NOT NULL,
	"org_id" uuid NOT NULL,
	"provider_customer_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "provider_customers"
		ADD CONSTRAINT "provider_customers_org_id_organizations_id_fk"
		FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "provider_customers_key"
	ON "provider_customers" USING btree ("provider_name","environment","org_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provider_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_name" text NOT NULL,
	"environment" text DEFAULT 'test' NOT NULL,
	"external_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"org_id" uuid,
	"provider_subscription_ref" text,
	"checkout_session_ref" text,
	"provider_transaction_ref" text,
	"invoice_ref" text,
	"state" text NOT NULL,
	"currency" text,
	"amount_minor" bigint,
	"payload_digest" text NOT NULL,
	"occurred_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reconciled_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "provider_payments"
		ADD CONSTRAINT "provider_payments_org_id_organizations_id_fk"
		FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "provider_payments_event_key"
	ON "provider_payments" USING btree ("provider_name","external_event_id");
CREATE INDEX IF NOT EXISTS "provider_payments_org_idx"
	ON "provider_payments" USING btree ("org_id","received_at");
CREATE INDEX IF NOT EXISTS "provider_payments_sub_idx"
	ON "provider_payments" USING btree ("provider_subscription_ref");
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "provider_environment" text;
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "last_event_at" timestamptz;
ALTER TABLE "checkout_sessions" ADD COLUMN IF NOT EXISTS "environment" text;
