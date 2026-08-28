-- Phase 04: Customer Extended Capability Parity (§D Team / Workspace Members).
--
-- ESTABLISHES durable customer workspace invitations strictly separated from
-- platform staff invitations. Token hashes are stored at rest; plaintext
-- invite tokens are shown only once at creation time.
--
-- Forward-only and additive: nothing existing is dropped or rewritten.

CREATE TABLE IF NOT EXISTS "workspace_invitations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "email" text NOT NULL,
  "role" "public"."membership_role" DEFAULT 'member' NOT NULL,
  "token_hash" text NOT NULL,
  "invited_by_user_id" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL,
  "accepted_at" timestamptz,
  "revoked_at" timestamptz,
  CONSTRAINT "workspace_invitations_org_id_organizations_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id")
    ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "workspace_invitations_invited_by_user_id_users_id_fk"
    FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id")
    ON DELETE set null ON UPDATE no action
);
CREATE UNIQUE INDEX IF NOT EXISTS "workspace_invitations_token_hash_key"
  ON "workspace_invitations" USING btree ("token_hash");
CREATE INDEX IF NOT EXISTS "workspace_invitations_org_idx"
  ON "workspace_invitations" USING btree ("org_id");
CREATE INDEX IF NOT EXISTS "workspace_invitations_email_idx"
  ON "workspace_invitations" USING btree ("email");
