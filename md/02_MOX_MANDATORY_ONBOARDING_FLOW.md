# MOX — PROMPT 02
# Mandatory Customer Onboarding Flow Using the Existing Mox Dashboard Design Language

## ROLE

Work directly on:

`E:\MyCodes\Mox`

Start only after Prompt 01 is complete and locally committed.

Re-scan current clean `master` before editing.

Do not push to GitHub.

---

# PRIMARY OBJECTIVE

Build a **mandatory, resumable customer onboarding flow**.

The onboarding must visually inherit the dashboard UI/CSS/design system completed in Prompt 01, but onboarding must be a **standalone full-screen flow with NO customer sidebar**.

Do not build a separate aesthetic.

The onboarding should look unmistakably like the same Mox product:

- same typography
- same colors
- same buttons
- same inputs
- same card/panel language
- same spacing/radii
- same status patterns

but with a focused onboarding layout instead of the application shell.

---

# REQUIRED ROUTING

## New customer

```text
/signup
→ authenticated account + workspace created
→ /onboarding
→ complete onboarding
→ /dashboard
```

## Returning customer

```text
/login
→ authenticate
→ inspect active workspace onboarding state
   ├── incomplete → /onboarding
   └── complete   → /dashboard
```

## Root

```text
/
├── unauthenticated → /login
├── authenticated + onboarding incomplete → /onboarding
└── authenticated + onboarding complete → /dashboard
```

## Protected customer product routes

An authenticated customer whose active workspace onboarding is incomplete must be redirected to `/onboarding` from normal application routes such as:

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

`/onboarding` itself requires authentication.

---

# ONBOARDING IS MANDATORY

Do NOT implement:

- "Skip onboarding"
- localStorage bypass
- query-string bypass
- dev auth bypass
- environment-variable bypass
- client-only onboarding completion

The developer can visually preview onboarding through the **development-only UI Studio from Prompt 01**, but real product routing still requires real onboarding authority.

Individual external-setup decisions may be deferred where appropriate.

Examples:

- configure AI provider later
- create first agent later
- provision server later
- connect channels later

A deferred decision counts as completing that **onboarding decision step**, but the UI must never mark the underlying feature as configured.

---

# DURABLE ONBOARDING AUTHORITY

Use PostgreSQL.

Onboarding authority should be scoped to the active customer organization/workspace.

Use the next available migration number after re-scanning the repo.

Do not rewrite old migrations.

Store enough state for reliable resume, for example:

- orgId
- status:
  - `not_started`
  - `in_progress`
  - `completed`
- currentStep
- completedSteps
- persona
- goals
- modelSetupChoice
- agentSetupChoice
- infrastructureSetupChoice
- connectionsSetupChoice
- startedAt
- updatedAt
- completedAt
- updatedByUserId

Use typed values/enums consistent with existing Mox conventions.

---

# EXISTING CUSTOMER SAFETY

Very important:

Existing organizations created before this onboarding migration must not suddenly become locked out.

Backfill existing customer organizations as onboarding `completed`.

New workspaces created after the migration through customer signup start as `not_started`.

Do not trap existing production/test accounts.

---

# ONBOARDING API

Create a small authoritative service/store/API.

Suggested responsibilities:

### GET onboarding state
Returns durable state for active org.

### PATCH onboarding progress
Allows only validated onboarding fields/step transitions.

### POST complete
May complete only when all required onboarding decision steps are recorded.

Requirements:

- authenticated customer only;
- active org scoped;
- no cross-org access;
- completion is idempotent;
- cannot set completed through arbitrary PATCH;
- progress survives refresh/logout/login;
- optional audit/platform event using existing safe event infrastructure.

Do not put onboarding authority in React state.

---

# UI SHELL — NO SIDEBAR

The onboarding page must NOT render:

- Customer sidebar
- Admin sidebar
- Support sidebar
- normal dashboard top-navigation clutter

Use a dedicated layout such as:

```text
┌──────────────────────────────────────────────┐
│ Mox                         Step 2 of 6       │
│                                              │
│           Build your Mox workspace           │
│                                              │
│        [ focused onboarding content ]        │
│                                              │
│        Back                     Continue     │
└──────────────────────────────────────────────┘
```

It can include:

- Mox logo/brand
- compact progress indicator
- current step
- helpful context
- back/continue
- save/resume state

No sidebar.

---

# REUSE DASHBOARD CSS / DESIGN SYSTEM

Do not copy/paste an unrelated CSS theme.

Reuse/refactor the shared primitives from Prompt 01.

Examples:

- buttons
- inputs
- cards
- badges
- typography
- status
- progress
- spacing
- error/loading states

If onboarding needs special CSS, extend the shared design tokens rather than inventing conflicting colors/radii/fonts.

The UI Studio should include an **Onboarding preview** so the developer can edit this flow visually without creating new accounts repeatedly.

Add representative onboarding preview states:

- Step 1
- Step 2
- Step 3
- Step 4
- Step 5
- Step 6/final
- error
- unavailable provider
- mobile

The preview is visual only and must not alter real onboarding authority.

---

# ONBOARDING STEPS

Use a concise, high-value flow.

## STEP 1 — Welcome / Workspace

Confirm/capture:

- user's display name where appropriate
- workspace name
- persona:
  - Founder / business owner
  - Developer
  - Agency
  - Operations / team
  - Other

Prefill information already known.

Do not ask the same signup information twice unnecessarily.

---

## STEP 2 — Goals

Multi-select the reasons they want Mox.

Examples:

- Build AI agents
- Automate business workflows
- Deploy autonomous agents
- Connect messaging channels
- Connect business apps/integrations
- Use my own AI provider/API keys
- Run agents on dedicated infrastructure
- Developer / CLI workflows

These selections personalize UX only.

They must not grant entitlements, roles or security capabilities.

---

## STEP 3 — AI / MODEL SETUP

Use real current Mox model capabilities.

Possible choices:

### Use Mox-managed models

Only show as usable if actual Mox-managed model configuration exists.

### Connect my own provider

Use the real BYOK/customer credential flow.

Never:
- store provider keys in onboarding state;
- display full secret after save;
- bypass credential authority.

### Configure later

Record as deferred.

Do not show "Connected" merely because the user chose "later".

---

# STEP 4 — FIRST AGENT

Encourage the customer to create their first real agent.

Use the real Agent authoring flow.

Keep onboarding version lightweight.

Default:

`Simple Mode`

Useful fields:

- agent name
- role/purpose
- instructions
- model if available
- permission preset

Offer:

`Create my first agent`

or:

`I'll create my first agent from the dashboard`

If created:
- create a real agent/draft;
- persist via canonical agent-control APIs.

If deferred:
- record `deferred`;
- do not make a fake agent.

---

# STEP 5 — INFRASTRUCTURE

Show actual workspace entitlement/commercial state.

Display safe values such as:

- included server count
- compute class
- current server count
- current server state

If entitled and provider setup supports it:

`Provision my server`

must call the real customer server-order authority.

Do not automatically provision a VPS merely because signup happened.

Allow:

`I'll provision infrastructure later`

if payment/provider readiness makes this optional.

Never expose:
- wholesale price
- provider credentials
- internal provider account
- internal SKU topology

---

# STEP 6 — CONNECTIONS / READY

Based on goals, optionally recommend real:

- Channels
- Integrations
- API tokens / CLI

Do not require the user to connect everything.

Then show a truthful final review.

Example:

```text
Workspace              Complete
Goals                  Complete
AI model               Connected / Deferred / Needs attention
First agent            Created / Deferred
Infrastructure         Running / Provisioning / Deferred / Unavailable
Connections            2 configured / Deferred
```

Use distinct visual states.

Do not render green success checkmarks for deferred/unavailable items.

Final CTA:

`Finish onboarding`

This must call the backend completion authority.

Successful completion:

`→ /dashboard`

---

# RESUME BEHAVIOR

Onboarding must resume correctly after:

- page refresh
- closing browser
- logout/login
- control-plane restart
- switching away and back to the active org

Current step and prior decisions come from PostgreSQL.

Back navigation must not destroy already-persisted values.

---

# MULTI-WORKSPACE / ORG SWITCHING

Onboarding belongs to the workspace.

If a user switches to:

- completed workspace → allow `/dashboard`
- incomplete workspace → route to `/onboarding`

Do not reuse onboarding status from another org.

---

# DASHBOARD AFTER ONBOARDING

After onboarding is complete:

`/dashboard`

is canonical.

Add a compact dashboard setup/status card using **real resource state**, not onboarding-completedSteps.

Possible operational checklist:

- First agent
- Model provider
- Server
- Integration/channel
- Developer/API token if relevant

This checklist is optional setup guidance after onboarding.

It must not reactivate the mandatory onboarding wizard.

---

# AUTH FLOW DETAILS

## Signup
Successful signup must route to `/onboarding`.

## Login
Successful login must:
- inspect active org onboarding;
- incomplete → onboarding;
- complete → safe customer return target or dashboard.

## Completed user manually visits onboarding
Redirect to `/dashboard`.

## Unauthenticated onboarding
Redirect to login with safe same-surface return handling.

Preserve open-redirect defenses.

---

# ADMIN / SUPPORT

Do not apply customer onboarding to:

- `/admin`
- `/admin/*`
- `/support`
- `/support/*`

Admin and Support staff have separate staff auth/capability flows.

Do not render Customer onboarding after Admin or Support login.

---

# ERROR / UNAVAILABLE STATES

Onboarding must survive missing external services.

Examples:

- model provider not configured
- credential vault unavailable
- compute provider unavailable
- channel OAuth unavailable

Behavior:

- show accurate reason;
- preserve progress;
- allow explicit defer if product rules permit;
- never fake success.

---

# ACCESSIBILITY / RESPONSIVENESS

Requirements:

- semantic headings
- form labels
- keyboard support
- visible focus
- accessible progress indicator
- errors associated with fields
- no color-only status
- good mobile layout
- no horizontal overflow
- responsive at ~390px
- reduced-motion support

---

# TESTS

Add strong tests.

## Signup/login routing
- new signup → onboarding
- incomplete login → onboarding
- complete login → dashboard
- root → correct destination

## Guards
- incomplete customer cannot access dashboard/product routes
- onboarding route allowed while incomplete
- completed customer visiting onboarding → dashboard
- no redirect loops

## Persistence
- progress written to DB
- refresh resumes
- logout/login resumes
- cross-org state isolated

## Existing users
- migration backfills existing orgs completed

## Step semantics
- goals saved
- model configured vs deferred distinguished
- agent created vs deferred distinguished
- server ordered vs deferred distinguished
- completion blocked until required decision steps recorded

## Real service usage
- BYOK uses customer credential authority
- agent uses real agent APIs
- infrastructure uses real server order API
- no fake connection success

## UI
- onboarding has no sidebar
- shared dashboard design primitives/styles used
- UI Studio onboarding preview works in development
- production remains auth protected

## Staff
- Admin unaffected
- Support unaffected

---

# VERIFICATION

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
powershell -ExecutionPolicy Bypass -File scripts\run-postgres-verification.ps1
```

If browser E2E/Playwright exists, also verify:

1. signup → onboarding
2. onboarding resume
3. onboarding completion → dashboard
4. returning login → dashboard
5. incomplete returning login → onboarding
6. Admin login unaffected
7. Support login unaffected

---

# FINAL REPORT

Create:

`docs/verification/MANDATORY_ONBOARDING_FLOW.md`

Include:

1. starting SHA
2. migration file
3. exact files changed
4. onboarding data model
5. API endpoints
6. routing matrix
7. all onboarding steps
8. screenshot/visual notes if test tooling supports them
9. UI Studio onboarding preview instructions
10. confirmation onboarding has no sidebar
11. confirmation dashboard CSS/design system was reused
12. deferred vs completed semantics
13. existing-user migration behavior
14. tests and totals
15. PostgreSQL results
16. remaining Critical/High/Medium findings
17. external/live-provider items still requiring manual validation
18. confirmation no push occurred

After all gates pass, create a local commit:

`feat(onboarding): add mandatory standalone customer onboarding`

Do not push.

STOP after report and local commit.
