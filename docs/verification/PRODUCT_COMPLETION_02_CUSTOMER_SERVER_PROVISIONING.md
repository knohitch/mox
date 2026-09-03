# PRODUCT COMPLETION — PHASE 02
# Customer Server Provisioning Verification

Starting SHA: `5adc048504e122e1edb402c49ba6cbf959be2db6`

## Summary

Customer server provisioning is now a real, end-to-end workflow. The `/servers` page has a primary "Provision Server" button that opens a multi-step wizard backed by real control-plane authority. No provider internals are exposed to the customer.

## What Was Built

### Backend (pre-existing in working tree, cleaned up)

- **`GET /api/servers/provision-options`** — returns safe Mox compute-class catalog, real server quota from commercial authority, and org SSH keys. Provider mapping/SKU/cost/account never exposed.
- **`POST /api/ssh-keys`** — adds an org SSH public key with format validation, fingerprint computation, 100-key limit, and audit logging.
- **`DELETE /api/ssh-keys/:keyId`** — removes a tenant-owned SSH key with audit logging.
- **`POST /api/servers/orders`** — accepts `sshKeyId`, enforces compute-class entitlement, server quota, idempotency key, and request fingerprinting.
- **Projections**: `projectSshKey`, `parseSshPublicKey` (validates OpenSSH format, rejects private keys, computes SHA256 fingerprint).
- **Database**: `ssh_keys` table (migrated in `0003_low_prowler.sql`), `server_orders.ssh_key_id` FK.

### Frontend

- **`ServersView`** (`MiscViews.tsx`): Added primary "Provision Server" button in `PageHeader` actions.
- **`ProvisionServerModal`** (`MiscViews.tsx`): 4-step wizard:
  1. **Choose class** — radio cards showing Mox compute classes with vCPU/RAM/included-in-plan status.
  2. **Hostname** — text input with validation (max 63 chars).
  3. **SSH access** — select existing key, add new key (with inline form), or skip. Keys show label + fingerprint.
  4. **Confirm** — review summary with plan impact (server count vs quota, included/charges badge).
- Quota exhaustion gate: shows honest message when plan limit reached.
- Auto-refreshes server list after successful provisioning.
- Placement is Mox-managed (no customer region selection — by design).

### API Client

- **`types.ts`**: Added `ComputeClassOption`, `SshKeyRow`, `ProvisionOptions` interfaces. Updated `MoxApi` with `getProvisionOptions`, `orderServer` (with `sshKeyId`), `addSshKey`, `deleteSshKey`. Removed stale duplicate `orderServer` signature. Removed `providerName` from `ServerOrderView`.
- **`http-api.ts`**: Added `getProvisionOptions`, `addSshKey`, `deleteSshKey` HTTP methods. Updated `orderServer` to pass `sshKeyId`.
- **`demo-api.ts`**: Full in-memory provisioning demo with idempotent ordering, SSH key CRUD, safe catalog fixtures.
- **`store.tsx`**: Added `getProvisionOptions`, `addSshKey`, `deleteSshKey` to `failingApi`.
- **`mockStore.ts`**: Added provisioning fixtures for UI Studio. Removed `providerName` from order fixture.

### Tests

Added 5 new tests in `apps/web/tests/authoring-versioning.test.ts`:

| Test | Coverage |
|------|----------|
| Safe catalog without provider internals | `getProvisionOptions` returns classes with no providerName/sku/cost |
| Idempotent double-submit | Same `idempotencyKey` returns same order |
| Order visible in listServers | New order appears in server list |
| SSH key add/list/delete lifecycle | Full CRUD round-trip |
| No providerName on ServerOrderView | Customer-safe order projection |

## Verification Results

| Gate | Result |
|------|--------|
| `pnpm typecheck` | PASS (all 37 workspace projects) |
| `pnpm lint` | PASS (0 errors, 58 warnings — all pre-existing) |
| `pnpm test` | PASS (85 files, 725 tests passed, 107 skipped) |
| `git diff --check` | PASS (no whitespace errors) |
| Provisioning tests (15 total) | PASS |

## Security Preservation

- Provider mapping/SKU/cost/account never exposed on customer surface.
- SSH public keys validated (format, algorithm, base64, max length). Private keys rejected.
- Tenant isolation: SSH keys scoped to `orgId`, cross-org access denied.
- Idempotency: double-click provisioning creates one order, not two.
- Server quota enforced at both fast-check and atomic reservation layers.
- Compute-class entitlement checked before order creation.
- All SSH key mutations audited.
- No provider credentials in browser bundle.

## Customer Abstraction Compliance

| Requirement | Status |
|-------------|--------|
| Mox compute class (not provider SKU) | PASS |
| CPU/RAM/storage description | PASS |
| Permitted region (Mox-managed, not customer-selectable) | PASS |
| Hostname/display name | PASS |
| SSH/public key if required | PASS |
| Entitlement/plan impact | PASS |
| Confirmation step | PASS |
| No provider account/credentials/wholesale cost/margin/SKU | PASS |

## Files Modified

- `apps/web/src/api/types.ts` — new provisioning types, cleaned duplicate `orderServer`
- `apps/web/src/api/http-api.ts` — provisioning HTTP methods
- `apps/web/src/api/demo-api.ts` — provisioning demo fixtures, removed duplicate import
- `apps/web/src/api/store.tsx` — added provisioning methods to failingApi
- `apps/web/src/views/MiscViews.tsx` — provisioning wizard UI
- `apps/web/src/uiStudio/mockStore.ts` — provisioning Studio fixtures
- `apps/web/tests/authoring-versioning.test.ts` — 5 new provisioning tests
- `services/control-plane/src/api.ts` — provisioning endpoints (pre-existing)
- `services/control-plane/src/projections.ts` — SSH key projections (pre-existing)
- `services/control-plane/tests/projections.test.ts` — updated provider abstraction test

## External Deployment Requirements

- `compute_classes` rows must be seeded in PostgreSQL for the catalog to populate.
- `ssh_keys` table exists via migration `0003_low_prowler.sql`.
- Actual VPS provisioning requires a configured provider account and compute orchestrator worker.
