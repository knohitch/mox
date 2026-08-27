-- Prompt 01: authentication, auth URLs and surface isolation.
--
-- ESTABLISHES a durable, server-authoritative platform-staff model SEPARATE
-- from customer organization memberships, plus durable one-use staff
-- invitations (invite-only Admin/Support signup) and password-reset tokens.
-- Only hashes of invite/reset tokens are ever stored; plaintext tokens are
-- shown once to authorized parties.
--
-- Forward-only and additive: nothing existing is dropped or rewritten.

-- Staff role enum (superset of the legacy config-driven roles).
DO $$
BEGIN
  CREATE TYPE "public"."staff_role" AS ENUM (
    'superadmin',
    'platform_admin',
    'support_manager',
    'support_agent'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END;
$$;

-- Durable platform-staff membership bound to a real user id. A customer
-- owner/admin org role NEVER grants these — authority is staff-only and
-- can be disabled/revoked independently.
CREATE TABLE IF NOT EXISTS "platform_staff_memberships" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "role" "public"."staff_role" NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "granted_by_user_id" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "revoked_at" timestamptz,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "platform_staff_memberships_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
    ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "platform_staff_memberships_granted_by_user_id_users_id_fk"
    FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."users"("id")
    ON DELETE set null ON UPDATE no action
);
CREATE UNIQUE INDEX IF NOT EXISTS "platform_staff_memberships_user_role_key"
  ON "platform_staff_memberships" USING btree ("user_id", "role");
CREATE INDEX IF NOT EXISTS "platform_staff_memberships_user_idx"
  ON "platform_staff_memberships" USING btree ("user_id");

-- Durable staff invitations for invite-only Admin and Support signup.
CREATE TABLE IF NOT EXISTS "staff_invitations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "token_hash" text NOT NULL,
  "email" text NOT NULL,
  "role" "public"."staff_role" NOT NULL,
  "surface" text NOT NULL,
  "created_by_user_id" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL,
  "consumed_at" timestamptz,
  "revoked_at" timestamptz,
  CONSTRAINT "staff_invitations_created_by_user_id_users_id_fk"
    FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id")
    ON DELETE set null ON UPDATE no action
);
CREATE UNIQUE INDEX IF NOT EXISTS "staff_invitations_token_hash_key"
  ON "staff_invitations" USING btree ("token_hash");
CREATE INDEX IF NOT EXISTS "staff_invitations_email_idx"
  ON "staff_invitations" USING btree ("email");

-- Durable one-use password-reset tokens. Hash storage + expiry + consume.
CREATE TABLE IF NOT EXISTS "password_resets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "token_hash" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "consumed_at" timestamptz,
  CONSTRAINT "password_resets_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
    ON DELETE cascade ON UPDATE no action
);
CREATE UNIQUE INDEX IF NOT EXISTS "password_resets_token_hash_key"
  ON "password_resets" USING btree ("token_hash");
CREATE INDEX IF NOT EXISTS "password_resets_user_idx"
  ON "password_resets" USING btree ("user_id");
