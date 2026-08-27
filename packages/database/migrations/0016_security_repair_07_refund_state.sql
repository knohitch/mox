-- Security Repair 07 §B — durable monotonic cumulative refund authority.
-- Forward-only: preserves existing billing/payment rows. Historical refund
-- effect rows cannot be safely backfilled because they did not store the
-- cumulative amount; the next verified provider refund establishes the max.

CREATE TABLE IF NOT EXISTS provider_refund_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_name text NOT NULL,
  environment text NOT NULL DEFAULT 'test',
  billing_identity text NOT NULL,
  subscription_id uuid REFERENCES subscriptions(id) ON DELETE SET NULL,
  cumulative_amount_minor bigint NOT NULL CHECK (cumulative_amount_minor >= 0),
  external_event_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS provider_refund_states_identity_key
  ON provider_refund_states (provider_name, environment, billing_identity);

CREATE INDEX IF NOT EXISTS provider_refund_states_sub_idx
  ON provider_refund_states (subscription_id, updated_at);
