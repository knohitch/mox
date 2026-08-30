# MOX — 03
# FINAL UI EXPOSURE, NAVIGATION, AND HIDDEN-FEATURE REVALIDATION

## Objective

Perform a fresh final audit after Phases 01 and 02.

Do not assume the work is correct because unit tests are green.

Prove that every legitimate Customer/Admin/Support capability is visible, navigable, and renders correctly, and that no new Studio work weakened production authorization.

This is the release gate before mandatory onboarding work begins.

## A. Rebuild the matrix from source

Freshly inspect:
- Customer nav/routes/views
- Admin nav/routes/views
- Support nav/routes/views
- Studio navigation/context
- Studio fixtures
- MoxApi
- HttpMoxApi
- Control Plane routes
- Mox-owned services/packages/runtime
- staff capability definitions
- entitlement definitions

Create `docs/verification/UI_COMPLETION_FINAL_MATRIX.md`.

Columns:

| Capability | Surface | Route/Page | API | Component | Studio Preview | Gate | Runtime Status | Classification |

There must be zero `UNCLASSIFIED`.

## B. Search for hidden/dead functionality

Search for:
- exported service methods with no product caller
- MoxApi methods with no UI caller
- safe Control Plane route with no client method
- Admin mutation authority with read-only UI
- Support-safe data with no visible section
- configuration field never editable
- route/component unreachable from navigation
- fixture capability absent from Studio
- `TODO`
- `FIXME`
- `not implemented`
- `not configured`
- `501`
- `ApiUnavailableError`
- suspicious `return []`
- hardcoded status/metric
- unconditional availability
- synthetic authority IDs
- buttons with no handler
- handlers that only log
- `href="#"`
- dead dropdowns
- hidden tabs due capability mismatch
- UI method omitted from store/interface
- populated preview accidentally rendering empty data
- raw backend field names exposed unintentionally
- page components that are never referenced

Every hit must be:
1. fixed;
2. intentionally `INTERNAL_ONLY`; or
3. intentionally `NOT_PRODUCTIZED_BLOCKED` with truthful UX and report rationale.

## C. Click-everything Studio walkthrough

### Customer
Traverse:
- Dashboard
- Agents
- Agent Rooms
- Deployments
- Servers
- Models
- Apps & Integrations
- Channels
- Usage
- Billing
- Backups
- Settings

On every page verify:
- visible page heading/landmark;
- populated content;
- empty state;
- loading state;
- error state;
- gated state when applicable;
- primary internal links/actions do not blank the screen;
- preview navigation remains inside `/__ui`.

### Admin — Superadmin
Traverse every visible Admin page.

Verify at least all current legitimate sections discovered from source.

### Admin — reduced roles
Verify page visibility and action visibility follow canonical capabilities.

### Support Manager
Traverse every manager-visible page/section.

### Support Agent
Traverse every agent-visible page/section.

## D. Blank-screen detector

Add/retain a development/test safeguard so a resolved route cannot silently render an effectively empty root due to an uncaught error.

Tests should detect:
- empty application root;
- missing expected page landmark;
- uncaught component exception.

A deliberate EmptyState counts as valid content.

In development, render useful safe diagnostics instead of a silent black screen.

## E. Production authority regression

Prove:
- unauthenticated `/dashboard` still requires Customer login;
- unauthenticated `/admin` still requires Admin staff auth;
- unauthenticated `/support` still requires Support staff auth;
- Customer cannot access Admin/Support;
- Support cannot access Admin;
- org role does not become staff authority;
- UI Studio is DEV + opt-in + localhost only;
- Studio fixtures do not create real cookies/tokens;
- Studio does not call privileged real mutations.

## F. Fixture/data isolation

Prove Studio fixtures cannot enter production behavior.

Production Customer/Admin/Support must use real API data.

Search build/import boundaries.

No fixture customer, fixture revenue, fixture server, fixture usage, fixture health, fixture payment, or fixture activity may appear in normal production paths.

## G. UI quality review

Review all three surfaces for:
- giant unused space;
- too-small text;
- poor hierarchy;
- raw camelCase/schema labels;
- clipped table headers;
- inconsistent padding;
- inconsistent buttons;
- malformed responsive tables;
- sidebar overflow;
- hidden mobile actions;
- forms without labels;
- duplicate page titles;
- stale horizontal tabs after sidebar conversion;
- inconsistent status colors;
- raw JSON shown to normal users;
- buttons visually enabled when action is unavailable.

Fix bounded defects found.

Do not start onboarding in this phase.

## H. Full verification

Run:

```cmd
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm public-branding-scan
pnpm secret-scan
pnpm scan:authority
pnpm dependency-security
git diff --check
```

If any backend/API/database code changed in the pack:

```cmd
powershell -ExecutionPolicy Bypass -File scripts\run-postgres-verification.ps1
```

If browser E2E infrastructure exists, run it.

## I. Final report

Create `docs/verification/UI_COMPLETION_FINAL_REVALIDATION.md`.

Include:

### Repository
- starting SHA
- ending SHA
- local commits

### Customer
- all pages
- all surfaced capabilities
- gated/blocked capabilities
- route traversal result

### Admin
- all Superadmin pages
- reduced-role matrix
- surfaced management actions

### Support
- Support Manager pages
- Support Agent pages
- safe data boundary proof

### Studio
- surface/role/page/state navigation
- deep links
- no blank pages
- production isolation

### Hidden-feature audit
- final hidden features found
- fixes
- intentionally internal/blocked items

### UI quality
- responsive results
- accessibility results
- remaining design debt

### Verification
- exact commands
- exact test totals
- skips/failures
- PostgreSQL result if run

Final decision must be exactly one of:

`CLOSED — READY FOR ONBOARDING IMPLEMENTATION`

or

`REPAIR REQUIRED`

Do NOT mark CLOSED if any Critical/High functional problem remains, including:
- blank page
- legitimate page inaccessible
- cross-surface leakage
- production auth bypass
- fixture leakage into production
- major capability hidden from the role that owns it

If CLOSED and all gates are green, create local commit:

`test(ui): close product surface completion revalidation`

Do not push.
