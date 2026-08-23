# Foundation 00D — Real PostgreSQL Verification Record

**Result: PASS** — recorded from an actual run of the disposable-cluster
harness after the Prompt 00D scope-enforcement changes. No credentials or
connection strings included.

| Field | Value |
| --- | --- |
| Timestamp | 2026-08-23 08:00–08:06 (local, UTC-05:00) |
| PostgreSQL version | 18.1 (x86_64-windows) |
| Command | `powershell -ExecutionPolicy Bypass -File scripts\run-postgres-verification.ps1` |
| Cluster | Fresh `initdb` on a free ephemeral loopback port, destroyed after the run |

## Migrations

All nine migrations applied cleanly to an empty database
(0000 → 0008, including `0008_programmatic_auth_00c.sql`).

## PG-gated suites

```
Test Files  2 passed (2)
Tests       31 -> 35 passed (35)   [restart.test.ts + auth-integration.test.ts]
```

New Prompt 00D coverage executed against real PostgreSQL:

1. PAT with `agents` can access agent endpoints — PASS
2. Same PAT denied on billing (`scope_denied`) — PASS
3. Same PAT denied on servers — PASS
4. PAT with `billing` reads billing; cannot mint tokens — PASS
5. Restricted PAT cannot call `POST /api/auth/tokens` for `*`
   (`session_only`) — PASS
6. Restricted PAT cannot list/revoke token inventory — PASS
7. `admin` scope rejected without real admin capability (member-role
   user); granted only to genuine org owner/admin — PASS
8. `*` PAT cannot exceed user capabilities (session-only minting,
   cross-org switch denied) — PASS
9. Revoked and expired PATs rejected — PASS
10. `CreateApiTokenResponse` JSON keys exactly `{token, tokenId, scopes,
    expiresAt}`; list metadata never contains plaintext — PASS
11. Browser cookie auth unchanged end-to-end — PASS
12. Cross-org membership protection intact for PATs — PASS

Plus all prior restart/idempotency and auth/security suites re-passed.

## Upgrade drill (pre-0006 → current)

**PASS** — legacy canceled subscription preserved, resubscribe creates a
second row, jsonb `fx_rate` migrated to `fx_rate_scaled`, new relations
present, one-issued-per-order partial index exists.

## Overall

**PASS: real PostgreSQL verification completed after Prompt 00D changes.**
