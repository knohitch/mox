# MOX — PROMPT 01
# Production Authentication Flow, Auth URLs, Staff Identity, and Surface Isolation

## ROLE

You are the implementation agent operating directly on:

`E:\MyCodes\Mox`

This is a production security-sensitive change. Re-scan the current repository before editing.

At the start of this prompt, expected baseline:
- branch: `master`
- HEAD: `43b0f3cf8f74ebca514a0cfb678b4770bf4ed033`
- `origin/master`: same SHA
- working tree: clean

If branch, SHA, remote SHA, or working-tree cleanliness does not match, STOP and report the mismatch.

Do not commit or push.

---

# CURRENT PROBLEMS

The backend already has real password login/signup/logout, HttpOnly cookie sessions, `/api/me`, organization membership, org switching, personal API tokens, rate limits, and server authorization.

But the frontend currently embeds auth inside `App.tsx`; the app shell can render before authentication is cleanly resolved; and customer navigation contains `Mox Admin`.

There are no production-quality standalone auth route trees for:
- customer users;
- Mox Admin;
- Mox Support.

Fix this architecture without weakening the hardened backend.

---

# REQUIRED BROWSER AUTH URL CONTRACT

## Customer

Public:
- `/login`
- `/signup`
- `/forgot-password`
- `/reset-password`

Protected:
- existing customer application routes.

Rules:
- unauthenticated customer protected route → `/login` with safe return target;
- successful login → requested safe customer path or `/`;
- customer signup remains public;
- customer auth pages must not render the logged-in app shell.

## Admin

Public:
- `/admin/login`
- `/admin/signup`
- `/admin/forgot-password`
- `/admin/reset-password`

Protected:
- `/admin`
- admin subroutes if created.

Rules:
- unauthenticated admin protected route → `/admin/login`;
- `/admin/signup` requires valid staff invite;
- no public admin self-registration;
- customer credentials without platform-admin capability must not grant Admin access;
- successful password auth must be followed by server-side Admin capability verification before Admin shell/data render.

## Support

Public:
- `/support/login`
- `/support/signup`
- `/support/forgot-password`
- `/support/reset-password`

Protected:
- `/support`
- support subroutes if created.

Rules:
- unauthenticated support protected route → `/support/login`;
- `/support/signup` requires valid staff invite;
- customer credentials without support capability must not grant Support access;
- successful password auth must be followed by server-side Support capability verification before Support shell/data render.

---

# ONE AUTHENTICATION AUTHORITY, THREE AUTHORIZATION SURFACES

Do NOT create three independent password systems.

Preserve the canonical Mox user/password/session authority and secure cookie session mechanism.

After authentication, the server must authorize the requested surface:
- customer;
- support;
- admin.

Never infer staff authority from:
- route;
- email domain;
- localStorage;
- client state;
- query string;
- organization role.

---

# PLATFORM STAFF AUTHORITY

Create or extend a durable server-authoritative platform-staff model separate from customer organization memberships.

Inspect existing admin capability code first and integrate instead of duplicating it.

Support at least:
- `superadmin`
- `platform_admin`
- `support_manager`
- `support_agent`

You may preserve existing capability names if safer.

Requirements:
1. Customer `owner`/`admin` roles do not imply staff authority.
2. Staff assignments bind to real user IDs.
3. Staff assignments can be disabled/revoked.
4. Server endpoints calculate effective capabilities.
5. Admin APIs remain server-gated.
6. Support APIs are support-capability-gated.
7. Frontend visibility is UX only, never security authority.
8. Staff status/capabilities are never accepted from the client.

If a migration is required, use exactly:

`packages/database/migrations/0018_auth_staff_surfaces.sql`

Do not rewrite 0000–0017.

---

# STAFF INVITES / ADMIN AND SUPPORT SIGNUP

`/admin/signup` and `/support/signup` are invitation acceptance flows.

Add durable staff invitations if absent.

Invitation requirements:
- cryptographically random token;
- only hash stored;
- intended email binding;
- intended staff role/capability binding;
- intended surface (`admin`, `support`, or explicit both);
- created by authorized staff actor;
- createdAt;
- expiresAt;
- consumedAt;
- revokedAt where appropriate;
- single-use;
- transactional consume on successful activation;
- creation/revocation/acceptance audited;
- plaintext token shown exactly once only to authorized invite creator;
- list APIs never return plaintext invite token.

Invalid, expired, revoked, reused, wrong-email, and wrong-surface invites must fail.

Public staff signup without invite must create nothing.

If invited email already belongs to an existing Mox customer identity, attach the staff assignment to that same identity safely instead of creating a duplicate user.

---

# PASSWORD RESET

Implement production-quality reset for all surfaces using one password authority.

Routes:
- `/forgot-password`
- `/reset-password`
- `/admin/forgot-password`
- `/admin/reset-password`
- `/support/forgot-password`
- `/support/reset-password`

Backend requirements:
- anti-enumeration response;
- random reset token;
- only token hash stored;
- expiry;
- one-use;
- rate limiting consistent with existing auth controls;
- current password policy/KDF;
- successful reset revokes existing browser sessions and API tokens as appropriate;
- audit/security event;
- no token in production JSON;
- no password/token logging.

Reuse real notification/email delivery if currently available.

If no production email transport exists, do not fabricate delivery. Implement durable reset authority and an explicit fail-closed delivery/configuration state and document deployment configuration still required.

---

# SESSION / IDENTITY CONTRACT

Do not overload customer organization `role` to represent Mox staff authority.

Add explicit server-authorized staff context as needed.

A clean option is:
- `/api/admin/session`
- `/api/support/session`

These must return 403 for authenticated users lacking the correct platform capability.

Only expose safe role/capability metadata needed by the frontend.

---

# ROUTING ARCHITECTURE

Refactor the frontend away from one flat route/nav authority.

Create explicit categories:
1. public customer auth;
2. protected customer;
3. public admin auth;
4. protected admin;
5. public support auth;
6. protected support.

Do not render customer application shell on:
- customer auth pages;
- Admin auth pages;
- Support auth pages;
- full-screen backend/configuration failure before identity is established.

Remove `Mox Admin` from customer navigation.

Do not add Support to customer navigation.

Direct `/admin` and `/support` still require server authorization.

Ensure browser refresh/deep links for all auth URLs work in dev and production hosting. Inspect SPA fallback configuration and add correct rewrites where required without intercepting API routes.

---

# AUTH UI

Build functional reusable production auth layouts for:
- login;
- customer signup;
- invite-only Admin signup;
- invite-only Support signup;
- forgot password;
- reset password;
- invalid/expired invite;
- invalid/expired reset;
- access denied;
- service unavailable;
- loading;
- password-reset success.

Requirements:
- semantic labels;
- correct autocomplete attributes;
- keyboard accessible;
- clear validation;
- no raw stack/backend secrets;
- no secret echo in errors.

Full dashboard visual reconstruction belongs to Prompt 02.

---

# RETURN URL / OPEN REDIRECT SECURITY

Return targets must:
- be same-origin relative paths only;
- reject absolute URLs;
- reject protocol-relative URLs;
- reject encoded open-redirect variants;
- remain within the relevant surface.

Examples:
- customer login cannot return to `/admin`;
- support login cannot return to `/admin`;
- Admin return cannot point external.

Add tests.

---

# CUSTOMER NON-DISCLOSURE

After this prompt:
- customer sidebar contains no `Mox Admin`;
- customer shell contains no Support link;
- customer routes do not advertise `/admin` or `/support`;
- customer org owner is not platform admin;
- unauthorized Admin/Support APIs fail server-side;
- no CSS-only hiding as security control.

---

# PRESERVE EXISTING SECURITY

Do not regress:
- HttpOnly cookie auth;
- SameSite/Secure production cookie behavior;
- CSRF enforcement;
- PAT separation/hash/expiry/revocation;
- session hash/expiry/revocation;
- auth rate limiting;
- anti-enumeration;
- current password KDF/policy;
- membership-verified org switching;
- existing admin authorization;
- audit/security events;
- credential authority isolation;
- migrations through 0017;
- payment/compute/SSRF/runtime/node/notification security repairs.

---

# REQUIRED TESTS

At minimum:

## Customer
- `/login` and `/signup` render without app shell;
- unauthenticated `/` → `/login`;
- customer login succeeds into customer app;
- invalid login remains on auth surface;
- safe return target works;
- unsafe return target rejected.

## Admin
- unauthenticated `/admin` → `/admin/login`;
- ordinary customer denied;
- customer org owner still denied;
- platform admin allowed;
- `/admin/signup` without invite creates nothing;
- valid invite accepted once;
- expired/revoked/reused/wrong-email invite fails.

## Support
- unauthenticated `/support` → `/support/login`;
- customer denied;
- support_agent allowed support but denied admin;
- support_manager follows capability map;
- `/support/signup` requires invite.

## Reset
- unknown email response generic;
- token hash stored;
- expired/used token fails;
- reset updates password;
- old password fails;
- sessions revoked;
- token cannot be reused.

## Disclosure
- customer nav never contains Admin/Support;
- auth pages never render app sidebar.

## PostgreSQL
- migration 0018 fresh run;
- 0017 → 0018 upgrade;
- existing data preserved;
- invite single-use;
- staff assignment separate from org membership;
- reset lifecycle.

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

Fix implementation-caused defects only.

---

# FINAL REPORT

Create:

`docs/verification/AUTH_ROUTING_SURFACE_ISOLATION.md`

Report:
1. baseline SHA;
2. files changed;
3. migration 0018;
4. auth URLs;
5. staff role/capability model;
6. invite lifecycle;
7. password-reset lifecycle;
8. session/identity changes;
9. route-tree changes;
10. customer/Admin/Support matrix;
11. open-redirect defenses;
12. tests/totals;
13. PostgreSQL results;
14. commands/results;
15. remaining Critical/High/Medium findings;
16. email/deployment config still required;
17. confirmation no commit/push occurred.

STOP after report.
