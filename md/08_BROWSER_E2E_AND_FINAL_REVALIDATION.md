# MOX — PHASE 08
# REPEATABLE BROWSER E2E + FINAL PRODUCT COMPLETION REVALIDATION

Use **Gemini 3.1 Pro High**.

Work in `E:\MyCodes\Mox` on clean `master`. Preserve onboarding, DEV direct access safety, themes, auth/RBAC and all prior work. Do not push.

## A. ADD REAL BROWSER E2E INFRASTRUCTURE

The repo previously lacked a repeatable browser suite. Add **Playwright** unless current HEAD already has a browser E2E framework. Do not add competing frameworks.

### Layer 1 — UI Studio smoke

Use dev-only isolated Studio for deterministic Customer/Admin/Support coverage across Light/Dark and populated/empty/loading/error/gated states. No real auth bypass or PostgreSQL mutation.

### Layer 2 — production-composition auth/navigation smoke

Run normal web app against a test Control Plane + temporary PostgreSQL.

Seed only explicit test identities/data.

Test real:
- customer signup/login;
- completed onboarding behavior WITHOUT changing onboarding;
- dashboard and deep links;
- durable Admin staff login;
- Support login;
- customer denied Admin/Support;
- logout;
- direct refresh on SPA routes.

External providers must use fake/test adapters. Never call/spend against real providers in CI.

## KEY PRODUCT E2E FLOWS

Customer:
- login;
- dashboard;
- Agents first message;
- server provisioning against fake provider;
- Agent Rooms shared conversation;
- Models connection state;
- Settings theme switch/persistence;
- logout.

Admin:
- dashboard;
- Staff & Access;
- compute;
- payments;
- operations;
- escalation visibility where authorized.

Support:
- lookup;
- diagnostics;
- notes;
- manager escalation;
- agent escalation denial.

## DEV DIRECT ACCESS E2E

Development:
- User Dashboard shortcut exists and reaches populated Studio Customer dashboard;
- Admin and Support shortcuts exist and reach their isolated fixtures.

Production:
- shortcuts absent;
- `/__ui` denied/unavailable under existing security policy;
- no fixture session/API leakage.

## THEME E2E

Check light Customer dashboard, dark Customer dashboard, light Agents, light Admin, light Support, and preference persistence after reload.

## NO BLANK PAGE REGRESSION

Navigate every canonical Customer route and capability-visible Admin/Support section. Assert a page landmark/state exists, no render-boundary failure, no empty root, no uncaught console error/unhandled rejection.

## FINAL SWEEP

Review every remaining `not_configured`. Classify each as external deployment dependency, intentionally unsupported, or defect. A Critical/High/Medium functional defect blocks closure.

## CI

Add the browser E2E command to CI without requiring live vendor credentials. Use temporary PostgreSQL consistent with current CI conventions.

## FULL VERIFICATION

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

Also run the new E2E command, e.g. `pnpm e2e` using the actual script created.

## FINAL REPORT

Create:
`docs/verification/PRODUCT_COMPLETION_08_FINAL_REVALIDATION.md`

Include starting/final local SHA, all phase commits, migration head, Customer/Admin/Support capability matrix, DEV direct-access security, onboarding preservation, server provisioning, Rooms, runtime surfaces, model probes, CLI state, escalation, staff roles, version diff, themes, E2E, test counts, PostgreSQL and remaining external deployment requirements.

Final verdict must be exactly one:

`CLOSED — MOX PRODUCT COMPLETION CODE GATE PASSED`

or

`REPAIR REQUIRED`

Do not declare CLOSED if a visible control is a no-op, required backend route remains a code-placeholder rather than an external deployment limitation, or any production direct-access bypass exists.

If CLOSED create local commit:
`test(release): close product completion revalidation`

Do not push.
