ALTER TABLE "provider_accounts" ADD COLUMN IF NOT EXISTS "rotated_at" timestamp with time zone;
ALTER TABLE "provider_accounts" ADD COLUMN IF NOT EXISTS "disabled_reason" text;

ALTER TABLE "server_operations" ADD COLUMN IF NOT EXISTS "lease_until" timestamp with time zone;
CREATE INDEX IF NOT EXISTS "server_operations_lease_idx" ON "server_operations" USING btree ("state", "lease_until");

CREATE TABLE IF NOT EXISTS "node_enrollment_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "token_id" text NOT NULL,
  "token_hash" text NOT NULL,
  "org_id" uuid NOT NULL,
  "order_id" uuid NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  "consumed_by_node_id" text,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "node_enrollment_tokens_org_id_organizations_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "node_enrollment_tokens_order_id_server_orders_id_fk"
    FOREIGN KEY ("order_id") REFERENCES "public"."server_orders"("id") ON DELETE cascade ON UPDATE no action
);
CREATE UNIQUE INDEX IF NOT EXISTS "node_enrollment_tokens_token_id_key" ON "node_enrollment_tokens" USING btree ("token_id");
CREATE INDEX IF NOT EXISTS "node_enrollment_tokens_order_idx" ON "node_enrollment_tokens" USING btree ("order_id", "expires_at");

ALTER TABLE "mox_nodes" ADD COLUMN IF NOT EXISTS "agent_token_hash" text;

CREATE TABLE IF NOT EXISTS "node_consumed_nonces" (
  "nonce" text PRIMARY KEY NOT NULL,
  "consumed_at" timestamp with time zone DEFAULT now() NOT NULL
);
