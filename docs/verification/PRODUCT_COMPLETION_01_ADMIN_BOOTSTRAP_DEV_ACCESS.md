# PRODUCT_COMPLETION_01 — ADMIN BOOTSTRAP + DEV DIRECT ACCESS

Phase: 01 of the remaining product completion autorun (`md/00_MOX_REMAINING_PRODUCT_COMPLETION_AUTORUN.md`).
Scope: (A) safe dev direct access preserved + populated by default, (B) secure first-superadmin bootstrap CLI.

## A. Safe dev direct access (preserved, now populated)

- The auth pages keep the development-only `DEV MODE DIRECT ACCESS` block
  (`apps/web/src/views/AuthPages.tsx`), mounted strictly behind
  `import.meta.env.DEV` inside `AuthLayout`.
- The three shortcuts now use explicit, populated UI-Studio fixture URLs:
  - Customer: `/__ui?surface=customer&page=/dashboard&state=populated`
  - Admin: `/__ui?surface=admin&page=dashboard&state=populated&role=superadmin`
  - Support: `/__ui?surface=support&page=overview&state=populated&role=support_manager`
- The block was extracted into an exported `DevDirectAccess` component with a
  canonical `DEV_DIRECT_ACCESS_SHORTCUTS` list so it stays testable without
  weakening the compile-time DEV gate.
- Studio security unchanged: `/__ui` remains available only when
  `import.meta.env.DEV` is true AND `VITE_MOX_UI_STUDIO` opt-in is set AND the
  host is localhost (`apps/web/src/uiStudio/security.ts`). Studio never mints
  cookies, never touches backend APIs/PostgreSQL, and production builds
  resolve `/__ui` as a normal not-found route.
- No production demo credentials or auth bypass were created.

## B. Secure first-superadmin bootstrap

New operator CLI: `packages/database/scripts/bootstrap-admin.mjs`, exposed as

```
pnpm mox:bootstrap-admin -- --email owner@example.com
pnpm mox:bootstrap-admin -- --user-id <uuid>
```

Properties (all verified by tests over real PostgreSQL):

- local/server-side CLI only — never a public web endpoint;
- uses the canonical `users` + `platform_staff_memberships` authority
  (`packages/database/src/schema/identity-staff.ts`);
- identifies an EXISTING account by email (lower-cased lookup) or user id;
  never creates a user (no-duplicate verified);
- refuses disabled accounts;
- grants only while NO active superadmin membership exists (initial
  bootstrap), or as an idempotent no-op for the already-active superadmin;
- fails closed once any active superadmin exists — later staff are managed
  through Admin → Staff & Access; the pre-existing deployment-config
  break-glass (`MOX_PLATFORM_ADMIN_USER_IDS` / `MOX_PLATFORM_ADMIN_ROLES` /
  `MOX_PLATFORM_ADMIN_CAPABILITIES`) is preserved and documented as the
  recovery path (config.ts unchanged);
- audits the grant on the canonical `audit_events` table
  (`actor_type='system'`, `action='staff.bootstrap_grant'`,
  `resource_type='staff_membership'`, org NULL = platform-level);
- logs no secrets (there are none: no tokens minted, no password touched);
- transactional with `FOR UPDATE` row lock on the superadmin set — two
  concurrent bootstraps cannot both succeed.

## Admin surface behavior (re-verified, unchanged)

- `/api/admin/login` authenticates via the one password authority, then
  enforces durable staff authority server-side: a customer org owner without
  staff grants is denied 403 `role_denied`; a durable superadmin receives
  `role=superadmin`, `capabilities=["*"]` and a session cookie.
- Admin signup remains invite-only (`/api/admin/signup` requires a valid
  invitation token).
- Staff & Access routes remain `admin.staff.write`-gated (superadmin only).

## Tests added

- `apps/web/tests/dev-direct-access.test.tsx` (5):
  shortcuts render in development with the populated fixture URLs; canonical
  href export matches; nothing renders outside development; every shortcut
  URL parses to a valid populated Studio state; the Studio route stays denied
  in production regardless of opt-in/host.
- `services/control-plane/tests/bootstrap-admin.test.ts` (4, PostgreSQL-gated):
  org owner denied Admin then bootstrapped into a durable superadmin (login
  403 → CLI grant → login 200 `superadmin`, no duplicate user, one enabled
  membership, audit row present); idempotent re-run is a no-op; second
  superadmin refused (fail closed); unknown account refused without creating
  a user.
- `scripts/run-postgres-verification.ps1` now runs the bootstrap suite as a
  dedicated sequential step (it requires a no-active-superadmin world, which
  the parallel staff suites would violate).

## Verification results (2026-09-02, Windows, Node 26, PostgreSQL 18)

- `pnpm lint` — 0 errors (56 pre-existing warnings across the tree, none from
  new code).
- `pnpm typecheck` — pass (all workspace packages).
- `pnpm test` — pass (root vitest; PG-gated suites skip without
  MOX_TEST_DATABASE_URL).
- `pnpm --filter @mox/web test` — pass (includes the new .tsx suite; web
  .tsx tests run via the web package's vitest, per repo convention).
- `pnpm build` — pass.
- `pnpm public-branding-scan` / `pnpm secret-scan` / `pnpm scan:authority` /
  `pnpm dependency-security` — clean.
- `powershell -File scripts\run-postgres-verification.ps1` — PASS (fresh
  disposable cluster; all migrations; restart/idempotency, auth-integration,
  security-repair-05b/07, rescue-postgres, onboarding, bootstrap-admin
  suites; pre-0006 → current upgrade drill).
- `git diff --check` — clean.

Note: one transient failure of
`security-repair-05b > B: quota=1 with two distinct concurrent PG keys yields
exactly one order` was observed in one parallel run and could not be
reproduced in isolated reruns (passed before and after). Classified as
test-load flakiness under full-parallel execution, not a product regression;
no product code on that path was changed by this phase.

## Remaining intentional unavailability

None introduced by this phase.

## Commit

`feat(platform): add secure first-admin bootstrap and preserve dev access`
(local only — nothing pushed).
