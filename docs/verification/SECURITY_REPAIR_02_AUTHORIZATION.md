# Security Repair 02: Authorization

Date: 2026-08-24

Baseline HEAD before repair: `649bf9facd6f00ab800bf5d00dba4045e8d65d26`
Verified working tree: `649bf9facd6f00ab800bf5d00dba4045e8d65d26` plus uncommitted Security Repair 01 and Security Repair 02 changes. No commit was created and nothing was pushed.

Pre-existing worktree note: the `md/*` deletions were already present before this repair and were not changed. Security Repair 01 remained present; before editing, `pnpm --filter @mox/billing test` passed with 3 test files and 37 tests.

## Summary

Security Repair 02 closes confirmed authorization defects around organization roles, platform-admin privileges, cross-tenant administrative actions, and notification visibility.

Main invariants now enforced:

- Organization viewers are read-only for workspace and notification mutations.
- Organization members may perform normal workspace writes and notification state changes, but not billing, infrastructure, integration, or approval-resolution actions.
- Organization admins and owners may perform billing, infrastructure, integration, and approval-resolution actions, subject to commercial entitlement checks.
- Programmatic tokens inherit organization role limits and cannot bypass server-order or approval gates.
- Platform admin access is session-only for admin APIs and requires explicit role or capability configuration.
- Legacy platform-admin user IDs no longer imply wildcard access.
- Cross-tenant customer suspend/reactivate flows use billing and compute orchestrator state machines and write target-organization audit rows.
- Per-recipient notification fan-out is visible only to the targeted user.
- Admin read APIs redact credential references, root credentials, request fingerprints, and token hashes from broad read responses.

## Organization Role Matrix

| Capability | viewer | member | admin | owner |
| --- | --- | --- | --- | --- |
| Read org-scoped resources | yes | yes | yes | yes |
| Workspace writes, threads, rooms, agent model changes | no | yes | yes | yes |
| Notification read/unread/archive/read-all mutations | no | yes | yes | yes |
| Billing management and checkout | no | no | yes | yes |
| Server ordering and infrastructure management | no | no | yes | yes |
| Integration management | no | no | yes | yes |
| Approval resolution | no | no | yes | yes |

Commercial-gated routes still require active Repair 01 entitlements after the role gate passes.

## Platform Admin Matrix

| Role | Effective capabilities |
| --- | --- |
| `superadmin` | wildcard admin capabilities |
| `billing_admin` | `admin.read`, `admin.billing.write`, `admin.notifications.write` |
| `ops_admin` | `admin.read`, `admin.compute.write`, `admin.intelligence.write`, `admin.operations.write`, `admin.notifications.write` |
| `support` | `admin.read`, `admin.support.write` |

Platform-admin users are configured by `MOX_PLATFORM_ADMIN_ROLES` and optional explicit `MOX_PLATFORM_ADMIN_CAPABILITIES`. `MOX_PLATFORM_ADMIN_USER_IDS` is now legacy identity registration only; every legacy user must also have an explicit role or capability mapping. Wildcard explicit capabilities are accepted only for `superadmin`.

## Routes Audited

- Workspace and tenant routes: `PATCH /api/agents/:agentId/model`, `POST /api/threads`, `POST /api/threads/:threadId/messages`, `POST /api/rooms`.
- Billing and commercial routes: checkout, billing manager routes, commercial mutation helper, server ordering entitlement path.
- Infrastructure and integration routes: `POST /api/servers/orders`, `POST /api/model-connections/:providerSlug/test`, `PATCH /api/integrations/:integrationId`.
- Approval route: `POST /api/approvals/:approvalId/resolve`.
- Notification routes: list/detail ownership, read/unread/archive/read-all, admin send/schedule/job APIs.
- Admin routes: billing provider writes, plan price-book writes, compute account writes, intelligence provider writes, customer support notes, customer suspend/reactivate, admin compute/operations/customer read DTOs.

## Migrations

No new schema migration was required for Security Repair 02. The PostgreSQL verification applied all migrations through Security Repair 01 migration `0011_security_repair_billing_commercial_auth.sql`.

## Verification

Passed:

- Repair 01 presence check: `pnpm --filter @mox/billing test` - 3 files passed, 37 tests passed.
- Targeted typechecks:
  - `pnpm --filter @mox/notification-service typecheck`
  - `pnpm --filter @mox/database typecheck`
  - `pnpm --filter @mox/control-plane typecheck`
- Targeted unit tests:
  - `pnpm --filter @mox/notification-service test` - 1 file passed, 7 tests passed.
  - `pnpm --filter @mox/control-plane test` - 3 files passed, 1 skipped; 25 tests passed, 42 skipped.
- PostgreSQL verification: `./scripts/run-postgres-verification.ps1` - 2 files passed, 49 tests passed; pre-0006 to current upgrade drill passed.
- Full lint: `pnpm lint` - passed with pre-existing warnings outside this repair.
- Full typecheck: `pnpm typecheck` - passed.
- Full tests: `pnpm test` - 57 files passed, 1 skipped; 426 tests passed, 42 skipped.
- Full build: `pnpm build` - passed.
- Diff hygiene: `git diff --check` - passed; output contained only Git LF-to-CRLF notices.

## Security Repair 03 Gate

Security Repair 03 SAFE TO RUN: YES, assuming no new user changes are introduced before the next repair starts.
