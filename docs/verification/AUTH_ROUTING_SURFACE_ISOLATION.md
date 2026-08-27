# Prompt 01 — Auth Routing & Surface Isolation (Frontend)

## Scope

This report documents the completed web-client portion of Prompt 01
(`01_MOX_AUTH_ROUTING_AND_SURFACE_ISOLATION.md`): converting the router from
hash-based to History-API **real paths**, and enforcing the three isolated
surfaces (customer / admin / support) at the URL layer with standalone auth
pages that never render the logged-in app shell.

The control-plane (backend) half was completed and PG-validated previously
(86/86 tests). This report re-confirms the combined state and captures the
frontend deltas.

## Repository State

- Working tree branch: `master` (no commit; commit/push is intentionally manual
  after review).
- Baseline matching SHA (`43b0f3cf8f74ebca514a0cfb678b4770bf4ed033`).

## Changes: contracts (wire types)

`packages/control-plane-contracts/src/index.ts` — added typed contracts so the
client and server share the staff-surface and password-recovery protocol:

- `StaffSessionIdentity`, `StaffSessionResponse` — admin/support session probe
  (identity + capabilities; never a reusable credential).
- `StaffLoginResponse` — staff login response (identity + capabilities +
  server-validated `returnTo` + cookie `expiresAt`).
- `ForgotPasswordResponse` (anti-enumeration envelope, optional
  `deliverableToken`), `ResetPasswordRequest`.
- `StaffSignupRequest` (invite-first staff signup).
- `LoginRequest.returnTo?: string` — carried to the backend which re-validates
  it with `safeCustomerReturnTarget`.

## Changes: web client

- `apps/web/src/router.tsx` — replaced the hash router with a History-API path
  router. Kept `matchPath`/`resolveParams`/`Link`/`useRoute`. Added:
  - `currentPath()` reads `location.pathname` (basename-aware).
  - `navigate()` uses `history.pushState` and dispatches a `mox:navigate`
    event so observers rerender on programmatic navigation.
  - `Link` renders a real `<a href>` (shareable, crawlable) and intercepts the
    click for SPA navigation, honoring modifier keys / `target=_blank`.
  - Optional `RouterConfig.basename` for sub-path hosting.
- `apps/web/src/api/http-api.ts` — added staff surface + recovery calls:
  `adminLogin`, `supportLogin`, `adminSession`, `supportSession`,
  `adminSignup`, `supportSignup`, `forgotPassword`, `resetPassword`.
- `apps/web/src/api/store.tsx` — added staff surface state + controllers on the
  store: `staffSession`, `staffSurface`, `staffReady`, `staffError`,
  `verifyStaffSession`, `adminLogin`, `supportLogin`, `adminSignup`,
  `supportSignup`, `staffSignOut`, `forgotPassword`, `resetPassword`.
- `apps/web/src/views/AuthPages.tsx` — new standalone (no app-shell) auth
  components: `LoginPage`, `SignupPage`, `ForgotPasswordPage`,
  `ResetPasswordPage`, `PermissionDenied`, plus a per-surface `AuthLayout`.
  Semantic credential labels + autocomplete; staff signup is invite-required.
- `apps/web/src/App.tsx` — rewrote as a root **surface router**:
  - `SurfaceRouter` dispatches on the URL prefix: `/admin` → admin surface,
    `/support` → support surface, otherwise customer surface.
  - Customer surface: removed `/admin` from the route table; removed
    **Mox Admin** from the customer NAV; protected routes redirect to
    `/login?returnTo=…` when unauthenticated; public routes
    (`/login`, `/signup`, `/forgot-password`, `/reset-password`) render the
    standalone auth pages.
  - Admin/support surfaces: verify the staff session on mount
    (`verifyStaffSession`), show standalone public auth pages under their
    surface prefix, redirect to the surface login when there is no session, and
    mount the protected console (`AdminView` / a `SupportConsole` stub) inside a
    `StaffShell` with an explicit staff identity + sign-out.
  - Client-side return-target guard `safeCustomerReturn` (defense in depth,
    mirroring the server's `safeCustomerReturnTarget`) plus a staff
    `safeReturnToStaff` that confines post-login redirects to the announced
    surface root.
- `apps/web/vite.config.ts` — set `appType: "spa"` and documented the required
  production static-host fallback (never a 404 at a real path).

No static/nginx host config exists in this repo (verified by search), so the
production SPA-fallback is a documented deployment requirement rather than a
checked-in server config.

## Security Isolation Properties

- Customers can never reach the admin/support shells: those live under distinct
  URL prefixes and are not linked from the customer NAV.
- Auth pages render **outside** the app shell, so an unauthenticated visitor
  never sees product IA or workspace chrome.
- Staff access is invite-first and server-verified; a customer account without
  staff authority is denied `403 role_denied` at login.
- `returnTo` is validated both client-side and (authoritatively) server-side;
  escapes to other surfaces, schemes, `//`, `\` and encoded variants are
  rejected.
- The session credential remains HttpOnly-cookie-only; no token enters JS or
  any URL.

## Verification

Ran the repo's focused quality gates and the PG verification:

- `apps/web` `pnpm typecheck` — pass.
- `apps/web` `pnpm build` (tsc -b && vite build) — pass, `dist` produced.
- `apps/web` `pnpm test` — 4 files / 14 tests passed (router `matchPath`,
  work view, roster, demo-api).
- root `pnpm lint` (oxlint) — completes; only pre-existing warnings, none from
  the new frontend files.
- `scripts/run-postgres-verification.ps1` (fresh private cluster, port 5433,
  all migrations including `0018_auth_staff_surfaces.sql`) — **86/86 tests pass
  and `PASS: real PostgreSQL verification completed.`**

## Outstanding / deferred

- Production static-host SPA fallback must be configured at deploy time
  (nginx/S3/CDN rewrite to `index.html`) or a deep link to a real path will
  404. This is documented, not code-pinned.
- Full Admin and Support consoles are out of Prompt 01 scope (Prompt 03 covers
  them); this prompt delivered the surface routing + auth isolation that gates
  them.

## Next

Proceed to Prompt 02 (`02_MOX_CUSTOMER_APP_UI_RECONSTRUCTION.md`) after manual
review of this report and the working-tree diff.
