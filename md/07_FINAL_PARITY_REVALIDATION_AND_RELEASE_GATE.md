# 07 — FINAL UI / API / SERVICE / RUNTIME PARITY REVALIDATION

## Objective

Perform a fresh, read-driven parity audit after Phases 01-06 and close any remaining accidental invisibility.

This phase is not a ceremonial test run. Re-scan the code and prove that every Mox-owned product capability has a deliberate surface classification.

---

# A. REBUILD THE FEATURE MATRIX FROM SOURCE

Do not simply trust the Phase 01 matrix.

Freshly scan:
- web routes/navigation
- UI components
- `MoxApi`
- `HttpMoxApi`
- Control Plane routes
- services/packages/runtime
- database schema
- CLI
- Admin/Support capability maps

Create:

`docs/verification/UI_PARITY_FINAL_MATRIX.md`

Columns:

| Capability | Owner | Customer | Admin | Support | API | UI entry point | Gate | Runtime status | Classification | Notes |

Allowed classifications:
- CUSTOMER_VISIBLE
- CUSTOMER_ENTITLEMENT_GATED
- CUSTOMER_ROLE_GATED
- ADMIN_VISIBLE
- ADMIN_CAPABILITY_GATED
- SUPPORT_VISIBLE
- SUPPORT_CAPABILITY_GATED
- INTERNAL_ONLY
- NOT_PRODUCTIZED_BLOCKED

There must be zero `UNCLASSIFIED`.

---

# B. HIDDEN-FEATURE DETECTION

Programmatically/search-driven inspect for patterns such as:

- exported service methods never referenced outside tests
- customer-safe Control Plane routes with no web API method
- web API methods with no UI caller
- MoxApi methods with no discoverable entry point
- form/action-capable service methods represented as read-only Admin tables
- customer configuration schema fields not editable anywhere
- `501 not_configured`
- `throw new ApiUnavailableError`
- `TODO`
- `FIXME`
- `not implemented`
- `not configured`
- `return []` placeholder paths
- hardcoded status projections
- hardcoded metrics
- hardcoded empty members
- unconditional `available: true`
- synthetic IDs used as authority
- disabled buttons with no explanation
- routes not reachable from shell/navigation
- CLI commands targeting nonexistent endpoints

Every hit must be classified and either:
- fixed;
- deliberately blocked with truthful UX;
- internal-only with rationale.

---

# C. SURFACE ISOLATION

Prove:
- customer cannot discover/navigate Admin or Support surfaces;
- Support cannot discover/navigate Admin-only tools;
- Admin-only data is not returned by customer/support APIs;
- staff authority cannot derive from organization role;
- PAT cannot become Admin authority;
- system credentials never enter customer API responses.

---

# D. UX WALKTHROUGH TESTS

Add or update route/component integration tests for at least:

## Customer
- signup/login
- customer shell/nav
- agent list
- create agent
- authoring
- thread/chat availability
- rooms
- server provisioning
- deployments
- models/BYOK
- integrations
- channels
- usage
- billing
- Settings/API tokens
- notifications/preferences
- team/backup/extended features that were productized

## Admin
- login/session capability
- each Admin nav section
- every implemented Admin mutation

## Support
- login/session capability
- lookup
- customer detail
- note/diagnostic actions

Use fixtures that make gated features both allowed and denied.

---

# E. FULL VERIFICATION

Run the repository-standard gates.

At minimum, where defined:

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

Also run focused web/control-plane/integration tests introduced by this pack.

Do not claim a command passed if it was unavailable.

---

# F. DATABASE

If this parity work added migrations:
- verify fresh migration path;
- verify upgrade path from the prior current migration;
- verify existing data preservation;
- verify tenant isolation;
- add migration verification to the PostgreSQL harness.

Never renumber old migrations.

---

# G. FINAL PRODUCT HONESTY CHECK

A visible capability must never be in this state:

> looks enabled -> user clicks -> deterministic HTTP 501

Instead:
- wire it fully; or
- visibly mark it unavailable with blocker/setup/entitlement context.

A backend capability that is customer-ready must never remain:

> working API/service -> no discoverable user entry point

Likewise for Admin and Support.

---

# H. MASTER REPORT

Create:

`docs/verification/UI_PARITY_MASTER_REPORT.md`

Include:

## Repository
- starting SHA
- ending SHA
- branch
- local commits

## Customer
- all newly surfaced features
- gated features
- blocked features and exact blockers

## Admin
- all newly surfaced features/actions
- capability gates

## Support
- all newly surfaced diagnostics/actions
- least-privilege checks

## Internal-only
List intentionally hidden capabilities and rationale.

## Fixed parity defects
Include:
- entitlement contract mismatch
- fake/hardcoded projections
- room membership
- dead API client methods
- dead UI actions
- missing routes
- CLI contract issues
- any newly discovered items

## Verification
Exact commands and test counts.

## Remaining external/live requirements
Examples:
- real Stripe sandbox
- real PayPal sandbox
- Contabo/provider credentials
- browser/computer production network enforcement
- real external channel webhooks
- OAuth device flows
only if still genuinely required.

## Git
State explicitly:
- no remote push performed
- working tree state

---

# I. FINAL LOCAL COMMIT

Only when the full verification gate is green:

Local commit message:

`feat(ui-parity): complete product surface parity`

Do not push.

If verification is not green:
- do not create the final "complete" commit;
- leave precise failure report and stop.
