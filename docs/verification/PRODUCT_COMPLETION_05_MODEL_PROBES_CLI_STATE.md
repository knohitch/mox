# PRODUCT COMPLETION — PHASE 05
# Model Connection Probes + CLI Runtime State Verification

Starting SHA: `3a9a9e8`

## Summary

Model connection probes are now vault-backed and real. The test endpoint verifies credentials against the customer vault. CLI engine state is derived from real model connection authority instead of returning 501.

## What Was Built

### A. Model Connection Probes

**`POST /api/model-connections/:providerSlug/test`** — Wired to real authority:
- Validates provider exists and belongs to org
- Checks connection status (returns honest "not connected" / "no credentials" if missing)
- Retrieves credential from `CustomerCredentialService` vault
- Returns structured probe result: `{ ok, status, checkedAt, latencyMs, safeMessage }`
- Vault errors return `{ ok: false, reason }` — never echo raw provider payloads
- Credential plaintext never appears in response

**Credential rules preserved:**
- Customer secrets resolve through `CustomerCredentialService` / customer vault
- Never return plaintext after save
- Never place plaintext in DB/API/logs
- Org/reference AAD binding preserved
- Rotate/delete/audit through canonical authority

### B. CLI Runtime State

**`GET /api/cli-engines`** — Derived from real authority:
- Queries `modelConnections` for the org
- Returns configured connections as available engines
- Includes backward-compatibility note directing callers to `/api/models`
- No fake permanent feature preserved just because an old API method exists

## Verification Results

| Gate | Result |
|------|--------|
| `tsc -b --force services/control-plane` | PASS |
| `tsc -b --force apps/web` | PASS |
| `pnpm test` | PASS (85 files, 736 tests passed, 107 skipped) |

## Security Preservation

- Customer credential vault isolation maintained (org-scoped)
- System credentials never mixed with customer rows
- Raw provider payloads never echoed (errors normalized)
- Credential plaintext never in API response
- Browser bundle has no secret material

## Files Modified

- `services/control-plane/src/api.ts` — wired test probe + CLI engines endpoints
- `md/04_RUNTIME_WORKSPACE_SURFACES.md` — marked as done

## External Deployment Requirements

- `MOX_CUSTOMER_CREDENTIALS_KEY` env var must be set for vault operations
- Without it, connect/rotate/test operations return 501 honestly
