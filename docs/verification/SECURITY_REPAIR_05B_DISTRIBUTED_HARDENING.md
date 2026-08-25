# Security Repair 05B: Distributed-Systems Hardening

Date: 2026-08-25

## Repository State

- Base SHA before repair: `dd0f731226d33fdbe220443778ab69111700fb1b`
  (this includes the committed Security Repair 05A work).
- New SHA: not created. Per the no-push/stop instruction this repair is a
  working-tree change on the same base SHA.
- Pre-existing unrelated worktree changes (deleted `md/*` run-order files)
  were present before this repair and were not modified.
- Prior repair reports present:
  - `docs/verification/SECURITY_REPAIR_01_BILLING.md`
  - `docs/verification/SECURITY_REPAIR_02_AUTHORIZATION.md`
  - `docs/verification/SECURITY_REPAIR_03_RUNTIME_NODE.md`
  - `docs/verification/SECURITY_REPAIR_04_CONCURRENCY.md`
  - `docs/verification/SECURITY_REPAIR_05A_PAYMENTS_BILLING.md`

## Scope

Repair the remaining independently confirmed distributed-systems, quota,
gateway-secret, SSRF, abuse-control, audit and runtime-sanitization
findings (A–L) without redesigning working subsystems. All controls closed
by Repairs 01–04 and 05A remain intact: org RBAC, PAT scope intersection,
platform-admin role/capability model, commercial entitlement gate,
server-order idempotency, node enrollment binding, durable approval
authority, raw-body webhook verification, provider-object/business-effect
dedupe, CSRF/CORS/session protections, secret hashing/vault references.

## Migrations

Added `packages/database/migrations/0015_security_repair_distributed_hardening.sql`:

- `server_operations.lease_version BIGINT NOT NULL DEFAULT 0` — fencing
  token for compute operation claims (finding A).
- `org_compute_allocations` — per-org row used ONLY as the PostgreSQL
  serialization point for quota-check + order-reservation transactions
  (finding B).
- `subscriptions.renewal_claim_version BIGINT NOT NULL DEFAULT 0` — fencing
  token for billing renewal claims (finding A).
- `notification_jobs.claim_version BIGINT NOT NULL DEFAULT 0` — fencing
  token for notification job claims (finding A).
- `dispatched_messages.delivery_state/attempts/last_error/updated_at` +
  index — durable dispatch outbox (finding K).
- `sse_admission_state` + `sse_connections` — cluster-wide SSE admission
  counters and expiring leases (finding I). No Redis was introduced.
- `audit_events.org_id` becomes nullable — platform-level admin actions
  record NULL instead of defaulting to the admin's own org (finding F).

Fresh-schema apply and the pre-0006 → current upgrade drill both pass (see
Verification). Historical rows are preserved; the only DDL that touches
existing data is the audit `org_id` NOT NULL drop, which only widens what
can be stored.

## Lease-Fencing Model (finding A)

Every durable claim now carries a monotonically increasing fencing token
(`lease_version` / `renewal_claim_version` / `claim_version`) set at claim
time. Post-claim writebacks are compare-and-set:

- compute: `updateOperationFenced(op, claimedVersion)` updates only when
  `id` + `state='running'` + `lease_owner=workerId` +
  `lease_version=claimedVersion` all match. Zero rows ⇒ the worker lost
  authority: no order-state write, no stale business event, safe stop.
- billing: `completeSubscriptionRenewal(sub, claimedVersion)` fences BOTH
  the success and failure renewal writebacks; a stale worker cannot regress
  a reclaimer's period advancement or transition state.
- notifications: `updateJobFenced(job, claimedVersion)` fences the terminal
  job writebacks (completed/failed); per-recipient fan-out cursors remain
  dedupe-keyed and converge-safe.
- The claim identity is matched from the writeback ARGUMENT and released in
  the SET payload, so the predicate always sees the claim as it was held.
- The compute reconciler was restructured so that order-state effects are
  emitted ONLY after the fenced operation writeback succeeds, and
  enrollment-token revocation on provision failure is gated on still
  owning the claim (a stale worker can never revoke a reclaimer's token).

Mandatory PostgreSQL race tests (two real PG-backed instances): worker A
claims, lease expires, worker B reclaims and succeeds, A's stale failure
writeback affects zero rows, the operation remains succeeded and the order
remains running — repeated for provision/cancel/reboot, plus the billing
renewal and notification-finalizer equivalents.

## Atomic Quota Model (finding B)

`POST /api/servers/orders` quota enforcement is now ONE serialized
PostgreSQL transaction (`org_compute_allocations` row lock):

1. upsert + `SELECT … FOR UPDATE` the per-org allocation row (all order
   creation for that org queues on this lock, across replicas);
2. same-key idempotency check INSIDE the lock (fingerprint conflicts
   throw);
3. count actual non-terminal orders (`requested/provisioning/running/
   resizing/stopping/stopped/cancelling`);
4. if the count reached the entitlement server-count quota → abort with
   `QuotaExceededError` (HTTP 402 `server_quota_exceeded`) — an over-quota
   order is NEVER inserted for later cleanup;
5. otherwise the order + its provision operation commit together.

Capacity derives from real order state, so cancellation/destruction/pro-
visioning failure (order → error) release capacity automatically — the
documented lifecycle. The HTTP fast-path rejection remains as UX only; the
atomic reservation is authoritative. Tests: quota=1 + two distinct
concurrent keys ⇒ exactly one order (PG, two instances); quota=2 + three
concurrent ⇒ exactly two; same-key replay ⇒ one order.

## Gateway-Secret / Replay Model (finding C)

The public hardcoded fallback `mox-local-gateway-token-secret-for-tests`
is REMOVED from production behavior:

- `gatewayTokenSecretFromEnv()` throws when
  `MOX_GATEWAY_TOKEN_SECRET` is missing, equals the legacy public value,
  is shorter than 32 characters, or lacks 3 of 4 character classes.
- `mintGatewayToken` fails closed without a strong secret (startup
  configuration failure / computer capability not_configured);
  `verifyGatewayToken` returns `{ok:false, reason:"gateway secret not
  configured"}`.
- `ComputerGateway` requires the secret at construction
  (`gatewaySecret` option or env) — no gateway can be composed silently.
- Explicitly injected test secrets pass the same strength policy; all
  test fixtures were migrated to a deterministic strong key.
- Replay semantics (documented): tokens are INTENTIONALLY reusable for
  their short TTL and are bound to exact org/agent/session (plus optional
  serverId/scopes/allowedActions); the gateway rejects cross-session use.
  The `seenJti`/`consumeReplay` hook stays OPTIONAL and makes no replay
  claim when the caller does not supply it — there is no false assurance.

## SSRF Connection-Pinning Model (finding D)

`safeOutboundFetch` now eliminates the DNS-rebinding TOCTOU on its default
path: DNS is resolved ONCE per request attempt, EVERY returned IP is
validated against the private/link-local/metadata blocklist, and the actual
connection (node:http/https) is pinned to exactly those addresses through a
custom `lookup` that never re-resolves. `servername` keeps the original
hostname for TLS SNI + certificate validation — TLS verification is never
disabled. Every redirect hop gets a fresh resolve→validate→pin cycle, and
auth/cookie headers are stripped across host changes. Timeout and body-size
caps are preserved. The injected `fetchImpl` option remains a documented
TEST seam only (production callers pass nothing and get the pinned path).
Tests simulate: first resolution public, later "default DNS" private — the
pinned lookup still serves only the validated address and never re-resolves;
private resolutions are refused before any connection; per-hop
re-validation is proven. Computer/browser `navigate` remains fail-closed
(egress policy + the control plane's explicit `not_configured` computer
surface): real browser networking cannot enforce resolved-IP egress safety,
so no production wiring claims it (finding L).

## Sanitization Changes (finding E)

- `packages/security`: `scrubLogLine` now also redacts `password=hunter2`-style
  assignments, `token/secret/api_key: …` values, GitLab (`glpat-`), Google
  (`AIza…`), npm (`npm_…`), Slack (`xox*`), GitHub PAT
  (`ghp_/github_pat_`), Stripe live keys (`sk_/rk_/pk_live_`, `whsec_`),
  cookie headers, and long mixed-case base64-like secrets (≥40 chars with
  separators). Card redaction now uses digit-boundary lookarounds so
  benign UUIDs/ids are never corrupted (regression-tested).
- `StdioRuntimeTransport`: the stderr tail embedded in exit errors and
  `stderrTailText()` is scrubbed; a structured `crashDiagnostic()` returns
  component/operation/exit code/correlation id/bounded sanitized diagnostic
  plus a transient SHA-256 of the raw tail. Raw stderr is never persisted
  or returned.
- `ComputerGateway` audit metadata (`takenBy`, `reason`, crash text) is
  scrubbed via `redactMetadata` before it reaches the audit sink.
- `runtime/mox-node` docker stderr scrubbing was already canonical.

## Admin-Audit Changes (finding F)

`appendAdminAudit` no longer defaults the target org to the admin's
active/home org: tenant-targeted actions pass the resolved target org, and
platform-level actions record NULL (`audit_events.org_id` is now
nullable). Fixed call sites: compute order actions (order's org), runtime
agent actions (order's org), customer lifecycle (already correct),
support notes (already correct). Notification send/schedule now audit with
the audience's org when the audience names one. Dedicated tests prove the
compute-order and runtime-agent audit rows carry the AFFECTED org while the
actor is the admin, with the admin's home org differing.

## Rate-Limit / SSE Architecture (findings H/I)

Rate limiting (H): the durable PostgreSQL limiter already serializes
bucket creation/update atomically; a concurrent-first-creation race test
proves two simultaneous checks on a fresh key yield exactly one allowed
call. `clientIp` normalizes IPv4-mapped IPv6 addresses and honors ONLY
configured trusted proxies for `X-Forwarded-For`. Real HTTP 429 tests
prove the login rate check fires before credential hashing and behaves
identically for known and unknown accounts; locks are window-bounded
(account 15 min, IP 5 min) — no permanent lockout. Password hashing is
untouched.

SSE (I): admission moved from process-local maps to cluster-wide
PostgreSQL leases/counters (`ClusterSseAdmission`): per-user, per-IP and
global caps with row-locked counter updates; each admission writes one
expiring lease row per scope; the stream's ping loop heartbeats the lease;
close deletes the leases; the lifecycle ticker sweeps expired leases so a
process crash leaks nothing beyond the lease TTL. PAT scopes and URL-token
prohibition are unchanged. Two-instance tests: the 6th stream on instance B
is denied after 5 on instance A; a released stream re-opens on the other
instance; a crashed lease is reclaimed by the sweep.

## Server-Operation State-Machine Changes (finding J)

- `cancelOrder` is an idempotent no-op in `canceled`/`destroyed`/
  `retention`; terminal operations are never re-enqueued.
- An abandoned cancel leaves the order in a VISIBLE reconciliable state
  (`error` with `lastError: cancel abandoned: …`) instead of indefinite
  `cancelling`.
- Rebooting uses REQUEST identities (`{orderId}:reboot:{requestId}`):
  replaying the same request returns the canonical operation; a new
  request creates a new operation — reboots remain repeatable for the
  server lifetime. `enqueue` now returns the canonical durable row so
  replays observe the original operation id.

## Notification-Dispatch Semantics (finding K)

Durable dispatch outbox: `recordDispatchPrepared` writes `sending` BEFORE
the transport call; success → `sent`; failure on an idempotent transport →
`pending` (retry eligible, ≤3 attempts) or `failed` (final) otherwise. The
sweep moves stale `sending` rows (crash between send and durable record)
to `uncertain` — visible, never silently resent. `RouteTransport` gained an
`idempotent` flag; retries are attempted only for transports that guarantee
provider-side deduplication (the dispatch `dedupeKey` is passed for that
purpose). Mox never claims exactly-once where the downstream provider
cannot guarantee it: non-idempotent routes stay at-least-once with explicit
`failed`/`uncertain` observability.

## Verification

Passed:

- `pnpm lint` — exit 0 (16 warnings, all pre-existing).
- `pnpm typecheck` — exit 0.
- Focused suites: `@mox/compute-orchestrator` (28 tests incl. the new 05B
  file), `@mox/billing` (67), `@mox/notification-service` (13),
  `@mox/security` (35), `@mox/computer-runtime` (35), `@mox/agent-runtime`
  (25), `@mox/runtime-client` (16 incl. stdio sanitization),
  `@mox/platform-ops`.
- `pnpm test` — 60 files passed, 2 skipped (PG-gated), 495 tests passed,
  61 skipped, exit 0.
- `powershell -ExecutionPolicy Bypass -File scripts\run-postgres-verification.ps1`
  — exit 0: fresh disposable cluster, migrations `0000`–`0015` applied
  cleanly, PG-gated suites (restart + auth-integration +
  security-repair-05b) 71/71, upgrade drill PASS (legacy rows preserved).
- `pnpm build` — exit 0.
- `pnpm public-branding-scan` — clean.
- `pnpm secret-scan` — clean.
- `pnpm scan:authority` — clean.
- `pnpm dependency-security` — exit 0 (`--audit-level high`; one
  pre-existing moderate advisory remains, unchanged since Repair 04).
- `git diff --check` — clean.

## Blockers / Residual Notes

- No push performed; no new commit created.
- No Redis was introduced: cluster-wide SSE admission uses the existing
  PostgreSQL tier, which the control plane requires anyway.
- Computer/browser runtime navigation remains not-production-ready: the
  control plane reports `not_configured` for computer endpoints, and the
  ComputerGateway now refuses to construct without a strong signing
  secret. Actual browser networking cannot enforce resolved-IP egress
  safety; no production wiring claims it does.
- `pnpm audit` still reports one pre-existing moderate advisory
  (unchanged from Repair 04/05A).

## Targeted Revalidation SAFE TO RUN

YES. Full repository verification and the real PostgreSQL verification
script completed successfully.
