# Security Repair 03 Runtime And Node Verification

Repository: `E:\MyCodes\Mox`
Branch: `master`
Baseline SHA: `649bf9facd6f00ab800bf5d00dba4045e8d65d26`
Date: 2026-08-24

## Scope

Repaired the confirmed runtime, node, approval, secret-persistence, SSRF, gateway-token, and runtime-policy findings.

## Changes

- Bound node enrollment tokens to a server-issued expected node identity (`node-${order.id}`), persisted it, emitted it through cloud-init, and rejected customer-chosen or cross-order node IDs.
- Preserved org/order ownership for existing node records and rejected stale provider-instance enrollments after re-provisioning.
- Moved approval resolution authority to `approval_requests`, with org-scoped lookup, atomic open-to-resolved transition, idempotent same-outcome replay, conflicting replay rejection, sanitized projection events, and runtime delivery through `respondApproval`.
- Added durable approval schema columns and migration `0012_security_repair_runtime_node.sql`.
- Sanitized event persistence in PostgreSQL/in-memory stores, runtime persistence, and admin payloads, including secret-shaped keys, bearer/API/JWT/DB/private-key/signed-URL values, large/binary payload artifact references, and Luhn-validated PAN redaction without corrupting UUIDs.
- Scrubbed node stderr tails before surfacing Docker/backup failures.
- Replaced raw webhook/outbound gateway fetch with DNS-validated `safeOutboundFetch`, blocking private/link-local/documentation/NAT64 ranges, credentialed URLs, unsafe ports, unsafe redirects, oversized bodies, and timeouts.
- Signed computer gateway tokens with HMAC, required org/agent/session/jti/expiry claims, added expected-scope validation, and added replay-cache hooks.
- Added runtime policy fail-closed handling for spend budget enforcement and mapped `requireApprovalFor` categories to spend, network, computer, and deployment operations.

## Regression Coverage

- Node identity: valid server-issued enrollment, cross-tenant takeover rejection, legitimate same-order reimage, stale provider-instance token rejection, restart persistence, atomic duplicate enrollment.
- Approval authority: member denial, owner/admin resolution, same-outcome idempotency, conflicting replay rejection, forged event projection ignored, cross-org resolution denied, runtime delivery exactly once.
- Secret persistence: event replay and durable stores redact secrets and preserve non-secret IDs.
- SSRF: trailing-dot localhost, private IPv4/IPv6, NAT64, documentation ranges, hex/decimal IP forms, disallowed ports, DNS rebinding, redirect rebinding, timeout and body limits.
- Gateway token: unsigned JSON, tampering, wrong secret, replay cache, and wrong org/server/session rejection.
- Runtime/node stderr: bounded redaction of secret-bearing stderr.

## Verification

- `pnpm lint` PASS. Remaining output is warning-only in unrelated existing files.
- `pnpm secret-scan` PASS.
- `pnpm scan:authority` PASS.
- `pnpm dependency-security` PASS exit code 0; audit reports one moderate advisory and no high/critical failure.
- `pnpm typecheck` PASS.
- `pnpm test` PASS: 57 files passed, 1 skipped; 436 tests passed, 43 skipped.
- `pnpm build` PASS.
- `pnpm --filter @mox/control-plane typecheck` PASS after PG-specific test updates.
- `powershell -File scripts\run-postgres-verification.ps1` PASS:
  - Applied migrations `0000` through `0012_security_repair_runtime_node.sql` to a fresh disposable PostgreSQL database.
  - PG-gated suites passed: 2 files, 50 tests.
  - Pre-0006 upgrade drill passed.

## Notes

- Existing unrelated dirty-tree deletions under `md/` were not reverted or modified.
- Security Repair 01/02 files and changes already present in the worktree were preserved.

## Security Repair 04 Gate

Security Repair 04 SAFE TO RUN: YES, assuming no new user changes are introduced before the next repair starts.
