CREATE TYPE "public"."checkout_state" AS ENUM('created', 'redirected', 'completed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('open', 'paid', 'failed', 'void');--> statement-breakpoint
CREATE TYPE "public"."subscription_item_kind" AS ENUM('base', 'addon');--> statement-breakpoint
CREATE TYPE "public"."plan_tier" AS ENUM('plus', 'pro', 'max', 'enterprise');--> statement-breakpoint
CREATE TYPE "public"."plan_version_status" AS ENUM('draft', 'active', 'retired');--> statement-breakpoint
CREATE TYPE "public"."price_book_mode" AS ENUM('fixed', 'fx_derived', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."subscription_state" AS ENUM('trial', 'active', 'past_due', 'grace_period', 'suspended', 'canceled', 'retention', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."webhook_status" AS ENUM('received', 'verified', 'applied', 'rejected');--> statement-breakpoint
CREATE TABLE "addon_definitions" (
	"code" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"consumable" boolean DEFAULT false NOT NULL,
	"unit" text DEFAULT 'count' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_customers" (
	"org_id" uuid NOT NULL,
	"provider_name" text NOT NULL,
	"provider_customer_id" text NOT NULL,
	"billing_region" text DEFAULT 'GLOBAL' NOT NULL,
	"default_display_currency" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "checkout_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"plan_version_id" uuid NOT NULL,
	"price_version_id" uuid NOT NULL,
	"state" "checkout_state" DEFAULT 'created' NOT NULL,
	"provider_name" text NOT NULL,
	"redirect_url" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "currencies" (
	"code" text PRIMARY KEY NOT NULL,
	"exponent" integer NOT NULL,
	"display_name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom_contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"contract_ref" text NOT NULL,
	"values" jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entitlement_definitions" (
	"key" text PRIMARY KEY NOT NULL,
	"value_type" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"default_value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entitlement_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"granted_by" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscription_id" uuid NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"status" "invoice_status" DEFAULT 'open' NOT NULL,
	"provider_invoice_ref" text,
	"attempt" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "plan_entitlement_values" (
	"plan_version_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plan_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" "plan_version_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	"retired_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "price_books" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"pricing_region" text NOT NULL,
	"mode" "price_book_mode" DEFAULT 'fixed' NOT NULL,
	"base_currency" text,
	"fx_rate" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "price_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"price_book_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pricing_regions" (
	"code" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"charge_currency" text NOT NULL,
	"display_currency" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"tier" "plan_tier" NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscription_id" uuid NOT NULL,
	"kind" "subscription_item_kind" DEFAULT 'base' NOT NULL,
	"addon_code" text,
	"quantity" integer DEFAULT 1 NOT NULL,
	"price_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription_transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscription_id" uuid NOT NULL,
	"from_state" "subscription_state",
	"to_state" "subscription_state" NOT NULL,
	"reason" text NOT NULL,
	"actor_type" text DEFAULT 'system' NOT NULL,
	"actor_id" text,
	"idempotency_key" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"plan_version_id" uuid NOT NULL,
	"price_version_id" uuid NOT NULL,
	"state" "subscription_state" DEFAULT 'trial' NOT NULL,
	"provider_ref" text,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"trial_ends_at" timestamp with time zone,
	"grace_ends_at" timestamp with time zone,
	"retention_until" timestamp with time zone,
	"failed_renewals" integer DEFAULT 0 NOT NULL,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"canceled_at" timestamp with time zone,
	"suspended_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verified_webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_name" text NOT NULL,
	"external_event_id" text NOT NULL,
	"type" text NOT NULL,
	"sequence" integer,
	"payload_digest" text NOT NULL,
	"status" "webhook_status" DEFAULT 'received' NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone,
	"rejection_reason" text
);
--> statement-breakpoint
ALTER TABLE "billing_customers" ADD CONSTRAINT "billing_customers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_customers" ADD CONSTRAINT "billing_customers_default_display_currency_currencies_code_fk" FOREIGN KEY ("default_display_currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_plan_version_id_plan_versions_id_fk" FOREIGN KEY ("plan_version_id") REFERENCES "public"."plan_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_price_version_id_price_versions_id_fk" FOREIGN KEY ("price_version_id") REFERENCES "public"."price_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_contracts" ADD CONSTRAINT "custom_contracts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_overrides" ADD CONSTRAINT "entitlement_overrides_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_entitlement_values" ADD CONSTRAINT "plan_entitlement_values_plan_version_id_plan_versions_id_fk" FOREIGN KEY ("plan_version_id") REFERENCES "public"."plan_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_entitlement_values" ADD CONSTRAINT "plan_entitlement_values_key_entitlement_definitions_key_fk" FOREIGN KEY ("key") REFERENCES "public"."entitlement_definitions"("key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_versions" ADD CONSTRAINT "plan_versions_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_books" ADD CONSTRAINT "price_books_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_books" ADD CONSTRAINT "price_books_pricing_region_pricing_regions_code_fk" FOREIGN KEY ("pricing_region") REFERENCES "public"."pricing_regions"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_books" ADD CONSTRAINT "price_books_base_currency_currencies_code_fk" FOREIGN KEY ("base_currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_versions" ADD CONSTRAINT "price_versions_price_book_id_price_books_id_fk" FOREIGN KEY ("price_book_id") REFERENCES "public"."price_books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_versions" ADD CONSTRAINT "price_versions_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_regions" ADD CONSTRAINT "pricing_regions_charge_currency_currencies_code_fk" FOREIGN KEY ("charge_currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_regions" ADD CONSTRAINT "pricing_regions_display_currency_currencies_code_fk" FOREIGN KEY ("display_currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_items" ADD CONSTRAINT "subscription_items_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_items" ADD CONSTRAINT "subscription_items_addon_code_addon_definitions_code_fk" FOREIGN KEY ("addon_code") REFERENCES "public"."addon_definitions"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_items" ADD CONSTRAINT "subscription_items_price_version_id_price_versions_id_fk" FOREIGN KEY ("price_version_id") REFERENCES "public"."price_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_transitions" ADD CONSTRAINT "subscription_transitions_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_version_id_plan_versions_id_fk" FOREIGN KEY ("plan_version_id") REFERENCES "public"."plan_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_price_version_id_price_versions_id_fk" FOREIGN KEY ("price_version_id") REFERENCES "public"."price_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_customers_org_provider_key" ON "billing_customers" USING btree ("org_id","provider_name");--> statement-breakpoint
CREATE INDEX "checkout_sessions_org_idx" ON "checkout_sessions" USING btree ("org_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "custom_contracts_ref_key" ON "custom_contracts" USING btree ("contract_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "entitlement_overrides_org_key" ON "entitlement_overrides" USING btree ("org_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_sub_period_attempt_key" ON "invoices" USING btree ("subscription_id","period_start","attempt");--> statement-breakpoint
CREATE UNIQUE INDEX "plan_entitlement_values_key" ON "plan_entitlement_values" USING btree ("plan_version_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "plan_versions_product_version_key" ON "plan_versions" USING btree ("product_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "price_books_product_region_key" ON "price_books" USING btree ("product_id","pricing_region");--> statement-breakpoint
CREATE UNIQUE INDEX "price_versions_book_version_key" ON "price_versions" USING btree ("price_book_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "products_code_key" ON "products" USING btree ("code");--> statement-breakpoint
CREATE INDEX "subscription_items_sub_idx" ON "subscription_items" USING btree ("subscription_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_transitions_idem_key" ON "subscription_transitions" USING btree ("subscription_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_org_active_key" ON "subscriptions" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "subscriptions_state_idx" ON "subscriptions" USING btree ("state");--> statement-breakpoint
CREATE UNIQUE INDEX "verified_webhook_events_provider_external_key" ON "verified_webhook_events" USING btree ("provider_name","external_event_id");