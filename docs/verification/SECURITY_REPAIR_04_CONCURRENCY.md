# Security Repair 04: Concurrency + Abuse Controls

Date: 2026-08-24

## Scope

Objective: eliminate process-local security/commercial correctness assumptions and add production abuse controls.

Base SHA before this repair: `649bf9facd6f00ab800bf5d00dba4045e8d65d26`

New SHA: not created. This repair was left as an uncommitted working-tree change per the no-push/stop instruction.

Prior repair reports present:

- `docs/verification/SECURITY_REPAIR_01_BILLING.md`
- `docs/verification/SECURITY_REPAIR_02_AUTHORIZATION.md`
- `docs/verification/SECURITY_REPAIR_03_RUNTIME_NODE.md`

## Process-Local Guard Inventory

Confirmed production side-effect guards replaced:

- `services/billing/src/service.ts`
  - Removed checkout application `Set`.
  - Removed renewal `Set`.
  - Replaced both with durable checkout/subscription claim methods.
- `services/compute-orchestrator/src/service.ts`
  - Removed operation `inFlightOps` `Set`.
  - Replaced with durable operation leasing via store claims.
- `services/notification-service/src/service.ts`
  - Removed job runner `runningJobs` `Set`.
  - Replaced with durable notification-job claims.
- `packages/database/src/pg-billing-store.ts`
  - Removed stale process-local provider-payment map from the Postgres store.

Process-local registries that remain are not commercial/security correctness guards: provider registries, transport registries, realtime subscriber sets, and in-memory stores used for local/test seams.

## Durable Claim Design

Migration added: `packages/database/migrations/0013_security_repair_concurrency.sql`

Durable fields added:

- Billing:
  - `verified_webhook_events.status = processing`
  - `verified_webhook_events.processing_owner`, `processing_expires_at`
  - `checkout_sessions.claim_owner`, `claim_expires_at`
  - `subscriptions.renewal_claim_owner`, `renewal_claim_expires_at`
- Compute:
  - `server_operations.lease_owner`, `lease_expires_at`
  - PG claim uses `FOR UPDATE SKIP LOCKED`.
  - Duplicate enqueue no longer resets terminal operations.
- Notifications:
  - `notification_jobs.claim_owner`, `claim_expires_at`, `attempts`
  - Admin job idempotency is now `(created_by, idempotency_key)`.
  - External dispatch dedupe key added and uniquely indexed per org.
- Auth abuse controls:
  - `auth_rate_limits`
  - `security_events`

The production stores now claim rows before side effects. Losing workers see applied/busy/non-due state rather than relying on same-process memory.

## Abuse Controls

- Auth endpoints (`setup`, `signup`, `login`, `token-login`) now use durable PostgreSQL rate-limit buckets with row-level locking and security-event logging on blocks.
- Trusted proxy IP parsing is explicit via `MOX_TRUSTED_PROXY_IPS`; forwarded headers are ignored unless the direct peer is trusted.
- SSE streams reject URL tokens, enforce PAT scopes, cap per-user/per-IP/global open streams, send heartbeat pings, and release counters on close.
- Billing webhooks have a tighter body limit, stable invalid-signature dedupe keys, and generic signature rejection without provider-name or verifier-detail oracle.
- Internal 500 responses no longer echo exception messages; 501/typed HTTP errors keep their explicit machine-readable codes.
- Credential key parsing now requires full-string 64-hex or `hex:` 64-hex keys; malformed hex is rejected.
- Password minimum raised to 12 characters for new credentials. Existing hashes remain verifiable.

Redis note: this repository has `REDIS_URL` config but no Redis client wired into the control-plane package. The implemented production control is durable PostgreSQL row locking. The bucket/scope design is compatible with a Redis backend later, but this repair does not introduce an unconfigured Redis dependency.

## Verification

Passed:

- `pnpm -s lint`
  - Exit 0. Warnings only, including pre-existing unused-variable warnings.
- `pnpm -s typecheck`
- `pnpm -s build`
- `pnpm -s test`
  - 57 files passed, 1 skipped.
  - 443 tests passed, 46 skipped.
- `pnpm -s public-branding-scan`
- `pnpm -s secret-scan`
- `pnpm -s scan:authority`
- `pnpm -s dependency-security`
  - Exit 0 under `--audit-level high`.
  - One moderate advisory remains reported by pnpm audit.
- `powershell -File scripts\run-postgres-verification.ps1`
  - Fresh disposable PostgreSQL cluster created.
  - Migrations `0000` through `0013` applied cleanly.
  - PG-gated `restart.test.ts` and `auth-integration.test.ts` passed.
  - Upgrade drill passed.

Focused regression coverage added:

- Concurrent duplicate billing checkout webhooks apply value once.
- Cross-instance PG duplicate billing webhook race applies once.
- Compute concurrent reconcilers claim a single operation.
- Notification concurrent job runners claim one broadcast job.
- Admin notification idempotency keys are actor-namespaced.
- External dispatch dedupe per recipient/channel.
- Credential malformed hex parser rejection.

## Blockers / Residual Notes

- No push was performed.
- No new commit was created, so there is no post-repair commit SHA.
- `pnpm audit --audit-level high` passes, but it reports one moderate vulnerability.
- Existing unrelated working-tree changes remain present, including prior repair files and deleted `md/` files; they were not reverted.

## Targeted Security Revalidation

SAFE TO RUN: YES
