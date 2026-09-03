# MOX — PHASE 06
# COMPLETE SUPPORT ESCALATION + UNIFY PLATFORM STAFF ROLE AUTHORITY

> ✅ **STATUS: DONE** — implemented and verified. See
> `docs/verification/PRODUCT_COMPLETION_06_SUPPORT_ESCALATION_STAFF_ROLES.md`.

Use **Gemini 3.1 Pro High**.

Work in `E:\MyCodes\Mox` on clean `master`. Preserve onboarding, DEV direct access and server-authoritative least-privilege staff isolation. Do not push.

## A. DURABLE SUPPORT ESCALATION

Support Manager UI has historically exposed Escalations while no real mutation/workflow existed. Build the durable workflow.

A durable escalation should contain at least:
- id;
- customer/org id;
- createdBy staff user;
- severity;
- category;
- title;
- description;
- status;
- optional assigned staff user;
- created/updated timestamps;
- optional resolved timestamp/resolution note.

Suggested statuses:

```text
open
acknowledged
investigating
resolved
closed
```

Conform to repository conventions. If schema changes are needed, inspect migration head and use the next sequential migration.

### Capability intent

- support_agent: support lookup/notes only according to current policy;
- support_manager: may create/escalate/update escalation state;
- authorized Admin roles: inspect/manage through appropriate Admin capability;
- Customers do not receive staff-only internal escalation data by accident.

### UI

Support Escalations becomes actionable:
- create from selected customer;
- list open/history;
- severity/status;
- assignment where permitted;
- state transitions;
- resolution;
- links to safe diagnostics/activity.

Admin Operations/Customers gets an appropriate capability-gated escalation view. Audit every mutation.

## B. UNIFY STAFF ROLE VOCABULARY

Current architecture has historically had overlapping role vocabularies:

Config/platform roles:
- superadmin
- billing_admin
- ops_admin
- support

Durable staff roles:
- superadmin
- platform_admin
- support_manager
- support_agent

Unify to one canonical vocabulary, preferably:

```text
superadmin
platform_admin
billing_admin
ops_admin
support_manager
support_agent
```

Do not silently promote legacy roles.

Preserve compatibility by explicitly mapping/deprecating old config values if needed.

### Capability intent

- superadmin: full Admin + staff management;
- platform_admin: general platform/customer/operations scope only as policy defines;
- billing_admin: billing/plans/contracts + necessary notification read/write;
- ops_admin: compute/intelligence/runtime/operations/notifications;
- support_manager: support + escalation;
- support_agent: support lookup/notes, no escalation;
- support roles never inherit Admin configuration.

### Staff & Access

Superadmin must be able to manage/invite all normal role types. A non-superadmin can never grant superadmin. If superadmin-to-superadmin grant is supported, require explicit server-side capability and strong confirmation; otherwise rely on the secure bootstrap/break-glass path from Phase 01.

Update Admin/Support DEV fixtures and navigation capability matrices.

## TESTS

Cover escalation create/update/resolve, support-agent denial, manager permission, cross-org safety, audit, role compatibility migration, billing/ops capabilities, support isolation, wildcard only for true superadmin, and UI role choices matching backend.

Run auth/admin/support/control-plane/full gates plus PostgreSQL.

Report:
`docs/verification/PRODUCT_COMPLETION_06_SUPPORT_ESCALATION_STAFF_ROLES.md`

Local commit:
`feat(staff): add support escalations and unify platform roles`

Do not push.
