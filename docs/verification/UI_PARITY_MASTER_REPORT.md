# UI Parity Master Report

Date: 2026-08-28

## Git

- Branch: `master`
- Starting SHA: `745ec42d33925bb59d78cdfe2717849d05698662`
- Ending SHA before final commit: pending final local commit
- Local commits in this phase: pending final local commit
- Final commit target, only if green: `feat(ui-parity): complete product surface parity`
- Push: not requested, do not push

## Scope

Prompt 07 revalidated UI/API/service/runtime parity from source:

- Customer app routes, customer navigation, current views, web API interface and HTTP implementation
- Admin routes, admin capability gates, Admin navigation, Admin UI entry points and operations
- Support routes, support capabilities, Support navigation, support-safe projections, notes and audit behavior
- Control-plane service routes, package/service exports, runtime protocol, Mox Node endpoints, CLI commands
- Database schema surfaces and migrations

The rebuilt matrix is in `docs/verification/UI_PARITY_FINAL_MATRIX.md`.

## Customer

Customer-visible capabilities are discoverable through the customer shell and route table: agents, rooms, servers, deployments, models, integrations, channels, usage, billing, backups, settings, notifications and authentication.

Customer-gated capabilities remain gated by org role, commercial entitlement, and canonical entitlement keys. Known blocked surfaces are explicit and non-actionable: computer gateway, files, logs, runtime terminal, workflow graph execution, provider health probes where runtime authority is absent, and legacy CLI engine state.

No customer route exposes Admin or Support navigation. Customer login return targets are normalized away from `/admin`, `/support`, scheme-relative, cross-origin and encoded escape targets.

## Admin

Admin capabilities are owned by `admin.*` staff capability gates:

- `admin.read`: overview/customers/operations read surfaces
- `admin.support.write`: admin-created support notes
- `admin.customers.write`: suspend/reactivate
- `admin.billing.write`: plans, price books, entitlements, addons, payment providers, contracts
- `admin.compute.write`: compute provider/accounts/classes/order actions
- `admin.intelligence.write`: system intelligence providers/models
- `admin.notifications.write`: notification preview/send/schedule/cancel
- `admin.operations.write`: runtime actions, backups and feature flags
- `admin.staff.write`: Staff & Access

Admin-only financial, secret, provider, feature flag, compute, intelligence, runtime and staff authority remains absent from customer and support navigation. Provider secrets are represented as configured/fingerprint/ref state, not plaintext.

## Support

Support is a separate least-privilege staff surface with only `support.*` capabilities:

- `support.customer.lookup`: customer search, detail, diagnostics, recent safe activity
- `support.ticket.write`: add audited support notes
- `support.escalate`: discoverable section with no action because no audited escalation service authority exists yet

Support-safe detail includes identity/workspace metadata, subscription lifecycle state, coarsened suspension reason, server lifecycle summaries, Mox Node health summaries, agent/deployment state, configured/not-configured connection state, note history and recent support-safe activity.

Support does not receive provider credentials, system credentials, customer plaintext secrets, payment provider secrets, wholesale costs, margins, staff authority, Admin feature flag controls, raw sensitive audit payloads, provider IP/hostnames, node ids/tokens, unrestricted runtime commands or Admin mutations.

## Internal Only

The following remain internal-only or service-only:

- One-time platform bootstrap
- Mox Node enrollment, heartbeat and command polling
- Billing webhook ingress
- Credential vaults and `secretbox`
- Database stores, schema, migrations and tenant guards
- Billing provider adapters, reconciliation queues, cost ledgers and provider object mappings
- Compute provider adapters and worker orchestration
- Runtime client/protocol and raw runtime command execution
- Integration/channel gateway execution
- SSRF, audit, egress policy and security helpers

## Fixed Defects

Prompt 07 fixed two PostgreSQL-mode contract-order defects found by the final verifier:

- Agent draft duplicate slug detection now runs before definition compilation, so the canonical uniqueness authority returns 409 even when the duplicate request body is otherwise malformed.
- Thread creation now verifies the requested agent belongs to the caller's organization before commercial entitlement checks or insert, preserving cross-org/IDOR safety and returning the expected validation error instead of a paywall response.

Previously fixed Prompt 06 support defects are included in the starting SHA:

- Support customer search/detail routes expose safe diagnostics and note state.
- Support navigation exposes Lookup, Diagnostics, Notes, Activity and Escalation by support capability.
- Support note creation validates length and HTML/script-like content and refreshes detail after persistence.
- Support projections coarsen sensitive errors and exclude secrets, costs, margins, provider account material, hostnames/IPs, node ids/tokens and raw audit payloads.

## Verification Plan

Required gates to run:

- `pnpm install --frozen-lockfile`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `pnpm public-branding-scan`
- `pnpm secret-scan`
- `pnpm scan:authority`
- `pnpm dependency-security`
- `git diff --check`
- `powershell -ExecutionPolicy Bypass -File scripts\run-postgres-verification.ps1`

Focused parity/security tests to run in addition to the full suite:

- `pnpm exec vitest run apps/web/tests/nav.test.ts apps/web/tests/staff-nav.test.ts apps/web/tests/admin-parity.test.ts`
- `pnpm exec vitest run apps/web/tests/commerce-connections.test.ts apps/web/tests/extended-capabilities.test.ts apps/web/tests/availability.test.ts`
- `pnpm exec vitest run services/control-plane/tests/projections.test.ts services/control-plane/tests/phase-05-admin.test.ts`
- `pnpm exec vitest run services/control-plane/tests/auth-integration.test.ts`

## Verification Results

Final-tree gates:

- `pnpm install --frozen-lockfile`: passed
- `pnpm lint`: passed with existing warnings only
- `pnpm typecheck`: passed
- `pnpm test`: passed; 79 files passed, 5 skipped; 656 tests passed, 93 skipped
- `pnpm build`: passed
- `pnpm public-branding-scan`: passed, public surfaces use Mox branding
- `pnpm secret-scan`: passed
- `pnpm scan:authority`: passed
- `pnpm dependency-security`: passed at `--audit-level high`; one moderate advisory reported below threshold
- `git diff --check`: passed; Git emitted only the existing Windows LF-to-CRLF warning for `services/control-plane/src/api.ts`
- `powershell -ExecutionPolicy Bypass -File scripts\run-postgres-verification.ps1`: passed; temporary PostgreSQL 18 instance started, migrations `0000` through `0019` applied, PostgreSQL-gated suites passed, pre-0006 upgrade drill passed

Focused parity/security tests:

- `pnpm exec vitest run apps/web/tests/nav.test.ts apps/web/tests/staff-nav.test.ts apps/web/tests/admin-parity.test.ts`: passed; 3 files, 16 tests
- `pnpm exec vitest run apps/web/tests/commerce-connections.test.ts apps/web/tests/extended-capabilities.test.ts apps/web/tests/availability.test.ts`: passed; 3 files, 30 tests
- `pnpm exec vitest run services/control-plane/tests/projections.test.ts services/control-plane/tests/phase-05-admin.test.ts`: passed; 2 files, 20 tests
- `pnpm exec vitest run services/control-plane/tests/auth-integration.test.ts`: skipped outside PostgreSQL script because `MOX_TEST_DATABASE_URL` is not set in the ambient shell; covered and passed inside `run-postgres-verification.ps1`

`pnpm secret-scan` was rerun after this report update and remained clean.

## Remaining External Live Requirements

- Live payment-provider accounts, live billing webhooks and real checkout redirects are represented by provider adapters and tested with deterministic fixtures; live-provider end-to-end validation remains environment-dependent.
- Real production compute provider credentials and Mox Node fleet operation are not available in this local verification environment.
- Full runtime terminal/computer/file/log gateways are intentionally `NOT_PRODUCTIZED_BLOCKED` until the runtime gateway authority is wired.
- PostgreSQL-backed integration verification depends on `scripts\run-postgres-verification.ps1` and local Docker/PostgreSQL availability.
