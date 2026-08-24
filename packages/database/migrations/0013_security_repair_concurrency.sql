ALTER TYPE webhook_status ADD VALUE IF NOT EXISTS 'processing';

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS renewal_claim_owner text,
  ADD COLUMN IF NOT EXISTS renewal_claim_expires_at timestamptz;

CREATE INDEX IF NOT EXISTS subscriptions_renewal_claim_idx
  ON subscriptions (renewal_claim_expires_at);

ALTER TABLE checkout_sessions
  ADD COLUMN IF NOT EXISTS claim_owner text,
  ADD COLUMN IF NOT EXISTS claim_expires_at timestamptz;

CREATE INDEX IF NOT EXISTS checkout_sessions_claim_idx
  ON checkout_sessions (claim_expires_at);

ALTER TABLE verified_webhook_events
  ADD COLUMN IF NOT EXISTS processing_owner text,
  ADD COLUMN IF NOT EXISTS processing_expires_at timestamptz;

CREATE INDEX IF NOT EXISTS verified_webhook_events_processing_idx
  ON verified_webhook_events (status, processing_expires_at);

ALTER TABLE server_operations
  ADD COLUMN IF NOT EXISTS lease_owner text,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;

CREATE INDEX IF NOT EXISTS server_operations_lease_due_idx
  ON server_operations (state, next_attempt_at, lease_expires_at);

ALTER TABLE dispatched_messages
  ADD COLUMN IF NOT EXISTS dedupe_key text;

CREATE UNIQUE INDEX IF NOT EXISTS dispatched_messages_org_dedupe_key
  ON dispatched_messages (org_id, dedupe_key);

ALTER TABLE notification_jobs
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS claim_owner text,
  ADD COLUMN IF NOT EXISTS claim_expires_at timestamptz;

DROP INDEX IF EXISTS notification_jobs_idem_key;
CREATE UNIQUE INDEX IF NOT EXISTS notification_jobs_actor_idem_key
  ON notification_jobs (created_by, idempotency_key);

CREATE INDEX IF NOT EXISTS notification_jobs_claim_due_idx
  ON notification_jobs (status, scheduled_at, claim_expires_at);

CREATE TABLE IF NOT EXISTS auth_rate_limits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope text NOT NULL,
  bucket_key text NOT NULL,
  window_start timestamptz NOT NULL,
  count integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS auth_rate_limits_scope_bucket_key
  ON auth_rate_limits (scope, bucket_key);

CREATE INDEX IF NOT EXISTS auth_rate_limits_locked_idx
  ON auth_rate_limits (locked_until);

CREATE TABLE IF NOT EXISTS security_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  scope text NOT NULL,
  bucket_key text NOT NULL,
  request_ip text,
  user_agent text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS security_events_kind_at_idx
  ON security_events (kind, at);
