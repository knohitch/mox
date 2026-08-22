ALTER TABLE "price_books"
  ADD COLUMN IF NOT EXISTS "base_amount_minor" bigint;

ALTER TABLE "billing_customers"
  ALTER COLUMN "provider_customer_id" DROP NOT NULL;

ALTER TABLE "subscriptions"
  ADD COLUMN IF NOT EXISTS "provider_name" text;
ALTER TABLE "subscriptions"
  ADD COLUMN IF NOT EXISTS "renewal_lease_until" timestamp with time zone;

ALTER TABLE "checkout_sessions"
  ADD COLUMN IF NOT EXISTS "provider_ref" text;
ALTER TABLE "checkout_sessions"
  ADD COLUMN IF NOT EXISTS "apply_lease_until" timestamp with time zone;

DROP INDEX IF EXISTS "subscriptions_org_active_key";
CREATE UNIQUE INDEX IF NOT EXISTS "subscriptions_org_live_key"
  ON "subscriptions" USING btree ("org_id")
  WHERE "state" IN ('trial', 'active', 'past_due', 'grace_period', 'suspended');

CREATE UNIQUE INDEX IF NOT EXISTS "subscriptions_provider_ref_key"
  ON "subscriptions" USING btree ("provider_name", "provider_ref")
  WHERE "provider_name" IS NOT NULL AND "provider_ref" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "subscriptions_renewal_lease_idx"
  ON "subscriptions" USING btree ("state", "renewal_lease_until");

CREATE UNIQUE INDEX IF NOT EXISTS "checkout_sessions_provider_ref_key"
  ON "checkout_sessions" USING btree ("provider_name", "provider_ref")
  WHERE "provider_ref" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "checkout_sessions_apply_lease_idx"
  ON "checkout_sessions" USING btree ("state", "apply_lease_until");
