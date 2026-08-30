# MOX — 01
# FIX UI STUDIO ROUTING, CAPABILITY VISIBILITY, BLANK PAGES, AND HIDDEN SURFACE FEATURES

## Objective

Perform a fresh source-level audit of Mox-owned Customer, Admin, and Support functionality and fix the development UI Studio so every legitimate surface capability can actually be viewed and navigated.

This phase prioritizes correctness and exposure. Do not do the full visual redesign yet.

## A. Fresh feature-to-surface inventory

Re-scan current source. Do not trust old verification reports as sufficient.

At minimum inspect:
- `apps/web/src/App.tsx`
- `apps/web/src/router.tsx`
- `apps/web/src/concepts/nav.ts`
- `apps/web/src/concepts/staffNav.ts`
- `apps/web/src/shell/*`
- `apps/web/src/views/*`
- `apps/web/src/api/types.ts`
- `apps/web/src/api/http-api.ts`
- `apps/web/src/api/store.tsx`
- `apps/web/src/uiStudio/*`
- `apps/web/src/fixtures/*`
- `services/control-plane/src/api.ts`
- relevant Mox-owned services/packages/runtime
- relevant database schema
- CLI only where it establishes a user-facing capability

Create `docs/verification/UI_COMPLETION_FEATURE_SURFACE_MATRIX.md`.

Columns:

| Capability | Owner | API | Customer | Admin | Support | Current UI | Current Studio | Gate | Classification | Problem |

Every meaningful Mox-owned capability must be classified. Do not classify donor/reference code merely because it exists.

## B. One canonical Studio navigation model

The Studio must not maintain disconnected navigation that conflicts with production shell links.

Create a deliberate preview navigation adapter/context.

The developer must be able to:
- click Studio toolbar page selector;
- click Customer sidebar;
- click Admin navigation;
- click Support navigation;
- click contextual internal links such as View all, Manage, Open, Back;

and remain inside `/__ui`.

Use shareable URL state, for example:

```text
/__ui?surface=customer&page=/agents&state=populated
/__ui?surface=admin&page=compute&role=superadmin&state=populated
/__ui?surface=support&page=diagnostics&role=support_manager&state=populated
```

Exact parameter names may differ.

Requirements:
- refresh preserves surface/page/role/state;
- browser back/forward works;
- sidebar clicks do not navigate to real `/agents`, `/admin`, `/support`, etc.;
- production routing remains unchanged outside Studio;
- avoid dozens of `if (studio)` checks in production components;
- prefer a clean navigation abstraction that production and preview can share.

## C. Fix Customer Studio blank-page behavior

Verify every Customer destination:
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

For every page:
1. select it from Studio page selector;
2. click it from sidebar;
3. exercise primary contextual navigation;
4. verify populated state;
5. verify empty state;
6. verify loading state;
7. verify error state;
8. verify gated state where applicable.

No page may silently render black/blank because Studio escaped into production routing or a fixture caused a component exception.

Add a safe development render-error boundary if one does not exist. In Studio/dev mode an exception must produce a visible diagnostic containing surface/page and a safe error message, never secrets.

## D. Fix Admin Studio capability model

Read canonical Admin role/capability definitions from current production code. Do not invent a second vocabulary.

Historically `AdminView` has used capability names like:
- `admin.read`
- `admin.billing.write`
- `admin.compute.write`
- `admin.intelligence.write`
- `admin.notifications.write`
- `admin.operations.write`
- `admin.staff.write`

while Studio fixtures supplied incompatible names such as:
- `admin.overview.read`
- `admin.customers.read`
- `admin.plans.read`
- `admin.compute.read`
- `admin.intelligence.read`
- `admin.runtime.read`
- `admin.operations.read`
- `admin.staff.read`

Re-verify current code and eliminate any mismatch.

Studio role profiles should be derived/imported from the same pure capability definitions used by production whenever possible.

Studio Admin Role selector must include only real roles in current Mox. At minimum, if current production supports them:
- Superadmin
- Platform Admin
- Billing Admin
- Ops Admin

Do not invent production roles just for preview.

Default Admin + Populated Studio preview should use the role that exposes all legitimate Admin sections, normally Superadmin.

Expected Admin sections to re-verify include:
- Dashboard
- Customers
- Plans
- Payments
- Compute
- Models / Intelligence
- Runtime
- Notifications
- Operations
- Enterprise Contracts
- Staff & Access

If current source contains more legitimate Admin sections/actions, expose them too.

## E. Admin page/section selection

Studio currently needs page/section control equivalent to Customer.

Add an Admin Page selector.

Clicking Admin nav/tab/sidebar inside Studio must update Studio page state, remain in `/__ui`, and survive refresh.

Reduced roles should show only sections they legitimately own. Superadmin preview must show all.

## F. Support role/capability preview

Read canonical Support capability definitions.

Create Studio role profiles for real roles, including:
- Support Manager
- Support Agent

If current Mox has other real support roles, include them.

Support Manager must receive only manager capabilities, including escalation only if canonical production policy grants it.

Support Agent must not receive Admin capabilities.

Studio needs a Support Role selector and Support Page/Section selector.

## G. Fix Support Populated state

For `surface=support&state=populated`:
- customer list must be visibly populated immediately;
- select one safe fixture customer automatically;
- render useful customer detail;
- Diagnostics must contain fixture data;
- Notes must contain fixture notes;
- Activity must contain safe fixture activity;
- Escalation must show only for a role with canonical escalation capability.

Do not require a manual fake search merely to see populated design.

For `empty`, intentionally render no customers.
For `loading`, render loading/skeleton.
For `error`, render a safe error.
For `gated`, demonstrate least privilege.

## H. Audit MoxApi methods vs UI callers

Enumerate every method in `MoxApi`.

For each:
- classify Customer/Admin/Support/Internal;
- identify UI caller if productized;
- if no UI caller, explain why;
- fix productized methods that are accidentally unreachable.

Add table to report:

| MoxApi method | Surface | UI caller | Visible? | Action |

Do not expose internal-only methods simply to make the table complete.

## I. Audit Control Plane routes vs UI

For customer-safe, Admin-safe, and Support-safe routes:
- route;
- HttpMoxApi method;
- UI entry point.

Detect and fix accidental gaps:
- route exists, client method absent;
- client method exists, UI caller absent;
- UI action exists, method absent;
- UI control is guaranteed to fail;
- legitimate mutation exists but UI is accidentally read-only.

If a feature is genuinely `NOT_PRODUCTIZED_BLOCKED`, render a truthful unavailable state rather than a fake active button.

## J. Fixture robustness

Audit all Studio fixture methods and non-null assertions.

Every page/state combination must receive structurally valid fixture data.

Do not let `empty` state crash because code assumes `customerAgents[0]!` exists.

Fixture actions may mutate in-memory preview state where useful, but must never call real privileged APIs.

## K. Tests

Add automated coverage for:

### Customer
All 12 customer pages, including Studio sidebar and selector navigation.

### Admin
Every Superadmin-visible section plus reduced-role visibility.

### Support
Every Support Manager and Support Agent section.

### Navigation
- sidebar click changes Studio page;
- toolbar selector changes Studio page;
- URL state updates;
- refresh preserves selection;
- back/forward works where test infrastructure allows;
- no Studio escape to production route.

### Security
- Studio remains DEV + explicit opt-in + localhost only;
- fixtures do not create real auth sessions;
- no privileged real API mutation;
- production auth guards unchanged.

## Verification

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

If backend/API/database source changed, also run:

```cmd
powershell -ExecutionPolicy Bypass -File scripts\run-postgres-verification.ps1
```

## Report

Create `docs/verification/UI_COMPLETION_01_STUDIO_AND_VISIBILITY.md`.

Include:
- starting SHA;
- files changed;
- hidden features discovered;
- capability mismatches;
- navigation defects;
- MoxApi-to-UI matrix summary;
- Control Plane-to-UI gaps;
- Customer page matrix;
- Admin role/page matrix;
- Support role/page matrix;
- intentionally blocked/internal capabilities;
- exact test commands/counts;
- confirmation production auth/security was not weakened.

After green verification create local commit:

`fix(ui-studio): expose all legitimate surfaces and repair preview navigation`

Do not push.
