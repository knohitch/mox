# MOX — PROMPT 01
# Unified Dashboard Design System + Safe Local UI Studio for Customer, Admin and Support

## ROLE

You are the implementation agent working directly on:

`E:\MyCodes\Mox`

Canonical branch:

`master`

Reference GitHub HEAD when this prompt was created:

`c0f678641dc4ff2798071b478f10dcb35ae85c8f`

Before editing:

```cmd
git fetch --prune origin
git branch --show-current
git rev-parse HEAD
git rev-parse origin/master
git status --short
```

Rules:

- branch must be `master`;
- working tree must be clean;
- if the repository has legitimately advanced beyond the reference SHA, DO NOT reset it — re-scan the current clean `master` and work from the actual HEAD;
- if working tree is dirty, STOP and report; never discard user work;
- do not push to GitHub;
- do not weaken authentication or authorization to make visual testing easier.

---

# PRIMARY OBJECTIVE

The developer needs to be able to work quickly on the UI for all three browser products:

1. Customer / User dashboard
2. Mox Admin dashboard
3. Mox Support dashboard

without repeatedly creating special accounts or fighting production authentication merely to inspect/edit visual components.

At the same time, production security must remain unchanged.

Implement TWO things:

1. a **unified Mox dashboard design system** shared visually across Customer, Admin and Support;
2. a **strictly development-only UI Studio / Preview mode** that allows local visual access to Customer, Admin and Support dashboards without creating an authentication backdoor.

This is a developer experience feature, not a production authentication bypass.

---

# PART A — CANONICAL DASHBOARD URLS

Normalize the real product routes.

## Customer

Canonical authenticated customer home:

`/dashboard`

`/` must redirect appropriately and must not be a second separately-rendered dashboard.

Customer routes should include:

- `/dashboard`
- `/agents`
- `/rooms`
- `/servers`
- `/deployments`
- `/models`
- `/integrations`
- `/channels`
- `/usage`
- `/billing`
- `/backups`
- `/settings`

Unauthenticated production navigation to `/dashboard` must still redirect to `/login`.

Do NOT remove the auth guard.

## Admin

Canonical protected Admin entry remains:

`/admin`

Admin auth remains:

- `/admin/login`
- `/admin/signup`
- `/admin/forgot-password`
- `/admin/reset-password`

## Support

Canonical protected Support entry remains:

`/support`

Support auth remains:

- `/support/login`
- `/support/signup`
- `/support/forgot-password`
- `/support/reset-password`

Customer navigation must never show Admin or Support.

Support must never gain Admin navigation.

---

# PART B — UNIFIED DESIGN SYSTEM

The three products must feel like one Mox platform while retaining different information architecture and permissions.

Do NOT merge the Customer, Admin and Support applications into one authorization surface.

"Unified" means:

- shared design tokens;
- shared typography;
- shared spacing/radius system;
- shared button/input/card/table primitives;
- shared topbar/sidebar visual language;
- shared empty/loading/error state language;
- shared responsive behavior;
- shared icon sizing and interaction states;
- shared accessibility rules;

while each surface keeps its own:

- routes;
- navigation;
- data;
- capabilities;
- authorization;
- terminology where appropriate.

Refactor duplicated CSS/components only where it reduces drift.

Do not destroy working surface-specific components merely to make everything abstract.

---

# PART C — DEVELOPMENT-ONLY UI STUDIO

Create a local visual development surface, for example:

`/__ui`

or another clearly internal development path.

It must allow the developer to preview:

- Customer dashboard shell
- Admin dashboard shell
- Support dashboard shell

from a single local page.

Recommended UI Studio structure:

```text
Mox UI Studio

Surface:
[ Customer ] [ Admin ] [ Support ]

Page:
[ Dashboard / Overview / ... ]

State:
[ Populated ] [ Empty ] [ Loading ] [ Error ] [ Gated ]
```

The UI Studio should make it easy to switch between representative pages/components without logging in.

---

# CRITICAL SECURITY REQUIREMENTS FOR UI STUDIO

The UI Studio MUST be impossible to use as a production auth bypass.

Require ALL applicable protections:

1. available only in Vite development mode:
   - `import.meta.env.DEV === true`

2. explicit opt-in:
   - e.g. `VITE_MOX_UI_STUDIO=1`

3. local browser host only:
   - `localhost`
   - `127.0.0.1`
   - optionally `[::1]`

4. production build:
   - route must resolve as normal Not Found;
   - no production API authorization bypass;
   - no Admin/Support real API calls using fake authority.

5. preview fixtures:
   - deterministic local fixture data;
   - no real secrets;
   - no production credentials;
   - no API keys;
   - no real customer data;
   - no real session impersonation.

6. the UI Studio must never:
   - create fake production sessions;
   - modify cookies;
   - create Admin roles;
   - create Support roles;
   - call privileged mutations under simulated identity;
   - alter PostgreSQL;
   - bypass server-side route guards.

The purpose is visual/component development only.

---

# PART D — UI STUDIO DATA / FIXTURES

Create typed fixture factories close to web code.

Do not create huge hand-written anonymous objects scattered across components.

Provide realistic safe fixtures for:

## Customer
- workspace
- user
- agents
- rooms
- servers
- deployments
- models
- integrations
- channels
- usage
- billing
- backups
- notifications
- settings states

## Admin
- platform overview
- customers
- plans/pricing
- billing providers
- compute
- intelligence/models
- runtime
- operations
- notifications
- staff/access

## Support
- customer lookup
- customer detail
- subscriptions
- server health
- agents/deployments
- model/integration/channel configured state
- notes
- diagnostics

Fixtures must never be imported into production server authority.

---

# PART E — ACTUAL DASHBOARD LAYOUT

Improve the actual shared dashboard visual foundation so visual edits in the UI Studio map directly to production components.

Create/refine shared components such as, where appropriate:

- `AppShell`
- `Sidebar`
- `TopBar`
- `PageHeader`
- `MetricCard`
- `Panel`
- `DataTable`
- `Badge`
- `StatusIndicator`
- `EmptyState`
- `LoadingState`
- `ErrorState`
- `SectionNav`
- `ProfileMenu`
- `WorkspaceSwitcher`

Do not force all surfaces to use every component.

---

# PART F — CUSTOMER DASHBOARD

Canonical route:

`/dashboard`

Customer dashboard should provide a polished operational home using authoritative data in real production mode.

Good sections, only where real data exists:

- workspace heading
- plan/subscription status
- agents
- running/active agents
- deployments
- approvals
- servers
- usage
- recent activity
- setup/getting-started state
- useful quick actions

No Admin/Support/internal platform data.

---

# PART G — ADMIN DASHBOARD

`/admin`

Use the same visual system but an Admin-specific information architecture.

Admin Overview may include real authorized platform metrics such as:

- customers
- subscriptions
- payment state
- compute/server state
- runtime health
- incidents
- notifications
- staff/access alerts
- provider/platform operational health

Only show data current Admin capabilities permit.

Do not expose a tab merely because fixture data exists.

---

# PART H — SUPPORT DASHBOARD

`/support`

Use the same visual system but a Support-oriented workflow.

Prioritize:

- customer search
- recently viewed/active support context if real
- customer health summary
- subscription lifecycle
- server/agent status
- support notes
- safe diagnostics

Never show:

- provider secrets
- system credentials
- wholesale costs
- margins
- Admin-only staff authority
- platform mutation controls

---

# PART I — RESPONSIVE / ACCESSIBILITY

Test at minimum:

- 1440px desktop
- 1280px laptop
- tablet
- ~390px mobile

Requirements:

- no unintended horizontal shell overflow;
- mobile sidebar/drawer behavior;
- usable tables;
- visible focus;
- semantic headings;
- accessible forms;
- icon-only controls have labels;
- sufficient contrast;
- reduced-motion support where animations exist.

---

# PART J — HOW THE DEVELOPER STARTS UI STUDIO

Add a clear development command/script to the web package or root package.

Preferred developer experience should be simple, for example:

```cmd
pnpm ui:studio
```

or:

```cmd
set "VITE_MOX_UI_STUDIO=1" && pnpm --filter @mox/web dev
```

If adding a root script is safe, prefer:

```json
"ui:studio": "..."
```

Document the actual URL.

The user should be able to launch the frontend and immediately switch among Customer/Admin/Support visual surfaces.

---

# PART K — TESTS

Add tests proving:

## Security
- UI Studio is enabled only in DEV + explicit opt-in;
- UI Studio unavailable in production config;
- UI Studio local-host restriction;
- no fake auth cookie/session creation;
- no privileged HTTP mutation from fixtures.

## Routing
- `/dashboard` is canonical customer dashboard;
- `/` redirects rather than duplicates dashboard;
- unauthenticated real `/dashboard` still goes to `/login`;
- real `/admin` and `/support` retain auth/capability guards.

## Isolation
- Customer preview contains no Admin/Support navigation;
- Support preview contains no Admin-only controls;
- production customer shell contains no Admin/Support controls.

## UI
- Customer/Admin/Support fixture modes render;
- populated/empty/loading/error states render;
- shared primitives do not regress actual pages.

---

# VERIFICATION

Run:

```cmd
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

Run PostgreSQL verification if backend source or API contracts were changed:

```cmd
powershell -ExecutionPolicy Bypass -File scripts\run-postgres-verification.ps1
```

Do not weaken tests to obtain green status.

---

# FINAL REPORT

Create:

`docs/verification/UI_STUDIO_UNIFIED_DASHBOARDS.md`

Report:

1. starting SHA
2. files changed
3. canonical route changes
4. shared design-system changes
5. UI Studio URL and launch command
6. exact production-disable controls
7. Customer preview coverage
8. Admin preview coverage
9. Support preview coverage
10. responsive/accessibility changes
11. tests and totals
12. verification results
13. remaining blockers
14. confirmation production auth was not weakened
15. confirmation no push occurred

After all gates are green, create a local commit:

`feat(ui): add unified dashboard design system and local ui studio`

Do not push.

STOP after report and local commit.
