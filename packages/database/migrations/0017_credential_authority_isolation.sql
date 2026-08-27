-- Credential authority isolation (retained-branch rescue).
--
-- ESTABLISHES the hard boundary between customer-owned credential state
-- (organization scoped) and Mox-owned platform credential state (no
-- organization namespace). Forward-only and additive: nothing is dropped,
-- and legacy org-scoped rows are preserved (never silently deleted, never
-- guessed to be platform-owned) while a reconciliation requirement is
-- surfaced via NOTICE.

DO $$
BEGIN
  CREATE TYPE "public"."provider_auth_method" AS ENUM ('api_key', 'oauth', 'device_login', 'none');
EXCEPTION
  WHEN duplicate_object THEN null;
END;
$$;

-- Customer credential secrets: addressed only by (org_id, external_id).
CREATE TABLE IF NOT EXISTS "customer_credential_secrets" (
  "org_id" uuid NOT NULL,
  "external_id" text NOT NULL,
  "sealed" text NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "customer_credential_secrets_org_id_organizations_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id")
    ON DELETE cascade ON UPDATE no action
);
CREATE UNIQUE INDEX IF NOT EXISTS "customer_credential_secrets_key"
  ON "customer_credential_secrets" USING btree ("org_id", "external_id");

-- Provider auth method + connection status on the customer connection table.
ALTER TABLE "model_connections"
  ADD COLUMN IF NOT EXISTS "auth_method" "public"."provider_auth_method" DEFAULT 'api_key' NOT NULL;
ALTER TABLE "model_connections"
  ADD COLUMN IF NOT EXISTS "connection_status" text DEFAULT 'configured' NOT NULL;

DO $$
BEGIN
  ALTER TABLE "model_connections"
    ADD CONSTRAINT "model_connections_credential_ref_id_credential_refs_id_fk"
    FOREIGN KEY ("credential_ref_id") REFERENCES "public"."credential_refs"("id")
    ON DELETE set null ON UPDATE no action NOT VALID;
EXCEPTION
  WHEN duplicate_object THEN null;
END;
$$;

-- Mox-owned credential metadata. No organization id anywhere in this table.
CREATE TABLE IF NOT EXISTS "system_credential_refs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "scope" text NOT NULL,
  "external_id" text NOT NULL,
  "label" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "system_credential_refs_external_key"
  ON "system_credential_refs" USING btree ("external_id");

-- Encrypted Mox-owned secret payloads, isolated from all customer rows.
CREATE TABLE IF NOT EXISTS "system_credential_secrets" (
  "external_id" text PRIMARY KEY NOT NULL,
  "sealed" text NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

-- Mox-managed intelligence/provider catalog (platform state, customer-less).
CREATE TABLE IF NOT EXISTS "system_model_providers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "slug" text NOT NULL,
  "display_name" text NOT NULL,
  "kind" "public"."provider_kind" DEFAULT 'api' NOT NULL,
  "capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "system_model_providers_slug_key"
  ON "system_model_providers" USING btree ("slug");

CREATE TABLE IF NOT EXISTS "system_models" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "provider_id" uuid NOT NULL,
  "slug" text NOT NULL,
  "display_name" text NOT NULL,
  "context_window" integer,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "system_models_provider_id_system_model_providers_id_fk"
    FOREIGN KEY ("provider_id") REFERENCES "public"."system_model_providers"("id")
    ON DELETE cascade ON UPDATE no action
);
CREATE UNIQUE INDEX IF NOT EXISTS "system_models_provider_slug_key"
  ON "system_models" USING btree ("provider_id", "slug");

CREATE TABLE IF NOT EXISTS "system_model_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "provider_id" uuid NOT NULL,
  "credential_ref_id" uuid,
  "auth_method" "public"."provider_auth_method" DEFAULT 'api_key' NOT NULL,
  "connection_status" text DEFAULT 'configured' NOT NULL,
  "base_url" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "system_model_connections_provider_id_system_model_providers_id_fk"
    FOREIGN KEY ("provider_id") REFERENCES "public"."system_model_providers"("id")
    ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "system_model_connections_credential_ref_id_system_credential_refs_id_fk"
    FOREIGN KEY ("credential_ref_id") REFERENCES "public"."system_credential_refs"("id")
    ON DELETE set null ON UPDATE no action
);
CREATE UNIQUE INDEX IF NOT EXISTS "system_model_connections_provider_key"
  ON "system_model_connections" USING btree ("provider_id");

-- Legacy org-scoped system-like credential references are preserved, never
-- guessed at. Ownership cannot be inferred from an org-scoped row, so a
-- reconciliation requirement is surfaced instead of a silent migration.
DO $$
DECLARE
  legacy_count bigint;
BEGIN
  SELECT count(*) INTO legacy_count
  FROM "public"."credential_refs"
  WHERE "scope" = 'mox_system_model_provider';
  IF legacy_count > 0 THEN
    RAISE NOTICE '[0017] % credential_refs row(s) use scope=mox_system_model_provider in customer authority tables; preserved as-is. Reconciliation required before deletion: ownership (admin active/home org) cannot be proven. Platform intelligence configuration now lives in system_credential_refs. New rows must NOT be created in the customer tables.',
      legacy_count;
  END IF;
END;
$$;