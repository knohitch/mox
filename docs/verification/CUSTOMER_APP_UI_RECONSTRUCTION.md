# Prompt 02 — Customer App UI Reconstruction (Frontend)

## Scope

This report documents the completed customer-app UI reconstruction
(`02_MOX_CUSTOMER_APP_UI_RECONSTRUCTION.md`): moving the customer app from an
engineering skeleton to a cohesive, useful surface while **preserving** the
Prompt 01 surface separation (customers never reach admin/support).

This is a **frontend-only** deliverable. No backend authority was redesigned for
UI convenience; the reconstruction consumes the same authoritative store/API
and adds no fake data.

## Repository State

- Working tree branch: `master` (no commit; commit/push is intentionally manual
  after review).
- All work is uncommitted on top of the Prompt 01 state.

## Key changes

### Information architecture (pure data module)

- `apps/web/src/concepts/nav.ts` (new) — grouped customer sidebar IA as a
  **pure** module so it can be unit-tested without a DOM:
  - `CUSTOMER_NAV` — groups **Home** (Home), **Build** (Agents, Agent Rooms,
    Deployments), **Infrastructure** (Servers, Models), **Connect** (Apps &
    Integrations, Channels), **Account** (Usage, Billing, Settings).
  - `CUSTOMER_DESTINATIONS` — flat list used to validate the IA.
  - `STAFF_SURFACE_ROOTS` (`/admin`, `/support`) and `CUSTOMER_AUTH_ROUTES`.
  - `hasForbiddenDestination()` — guard that flags any staff/staff-leaning term
    (admin, support, operations, abuse, runtime, provider, payment, margin,
    notification) so the customer IA can never regress toward a staff surface.

### Shell

- `apps/web/src/shell/CustomerShell.tsx` (new) — customer app chrome:
  - **Grouped collapsible sidebar** (desktop icon rail when collapsed) with a
    `nav-icon` per section and real screen-reader labels.
  - **Mobile drawer** (backdrop + Escape-to-close) for the same IA.
  - **Top bar** with `OrgSwitcher` (renders a switch menu only when the identity
    actually has >1 membership, driven by the authoritative `me.orgs`),
    `ProfileMenu` (Settings + Sign out), and the existing notification bell.
  - The nav used is exclusively `CUSTOMER_NAV` — no admin/support links exist.

### Design-system primitives

- `apps/web/src/ui/primitives.tsx` — added `Button` (kind/size), `PageHeader`,
  `Panel`, `KpiCard`, `DataTable<T>` (generic, typed rows), `LoadingState`,
  `ErrorState`; kept `Avatar`, `Badge`, `Card`, `EmptyState`. All use the new
  design tokens (radius/space/ink/semantic color scales) in `styles.css`.

### Views

- `apps/web/src/views/MiscViews.tsx` — rebuilt:
  - `HomeView` dashboard: greeting + workspace name from `me`, KPI cards that
    aggregate **authoritative** data (agents, deployments, open approvals,
    servers), panels for Agents / Pending approvals / Deployments / Usage, and
    real `Link` shortcuts. No fabricated numbers.
  - `ServersView`, `DeploymentsView`, `ModelsView`, `IntegrationsView`,
    `ChannelsView`, `UsageView`, `BillingView` — consistent `PageHeader` +
    `Panel` + `DataTable` with human-readable values and status badges.
  - `RoomsView`, `SettingsView` — rebuilt around the same primitives (settings
    shows only authoritative identity + entitlement capabilities).

### Store & identity

- `apps/web/src/api/store.tsx` — added `me: MeResponse | null` state (fetched on
  boot / after auth via `/api/me`), a `switchOrg(orgId)` action (uses the
  membership-verified `/api/auth/orgs/select` then refetches `me`), and `signOut`
  now clears `me`. The store's `MoxApi` seam still does NOT carry auth/me (those
  live on `HttpMoxApi`) — unchanged separation.

### App wiring

- `apps/web/src/App.tsx` — `CustomerSurface` now renders `<CustomerShell
  activePath={...}>`; removed the old flat `CUSTOMER_NAV` const (now in
  `concepts/nav.ts`) and unused imports. Staff surfaces (Admin/Support) are
  untouched and remain isolated under their own URL prefixes.

### Styles

- `apps/web/src/styles.css` — expanded the token scale (ink/radius/spacing),
  added component classes (`btn`, `page-head`, `panel`, `kpi`, `data-table`,
  `badge-*`, `state`, `spinner`, `notice`, `topbar-customer`, `org-swatch`,
  `profile-menu`, `nav-icon`, `nav-group`, `collapse-btn`, `sidebar-collapsed`,
  `drawer-backdrop`, `menu-toggle`), and a responsive block that swaps the
  desktop rail for the mobile drawer ≤960px. Admin/support console styles are
  preserved.

## Security / isolation properties (retained)

- The customer shell renders **only** `CUSTOMER_NAV` (verified by test); there
  are no admin/support links in the sidebar, profile menu, top bar, footer, or
  any customer view.
- Auth pages remain standalone (no app shell) and unchanged from Prompt 01.
- Backend authorization is untouched and remains mandatory; this prompt only
  changed the customer-facing presentation.
- No admin/support/diagnostics UI leaked into the customer surface; usage and
  billing views surface only measured usage and invoices.

## Verification

- `apps/web` `pnpm typecheck` — pass.
- `apps/web` `pnpm build` (tsc -b && vite build) — pass, `dist` produced.
- `apps/web` `pnpm test` — 5 files / **19 tests** passed, including the new
  `tests/nav.test.ts` that proves: the IA groups/destinations match the target
  spec; every customer protected route is reachable from the nav; **never**
  contains `/admin`/`/support` (or any prefix of them); `hasForbiddenDestination`
  flags staff surfaces; and customer auth routes stay clear of staff prefixes.
- root `pnpm lint` (oxlint) — completes with only pre-existing warnings; the
  two warnings introduced in this prompt (unused import/variable in
  `MiscViews.tsx`) were removed.

## Notes on test strategy

The web test environment is `node` (no jsdom / no happy-dom; neither was added
as a dev dependency). DOM-rendering tests of the shell are therefore not
feasible without adding a new browser-ish test dependency, which was
deliberately avoided. Instead the navigation/IA contract was extracted into a
pure data module and unit-tested authoritatively (items present, no staff
leakage), matching the pattern used for `router.tsx`, the work view, roster,
and demo-api tests.

## Outstanding / deferred

- No new open items specific to Prompt 02. Standing items from Prompt 01 remain
  (production SPA fallback at deploy time; full Admin/Support consoles are
  Prompt 03).

## Next

Proceed to Prompt 03 (`03_MOX_ADMIN_SUPPORT_CONSOLES.md`) after manual review of
this report and the working-tree diff.
