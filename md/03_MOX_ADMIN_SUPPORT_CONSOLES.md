# MOX — PROMPT 03
# Dedicated Mox Admin and Mox Support Consoles

## ROLE

Operate on the latest clean, synchronized `master` in:

`E:\MyCodes\Mox`

Start only after Prompts 01 and 02 have been reviewed and pushed.

Re-scan current source before editing.

Do not commit or push.

---

# OBJECTIVE

Build distinct production-quality staff experiences:

1. Mox Admin Console
2. Mox Support Console

They must use the server-authoritative platform-staff identity created in Prompt 01.

They must not be embedded in or linked from the customer application.

The consoles may share UI primitives, identity/session infrastructure, and selected safe service logic, but authorization and data projections must remain least-privilege.

---

# ROUTE TREES

## Admin
Public:
- `/admin/login`
- `/admin/signup`
- `/admin/forgot-password`
- `/admin/reset-password`

Protected:
- `/admin`
- optional `/admin/...` subroutes.

## Support
Public:
- `/support/login`
- `/support/signup`
- `/support/forgot-password`
- `/support/reset-password`

Protected:
- `/support`
- optional `/support/...` subroutes.

Customer app must not link to these.

---

# ADMIN CONSOLE

Preserve legitimate existing Admin functionality but move/reorganize it into a dedicated Admin shell.

Recommended capability-gated navigation:
- Overview
- Customers
- Plans & Pricing
- Payments
- Compute
- Models / Intelligence
- Runtime
- Notifications
- Operations / Incidents
- Staff & Access

Do not expose tabs to an Admin actor lacking the required capability.

Server must still enforce every endpoint.

## Staff & Access

Add UI over Prompt 01 staff authority:
- list staff assignments;
- role/status;
- issue invite;
- revoke invite;
- disable/revoke staff assignment where authorized;
- invitation status without plaintext token after creation;
- plaintext invite token shown exactly once on issuance;
- strong confirmation for destructive actions.

Only sufficiently privileged Admin roles may manage staff.

A Support role cannot elevate itself into Admin.

---

# SUPPORT CONSOLE

Support must be a separate least-privilege product, not a copy of Admin.

Build only functionality backed by real data and support-safe APIs.

Recommended capabilities:

## Customer lookup
Search/select organizations and users using safe identifiers.

## Customer overview
Show:
- organization name;
- account/user status;
- plan/subscription status;
- servers and safe health status;
- agents and safe status;
- recent support-relevant errors/status where already available.

## Support notes
Expose/move existing support-note functionality through Support-scoped APIs.

Notes must retain audit actor identity.

## Diagnostics
Safe customer diagnostics only.

Never expose:
- provider secrets;
- system credentials;
- wholesale costs;
- Mox margins;
- raw payment credentials;
- unrestricted runtime command execution;
- system model keys;
- platform-wide abuse/operations controls unless explicitly permitted.

## Actions
Default `support_agent` should primarily have read + support-note authority.

Higher-impact actions such as suspension/reactivation require explicit stronger capability such as `support_manager` or Admin and must remain audited.

Do not let Support UI call broad Admin APIs and merely hide fields. Use support-scoped server projections and guards.

---

# CAPABILITY MATRIX

Use Prompt 01 server-side capabilities.

At minimum:

### customer user
- customer app: yes according to org/entitlements;
- support: no;
- admin: no.

### support_agent
- support safe read: yes;
- add support note: yes;
- admin: no;
- pricing/payment-provider config: no;
- compute-provider config: no;
- staff role management: no.

### support_manager
- support-agent capabilities;
- explicitly-approved higher support actions;
- no automatic Admin authority.

### platform_admin
- Admin capabilities according to existing capability model;
- cannot become `superadmin` without explicit authority.

### superadmin
- complete platform administrative capability including Staff & Access.

Do not use frontend role checks as the security boundary.

---

# ADMIN AUTH EXPERIENCE

Polish staff auth pages.

`/admin/signup` must clearly require a Mox staff invitation.

Do not reveal whether arbitrary email addresses are staff accounts.

After password auth:
- verify Admin capability server-side;
- if absent, do not render Admin shell;
- show generic access-denied state;
- do not fetch/expose Admin data during failed authorization.

---

# SUPPORT AUTH EXPERIENCE

Apply the same principles.

`/support/signup` is invite-only.

After login:
- verify Support capability server-side;
- no Support shell/data before authorization is confirmed.

---

# VISUAL DESIGN

Admin and Support should belong to Mox but differ from customer UX in information density.

Admin:
- dense operational dashboard;
- clear status/severity patterns;
- production tables;
- safe confirmations;
- audit visibility.

Support:
- calmer customer-service workflow;
- fast customer lookup;
- customer context pane;
- notes and diagnostics easy to scan;
- do not overload support agents with platform-internal systems.

No secrets in tooltips, hidden fields, DOM attributes, or errors.

---

# API / DATA PROJECTION

Audit current Admin APIs.

For Support, create explicit safe responses rather than shipping broad Admin payloads and hiding fields in React.

Admin-only examples:
- unnecessary provider credential refs;
- wholesale costs/margin;
- payment-provider configuration;
- compute-provider account configuration;
- system intelligence credentials;
- global destructive operations.

Minimize Support DTOs.

---

# AUDIT

All staff-sensitive writes record:
- actor user;
- staff role/capability context;
- target org/user/resource;
- action;
- timestamp;
- safe reason/details.

No secrets in audit payloads.

---

# MIGRATIONS

Prompt 01 should have created staff/invite identity schema.

Do not create another migration unless genuinely necessary.

If a new migration is required, STOP and report why before creating it so the user can approve the migration scope.

---

# TESTS

At minimum:

## Navigation
- customer shell never links Admin/Support;
- Support shell never links Admin-only sections;
- Admin shell nav capability-aware.

## Authorization
- customer → `/admin`: denied;
- customer → `/support`: denied;
- org owner still denied;
- support_agent → Support allowed;
- support_agent → Admin denied;
- support_manager follows matrix;
- platform_admin follows matrix;
- superadmin Staff & Access allowed.

## API projection
- Support customer payload excludes Admin-only/secret fields;
- Support cannot call pricing/payment/compute/system-intelligence admin mutations;
- support notes scoped and audited.

## Invite management
- only authorized role creates Admin invite;
- Support self-escalation impossible;
- invitation plaintext displayed only on issuance.

## UI
- loading/error/empty states;
- mobile/tablet staff auth and core console;
- no secrets rendered.

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
powershell -ExecutionPolicy Bypass -File scripts\run-postgres-verification.ps1
```

---

# FINAL REPORT

Create:

`docs/verification/ADMIN_SUPPORT_CONSOLES.md`

Report:
1. baseline SHA;
2. files changed;
3. final Admin routes/navigation;
4. final Support routes/navigation;
5. staff/capability matrix;
6. Support-safe API projections;
7. Staff & Access behavior;
8. audit behavior;
9. customer non-disclosure;
10. tests/totals;
11. commands/results;
12. remaining Critical/High/Medium findings;
13. deferred Support capability;
14. confirmation no commit/push occurred.

STOP after report.
