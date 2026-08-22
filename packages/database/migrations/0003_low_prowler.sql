CREATE TYPE "public"."server_operation_state" AS ENUM('queued', 'running', 'succeeded', 'failed', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."server_order_state" AS ENUM('requested', 'provisioning', 'running', 'error', 'resizing', 'stopping', 'stopped', 'cancelling', 'canceled', 'retention', 'destroyed');--> statement-breakpoint
CREATE TABLE "compute_classes" (
	"code" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"min_vcpu" integer NOT NULL,
	"min_ram_gb" integer NOT NULL,
	"sku_map" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mox_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"order_id" uuid,
	"node_id" text NOT NULL,
	"enroll_token_hash" text NOT NULL,
	"version" text,
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metrics" jsonb,
	"enrolled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'active' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "node_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" text NOT NULL,
	"nonce" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"acknowledged_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "provider_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_name" text NOT NULL,
	"account_label" text NOT NULL,
	"region_code" text,
	"commercial_status" text DEFAULT 'active' NOT NULL,
	"health_score" integer DEFAULT 100 NOT NULL,
	"credential_ref_id" uuid,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"state" "server_operation_state" DEFAULT 'queued' NOT NULL,
	"provider_operation_id" text,
	"idempotency_key" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"subscription_item_id" uuid,
	"compute_class_code" text NOT NULL,
	"state" "server_order_state" DEFAULT 'requested' NOT NULL,
	"provider_name" text,
	"provider_account_id" uuid,
	"region_code" text,
	"provider_sku" text,
	"provider_instance_id" text,
	"ipv4" text,
	"ipv6" text,
	"hostname" text NOT NULL,
	"ssh_key_id" uuid,
	"root_credential_ref_id" uuid,
	"reverse_dns" text,
	"idempotency_key" text NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"retention_until" timestamp with time zone,
	"canceled_at" timestamp with time zone,
	"destroyed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ssh_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"label" text NOT NULL,
	"public_key" text NOT NULL,
	"fingerprint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mox_nodes" ADD CONSTRAINT "mox_nodes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mox_nodes" ADD CONSTRAINT "mox_nodes_order_id_server_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."server_orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_commands" ADD CONSTRAINT "node_commands_node_id_mox_nodes_node_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."mox_nodes"("node_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_operations" ADD CONSTRAINT "server_operations_order_id_server_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."server_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_orders" ADD CONSTRAINT "server_orders_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_orders" ADD CONSTRAINT "server_orders_compute_class_code_compute_classes_code_fk" FOREIGN KEY ("compute_class_code") REFERENCES "public"."compute_classes"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_orders" ADD CONSTRAINT "server_orders_provider_account_id_provider_accounts_id_fk" FOREIGN KEY ("provider_account_id") REFERENCES "public"."provider_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_orders" ADD CONSTRAINT "server_orders_ssh_key_id_ssh_keys_id_fk" FOREIGN KEY ("ssh_key_id") REFERENCES "public"."ssh_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ssh_keys" ADD CONSTRAINT "ssh_keys_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mox_nodes_node_id_key" ON "mox_nodes" USING btree ("node_id");--> statement-breakpoint
CREATE UNIQUE INDEX "node_commands_nonce_key" ON "node_commands" USING btree ("nonce");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_accounts_label_key" ON "provider_accounts" USING btree ("provider_name","account_label");--> statement-breakpoint
CREATE UNIQUE INDEX "server_operations_order_kind_key" ON "server_operations" USING btree ("order_id","kind","idempotency_key");--> statement-breakpoint
CREATE INDEX "server_operations_due_idx" ON "server_operations" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "server_orders_org_idem_key" ON "server_orders" USING btree ("org_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "server_orders_state_idx" ON "server_orders" USING btree ("state");--> statement-breakpoint
CREATE INDEX "server_orders_org_idx" ON "server_orders" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "ssh_keys_org_idx" ON "ssh_keys" USING btree ("org_id");