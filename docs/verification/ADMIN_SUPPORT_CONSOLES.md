# Prompt 03 — Admin & Support Consoles (Server-Authoritative, Least-Privilege)

## Scope

This report documents Prompt 03
(`03_MOX_ADMIN_SUPPORT_CONSOLES.md`): a dedicated **Admin Console** and
**Support Console** with server-authoritative staff identity, a least-privilege,
capability-gated admin navigation (including **Staff & Access**), support-safe
data projections, and no cross-surface leakage. Prompts 01 and 02 (surface
isolation / routing + customer-app UI) completed and verified earlier.

## Repository State

- Working tree branch: `master` (no commit; commit/push intentionally manual
  after review).
- Baseline matching SHA (`43b0f3cf8f74ebca514a0cfb678b4770bf4ed033`) — same
  root as Prompts 01/02.

## Changes: contracts (wire types)

`packages/control-plane-contracts/src/index.ts` (rebuilt):
- `StaffSessionResponse` re-defined as a flat, **optional-field** body (no
  longer extends `StaffSessionIdentity`): `staffUserId?`, `email?`,
  `displayName?`, `surface?`, `role?`, `roles?`, `staffRoles?`, plus
  `capabilities` and `grants?`.
- `CreateStaffInviteResponse.surface` and `StaffInviteRow.surface` now include
  `"both"`.
- `StaffMembershipRow` (member list entry: `userId`, `email`, `displayName`,
  `role`, `enabled`, `surface`, `createdAt`, `updatedAt?`, `revokedAt?`,
  `grantedByUserId?`).
- `AdminStaffList` (`{ members, invites }`).
- `SupportCustomerSummary`, `SupportCustomerList`, `SupportCustomerDetail`
  (with redesigned `supportNotes` + `recentActivity`), `SupportNoteRequest`.

## Changes: control-plane backend

`services/control-plane/src/config.ts`:
- Added `admin.staff.write` to `PlatformAdminCapability` and
  `PLATFORM_CAPABILITY_SET`.

`services/control-plane/src/auth.ts`:
- Added `listStaffMemberships(db)` (join `users`; surface derived from role:
  `support_manager`/`support_agent` → `support`, else `admin`;
  `created_at`/`updated_at`/`revoked_at` normalized to ISO).
- Added `updateStaffMembershipStatus(db, userId, role, action)` supporting
  `disable | enable | revoke` (revoke sets `enabled:false` + `revoked_at`;
  enable clears `revoked_at`).
- `requireAdminSession` hardened to least privilege: only a **superadmin**
  (`role === "superadmin"`) receives `"*"`; durable `platform_admin` gets its
  own capability set; `effectiveRole` may include `"platform_admin"`.
- `displayName` coalesced to `email` when `NULL`.

`services/control-plane/src/api.ts`:
- The three staff-invite routes are now gated `admin.staff.write`
  (superadmin-only via `"*"`) — safe because existing invite tests act as a
  seeded superadmin.
- `GET /api/admin/staff` (member roster + pending invites) and
  `POST /api/admin/staff/:userId/:action` (`disable|enable|revoke`), both
  `admin.staff.write`, with a **self-lockout guard** and audited
  `staff.{action}` events.
- Support console: `GET /api/support/customers` (search by `q`),
  `GET /api/support/customers/:orgId`, `POST
  /api/support/customers/:orgId/notes` (gated `support.ticket.write`, audited
  `support.note`).
- `appendSupportAudit(support, …)` — best-effort writer storing
  `actorType: support:{roles}` and a `redactAdminPayload`-scrubbed `after`. The
  `after` payload is spread at the top level (not nested under `data`), so the
  shared `supportNotes` reader (`after.note`) finds the note — matching how the
  admin support-note route writes it.
- `projectServerOrderForSupport(...)` — Support-safe projection exposing only
  `id`, `orgId`, `computeClassCode`, `state`, `providerName`, `regionCode`,
  `createdAt`, `updatedAt`. Excludes provider account/instance IDs, IPs,
  hostname, ssh key refs, root credentials, last error, and all cost/margin
  material.

## Changes: web client

- `apps/web/src/concepts/staffNav.ts` (new, pure module — no DOM): 
  `AdminTabKey`, `ADMIN_TAB_CAPABILITY`, `ADMIN_TAB_LABEL`, 
  `hasSurfaceCapability` (wildcard-aware), `visibleAdminTabs` (capability
  filtered), `canManageStaff` (superadmin-only via `admin.staff.write`),
  `canSupportLookup` / `canSupportNote`, `SUPPORT_ROLES`.
- `apps/web/src/api/types.ts` + `http-api.ts` + `store.tsx` + `demo-api.ts`:
  `StaffMember`, `AdminStaffInvite`, `AdminStaff`, `CreateStaffInviteInput`,
  `CreatedStaffInvite`, `SupportCustomer`, `SupportCustomerDetail`, and MoxApi
  methods (`adminStaff`, `adminCreateStaffInvite`, `adminRevokeStaffInvite`,
  `adminStaffAction`, `supportCustomers`, `supportCustomer`, `supportAddNote`).
- `apps/web/src/views/AdminView.tsx`: tab list driven by `visibleAdminTabs`
  (capability-aware); defaults to the first visible tab when capabilities
  change; `refresh()` uses `Promise.allSettled` with an optional `adminStaff()`
  call; new **`StaffPanel`** — member roster with Enable/Disable/Revoke
  (`confirmAnd`), invite form with token-shown-once, and pending-invite table
  with Revoke.
- `apps/web/src/App.tsx`: `SupportConsole` rewritten — customer search, list,
  and detail panels (Subscriptions / Servers / Agents / Recent activity /
  Support notes), audited note form gated `support.ticket.write`, capability-
  gated behavior, and an access-denied state when `support.customer.lookup`
  is missing. Added a local `DataTable` helper.

## Security isolation properties

- Admin nav is capability-gated: only a superadmin (`admin.staff.write`) sees
  **Staff & Access**; a `support_*` role sees **zero** admin tabs.
- All staff-management endpoints are server-gated `admin.staff.write`;
  customers and support staff are denied `403` on them (tested).
- Support projections never expose costs, credentials, or host/IP material.
- Support notes are always tenant-targeted and fully audited
  (`support.note`, `actorType: support:…`); note writes require
  `support.ticket.write`.
- Self-lockout guard prevents an actor disabling/revoking their own membership.

## Verification

Ran the focused quality gates plus the disposable real-PostgreSQL suite:

- `@mox/control-plane` `pnpm typecheck` (incl. `tsconfig.test.json`) — pass.
- `@mox/control-plane-contracts` `pnpm build` — pass (rebuild clean).
- `@mox/web` `pnpm typecheck` — pass.
- `@mox/web` `pnpm build` (tsc -b && vite build) — pass, `dist` produced
  (44 modules).
- `@mox/web` `pnpm test` — **6 files / 25 tests pass** including the new
  `tests/staff-nav.test.ts` (capability gating, superadmin-only Staff & Access,
  wildcard semantics, support-never-admin).
- root `pnpm lint` (oxlint) — completes; only pre-existing warnings, none from
  the new files.
- `scripts/run-postgres-verification.ps1` (fresh private cluster, all
  migrations, PG-gated suites + upgrade drill) — **90 tests pass across 5
  files** and `PASS: real PostgreSQL verification completed.` Includes new
  Prompt 03 authorization-matrix / projection / audit tests in
  `auth-integration.test.ts`.
- `git diff --check` — clean (all trailing-whitespace & EOF warnings fixed).

## Outstanding / deferred

- (none blocking) Admin/Support console copy, empty states, and richer
  per-panel detail beyond the gated tabs remain polish for follow-up work.

## Next

Proceed to Prompt 04 (`04_MOX_…`) after manual review of this report and the
working-tree diff.
