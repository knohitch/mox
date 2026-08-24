-- Security Repair 01: commercial authorization and billing provider identity.

ALTER TABLE "subscriptions"
  ADD COLUMN IF NOT EXISTS "provider_name" text;

ALTER TABLE "server_orders"
  ADD COLUMN IF NOT EXISTS "request_fingerprint" text;

-- Backfill provider_name only from unambiguous checkout ownership.
WITH candidates AS (
  SELECT
    s.id AS subscription_id,
    min(c.provider_name) AS provider_name,
    count(DISTINCT c.provider_name) AS provider_count
  FROM subscriptions s
  JOIN checkout_sessions c
    ON c.org_id = s.org_id
   AND (
      c.provider_ref = s.provider_ref
      OR c.id::text = regexp_replace(coalesce(s.provider_ref, ''), '^.*co_', '')
   )
  WHERE s.provider_name IS NULL
  GROUP BY s.id
)
UPDATE subscriptions s
SET provider_name = candidates.provider_name
FROM candidates
WHERE s.id = candidates.subscription_id
  AND candidates.provider_count = 1;

CREATE INDEX IF NOT EXISTS "subscriptions_provider_name_ref_idx"
  ON "subscriptions" USING btree ("provider_name", "provider_ref");
