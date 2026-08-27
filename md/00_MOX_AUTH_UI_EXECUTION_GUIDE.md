# MOX — AUTHENTICATION, SURFACE ISOLATION, AND UI RECONSTRUCTION
## Sequential Execution Guide

Repository: `E:\MyCodes\Mox`  
Canonical branch: `master`  
Baseline at the start of Prompt 01: `43b0f3cf8f74ebca514a0cfb678b4770bf4ed033`

Run these prompts **in order**, one at a time, against the canonical local repository:

1. `01_MOX_AUTH_ROUTING_AND_SURFACE_ISOLATION.md`
2. `02_MOX_CUSTOMER_APP_UI_RECONSTRUCTION.md`
3. `03_MOX_ADMIN_SUPPORT_CONSOLES.md`
4. `04_MOX_AUTH_UI_FINAL_REVALIDATION.md`

Do not run them in parallel.

After Prompts 01–03, review the implementation report, inspect `git status --short`, `git diff --stat`, and `git diff --check`, run the requested verification, then commit/push manually only after review. Start the next prompt from a clean synchronized `master`.

Prompt 04 is a final **read-only revalidation**.

## Locked product decisions

Mox exposes three distinct browser experiences backed by one server-authoritative identity system.

### Customer App
Public auth URLs:
- `/login`
- `/signup`
- `/forgot-password`
- `/reset-password`

Protected customer application:
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

Customers must never see links, labels, navigation, route hints, internal terminology, or UI for Mox Admin or Mox Support.

### Mox Admin
Public auth URLs:
- `/admin/login`
- `/admin/signup`
- `/admin/forgot-password`
- `/admin/reset-password`

Protected console:
- `/admin`

`/admin/signup` is **invite-only**, never open public registration.

### Mox Support
Public auth URLs:
- `/support/login`
- `/support/signup`
- `/support/forgot-password`
- `/support/reset-password`

Protected console:
- `/support`

`/support/signup` is **invite-only**, never open public registration.

## Security boundary

Organization roles such as `owner` or `admin` are customer/workspace roles and must **not** imply Mox platform-admin or Mox-support authority.

Platform staff authority must be separate and server-authoritative.

A normal customer, including a customer organization owner, must receive 403/404 for protected Admin/Support APIs and must not see Admin/Support UI.

## UX direction

Target a polished commercial AI-agent platform:
- modern dark UI;
- clear hierarchy;
- compact information density;
- responsive desktop/tablet/mobile layouts;
- accessible focus/keyboard behavior;
- consistent design tokens and components;
- real data only;
- polished loading/error/empty states;
- customer, support, and admin experiences visually related but operationally separate.

Do not reintroduce production demo fallback or fabricated success.

## Git rule

Implementation agents must not commit, push, merge, rebase, reset, clean, delete branches, or rewrite history unless the user explicitly instructs them after reviewing the result.
