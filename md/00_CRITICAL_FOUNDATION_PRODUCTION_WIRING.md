# Repair Prompt 00 — Critical foundation, production wiring, persistence and Mox Node security

**Reasoning: Ultra**

## Goal
Replace the demo/in-memory production spine with real Mox production wiring and fix the confirmed database + Mox Node security defects before integrating real money flows.

### A. Replace DemoMoxApi in production
Current audited behavior has `apps/web/src/api/store.tsx` constructing `DemoMoxApi`.

Implement a real authenticated HTTP client behind the existing `MoxApi` interface.

Requirements:
- production web uses the real API client;
- demo API is explicit dev/test only;
- no automatic production fallback to demo/local state;
- backend unavailability shows an honest error;
- authenticated server state supplies user/org identity, not hard-coded `org_demo`;
- API URL is validated configuration;
- auth/session handling is secure;
- realtime uses a Mox abstraction.

Create/finish the runnable Mox Control Plane HTTP API and wire current screens to authoritative services for:
- current user/org/session
- agents
- rooms/threads
- servers
- deployments
- models/connections
- integrations
- channels
- usage
- billing/subscription
- settings

### B. Production composition root
Create one explicit production bootstrap/composition path.

Production must not silently instantiate authoritative `InMemory*` stores. Search repository-wide for `new InMemory` and classify every occurrence:
- tests/dev only
- non-authoritative ephemeral
- production bug requiring replacement

Missing durable dependencies such as `DATABASE_URL` must fail startup clearly rather than running a fake system.

PostgreSQL is business truth. Redis is queues/cache/locks/rate limits/ephemeral state only.

### C. PostgreSQL stores
Implement and production-wire at minimum:

**PgBillingStore**
- products
- plan versions
- pricing regions
- price books/versions
- addons
- customers
- subscriptions
- subscription items
- transitions
- checkout sessions
- invoices
- webhook records

**PgOrchestratorStore**
- compute classes
- provider accounts
- SSH public-key metadata
- server orders
- operation/idempotency state
- node state
- enrollment token/nonce state

**PgNotificationStore**
- ensure current notification records survive restart; Prompt 02 finishes user/admin semantics.

No authoritative plan/entitlement configuration may live only in a process `Map`.

### D. Fix billing schema/service mismatches
Inspect service types against Drizzle schema field-by-field.

Fix:
1. **Subscription history** — current audited uniqueness effectively blocks more than one subscription row per org. Preserve historical subscriptions and allow cancel → later resubscribe. Use a safe partial-current uniqueness design or explicit current-subscription relationship.
2. **Checkout provider reference** — persist the provider-side checkout/session/order reference.
3. **FX/base pricing** — make durable schema and service fields agree, using safe money representation.
4. **Plan entitlement values** — remove process-memory authority; persist/read from durable entitlement schema.
5. **Money** — no floating-point currency amounts.
6. Add clean-DB and upgrade migrations without deleting legitimate history.

### E. Fix first-time Mox Node enrollment
Current audited flaw: provisioning creates a token, but first enrollment does not validate it against a pre-persisted expected token.

Implement:
1. cryptographically strong bootstrap secret;
2. persist only expected hash **before** provisioning/cloud-init;
3. bind to exact org + server order + provider instance when known;
4. expiry + unused/consumed state;
5. plaintext token exists only in bootstrap payload;
6. first enrollment loads expected record, validates org/order, expiry, constant-time hash comparison, and atomically consumes it;
7. wrong/replayed/already-consumed tokens fail;
8. issue a durable node identity after success;
9. subsequent heartbeat uses durable node auth, not bootstrap token;
10. audit without logging secrets;
11. concurrency test proves two simultaneous enrollments cannot both succeed.

### F. Remove hard-coded control-plane URL
Replace the hard-coded Mox internal URL in provisioning with validated deployment configuration. Require HTTPS in production, permit test override, and pass resolved enrollment/control-plane endpoint into cloud-init.

### G. Restart/idempotency tests
Prove:
- billing survives restart;
- pending VPS operation survives restart;
- node expected-token state survives restart;
- notification survives restart;
- duplicate operation/webhook remains deduped after restart;
- browser refresh does not reset customer state;
- production web cannot silently fall back to demo.

## Acceptance criteria
Do not claim completion unless:
- production web no longer constructs `DemoMoxApi`;
- real authenticated API path is wired;
- production fails closed when durable dependencies are absent;
- billing/compute/notifications use Postgres in production;
- subscription history/resubscribe works;
- checkout provider refs persist;
- FX pricing fields agree;
- plan entitlement values are durable;
- first Mox Node enrollment validates a pre-stored expiring single-use token atomically;
- hard-coded control-plane URL is gone;
- restart/idempotency tests pass.
