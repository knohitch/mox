# UI Completion 02 — Customer, Admin, and Support product reconstruction

**Starting SHA:** `c772b90` (`fix(ui-studio): expose all legitimate surfaces and repair preview navigation`)  
**Branch:** `master` (not pushed)  
**Pack:** `moxui/02_REBUILD_CUSTOMER_ADMIN_SUPPORT_UI.md`

## Before / after architecture

**Before.** Customer dashboard was a fake “Tasks report” kanban with invented counts (`|| 24`, comments `109`, burndown). Admin and Support were an empty staff sidebar plus horizontal camelCase tabs. Topbar included a non-authoritative search box. Brand chrome used a purple/pink/orange gradient.

**After.** Shared pitch-black tokens drive all three surfaces. Customer topbar uses the real workspace switcher, notification bell, profile menu, and Create agent. Admin and Support have capability-filtered sidebar IA; page chrome is the same production components Studio renders. Tables use human labels. Empty / gated / error states explain the next action.

Studio did not get a parallel prettier tree. `UiStudioView` still mounts `HomeView`, `AdminView`, and `SupportConsole`.

## Customer IA

```
HOME          Dashboard
BUILD         Agents, Agent Rooms, Deployments
INFRASTRUCTURE Servers, Models
CONNECT       Apps & Integrations, Channels
ACCOUNT       Usage, Billing, Backups, Settings
```

No Admin or Support links. Settings is split: Profile, Workspace, Team, Notifications, Developer.

## Admin IA

```
OVERVIEW         Dashboard
CUSTOMERS        Customers, Enterprise Contracts
COMMERCIAL       Plans & Pricing, Payments
INFRASTRUCTURE   Compute, Models / Intelligence, Runtime
OPERATIONS       Notifications, Operations
PLATFORM         Staff & Access
```

Reduced roles see only capability-owned groups. Superadmin Studio preview still shows all.

## Support IA

```
SUPPORT  Overview, Customer Lookup, Diagnostics, Notes, Activity, Escalations
```

Overview is the landing page. Escalations only for `support.escalate` (Support Manager). Support Agent never receives Admin capabilities.

## Pages completed

- Customer dashboard rebuilt as operational summary (real agents/servers/deployments/approvals/usage).
- Customer topbar: workspace switcher, page title, notifications, profile, Create agent. Fake search removed.
- Settings subsection navigation.
- Agent Rooms gated state when entitlement is off.
- Admin dashboard: needs-attention chips, revenue (not wholesale margin), human table headers, sidebar instead of primary tabs.
- Support overview chips from authorized customer diagnostics; human table headers; sidebar IA.

Existing Customer list pages (Agents, Deployments, Servers, Models, Integrations, Channels, Usage, Billing, Backups) keep their real API wiring and now sit in the rebuilt chrome/tokens.

## Hidden features made visible

- Workspace switcher and profile menu were implemented but unused; they are now in the customer topbar.
- Support Overview (attention across the loaded customer set) instead of a blank search screen.
- Admin sidebar groups that were previously only horizontal tabs.

## Intentionally blocked

- Shared room chat remains an honest unavailable state (no room-scoped thread authority).
- `diffAgentVersions`, `archiveThread`, `listCliEngines` remain `NOT_PRODUCTIZED_BLOCKED`.
- Support never shows credentials, wholesale cost, or staff-management controls.
- No fake global search (no search authority).
- No invented time-series charts.

## Responsive checks

CSS covers:
- full-width shell with content cap at 1440px
- ops/admin grids collapsing under 1024px
- mobile drawer + hidden desktop breadcrumb under 768px
- tables already wrap in `.table-wrap` / `.admin-table-wrap`
- sidebar collapse tokens unchanged (`248px` / `64px`)

No Playwright/E2E harness exists in this repo (Vitest `environment: node`). Layout rules are CSS + unit coverage, not a headed browser pass.

## Accessibility checks

- Semantic `h1` page titles on Customer/Admin/Support
- Visible labels on search, settings tabs, staff nav
- Existing `:focus-visible` ring retained
- Icon-only sidebar collapse / menu controls keep `aria-label`
- Status uses label text plus tone, not color alone
- `prefers-reduced-motion` still disables animation globally
- Support search input has an accessible name

## Test commands / counts

| Command | Result |
|---|---|
| `pnpm lint` | 0 errors (39 pre-existing warnings) |
| `pnpm typecheck` | pass |
| `pnpm --filter @mox/web test` | 15 files, **119 tests passed** |
| `pnpm test` | **695 passed**, 93 skipped |
| `pnpm build` | pass |
| `pnpm public-branding-scan` | clean |
| `pnpm secret-scan` | clean |
| `pnpm scan:authority` | clean |
| `pnpm dependency-security` | exit 0 (1 pre-existing moderate) |
| `git diff --check` | pass |

New coverage: `apps/web/tests/product-surfaces.test.ts` (IA, human labels, dashboard attention, Studio=production components). Postgres verification was not run: no backend/API/database source changed.

## Remaining design debt

- Agents work panes (Chat/Computer/Files/Terminal/Logs) still use the existing work-tab chrome; they were not redesigned as a separate product.
- Admin forms inside Plans/Compute/Intelligence remain dense; labels are humanized but layout is not a full form redesign.
- No headed visual QA at 1920/1440/1280/768/390 in this environment.
- Auth pages were out of scope for this pack.
