# Repair Prompt 01 — Real PostgreSQL Verification Record

**Result: PASS** — recorded from an actual run of the disposable-cluster
harness after implementing the four payment-provider adapters and the
billing-mutation authorization model. No credentials or connection strings
included.

| Field | Value |
| --- | --- |
| Timestamp | 2026-08-23 10:26 (local, UTC-05:00) |
| PostgreSQL version | 18.1 (x86_64-windows) |
| Command | `powershell -ExecutionPolicy Bypass -File scripts\run-postgres-verification.ps1` |
| Cluster | Fresh `initdb` instance on a free ephemeral loopback port, destroyed after the run |

## Migrations

All TEN migrations applied cleanly to an empty database, including
`0009_payment_providers_01.sql` (provider configs, plan mappings, provider
customers, normalized provider-payment ledger, subscription environment +
event-ordering columns).

## PG-gated suites

```
Test Files  2 passed (2)
Tests       40 passed (40)
```

Prompt-01 coverage executed against real PostgreSQL:

- Billing mutations require BOTH `billing` scope AND org owner/admin —
  plain member with billing PAT denied (`role_denied`); `*` PAT for a
  member denied; PAT without `billing` scope denied on reads; owner cookie
  allowed.
- Success redirect WITHOUT webhook activates nothing.
- Verified webhook activates; replay of the same event is deduped.
- Out-of-order protection: an older cancellation cannot regress newer
  active state (PostgreSQL-persisted event cursor).
- Wrong amount rejected (`amount mismatch`) before any state change.
- Missed-webhook reconciliation repairs exactly once; second run is a
  no-op; provider refs survive a simulated process restart.
- Provider configuration is platform-admin only via explicit deployment
  admin list; secret REF names only — no secret material ever echoed;
  public catalog exposes safe fields only.

All prior suites (restart/idempotency conformance, auth/security,
enrollment, entitlements transactionality, slug collision) re-passed.

## Upgrade drill (pre-0006 → current)

**PASS** — legacy canceled subscription preserved through 0009, resubscribe
creates new rows, FX migration intact, all new provider relations present.

## Overall

**PASS: real PostgreSQL verification completed after Prompt 01 changes.**
