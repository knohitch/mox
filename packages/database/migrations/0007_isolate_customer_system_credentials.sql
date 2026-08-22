DO $$ BEGIN
  CREATE TYPE "public"."provider_auth_method" AS ENUM('api_key', 'oauth', 'device_login', 'none');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "customer_credential_secrets" (
  "org_id" uuid NOT NULL,
  "external_id" text NOT NULL,
  "sealed" text NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "customer_credential_secrets_org_id_organizations_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action
);
CREATE UNIQUE INDEX IF NOT EXISTS "customer_credential_secrets_key"
  ON "customer_credential_secrets" USING btree ("org_id", "external_id");

ALTER TABLE "model_connections"
  ADD COLUMN IF NOT EXISTS "auth_method" "provider_auth_method" DEFAULT 'api_key' NOT NULL;
ALTER TABLE "model_connections"
  ADD COLUMN IF NOT EXISTS "connection_status" text DEFAULT 'configured' NOT NULL;

DO $$ BEGIN
  ALTER TABLE "model_connections"
    ADD CONSTRAINT "model_connections_credential_ref_id_credential_refs_id_fk"
    FOREIGN KEY ("credential_ref_id") REFERENCES "public"."credential_refs"("id")
    ON DELETE set null ON UPDATE no action NOT VALID;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "system_credential_refs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "scope" text NOT NULL,
  "external_id" text NOT NULL,
  "label" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "system_credential_refs_external_key"
  ON "system_credential_refs" USING btree ("external_id");

CREATE TABLE IF NOT EXISTS "system_credential_secrets" (
  "external_id" text PRIMARY KEY NOT NULL,
  "sealed" text NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "system_model_providers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "slug" text NOT NULL,
  "display_name" text NOT NULL,
  "kind" "provider_kind" DEFAULT 'api' NOT NULL,
  "capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "enabled" text DEFAULT 'true' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "system_model_providers_slug_key"
  ON "system_model_providers" USING btree ("slug");

CREATE TABLE IF NOT EXISTS "system_models" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "provider_id" uuid NOT NULL,
  "slug" text NOT NULL,
  "display_name" text NOT NULL,
  "context_window" integer,
  "enabled" text DEFAULT 'true' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "system_models_provider_id_system_model_providers_id_fk"
    FOREIGN KEY ("provider_id") REFERENCES "public"."system_model_providers"("id") ON DELETE cascade ON UPDATE no action
);
CREATE UNIQUE INDEX IF NOT EXISTS "system_models_provider_slug_key"
  ON "system_models" USING btree ("provider_id", "slug");

CREATE TABLE IF NOT EXISTS "system_model_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "provider_id" uuid NOT NULL,
  "credential_ref_id" uuid,
  "auth_method" "provider_auth_method" DEFAULT 'api_key' NOT NULL,
  "connection_status" text DEFAULT 'configured' NOT NULL,
  "base_url" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "system_model_connections_provider_id_system_model_providers_id_fk"
    FOREIGN KEY ("provider_id") REFERENCES "public"."system_model_providers"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "system_model_connections_credential_ref_id_system_credential_refs_id_fk"
    FOREIGN KEY ("credential_ref_id") REFERENCES "public"."system_credential_refs"("id") ON DELETE set null ON UPDATE no action
);
CREATE UNIQUE INDEX IF NOT EXISTS "system_model_connections_provider_key"
  ON "system_model_connections" USING btree ("provider_id");
