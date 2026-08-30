# MOX — 02
# REBUILD CUSTOMER, ADMIN, AND SUPPORT UI INTO A MATURE COMMERCIAL PRODUCT

## Objective

After Phase 01 has made every legitimate feature/page reachable, reconstruct the visual and interaction design of all three Mox surfaces.

The current product is functionally present but still looks like an engineering/test console. Do not merely recolor it. Rebuild hierarchy, navigation, density, forms, tables, page structure, empty states, and operational dashboards.

Preserve the user's chosen direction:
- pitch-black / near-black base;
- white, high-contrast typography;
- restrained graphite borders;
- semantic status colors;
- premium technical SaaS feel;
- full-width responsive shell;
- no giant dead spaces;
- no gratuitous glow or generic purple SaaS styling.

## A. Shared design system

Create/refine coherent tokens for:
- page background
- sidebar background
- surface/elevated surface
- borders/hover borders
- primary/secondary/muted text
- accent
- success/warning/danger/info
- inputs
- focus ring
- spacing
- radii
- typography scale
- sidebar widths
- topbar height
- elevation/shadow
- table density
- responsive breakpoints

Avoid uncontrolled raw hex duplication.

Refactor shared primitives where useful:
- AppShell
- Sidebar
- Topbar
- PageHeader
- MetricCard
- Panel/Card
- DataTable
- StatusBadge/StatusIndicator
- EmptyState
- LoadingState/Skeleton
- ErrorState
- GatedState
- SectionNav
- ProfileMenu
- WorkspaceSwitcher
- ConfirmationDialog/ActionMenu if already consistent with stack

Do not over-abstract.

## B. Customer navigation

Customer IA should remain Customer-only:

```text
HOME
Dashboard

BUILD
Agents
Agent Rooms
Deployments

INFRASTRUCTURE
Servers
Models

CONNECT
Apps & Integrations
Channels

ACCOUNT
Usage
Billing
Backups
Settings
```

If the current feature inventory proves another legitimate Customer page exists, place it intelligently.

No Admin or Support links.

## C. Customer topbar

Use real state:
- active workspace
- workspace switcher
- notification bell
- profile menu
- responsive menu
- optionally one useful global action such as Create Agent

Do not add fake global search unless a real search authority exists.

## D. Customer dashboard `/dashboard`

Rebuild it to answer:
1. What is happening?
2. What needs attention?
3. What can I do next?
4. How much am I using?
5. Is my infrastructure healthy?

Recommended composition:

### Header
- greeting/workspace
- concise context
- high-value actions depending on real product state:
  - Create Agent
  - Provision Server
  - Connect Model

### Operational summary
Use meaningful metrics such as:
- agents
- active/running agents
- deployments
- servers
- open approvals
- AI credits/usage when real

Do not duplicate meaningless counts.

### Needs attention
Only show actual actionable states:
- pending approval
- failed deployment
- server degraded/error
- model/integration/channel disconnected
- billing/commercial issue

### Active work
- active agents
- recent deployments
- server health

### Usage
If time-series data exists, use it.
If only aggregate totals exist, do not invent charts.

### Recent activity
Only use authoritative activity/event data.

### Getting started
For empty/new accounts, show useful setup actions. This is NOT mandatory onboarding authority.

Avoid huge empty rectangles.

## E. Complete every Customer page

### Agents
- clear New Agent CTA
- list/grid with status/model/deployment state
- sensible filtering/search only if useful
- polished empty state

### Agent detail/workspace
Complete:
- Chat
- Work
- Computer
- Files
- Terminal
- Logs
- Settings

If a capability is not productized, show an explicit disabled/unavailable state with reason. Do not leave a normal-looking active tab that deterministically fails.

### Agent Rooms
- create room
- members
- room conversation
- limits
- empty state

### Deployments
- real version/revision
- target
- state
- actions
- failure details
- rollback where supported

### Servers
- provision action
- server state
- compute class
- safe region/provider-independent details
- lifecycle actions
- telemetry unavailable state instead of fake zero

### Models
- managed models vs BYOK
- provider connection state
- setup/test/disconnect
- unavailable reason
- models used by agents where useful

### Apps & Integrations
- provider catalog
- connection status
- setup
- tool grants
- disconnect

### Channels
- provider
- bound agent
- configured status
- connect/test/disconnect

### Usage
- included quantity
- used
- remaining
- unlimited
- warnings
- hard-limit state
- credits

### Billing
- current subscription
- plan
- period
- invoices
- plan change/checkout/cancel where real authority exists

### Backups
- availability
- retention
- recent backups
- failures
- manual/restore actions only if allowed

### Settings
Use clear subsections/tabs:
- Profile
- Workspace
- Team
- Notifications
- Developer / API Tokens
- other legitimate Customer settings

Do not create one giant page.

## F. Admin shell and IA

Admin must become a real platform-operations product, not a mostly empty sidebar plus horizontal tabs.

Recommended sidebar grouping, adjusted to actual capabilities:

```text
OVERVIEW
Dashboard

CUSTOMERS
Customers
Enterprise Contracts

COMMERCIAL
Plans & Pricing
Payments

INFRASTRUCTURE
Compute
Models / Intelligence
Runtime

OPERATIONS
Notifications
Operations
Backups / Feature Flags where distinct

PLATFORM
Staff & Access
```

Only pages allowed by the real staff capability list render.

Superadmin Studio preview should show all legitimate sections.

Remove redundant horizontal primary tabs after sidebar IA is authoritative.

## G. Admin dashboard

Use safe authorized data:
- customers
- active subscriptions
- payment attention
- compute/fleet health
- runtime health
- incidents
- notification jobs
- provider health
- staff/security attention
- revenue only if current Admin API already safely provides it to that role

Prioritize "Needs attention" and operational actions, not raw totals only.

## H. Complete every Admin page

Polish all current Admin sections:
- Customers
- Plans/Pricing
- Payments
- Compute
- Models/Intelligence
- Runtime
- Notifications
- Operations
- Enterprise Contracts
- Staff & Access
- backups/feature flags if current Admin authority exposes them

Requirements:
- clear page headers
- human-readable labels
- no truncated raw camelCase schema names as primary UI
- forms with visible labels/help
- grouped inputs
- validation
- meaningful empty states
- destructive actions visually distinct
- confirmation for destructive operations
- tables with useful columns
- raw IDs only where operationally necessary
- no secrets returned/displayed

Example: replace raw headers like `providerName`, `accountLabel`, `commercialSta...` with `Provider`, `Account`, `Commercial status`, etc.

## I. Support shell and IA

Support should become a real support workspace.

Recommended sidebar, governed by canonical support capabilities:

```text
SUPPORT
Overview
Customer Lookup
Diagnostics
Notes
Activity
Escalations
```

Support Manager may see Escalations if canonical policy grants it.
Support Agent should not see Admin-only or manager-only capabilities.

## J. Support overview

Do not make the landing page a giant empty search screen.

Use safe real data when available:
- customer search
- customer issues requiring attention
- subscription lifecycle problems
- degraded servers/agents
- notification failures
- escalations if manager capability exists
- recent customer/support activity if authoritative

Do not invent ticket counts if no durable ticket service exists.

## K. Support customer detail

Organize:
- Workspace summary
- Users
- Subscription
- Servers
- Agents & Deployments
- Model Connections
- Integrations
- Channels
- Notifications
- Notes
- Activity

Never expose:
- payment/provider credentials
- customer plaintext secrets
- system model credentials
- wholesale costs/margins
- raw node tokens
- staff-management authority
- unrestricted runtime controls

## L. Studio must render the real production components

Studio uses fixture data only.

Do not build separate prettier Studio-only versions.

The Customer/Admin/Support components shown in Studio must be the same components used in production, so design edits apply to both.

## M. Studio toolbar

Provide:
### Surface
Customer / Admin / Support

### Role
For Admin: all real Admin roles useful for preview.
For Support: Support Manager / Support Agent and any other real roles.

### Page
Every page/section for selected surface.

### State
Populated / Empty / Loading / Error / Gated

### Sidebar
Expanded / Collapsed

Selections should be encoded in Studio URL state.

## N. State quality

Every page needs intentional:
- Populated
- Empty
- Loading
- Error
- Gated when relevant

Empty should explain what the page is and what action to take.
Error must be concise and safe.
Gated must explain role/entitlement/setup requirement.
No blank screen.

## O. Responsive design

Verify at:
- 1920×1080
- 1440×900
- 1280×720
- 1024
- 768
- ~390 mobile

Rules:
- no absurd text-line widths on large screens;
- useful grids;
- tables scroll when needed;
- desktop sidebar collapses;
- mobile uses drawer;
- no horizontal shell overflow;
- controls remain reachable.

## P. Accessibility

At minimum:
- semantic headings
- visible labels
- visible focus
- keyboard navigation
- aria labels for icon-only controls
- no color-only status meaning
- adequate contrast
- accessible tables
- reduced-motion handling where animations exist

## Q. Tests

Add/update tests proving:
- every Customer page renders populated state;
- every Admin Superadmin page renders;
- every Support Manager page renders;
- reduced-role visibility correct;
- sidebar navigation works;
- no blank route;
- empty/loading/error/gated states render;
- Customer has no Admin/Support links;
- Support has no Admin-only controls;
- Studio and production share the same real components;
- no internal-only fields leak.

If browser/E2E infrastructure exists, add a traversal smoke test for all three surfaces.

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

If backend/API/database code changed, also run:

```cmd
powershell -ExecutionPolicy Bypass -File scripts\run-postgres-verification.ps1
```

## Report

Create `docs/verification/UI_COMPLETION_02_PRODUCT_RECONSTRUCTION.md`.

Include:
- before/after architecture;
- Customer IA;
- Admin IA;
- Support IA;
- pages completed;
- hidden features made visible;
- intentionally blocked features;
- responsive checks;
- accessibility checks;
- exact test counts;
- remaining design debt.

After green verification create local commit:

`feat(ui): complete customer admin and support product surfaces`

Do not push.
