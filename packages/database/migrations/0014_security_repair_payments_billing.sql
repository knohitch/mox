-- Security Repair 05A: payments, billing, webhook, lifecycle, crash
-- consistency and provider-state correctness.
--
-- Adds:
--   * durable typed provider-object mappings (Stripe charge/pi/invoice/sub
--     resolution without ID-prefix guessing);
--   * durable business-effect idempotency (one provider invoice/sale creates
--     exactly one local period-extension effect);
--   * checkout 'applying' state for crash-replayable local application;
--   * suspension reason/source + reconciliation flags;
--   * durable cancellation progress (cancel_requested /
--     provider_cancel_pending / canceled / reconciliation_required);
--   * commercial-ineligibility reconciliation queue (compute shutdown is
--     never performed synchronously inside a webhook handler);
--   * rejected-webhook retention index (cleanup job deletes short-TTL junk;
--     applied financial history is never purged);
--   * unambiguous-only backfill of provider-object mappings; ambiguous
--     legacy rows become reconciliation_required rows, never guesses.

-- ---- State-machine values -----------------------------------------------------

ALTER TYPE checkout_state ADD VALUE IF NOT EXISTS 'applying';

ALTER TYPE webhook_status ADD VALUE IF NOT EXISTS 'duplicate';
ALTER TYPE webhook_status ADD VALUE IF NOT EXISTS 'stale_ignored';
ALTER TYPE webhook_status ADD VALUE IF NOT EXISTS 'reconciliation_required';

-- ---- Provider-object mappings (finding A) --------------------------------------

CREATE TABLE IF NOT EXISTS provider_object_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_name text NOT NULL,
  environment text NOT NULL DEFAULT 'test',
  org_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  subscription_id uuid REFERENCES subscriptions(id) ON DELETE SET NULL,
  provider_customer_ref text,
  checkout_session_ref text,
  provider_subscription_ref text,
  provider_invoice_ref text,
  provider_payment_ref text,
  provider_payment_intent_ref text,
  provider_charge_ref text,
  resolution_state text NOT NULL DEFAULT 'resolved',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One row per typed provider object. A customer may own many subscriptions,
-- so provider_customer_ref is intentionally NOT unique.
CREATE UNIQUE INDEX IF NOT EXISTS provider_object_mappings_checkout_key
  ON provider_object_mappings (provider_name, environment, checkout_session_ref)
  WHERE checkout_session_ref IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS provider_object_mappings_subscription_key
  ON provider_object_mappings (provider_name, environment, provider_subscription_ref)
  WHERE provider_subscription_ref IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS provider_object_mappings_invoice_key
  ON provider_object_mappings (provider_name, environment, provider_invoice_ref)
  WHERE provider_invoice_ref IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS provider_object_mappings_payment_key
  ON provider_object_mappings (provider_name, environment, provider_payment_ref)
  WHERE provider_payment_ref IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS provider_object_mappings_pi_key
  ON provider_object_mappings (provider_name, environment, provider_payment_intent_ref)
  WHERE provider_payment_intent_ref IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS provider_object_mappings_charge_key
  ON provider_object_mappings (provider_name, environment, provider_charge_ref)
  WHERE provider_charge_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS provider_object_mappings_sub_idx
  ON provider_object_mappings (subscription_id);

-- ---- Business-effect idempotency (finding B) -----------------------------------

CREATE TABLE IF NOT EXISTS provider_billing_effects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_name text NOT NULL,
  environment text NOT NULL DEFAULT 'test',
  billing_identity text NOT NULL,
  effect_type text NOT NULL,
  subscription_id uuid REFERENCES subscriptions(id) ON DELETE SET NULL,
  outcome text NOT NULL DEFAULT 'applied',
  external_event_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS provider_billing_effects_identity_key
  ON provider_billing_effects (provider_name, environment, billing_identity, effect_type);

CREATE INDEX IF NOT EXISTS provider_billing_effects_sub_idx
  ON provider_billing_effects (subscription_id, created_at);

-- ---- Subscriptions: suspension + reconciliation state (findings I/F) ------------

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS suspension_reason text,
  ADD COLUMN IF NOT EXISTS suspension_source text,
  ADD COLUMN IF NOT EXISTS reconciliation_required boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS provider_plan_ref text;

CREATE INDEX IF NOT EXISTS subscriptions_reconciliation_idx
  ON subscriptions (reconciliation_required);

-- ---- Durable cancellation progress (finding H) ----------------------------------

CREATE TABLE IF NOT EXISTS subscription_cancellations (
  subscription_id uuid PRIMARY KEY REFERENCES subscriptions(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'cancel_requested',
  requested_by text NOT NULL DEFAULT 'user',
  requested_by_id text,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  next_attempt_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS subscription_cancellations_due_idx
  ON subscription_cancellations (state, next_attempt_at);

-- ---- Commercial-ineligibility reconciliation queue (finding A) -------------------

CREATE TABLE IF NOT EXISTS commercial_reconciliation_queue (
  subscription_id uuid PRIMARY KEY REFERENCES subscriptions(id) ON DELETE CASCADE,
  reason text NOT NULL,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS commercial_reconciliation_queue_due_idx
  ON commercial_reconciliation_queue (enqueued_at);

-- ---- Invoice identity + item idempotency (findings B/E) --------------------------

CREATE UNIQUE INDEX IF NOT EXISTS invoices_provider_ref_key
  ON invoices (provider_invoice_ref)
  WHERE provider_invoice_ref IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS subscription_items_base_key
  ON subscription_items (subscription_id)
  WHERE kind = 'base';

-- ---- Ledger enrichment (findings A/B/F) -----------------------------------------

ALTER TABLE provider_payments
  ADD COLUMN IF NOT EXISTS provider_payment_intent_ref text,
  ADD COLUMN IF NOT EXISTS provider_charge_ref text,
  ADD COLUMN IF NOT EXISTS provider_customer_ref text,
  ADD COLUMN IF NOT EXISTS billing_identity text;

CREATE INDEX IF NOT EXISTS provider_payments_billing_identity_idx
  ON provider_payments (provider_name, environment, billing_identity);

-- ---- Rejected-webhook retention index (finding G) -------------------------------

CREATE INDEX IF NOT EXISTS verified_webhook_events_status_received_idx
  ON verified_webhook_events (status, received_at);

-- ---- Backfill: unambiguous provider-object mappings only -------------------------

-- Anchor rows on subscriptions that carry provider identity + ref.
INSERT INTO provider_object_mappings
  (provider_name, environment, org_id, subscription_id, provider_subscription_ref, resolution_state)
SELECT s.provider_name,
       COALESCE(s.provider_environment, 'test'),
       s.org_id,
       s.id,
       s.provider_ref,
       'resolved'
FROM subscriptions s
WHERE s.provider_name IS NOT NULL
  AND s.provider_ref IS NOT NULL
ON CONFLICT DO NOTHING;

-- Merge checkout sessions onto the same (provider, environment, org) row.
UPDATE provider_object_mappings m
SET checkout_session_ref = c.provider_ref,
    updated_at = now()
FROM checkout_sessions c
WHERE c.provider_name = m.provider_name
  AND COALESCE(c.environment, 'test') = m.environment
  AND c.org_id = m.org_id
  AND c.provider_ref IS NOT NULL
  AND m.checkout_session_ref IS NULL
  AND m.resolution_state = 'resolved';

-- Checkout sessions with no row yet (unambiguous by unique ref).
INSERT INTO provider_object_mappings
  (provider_name, environment, org_id, checkout_session_ref, resolution_state)
SELECT c.provider_name,
       COALESCE(c.environment, 'test'),
       c.org_id,
       c.provider_ref,
       'resolved'
FROM checkout_sessions c
WHERE c.provider_ref IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM provider_object_mappings m
    WHERE m.provider_name = c.provider_name
      AND m.environment = COALESCE(c.environment, 'test')
      AND m.checkout_session_ref = c.provider_ref
  );

-- Ambiguity: a checkout ref that equals a subscription ref of a DIFFERENT
-- org (PayPal-style shared ids) can never be guessed — record it as
-- reconciliation-required.
INSERT INTO provider_object_mappings
  (provider_name, environment, org_id, checkout_session_ref, resolution_state)
SELECT DISTINCT c.provider_name,
       COALESCE(c.environment, 'test'),
       c.org_id,
       c.provider_ref,
       'reconciliation_required'
FROM checkout_sessions c
JOIN subscriptions s
  ON s.provider_ref = c.provider_ref
 AND s.provider_name = c.provider_name
 AND s.org_id <> c.org_id
WHERE c.provider_ref IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM provider_object_mappings m
    WHERE m.provider_name = c.provider_name
      AND m.environment = COALESCE(c.environment, 'test')
      AND m.checkout_session_ref = c.provider_ref
  );
