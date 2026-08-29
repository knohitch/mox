# UI Completion 01 — Studio routing, capability visibility, blank pages, hidden surfaces

**Starting SHA:** `e78af1e685ebccde82d1d777ec0da9ed12bd221a`  
**Branch:** `master` (not pushed)  
**Pack:** `moxui/01_FIX_UI_STUDIO_ROUTING_VISIBILITY_AND_HIDDEN_FEATURES.md`

## Files changed

- `apps/web/src/router.tsx` — `NavAdapter` so production `Link` / `useRoute` can be intercepted without `if (studio)` in views
- `apps/web/src/concepts/staffNav.ts` — canonical Admin/Support preview role profiles + tab/section type guards
- `apps/web/src/uiStudio/previewNavigation.ts` — shareable `/__ui?surface&page&state&role` state machine
- `apps/web/src/uiStudio/StudioErrorBoundary.tsx` — dev-only render diagnostic (no secrets)
- `apps/web/src/uiStudio/mockStore.ts` — production capability names, role argument, empty-state-safe fixtures
- `apps/web/src/views/UiStudioView.tsx` — URL-backed selectors for Customer/Admin/Support pages and roles
- `apps/web/src/views/AdminView.tsx` — admin tabs write through the navigation adapter
- `apps/web/src/App.tsx` — Support sections write through the adapter; populated list auto-loads and auto-selects
- `apps/web/tests/preview-navigation.test.ts` — navigation, URL, capability, fixture coverage
- `apps/web/tests/staff-nav.test.ts` — preview role vocabulary
- `docs/verification/UI_COMPLETION_FEATURE_SURFACE_MATRIX.md`
- `docs/verification/UI_COMPLETION_01_STUDIO_AND_VISIBILITY.md`

## Hidden features discovered

1. Admin Studio fixtures used a second capability vocabulary (`admin.overview.read`, `admin.customers.read`, …). `visibleAdminTabs` keys off `admin.read` / `admin.billing.write` / `admin.staff.write` / etc., so most Admin sections disappeared in preview.
2. Support Studio omitted `support.escalate`, so Support Manager never saw Escalation.
3. Support `Populated` required a manual Search click; the customer list and detail were empty on first paint.
4. Customer sidebar / Manage / Back / Settings used production `Link`/`navigate`, so Studio left `/__ui` for `/agents`, `/dashboard`, `/settings`.
5. Studio URL state only stored `surface`. Refresh lost page, role, and preview state. History could not restore them.
6. Empty-state mock methods used `customerAgents[0]!` / `connections[0]!` / `members[0]!`, which throw when those arrays are empty.
7. Support mock role was the invented `tier2_support`.
8. Admin/Support had no Studio page selector and no role selector.

No additional Mox-owned customer/admin/support *pages* were missing from the IA. Unreachable client methods (`diffAgentVersions`, `archiveThread`, `listCliEngines`) are classified `NOT_PRODUCTIZED_BLOCKED` rather than given fake buttons.

## Capability mismatches

| Before (Studio) | Canonical (control-plane + `staffNav`) |
|---|---|
| `admin.overview.read` | `admin.read` |
| `admin.customers.read` / `.write` | `admin.read` + `admin.customers.write` |
| `admin.plans.read` / `.write` | `admin.billing.write` |
| `admin.compute.read` | `admin.compute.write` |
| `admin.intelligence.read` | `admin.intelligence.write` |
| `admin.runtime.read` | `admin.operations.write` |
| `admin.operations.read` | `admin.read` / `admin.operations.write` |
| (missing notifications) | `admin.notifications.write` |
| `admin.staff.read` | `admin.staff.write` (superadmin) |
| `support.customer.read` / `.diagnostics` / `support.note.write` | not in production |
| (missing) `support.escalate` | Support Manager only |

Studio now imports the UI-side copy of `STAFF_ROLE_CAPABILITIES` / `PLATFORM_ROLE_CAPABILITIES`.

## Navigation defects

| Defect | Fix |
|---|---|
| Sidebar `Link` to `/agents` escaped Studio | `NavAdapter` rewrites product destinations onto `/__ui?...` |
| Toolbar page state was React-only | `page` is a query param; refresh restores it |
| Admin tabs were local state | tabs call `setSection`, which updates `page=` |
| Support sections were local state | same adapter |
| No Admin/Support page or role selectors | added; reduced roles only list owned sections |
| Browser history ignored Studio | `history.pushState` on `/__ui` search; `popstate` re-parses |

Production routing outside `/__ui` is unchanged.

Shareable examples:

```text
/__ui?surface=customer&page=/agents&state=populated
/__ui?surface=admin&page=compute&role=superadmin&state=populated
/__ui?surface=support&page=diagnostics&role=support_manager&state=populated
```

## MoxApi-to-UI matrix summary

See `UI_COMPLETION_FEATURE_SURFACE_MATRIX.md` for the full table.

| MoxApi method | Surface | UI caller | Visible? | Action |
|---|---|---|---|---|
| Customer roster/authoring/rooms/servers/deployments/models/integrations/channels/usage/billing/backups/settings/computer | Customer | matching views | yes | none |
| All `admin*` methods listed on `MoxApi` | Admin | `AdminView` | yes, capability-gated | none |
| `supportCustomers` / `supportCustomer` / `supportAddNote` | Support | `SupportConsole` | yes | auto-load populated |
| `diffAgentVersions` | Customer | none | no | `NOT_PRODUCTIZED_BLOCKED` |
| `archiveThread` | Customer | none | no | `NOT_PRODUCTIZED_BLOCKED` |
| `listCliEngines` | Customer | none | no | `NOT_PRODUCTIZED_BLOCKED` |
| `getAgent` | Customer | roster path, not a page | via `/agents` | none |

Internal-only methods were not exposed just to complete the table.

## Control Plane-to-UI gaps

Customer-safe, Admin-safe, and Support-safe `HttpMoxApi` routes have UI entry points except the three blocked methods above. No legitimate mutation was left accidentally read-only. Escalation has a Support Manager section and a truthful empty/unavailable body because no audited escalation mutation exists yet.

Auth/session/token-login routes stay on auth pages, not Studio product chrome.

## Customer page matrix

| Page | Selector | Sidebar | Populated | Empty | Loading | Error | Gated |
|---|---|---|---|---|---|---|---|
| Dashboard | yes | yes | fixture KPIs | empty collections | shell `LoadingState` | store error banner | pages render; entitlements denied |
| Agents | yes | yes | 3 agents | `[]` | same | same | same |
| Agent Rooms | yes | yes | 2 rooms | `[]` | same | same | entitlement empty |
| Deployments | yes | yes | fixture deploys | `[]` | same | same | same |
| Servers | yes | yes | 2 servers | `[]` | same | same | same |
| Models | yes | yes | catalog + connections | empty catalog path | same | same | entitlement empty |
| Apps & Integrations | yes | yes | 3 apps | `[]` | same | same | entitlement empty |
| Channels | yes | yes | 2 channels | `[]` | same | same | entitlement empty |
| Usage | yes | yes | rows | empty usage | same | same | same |
| Billing | yes | yes | subscription | null subscription | same | same | commerciallyEntitled false |
| Backups | yes | yes | 2 backups | unavailable | same | same | entitlement empty |
| Settings | yes | yes | team/prefs/knowledge/tokens | reduced team | same | same | entitlement empty |

## Admin role/page matrix

| Role | Visible sections |
|---|---|
| Superadmin (`*`) | Dashboard, Customers, Plans, Payments, Compute, Models, Runtime, Notifications, Operations, Contracts, Staff & Access |
| Platform Admin | Dashboard, Customers, Runtime, Operations |
| Billing Admin | Dashboard, Customers, Plans, Payments, Notifications, Operations, Contracts |
| Ops Admin | Dashboard, Customers, Compute, Models, Runtime, Notifications, Operations |
| Gated (no caps) | none — least-privilege empty console |

## Support role/page matrix

| Role | Visible sections |
|---|---|
| Support Manager | Lookup, Diagnostics, Notes, Activity, Escalation |
| Support Agent | Lookup, Diagnostics, Notes, Activity |
| Gated | none |

Populated: customer list is returned without a query string; first fixture customer is selected; diagnostics/notes/activity have fixture rows. Empty: zero customers. Loading/error: shell states. Gated: no lookup capability.

## Intentionally blocked / internal

- Control-plane credentials, provider secrets, PostgreSQL, runtime node internals: `INTERNAL_ONLY`
- `diffAgentVersions`, `archiveThread`, `listCliEngines`: `NOT_PRODUCTIZED_BLOCKED`
- UI Studio: Vite DEV + `VITE_MOX_UI_STUDIO` + localhost only; production route is 404
- Studio fixtures never create cookies, sessions, or privileged API/PostgreSQL mutations
- Production auth guards in `CustomerSurface` / `StaffSurface` were not relaxed

## Test commands / counts

| Command | Result |
|---|---|
| `pnpm lint` | 0 errors (42 pre-existing warnings, none in new Studio files) |
| `pnpm typecheck` | pass |
| `pnpm --filter @mox/web test` | 14 files, **111 tests passed** |
| `pnpm test` | **687 passed**, 93 skipped (postgres-gated control-plane files) |
| `pnpm build` | pass (web production bundle built) |
| `pnpm public-branding-scan` | clean |
| `pnpm secret-scan` | clean |
| `pnpm scan:authority` | clean |
| `pnpm dependency-security` | exit 0 (`--audit-level high`; 1 pre-existing moderate) |
| `git diff --check` | pass |

This phase adds `apps/web/tests/preview-navigation.test.ts` (16) and one staff-nav profile test.

Postgres verification was not run: no backend/API/database source changed.

## Security confirmation

- `isUiStudioAllowed` still requires DEV + explicit opt-in + localhost/`127.0.0.1`/`[::1]`
- Disallowed environments still render a 404
- Fixtures remain in-memory; mock `staffSession` is not written to cookies/storage
- Mock mutations are no-ops / in-memory returns
- Customer/Admin/Support production auth redirects and capability checks are unchanged
- Error boundary redacts token/secret-like strings and never prints cookies
