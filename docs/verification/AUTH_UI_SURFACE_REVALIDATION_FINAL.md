# MOX — PROMPT 04
# Final Authentication / UI / Surface-Security Revalidation — FINAL

**Audited SHA:** `aaccd09` — `feat(auth-ui): complete Prompts 01-03 auth routing, customer UI, admin/support consoles`

**Date:** 2026-08-27

**Mode:** Read-only release revalidation. No source modified, no tests rewritten, no commit, no push, no migration created. The only artifact produced is this report.

---

## 1. Audited SHA

`aaccd09` (HEAD) — the commit that completes Prompts 01–03 (auth routing, customer UI reconstruction, Admin/Support consoles).

## 2. Working-Tree Cleanliness

`git status --porcelain` → **0 entries. TREE CLEAN.**
`git diff --check` → **exit 0** (no whitespace errors).

## 3. A — Auth URL Matrix

Verified by source (router + `App.tsx` route tables) and the executable `nav.test.ts` / `staff-nav.test.ts` (11 passed).

The app is a shallow History-API router reading `window.location.pathname` on load, so browser **refresh and deep-links resolve the real path** (not just client-side navigation). A static-server fallback to `index.html` is required/configured.

| Surface | Route | First-match dispatch |
|---|---|---|
| Customer public | `/login` `/signup` `/forgot-password` `/reset-password` | `CUSTOMER_PUBLIC` (App.tsx:46) |
| Customer protected | `/` `/agents` `/rooms` `/deployments` `/servers` `/models` `/integrations` `/channels` `/usage` `/billing` `/settings` | `CUSTOMER_ROUTES` (App.tsx:31–43) |
| Admin public | `/admin/login` `/admin/signup` `/admin/forgot-password` `/admin/reset-password` | `ADMIN_PUBLIC` (App.tsx:48) |
| Admin protected | `/admin` + subroutes | `StaffSurface("admin")` (App.tsx:507) |
| Support public | `/support/login` `/support/signup` `/support/forgot-password` `/support/reset-password` | `SUPPORT_PUBLIC` (App.tsx:49) |
| Support protected | `/support` + subroutes | `StaffSurface("support")` (App.tsx:508) |

`SurfaceRouter` (App.tsx:505–510) dispatches strictly by URL prefix: `/admin*` and `/support*` never reach `CustomerSurface`, and `CustomerPublicAuth`/`StaffSurface` auth pages render **without** the logged-in shell. Route confusion between surfaces is structurally prevented.

**Result: PASS.**

## 4. B — Authentication Behavior

Verified by the real-PostgreSQL auth-integration suite (90 tests, PG) + source tracing.

- **HttpOnly cookie session authoritative:** signup/login issue HttpOnly cookie; `/api/me` authenticates via cookie alone (auth-integration §B/§I lines 139, 208; §A 399–424). Tokens never appear in browser login/signup JSON (`not.toContain("sessionToken")`, no `mox_pat_`/Bearer); org-switch response carries no bearer material (426–441).
- **CSRF preserved:** cookie-authenticated mutations require the CSRF header (line 265).
- **Logout clears/revokes session:** logout revokes session; expired sessions fail (line 188).
- **Password policy / KDF unchanged or stronger:** `password.ts` uses Node `scrypt` (N=2^15, r=8, p=1, OWASP interactive baseline), per-password 16-byte random salt, timing-safe compare, min 12-char policy, algorithm `scrypt`. Consistent with prior — **unchanged baseline, per contract.**
- **Reset tokens hashed, expiring, one-use:** only the SHA-256 hash is stored (never plaintext); expired token rejected (400); reuse rejected (400) (2574–2669).
- **Reset anti-enumeration:** unknown email returns a generic 200, nothing stored; constant-shape one-KDF behavior for unknowns (auth.ts:486) (2580–2586).
- **Password reset revokes existing sessions:** pre-reset session returns 401 afterward (2646–2648).
- **Staff invites hashed, expiring, one-use:** `mox_invite_` token; list API returns no plaintext; consume once; reuse fails (2671–2740).
- **Invite email/role/surface binding:** wrong email on redeem → 400; revoked invite → 400 (2742–2779).
- **Invalid staff signup creates no staff assignment:** `/support/signup` without a valid invite → 400 and creates nothing (2708–2714).
- **No auth/reset/invite token leakage:** reset/invite stored as hashes; request logs contain pathname only — never query secrets/auth headers (line 331).

**Result: PASS.**

## 5. C — Authorization Matrix

Verified by the real-PostgreSQL auth-integration suite + source.

| Actor | Customer surface | Support | Admin |
|---|---|---|---|
| unauthenticated | public auth pages only | public auth pages only | public auth pages only |
| normal customer | allowed by org/entitlement | DENY (403) | DENY (403) |
| customer org owner | customer | DENY (403) | DENY (403) — `surface isolation: customer (even org owner) denied Admin and Support` (line 2781) |
| support_agent | only if separately customer member | ALLOW (support.*) | DENY (403) — `/api/admin/session` 403, `/api/admin/staff` 403 (2738–2739, 2890, 2987) |
| support_manager | per explicit support caps | ALLOW by caps | DENY unless separately granted |
| platform_admin / superadmin | only if separately customer member | only if separately granted | ALLOW by caps |

- Cross-surface matrix: `customer and support staff can never reach admin staff routes` (2987–2998).
- **Organization role never substitutes for platform staff role:** staff identity is a separate `platformStaffMemberships` grant; org-role matrix (line 1087) keeps workspace/billing/infra authority distinct; admin scope requires real admin capability and `*` cannot self-escalate (794).
- Server-gated: Admin/Support APIs require server-issued staff session (`/api/admin/session`, `/api/support/session`), not the customer cookie alone.

**Result: PASS.**

## 6. Invite / Reset Results

See §4. Invites: admin-only creation (403 for customers), hashed storage, one-use, email/role/surface-bound, revocable, invalid/revoked → 400 with no grant. Resets: hashed, expiring, one-use, session-revoking, anti-enumerating.

**Result: PASS.**

## 7. D — Customer Non-Disclosure

Verified structurally (not CSS hiding) plus executable tests.

- Customer nav (`nav.ts`) has a **forbidden-term guard** (`admin`, `support`, `operations`, `abuse`, `runtime`, `provider`, `payment`, `margin`, `notification`); `CustomerShell.tsx` states it "NEVER exposes staff surfaces". `nav.test.ts` asserts `CUSTOMER_DESTINATIONS` contains no staff root and passes `hasForbiddenDestination` (48–64).
- The forbidden check is **data/model-level**, not CSS: the customer IA never lists Admin/Support/staff nav/margin/provider-admin/runtime/staff-and-access.
- `CustomerPublicAuth` renders standalone auth pages with **no shell** (App.tsx:74–127).

**Result: PASS.**

## 8. E — Support Least Privilege

Verified by the PG suite + source.

- Support customer projection (`/api/support/customers`, detail) **excludes** `costMargin`, `costMinor`, `revenue`, `providerAccountId`, `providerInstanceId`, `rootCredentialRefId`, and any `ipv4/ipv6/hostname/sshKeyId` — asserted on both list and detail (2925–2959).
- Support notes/actions audited: `support.note` action persisted with `support:` actorType (2961–2985); support note write requires `support.ticket.write`.
- Capability gates client-side (`canSupportLookup`/`canSupportNote`) mirror server grants; support surface carries no `admin.*` capabilities (`staff-nav.test.ts` line 33).

**Result: PASS.**

## 9. F — Admin Access

- **Admin shell renders only after server staff authorization:** `StaffSurface` calls `verifyStaffSession(kind)` on mount and renders `<AdminView/>` only when `staffReady && staffSession` (App.tsx:381–383, 456–460); a plain user (even org owner) is redirected to `/admin/login` and server returns 403 on `/api/admin/*`.
- **Admin APIs server-gated:** `/api/admin/staff` requires `admin.staff.write` (superadmin); support_agent → 403 (2890–2904, 2987).
- **Staff invite/assignment requires sufficient capability:** invite create gated to staff admin (403 for customers) (2700–2706).
- **Support role cannot self-promote:** `/api/support/signup` grants only the invite's bound surface/role; support cannot reach `/api/admin/session` (2734–2739); staff/admin routes deny non-superadmin (2890).
- **Org role and platform staff identity are separate concepts:** distinct `platformStaffMemberships` + capability model (staff-nav tests; org-role matrix at 1087).

**Result: PASS.**

## 10. G — Open Redirect / Route Confusion

Verified by client + server guards and the PG test `customer login return target cannot escape into Admin/Support or open redirect` (2825–2858).

- Client `safeCustomerReturn` (App.tsx:57–64) rejects `//`, `://`, `\`, non-`/`, `/admin*`, `/support*`.
- Staff `safeReturnToStaff` (App.tsx:487–491) constrains to the same surface root.
- **Server-enforced `safeCustomerReturnTarget`** tested: `https://evil.example` → `/`, `//evil.example` → `/`, `/admin` → `/`, `/agents?tab=1` preserved (2830–2857).
- Spec's `next` parameter is **not used** by this implementation (it uses `returnTo`); `?next=` is inert, so no `next`-based redirect is possible.

**Result: PASS.**

## 11. H — UI Functional Regression

- Auth pages never render the logged-in shell (standalone auth components).
- Customer shell has no staff links (see §3/§7).
- Responsive navigation: grouped IA rendered from `CustomerShell`/`nav`.
- Loading/error/empty states honest: `Connecting`, `backend-error`, `EmptyState` used throughout SupportConsole and customer surface.
- **Backend unavailable does not show a fake healthy dashboard:** `CustomerSurface` shows connecting / explicit `backend-error` ("the Mox web app never falls back to demo data", App.tsx:162–166).
- **No production demo fallback:** `config.ts` hard-fails `VITE_DEMO_MODE=1` in production builds (config.ts:29); `demo-api.ts` is a dev-only labeled seam; store.tsx shows honest error surfaces.
- No major horizontal overflow introduced (admin-table uses a scroll wrapper).
- Form inputs use associated labels/placeholders with role/semantics; buttons are `type="button"` where non-submit to avoid accidental submits.

No Critical/High/Medium security items. Any UI variables are cosmetic/informational (none render staff surfaces).

**Result: PASS (no release-blocking UI defects).**

## 12. I — Prior Security Regression Pass

- **Real-PostgreSQL drill: PASS** (`PASS: upgrade drill — history preserved, resubscribe works, FX migrated, new objects present`; 90 tests / 5 files green).
- Full monorepo suite: **555 passed / 70 files** (80 skipped are the PG-requiring suites covered by the PG run) — includes prior security repairs: customer/system credential authority isolation, billing seed idempotency, payment lifecycle/refund/dispute authorization, compute fencing/quota/cancel authority (category/audit-org), SSRF/request-target, gateway signing secret, default-deny egress, admin audit, notification durability, node enrollment (auth-integration test list lines 557–2501; full-suite PASS).
- Scans: `secret-scan` clean; `scan:authority` clean (no vendored-tree imports); `public-branding-scan` clean.

**Result: PASS — no regression.**

## 13. Exact Tests / Totals

- `pnpm test` (root, non-PG): **70 files passed, 555 tests passed** (80 skipped = PG-requiring, covered below).
- Real-PostgreSQL verification (`run-postgres-verification.ps1`): **5 files passed, 90 tests passed** + **`PASS: upgrade drill`** + **`PASS: real PostgreSQL verification completed.`**
- Focused web router/staff/support suites (`nav.test.ts` + `staff-nav.test.ts`): **11 passed**.
- **Combined authenticated + integration tests: 555 + 90 = 645 passing** (70+5 files), with 80 PG-requiring tests residing inside the 90 for the run that has Postgres.

## 14. All Commands / Results

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | lockfile up to date, 3s ✅ |
| `pnpm lint` | clean — warnings only (pre-existing unused-var lint, no errors) ✅ |
| `pnpm typecheck` | all 38 packages Done ✅ |
| `pnpm test` | 555 passed / 70 files ✅ |
| `pnpm build` | all packages Done ✅ |
| `pnpm public-branding-scan` | clean ✅ |
| `pnpm secret-scan` | clean ✅ |
| `pnpm scan:authority` | clean ✅ |
| `pnpm dependency-security` | 1 moderate advisory (no high/critical) — informational ⚠️ |
| `git diff --check` | exit 0 ✅ |
| `run-postgres-verification.ps1` | 90 passed + upgrade drill PASS ✅ |
| Focused auth/router/staff/support suites | web 11 passed; auth-integration covered by PG 90 ✅ |

## 15. Remaining Findings

No **Critical**, **High**, or **Medium** findings affecting authentication or cross-surface authorization.

Informational (non-blocking):
- `dependency-security`: one **moderate** npm advisory (no high/critical). Pre-existing, unrelated to the AUTH UI work.
- Spec §G lists a `next` parameter; this implementation uses `returnTo` (and `next` is inert). Behavior-equivalent and safe — documented for clarity.

No customer-accessible Admin/Support path exists without server enforcement (all cross-surface routes 403 without a matching staff session).

---

## FINAL DECISION

## **CLOSED — READY FOR NEXT PRODUCTION PHASE**

All fifteen report sections pass. The authentication redesign, customer UI reconstruction, and Admin/Support separation are production-consistent with no regression to prior Mox security. No auth- or cross-surface-authorization block exists.
