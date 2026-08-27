# Retained Branch Functionality Rescue

Date: 2026-08-27

## 1. Baseline Branch and SHA

- Branch: `master`
- Baseline SHA: `d76eeb4185f4d02036e4bf2d93e099b517c6d18b` (verified before implementation)
- `origin/master`: same SHA (`git rev-parse origin/master` matched)
- Remote: `https://github.com/knohitch/mox.git`
- Working-tree state at start: NOT clean — `md/glmscan.md` and `md/grok.md` were
  already deleted (staged), and the task file itself was untracked. The mismatch is
  confined to scratch files under `md/`; implementation proceeded and this
  mismatch is reported here (per task instruction: stop-and-report instead of
  modifying unrelated state; no remediation of those `md/` deletions was performed).

No commit, push, branch switch, or history rewrite was performed. All
implementation exists only as uncommitted working-tree changes.

## 2. Exact Files Changed

Tracked files modified (working-tree only):

1. `packages/credentials/src/secretbox.ts`
2. `packages/credentials/src/service.ts`
3. `packages/credentials/tests/secretbox.test.ts`
4. `packages/database/src/index.ts`
5. `packages/database/src/schema/models.ts`
6. `packages/database/tests/schema-invariants.test.ts`
7. `scripts/run-postgres-verification.ps1`
8. `services/billing/src/seed.ts`
9. `services/control-plane/src/api.ts`

New files (untracked):

10. `packages/credentials/tests/service.test.ts`
11. `packages/database/migrations/0017_credential_authority_isolation.sql`
12. `packages/database/src/credential-stores.ts`
13. `services/billing/tests/seeding.test.ts`
14. `services/control-plane/tests/rescue-postgres.test.ts`
15. `docs/verification/RETAINED_BRANCH_FUNCTIONALITY_RESCUE.md` (this report)

Pre-existing unrelated working-tree state (present before this task, left
untouched): staged deletions of `md/glmscan.md`, `md/grok.md`; untracked task
file `md/MOX_RETAINED_BRANCH_FUNCTIONALITY_RESCUE_BIG_PICKLE.md`.

`git diff --check`: clean (only informational autocrlf LF→CRLF notices).

## 3. Legacy Branch Files Inspected

`origin/fix/production-authorities-foundation` (`0aa106e7b3b3b202ac06d6c052a5afca8c14079f`), read-only:

- `packages/credentials/src/secretbox.ts`
- `packages/credentials/src/service.ts`
- `packages/database/src/credential-stores.ts`
- `packages/database/migrations/0007_isolate_customer_system_credentials.sql`
- `packages/database/src/schema/models.ts`

`origin/fix/production-hardening-foundation-20260822` (`a685b7a…`), read-only:

- `services/billing/src/seed.ts`

Neither branch was merged or checked out; no local tracking branches were created.

## 4. Functionality Rescued from `fix/production-authorities-foundation`

- Customer vs Mox-system credential authority separation:
  - versioned `secretbox` with AEAD context (v2 prefix).
  - dual credential service types (`CustomerCredentialService` /
    `SystemCredentialService`) with per-authority AAD binding.
  - physical PostgreSQL separation: customer secrets in `customer_credential_secrets`
    (org-scoped), Mox secrets in `system_credential_secrets` (global, no org_id),
    plus global `system_credential_refs`.
  - `PgCustomerCredentialStore` / `PgSystemCredentialStore` implementations.
  - unrelated org-scope present on `model_connections` alongside `credentialRefs`
    privacy: customer connections carry a `credential_ref_id` FK and none of the
    secret payload.
- Control-plane "intelligence" provider configuration running as Mox-system
  (platform) state rather than the administrator's org state.

## 5. Functionality Rescued from `fix/production-hardening-foundation-20260822`

- Idempotent billing catalog seeding: calling `seedCatalog()` twice against one
  store succeeds both times, reuses logical products and plan version 1, and
  avoids duplicate identical GLOBAL USD anchor price versions.

## 6. Adaptation to Current Master

- `deriveKey` semantics kept byte-for-byte from master: trim; empty throws;
  `hex:` prefix requires exactly 64 hex digits (with prefix); a bare 64-hex
  string is used raw; any other all-hex string throws "credentials hex key must
  be exactly 32 bytes"; anything else becomes a SHA-256 passphrase. The legacy
  branch's `assertStrongMasterKey` weak-passphrase/passphrase rejection was NOT
  adopted — short passphrases remain permitted (`CredentialService("k", …)`).
- Branch migration `0007` targeted tables that do not exist on master (it was a
  rewrite of master's `0007`); instead a NEW additive migration `0017` was
  written against master's current schema and forward-scan mechanics.
- Branch `createCredentialAuthorities` split was re-expressed on master's exact
  file layout with master-compatible names (`CredentialService extends
  CustomerCredentialService`, `CredentialStore = CustomerCredentialStore`)
  so existing callers (`redact` in agent-runtime and its tests) keep compiling
  unchanged.
- Master's `createProduct` is already idempotent; version-1 reuse was added via
  `store.listPlanVersions(productId)` and the GLOBAL USD anchor reuse via
  `store.listPriceVersions(priceBookId)` with a `BigInt` amount comparison,
  matching master's store interface (`listPlanVersions`/`listPriceVersions`
  exist on `BillingStore`, `PgBillingStore`, `InMemoryBillingStore`).
- Master's intelligence endpoints used org-scoped `modelProviders` /
  `credentialRefs` / `modelConnections`; rewritten against the new system tables
  with a metadata-only projection and identical capability/audit/URL guards.

## 7. Credential Authority Architecture After the Change

- `packages/credentials/src/secretbox.ts`: `seal(key, plaintext, aad?)` emits only
  `v2.<nonce|tag|ct>` (AES-256-GCM, 12-byte nonce, 16-byte tag, base64url);
  `open(key, sealed, aad?)` reads v2 (AAD required to round-trip) and still
  decrypts legacy unversioned payloads.
- `packages/credentials/src/service.ts`:
  - `CustomerCredentialService` and `SystemCredentialService` share an abstract
    base; the system authority's ref type has NO orgId.
  - `createCredentialAuthorities({ customerMasterKey, systemMasterKey,
    customerStore, systemStore })` derives both keys, rejects identical
    cryptographic roots via `timingSafeEqual` on the DERIVED keys (catches
    `hex:` vs bare-hex spellings of the same key), and returns the pair.
  - `CredentialService` / `CredentialStore` remain as customer aliases for
    backward compatibility. `redact`/`CREDENTIAL_SCOPES` untouched.

## 8. Customer vs System Storage Boundary

- Customer (org-scoped): `credential_refs` (metadata) +
  `customer_credential_secrets` (sealed payloads, key `(org_id, external_id)`).
- System (global): `system_credential_refs` (metadata, unique
  `external_id`) + `system_credential_secrets` (sealed payloads, PK
  `external_id`). No `org_id` column exists, so customer-scoped code cannot
  address platform secrets physically or in the type system.
- `model_connections` gained `auth_method` + `connection_status` and an optional
  `credential_ref_id` FK; `system_model_connections` mirrors that for system
  providers.
- Schema invariant test asserts no system table carries `orgId`.

## 9. Cryptographic / AAD Behavior

- Per-open AAD payloads: `mox:credential:v2:customer:<orgId>:<externalId>` and
  `mox:credential:v2:system:<externalId>` — org, external id, and the customer/
  system namespace are all cryptographically bound; wrong/missing AAD fails
  GCM authentication. Tests cover cross-org, cross-id, and cross-namespace
  reuse rejection in both directions.

## 10. Legacy Ciphertext Compatibility

- `open()` detects the `v2.` prefix and passes AAD only for v2; legacy
  unversioned blobs decrypt as before (no AAD). The existing `redact.test.ts`
  contract (seal → open with the same master key) is preserved. A dedicated test
  asserts a legacy (prefix-stripped) payload still opens.

## 11. Migration `0017` Details

`packages/database/migrations/0017_credential_authority_isolation.sql` (additive,
never rewrites history):

- `provider_auth_method` enum (DO block).
- `customer_credential_secrets` with `(org_id, external_id)` unique key.
- `model_connections`: adds `auth_method`, `connection_status`, and a
  `credential_ref_id` FK to `credential_refs` (`NOT VALID`, so existing rows
  with orphan/null refs are not rejected).
- Global tables: `system_credential_refs`, `system_credential_secrets`,
  `system_model_providers`, `system_models`, `system_model_connections`.
- Legacy handling (see §13): org-scoped `mox_system_model_provider` rows are
  preserved with a reconciliation `RAISE NOTICE`; nothing is deleted or
  ownership-guessed.

The migration is forward-only and lexicographically after `0016`; the tooling
(`packages/database/scripts/migrate.mjs`) scans committed SQL lexicographically
and reconciles via `mox_migrations` checksums.

## 12. Existing-Data Upgrade Behavior

- Verified by the suite `services/control-plane/tests/rescue-postgres.test.ts`
  (PG-gated): a legacy org-scoped row (`scope='mox_system_model_provider'`,
  external id `mox:openai:…`) inserted directly into `credential_refs` survives,
  and the rewritten control-plane PUT creates NO new org-scoped refs
  (differential before/after count) and NO org-scoped `model_providers` row.

## 13. Handling of Legacy `mox_system_*` Org-Scoped References

- Left in place, never deleted, never remapped to a guessed system owner.
- The migration emits a `RAISE NOTICE` reconciliation message so operators can
  inspect candidates before any manual cleanup.
- The control-plane intelligence flow no longer reads or writes them; new
  platform configuration lands exclusively in `system_*` tables.

## 14. Control-Plane Intelligence Authority Changes

- `GET /api/admin/intelligence` and `PUT /api/admin/intelligence/providers/:slug`
  now operate on `systemModelProviders` / `systemModels` /
  `systemModelConnections` / `systemCredentialRefs`.
- PUT: upserts the system provider (slug-unique), upserts a system credential ref
  `scope='model'`, external id `mox:<slug>:<secretRef>` (label = fingerprint),
  and upserts the system connection; still rejects secret-bearing base URLs
  (`rejectSecretBearingUrl`), still requires `admin.intelligence.write`
  (`requireAdminCapability`), still appends an admin audit event.
- GET: metadata-only projection (`configured`, `credentialFingerprint` = ref
  label, `providerState`, `connectionState`, `baseUrlConfigured`, `settings`,
  `models` with `enabled`); never returns sealed ciphertext or key material —
  verified by test assertions over the JSON response.

## 15. Catalog Seed Idempotency Behavior

- `seedCatalog()` reuses existing products by code, reuses existing plan
  version 1 (only activated if not already active), and reuses an existing
  identical GLOBAL USD price version before calling `addFixedPriceVersion` so a
  second run never creates a duplicate (product, version=1) or a duplicate
  identical anchor price. Regional `upsertPriceBook` flows unchanged.
- Verified in-memory (`services/billing/tests/seeding.test.ts`) and over real
  PostgreSQL (differential plan/price counts before/after second seed,
  identical IDs across runs, legacy catalog rows preserved).

## 16. Tests Added / Modified

- Added: `packages/credentials/tests/service.test.ts` (9 tests — customer/system
  round trips; same-root rejection; same-root across `hex:`/bare spellings;
  short-passphrase policy kept; cross-authority decryption failures both
  directions; empty-ref rejection).
- Extended: `packages/credentials/tests/secretbox.test.ts` (v2 format, legacy
  unversioned readable, wrong/missing AAD throws, org binding, external-id
  binding, customer/system namespace distinct).
- Added: `services/billing/tests/seeding.test.ts` (double-seed idempotency +
  pre-existing-catalog preservation, in-memory).
- Extended: `packages/database/tests/schema-invariants.test.ts`
  (`customerCredentialSecrets` added to tenant list; new assertion that all five
  system tables are free of `orgId`).
- Added: `services/control-plane/tests/rescue-postgres.test.ts` (PG-gated:
  customer-store org isolation + physical unique key, system store has no org
  namespace, system tables carry no org_id, legacy ref preservation, seed
  idempotency over `PgBillingStore`, control-plane PUT/GET authority test).

## 17. PostgreSQL Verification Added / Modified

- Extended `scripts/run-postgres-verification.ps1` suite list to run
  `tests/rescue-postgres.test.ts` alongside the existing PG-gated suites. The
  script provisions a fresh disposable cluster (ephemeral port), applies ALL
  migrations to an empty database, runs the suites, and runs the
  `pre-0006 → current` upgrade drill.

## 18. Every Verification Command Executed

- `pnpm typecheck` → PASS (all 37 projects; exit 0)
- `pnpm lint` → PASS with warnings only (all warnings pre-existing; none in files changed by this task)
- `pnpm test` → PASS
- `pnpm vitest run packages/credentials packages/database services/billing` → PASS (post whitespace-normalization confirmation; 13 files, 121 tests)
- `powershell -File scripts\run-postgres-verification.ps1` → PASS (twice; final run after whitespace normalization)
- `git rev-parse --abbrev-ref HEAD` → `master`
- `git rev-parse HEAD` → `d76eeb4185f4d02036e4bf2d93e099b517c6d18b` (unchanged)
- `git status --porcelain` → only the expected modified/untracked files (§2)
- `git diff --check` → clean
- `git diff --stat` → 11 tracked files, +417/−644

## 19. Exact Test Totals / Results

- Full unit suite (`pnpm test`): 68 files passed, 4 skipped (72 total);
  544 tests passed, 69 skipped (613 total). 0 failures.
- PostgreSQL-gated suites (final run): 5 files, 79 tests passed, 0 failures,
  plus the `pre-0006 → current` upgrade drill: PASS.

## 20. Commands That Could Not Run

- None. Every verification command above executed successfully on this Windows
  host (PostgreSQL binaries resolved by `run-postgres-verification.ps1`).

## 21. Remaining Critical Findings

- No new Critical findings.
- Working-tree state: implementation is uncommitted by design (baseline SHA
  unchanged). The `md/` deletions and untracked task file are pre-existing and
  unrelated; they remain as-is.
- Note: `pnpm lint` reports pre-existing warnings across the monorepo
  (`eslint(no-unused-vars)`, `unicorn(no-useless-fallback-in-spread)`, etc.)
  that are not introduced by this task.