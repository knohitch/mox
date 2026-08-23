# Full System Debug Sweep

Date: 2026-08-23

Scope: repository-wide bug hunt across auth, billing, notifications, compute, runtime, admin, branding, and persistence. This was a defect-finding pass, not feature construction. Production defects found during the sweep were fixed and covered by regression tests.

## Methodology

Searches run across `apps`, `packages`, `runtime`, `services`, `scripts`, and `docs`:

- `TODO`, `FIXME`, `HACK`, `placeholder`, `mock`, `fake`, `demo`
- `InMemory`
- `return []`, `return true`
- `not_configured`
- hard-coded URLs/credentials
- `any`, unsafe casts
- swallowed exceptions / suspicious `catch` blocks
- unhandled promise surfaces

Codex Security Deep Scan was attempted but did not start:

`Codex Security Deep Scan discovery did not start or rejoin. Deep Scan cannot safely start a read-only worker: the parent must provide a managed filesystem permission profile.`

TAC status also could not be checked because `connector_openai_codex_security_access is not connected`.

## Match Classification

Legitimate test/dev:

- `FakeBillingProvider`, `FakeComputeProvider`, fake API clients, demo API, and `InMemory*` stores under tests.
- `apps/web/src/api/demo-api.ts` remains explicitly dev/demo-only and labeled as demo.
- `runtime/*/tests`, `services/*/tests`, and provider conformance fakes are test harnesses.

Honest unsupported capability:

- `not_configured` responses for provider connection probes, computer gateway, workspace files, logs, terminal execution, and CLI engine state.
- These are explicit failure states and were not converted into fake success.

Production defects:

- Admin capability checks were incomplete.
- Billing checkout completion trusted missing amount/currency.
- Compute provisioning selected candidates without a usable provider account.
- Webhook automation allowed unsafe outbound URLs and sent vault refs as bearer tokens.
- Customer web terminal and CLI engine surfaces hid unavailable backend capability.

Dead/confusing code:

- Duplicate `BillingProvider` interface block in `services/billing/src/provider.ts` was removed.

Remaining non-code blocker:

- Container builds were requested, but this repository has no `Dockerfile*`, `docker-compose*.yml`, or compose files to build.

## Findings

| Severity | File/path | Bug | Fix | Test proving fix | Remaining blocker |
| --- | --- | --- | --- | --- | --- |
| High | `services/control-plane/src/api.ts`, `services/control-plane/src/config.ts` | Admin notification routes and the admin session helper did not enforce route-level capabilities correctly; a broad platform-admin check could bypass RBAC or deny capability-bearing staff before capability evaluation. | Added server-side `MOX_PLATFORM_ADMIN_CAPABILITIES`, enforced exact capabilities, and changed admin notification/admin helpers to use capability checks. | `pnpm --filter @mox/control-plane test -- runtime-config`; PostgreSQL auth suite in `scripts/run-postgres-verification.ps1` caught the helper bug, then passed after fix. | None. |
| High | `services/billing/src/service.ts`, `services/billing/src/provider.ts` | A verified checkout webhook could activate a subscription without amount/currency evidence because exact money checks only ran when fields were present. | `checkout.completed` now requires amount and currency and compares both exactly against the checkout session. Fake provider parses those fields for conformance tests. | `pnpm --filter @mox/billing test`; `pnpm test`; PostgreSQL restart/idempotency suite. | None. |
| High | `services/integration-gateway/src/providers.ts` | Webhook automation could fetch arbitrary configured URLs and used `secretRef` directly as `Authorization: Bearer`, risking SSRF and secret-reference leakage. | Added outbound URL safety validation, vault-ref resolver hook, fail-closed behavior when secrets cannot resolve, and injected fetch for testing. | `pnpm --filter @mox/integration-gateway test`; `pnpm --filter @mox/security test`; full `pnpm test`. | None. |
| Medium | `services/compute-orchestrator/src/service.ts` | Candidate selection could provision with no enabled provider account and ignored provider account region compatibility. | Selection now requires an enabled account matching the candidate region, and returns the selected account with the candidate. | `pnpm --filter @mox/compute-orchestrator test`; full `pnpm test`. | None. |
| Medium | `apps/web/src/views/AgentsView.tsx`, `apps/web/src/api/http-api.ts`, `services/control-plane/src/api.ts` | The web terminal UI appended a demo success string instead of calling the backend. | Added `runTerminalCommand` API method and backend route that fails honestly with `501/not_configured` until Mox Runtime terminal execution is wired. | `pnpm --filter @mox/web typecheck`; `pnpm --filter @mox/control-plane typecheck`; full build/typecheck. | Terminal execution remains honestly unsupported in this deployment. |
| Medium | `apps/web/src/api/http-api.ts`, `apps/web/src/views/MiscViews.tsx`, `services/control-plane/src/api.ts` | Production HTTP client returned `[]` for CLI engines, hiding an unavailable backend capability as an empty catalogue. | Client now calls `/api/cli-engines`; backend returns `501/not_configured`; UI catches and displays the explicit unavailable state. | PostgreSQL auth suite regression: "CLI engine catalogue fails honestly instead of returning a silent empty list"; full build/typecheck. | CLI engine state remains honestly unsupported until the real gateway state endpoint is wired. |
| Low | `services/billing/src/provider.ts` | Duplicate `BillingProvider` interface declaration created a dead/confusing contract surface. | Removed the duplicate declaration. | `pnpm --filter @mox/billing typecheck`; full `pnpm typecheck`. | None. |

## Verification Results

Passed:

- `pnpm -r run build`
- `pnpm typecheck`
- `pnpm test`  
  Result: 57 passed test files, 1 skipped; 422 passed tests, 39 skipped.
- `powershell -ExecutionPolicy Bypass -File scripts\run-postgres-verification.ps1`  
  Result: clean PostgreSQL install migrations `0000` through `0010`, PostgreSQL auth/restart suites 46 passed tests, pre-0006 to current upgrade drill passed.
- `pnpm public-branding-scan`  
  Result: `public-branding-scan: clean - public surfaces use Mox branding`.
- Focused regression suites:
  - `pnpm --filter @mox/billing test`
  - `pnpm --filter @mox/compute-orchestrator test`
  - `pnpm --filter @mox/integration-gateway test`
  - `pnpm --filter @mox/security test`
  - `pnpm --filter @mox/platform-ops test -- security-hardening`
  - `pnpm --filter @mox/control-plane test -- runtime-config`
  - affected web/control-plane typechecks

Not configured:

- Container builds: no container build files are present in the repository.
- Codex Security Deep Scan: blocked by missing managed filesystem permission profile.
- Codex Security TAC status: connector is not connected.

## Residual Risk

No known critical/high production defect remains undocumented from this sweep. The remaining unsupported surfaces are explicit `not_configured`/unavailable responses rather than demo or mock production authorities. Existing `InMemory*` classes remain classified in `docs/inmemory-authority-classification.md`; production composition does not use them as authoritative stores for the durable control-plane path.
