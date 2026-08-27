# MOX — PROMPT 04
# Final Authentication / UI / Surface-Security Revalidation

## ROLE

You are a read-only release revalidation agent.

Operate against the latest clean synchronized:

`E:\MyCodes\Mox`

Prompts 01–03 should already be committed and pushed.

DO NOT modify production source.
DO NOT rewrite tests.
DO NOT commit.
DO NOT push.
DO NOT create migrations.

You may create only the final verification report after the audit.

---

# OBJECTIVE

Independently verify that the authentication redesign, customer UI reconstruction, and Admin/Support separation are production-consistent and did not regress previous Mox security.

Do not trust implementation reports without source tracing and executable tests.

---

# A — AUTH URL MATRIX

Verify browser URLs and direct-refresh behavior.

## Customer public
- `/login`
- `/signup`
- `/forgot-password`
- `/reset-password`

## Customer protected
- `/`
- `/agents`
- `/rooms`
- `/deployments`
- `/servers`
- `/models`
- `/integrations`
- `/channels`
- `/usage`
- `/billing`
- `/settings`

## Admin public
- `/admin/login`
- `/admin/signup`
- `/admin/forgot-password`
- `/admin/reset-password`

## Admin protected
- `/admin` and implemented subroutes.

## Support public
- `/support/login`
- `/support/signup`
- `/support/forgot-password`
- `/support/reset-password`

## Support protected
- `/support` and implemented subroutes.

Test browser refresh/deep links, not only client-side navigation.

---

# B — AUTHENTICATION BEHAVIOR

Verify:
- HttpOnly cookie session remains authoritative;
- browser login JSON never exposes session token;
- CSRF preserved;
- logout clears/revokes session;
- password policy/KDF unchanged or stronger;
- reset tokens hashed, expiring, one-use;
- reset anti-enumeration;
- password reset revokes existing sessions;
- staff invites hashed, expiring, one-use;
- invite email/role/surface binding;
- invalid staff signup creates no staff assignment;
- no auth/reset/invite token leakage to logs/errors.

---

# C — AUTHORIZATION MATRIX

Verify:

| Actor | Customer | Support | Admin |
|---|---|---|---|
| unauthenticated | auth pages only | auth pages only | auth pages only |
| normal customer | allowed by org/entitlement | DENY | DENY |
| customer org owner | customer | DENY | DENY |
| support_agent | only if separately customer member | safe Support ALLOW | DENY |
| support_manager | per explicit support caps | ALLOW | DENY unless separately granted |
| platform_admin | only if separately customer member | only if separately granted | ALLOW by caps |
| superadmin | only if separately customer member | by caps | ALLOW |

Organization role must never substitute for platform staff role.

---

# D — CUSTOMER NON-DISCLOSURE

Normal customer must not see:
- Mox Admin;
- Support Console;
- staff navigation;
- wholesale cost/margin;
- payment-provider administration;
- compute-provider administration;
- system intelligence credential/config controls;
- runtime platform operations;
- Staff & Access controls.

Verify this is not CSS hiding.

---

# E — SUPPORT LEAST PRIVILEGE

Support endpoints/payloads must exclude:
- secrets;
- unnecessary provider credential metadata;
- payment-provider config;
- compute-provider credentials/config;
- system-model credentials;
- wholesale margin/cost;
- destructive platform operations;
- staff privilege escalation.

Support notes/actions must be audited.

---

# F — ADMIN

Verify:
- Admin shell renders only after server staff authorization;
- Admin APIs remain server-gated;
- staff invite/assignment management requires sufficient capability;
- Support role cannot self-promote;
- customer org role and platform staff identity remain separate concepts.

---

# G — OPEN REDIRECT / ROUTE CONFUSION

Test:
- absolute return URLs;
- `//evil.example`;
- encoded host/scheme variants;
- cross-surface return paths;
- `/login?next=/admin`;
- `/support/login?next=/admin`;
- `/admin/login?next=https://evil.example`.

All must fail or normalize to safe same-surface destinations.

---

# H — UI FUNCTIONAL REGRESSION

Verify:
- auth pages never render logged-in shell;
- customer shell has no staff links;
- responsive navigation works;
- loading/error/empty states honest;
- backend unavailable does not show fake healthy dashboard;
- no production demo fallback;
- no major horizontal overflow;
- accessible form labels/focus semantics.

Document clear UX defects but do not turn aesthetic preference alone into security severity.

---

# I — PRIOR SECURITY REGRESSION PASS

Confirm no regression to:
- customer/system credential authority isolation;
- migration 0017;
- billing seed idempotency;
- payment lifecycle/refund/dispute authorization;
- compute fencing/quota/cancel authority;
- SSRF/DNS rebinding/request-target protection;
- gateway signing secret;
- browser/computer default-deny egress;
- admin audit;
- notification durability;
- node enrollment.

---

# J — VERIFICATION COMMANDS

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

Also run focused auth/router/staff/support suites separately so totals are visible.

If browser E2E infrastructure exists, use it for route/deep-link tests. Otherwise state that and use strongest available component/HTTP integration tests.

---

# CLASSIFICATION

Classify:
- Critical
- High
- Medium
- Low
- Informational

Any Critical/High affecting authentication or cross-surface authorization blocks release.

Any customer-accessible Admin/Support path lacking server enforcement is at least High.

---

# FINAL REPORT

Create only:

`docs/verification/AUTH_UI_SURFACE_REVALIDATION_FINAL.md`

Include:
1. audited SHA;
2. working-tree cleanliness;
3. auth URL matrix;
4. authorization matrix;
5. invite/reset results;
6. customer non-disclosure;
7. Support least privilege;
8. Admin access result;
9. open-redirect result;
10. UI functional/accessibility findings;
11. prior-security regression result;
12. exact tests/totals;
13. all commands/results;
14. remaining Critical/High/Medium;
15. final decision:
   - `CLOSED — READY FOR NEXT PRODUCTION PHASE`, or
   - `REPAIR REQUIRED`.

Do not modify source to make the audit pass.

STOP after report.
