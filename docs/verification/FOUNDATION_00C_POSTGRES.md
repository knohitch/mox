# Foundation 00C — Real PostgreSQL Verification Record

**Result: PASS** — recorded from an actual run of the disposable-cluster
harness. No connection strings or credentials are included, by design.

| Field | Value |
| --- | --- |
| Timestamp | 2026-08-23 06:23–06:28 (local, UTC-05:00) |
| PostgreSQL version | 18.1 (x86_64-windows, msvc-19.44.35219) |
| Command | `powershell -ExecutionPolicy Bypass -File scripts\run-postgres-verification.ps1` |
| Cluster | Fresh `initdb` instance on a free ephemeral loopback port (28536 this run), trust auth, destroyed after the run |
| Databases | `mox_verify` (empty → full migration) · ephemeral upgrade-drill DB |

## Migration result

All migrations applied cleanly to the empty database, in order:

```
apply 0000_sticky_thor_girl.sql
apply 0001_youthful_iceman.sql
apply 0002_kind_archangel.sql
apply 0003_low_prowler.sql
apply 0004_reflective_kinsey_walden.sql
apply 0005_redundant_human_cannonball.sql
apply 0006_foundation_production_wiring.sql
apply 0007_auth_security_00b.sql
apply 0008_programmatic_auth_00c.sql
```

## PG-gated suites (vitest over real PostgreSQL)

Command scope: `npx vitest run tests/restart.test.ts tests/auth-integration.test.ts`
with `MOX_TEST_DATABASE_URL` set.

```
Test Files  2 passed (2)
Tests       31 passed (31)
```

Coverage highlights (all executed against PostgreSQL, with service/store
clients recreated between writes and reads to prove durability):

- restart.test.ts — billing survives restart; duplicate webhook stays
  deduped after restart; subscription history preserved across cancel →
  resubscribe; pending VPS operation survives restart and reconciles once;
  enrollment expectation survives restart; two simultaneous enrollments
  cannot both succeed; notifications survive restart with dedupe intact.
- auth-integration.test.ts — one-time setup closes permanently; signup/
  login/logout/expiry/revocation; session belongs to authenticated user;
  membership-checked multi-org switching; CSRF on cookie mutations;
  SSE rejects URL tokens, accepts cookie/bearer channels; **browser login/
  signup JSON contains no session token (00C §A)**; **programmatic token
  contract separate from browser cookies, scoped PATs revocable (00C §B)**;
  **credentialed CORS for allowlisted origins, unlisted origins denied
  (00C §C)**; **webhook signature verification receives exact raw bytes,
  reserialization would fail (00C §D)**; **node command polling requires
  that node's durable agent token, cross-node tokens rejected (00C §E)**;
  **duplicate workspace names get distinct slugs via ON CONFLICT retry
  (00C §F)**; transactional entitlement replacement rollback.

## Upgrade drill (pre-0006 → current)

`node packages/database/scripts/pg-upgrade-drill.mjs`

- Baseline 0000–0005 applied; legacy rows inserted under the OLD schema
  (canceled subscription, jsonb `fx_rate`, pre-enrollment state).
- Upgraded through 0006 → 0008.
- Assertions passed: canceled-subscription history survived; a NEW live
  subscription was created afterwards (2 rows total); legacy jsonb rate
  migrated to `fx_rate_scaled = 1250000000`; new relations present;
  one-issued-per-order partial index exists.

**Upgrade drill: PASS**

## Overall

**PASS: real PostgreSQL verification completed after Prompt 00C changes.**
