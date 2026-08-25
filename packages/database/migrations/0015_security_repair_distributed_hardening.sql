-- Security Repair 05B: distributed-systems hardening.
--
-- A. Lease fencing: every post-claim writeback must prove it still owns the
--    claim (lease_owner + monotonically increasing lease_version). A stale
--    worker whose lease was stolen updates zero rows and stops.
-- B. Atomic server quota: a per-org serialization row makes quota-check +
--    order-reservation one serialized PostgreSQL decision across replicas.
-- G/K. Notification dispatch outbox states (pending/sending/sent/failed/
--    uncertain) with bounded attempts — crash between transport send and
--    durable record no longer silently loses or blindly duplicates.
-- I. Cluster-wide SSE admission: bounded PostgreSQL lease/counter design
--    (no Redis dependency); crash leaves only expiring lease state, swept
--    by the lifecycle ticker.
-- A. Billing renewal writeback fencing (renewal_claim_version) so a stale
--    renewal worker cannot regress a stolen-lease period write.

-- ---- A: compute operation lease fencing ---------------------------------------

ALTER TABLE server_operations
  ADD COLUMN IF NOT EXISTS lease_version bigint NOT NULL DEFAULT 0;

-- ---- B: atomic server quota serialization -------------------------------------

CREATE TABLE IF NOT EXISTS org_compute_allocations (
  org_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---- A: billing renewal writeback fencing --------------------------------------

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS renewal_claim_version bigint NOT NULL DEFAULT 0;

-- ---- A: notification job claim fencing -----------------------------------------

ALTER TABLE notification_jobs
  ADD COLUMN IF NOT EXISTS claim_version bigint NOT NULL DEFAULT 0;

-- ---- K: dispatch outbox states --------------------------------------------------

ALTER TABLE dispatched_messages
  ADD COLUMN IF NOT EXISTS delivery_state text NOT NULL DEFAULT 'sent',
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS last_error text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS dispatched_messages_state_idx
  ON dispatched_messages (delivery_state, updated_at);

-- ---- F: platform-admin target-org audit completeness ----------------------------

-- Platform-level admin actions have NO tenant target; the admin's own org
-- must never stand in for the affected tenant. Tenant-targeted actions now
-- always pass the resolved target org explicitly.
ALTER TABLE audit_events ALTER COLUMN org_id DROP NOT NULL;

-- ---- I: cluster-wide SSE admission (PG lease/counter, no Redis) ------------------

CREATE TABLE IF NOT EXISTS sse_admission_state (
  scope text NOT NULL,
  scope_key text NOT NULL,
  active integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, scope_key)
);

CREATE TABLE IF NOT EXISTS sse_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL,
  scope text NOT NULL,
  scope_key text NOT NULL,
  owner text,
  lease_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sse_connections_lease_idx
  ON sse_connections (lease_expires_at);

CREATE INDEX IF NOT EXISTS sse_connections_conn_idx
  ON sse_connections (connection_id);
