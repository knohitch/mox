# MOX — UI / PRODUCT SURFACE PARITY — RUN ALL

## Mission

You are the implementation agent for the Mox repository.

Your job is to make **every Mox-owned capability that is supposed to be visible on a given product surface actually visible and usable on that surface**, without leaking internal/admin/support functionality into the wrong surface and without inventing fake functionality.

This pack is intentionally split into ordered implementation phases. Execute them **automatically, one after another**, unless a hard safety/verification gate fails.

The user should be able to start you before going to sleep and inspect the completed implementation and reports later.

---

## Repository

Canonical local repository:

`E:\MyCodes\Mox`

Canonical branch:

`master`

Reference GitHub HEAD when this pack was generated:

`ecf054d1fea293168c42d4748c9f66731a41d3ed`

The reference SHA is context, not an excuse to overwrite newer legitimate work.

---

## Files to execute, in order

1. `01_PRODUCT_SURFACE_INVENTORY_AND_TRUTH.md`
2. `02_CUSTOMER_CORE_PARITY.md`
3. `03_CUSTOMER_COMMERCIAL_CONNECTIONS_AND_DEVELOPER.md`
4. `04_CUSTOMER_EXTENDED_CAPABILITIES.md`
5. `05_ADMIN_SURFACE_PARITY.md`
6. `06_SUPPORT_SURFACE_PARITY.md`
7. `07_FINAL_PARITY_REVALIDATION_AND_RELEASE_GATE.md`

Read each entire file before implementing that phase.

Do not skip a phase because a feature "looks unfinished." Determine whether it is:
- already production-capable and merely not surfaced;
- partially wired and needs completion;
- intentionally unavailable and must be shown as unavailable with accurate prerequisite/blocker text;
- internal-only and must remain off the customer surface.

---

# NON-NEGOTIABLE PRODUCT RULE

The objective is **not** "put every source file in the UI."

The objective is:

> Every capability that belongs on the Customer surface must be discoverable and usable by customers when authorized.  
> Every capability that belongs on the Admin surface must be discoverable and usable by authorized admins.  
> Every capability that belongs on the Support surface must be discoverable and usable by authorized support staff.  
> Internal-only infrastructure must remain internal.

For every discovered capability classify it as exactly one of:

- `CUSTOMER_VISIBLE`
- `CUSTOMER_ENTITLEMENT_GATED`
- `CUSTOMER_ROLE_GATED`
- `ADMIN_VISIBLE`
- `ADMIN_CAPABILITY_GATED`
- `SUPPORT_VISIBLE`
- `SUPPORT_CAPABILITY_GATED`
- `INTERNAL_ONLY`
- `NOT_PRODUCTIZED_BLOCKED`

There must be no `UNCLASSIFIED` item at the end of the run.

---

# PRE-FLIGHT

Run from `E:\MyCodes\Mox`.

Record:

```cmd
git branch --show-current
git rev-parse HEAD
git status --short
node -v
pnpm -v
```

Requirements:
- branch must be `master`;
- working tree must be clean before mutation;
- do not reset, clean, stash, discard, or overwrite user work to force cleanliness;
- if dirty, STOP before source mutation and write `docs/verification/UI_PARITY_PREFLIGHT_BLOCKED.md`;
- do not delete branches;
- do not push to GitHub.

If HEAD differs from `ecf054d1fea293168c42d4748c9f66731a41d3ed`, do not reset it. Record the actual HEAD and perform a brief delta-aware rescan before applying this pack.

---

# SCOPE

Primary Mox-owned implementation scope:

- `apps/web`
- `apps/cli`
- `services`
- `packages`
- `runtime`
- `scripts`
- `docs`
- database schema/migrations where genuinely required

Donor/reference trees are **not automatically product requirements**. They may be consulted as historical implementation references only if Mox-owned code/contracts already establish the feature.

Never expose donor names or donor branding in:
- customer UI
- Admin UI
- Support UI
- public APIs
- public errors
- generated labels
- CLI output
- notifications

---

# SECURITY / AUTHORITY RULES

Preserve all established Mox security invariants.

In particular:

- PostgreSQL remains authoritative for durable state.
- Browser auth remains HttpOnly cookie based.
- CSRF protection remains enforced.
- PAT/token scopes do not become Admin authority.
- Admin, Support, Customer and Mox Node authority boundaries remain separate.
- Customer secrets and Mox system secrets remain physically/logically separated.
- Never expose secret values after storage.
- Billing redirect is never entitlement authority.
- Webhooks and reconciliation remain payment authority paths.
- Provider/customer VPS/root remains untrusted.
- No customer route may expose wholesale provider credentials, margin/cost internals, system model credentials, staff authority, audit internals or abuse controls.
- No "temporary" wildcard authorization.
- Do not weaken SSRF, signing-secret, fencing, idempotency, rate-limit, tenant-isolation or egress controls repaired previously.

If surfacing a feature requires crossing one of these boundaries, create the correct safe projection/API instead of reusing an internal/Admin endpoint.

---

# NO FAKE PRODUCT STATE

Do not fabricate success or placeholder production data.

Forbidden examples:

- hardcoded `cpuPct: 0` when CPU is unknown;
- hardcoded `memPct: 0` when memory is unknown;
- mapping every non-running server to `provisioning`;
- hardcoding every deployment target to `sandbox`;
- hardcoding every deployment state to `desired`;
- setting every model to `available: true`;
- returning submitted room members without persisting them;
- marking an integration "connected" when credentials/runtime binding were never established;
- a clickable production-looking button guaranteed to return HTTP 501.

Use explicit states such as:
- unavailable
- not configured
- requires setup
- requires entitlement
- requires role
- provider unavailable
- telemetry unavailable

when that is the truth.

---

# IMPLEMENTATION DISCIPLINE

For each phase:

1. Re-scan relevant source before editing.
2. Create/update the phase verification report requested by that file.
3. Add or update tests.
4. Run focused tests.
5. Run affected-package typecheck/build where available.
6. Run `git diff --check`.
7. Only after the phase is green, create a **local commit** with the phase's requested commit message.
8. Do **not** push.

If a phase fails:
- do not bulldoze through the failure;
- write a precise blocking report;
- preserve completed, verified earlier commits;
- stop before starting the next dependent phase.

Do not rewrite unrelated production code.

---

# UX STANDARD

A capability that belongs to a surface must be discoverable without guessing a URL.

Customer features should appear in the correct combination of:
- sidebar navigation
- page-level actions
- agent workspace tabs/settings
- Settings
- Billing
- contextual empty states
- entitlement/role-gated controls

Admin and Support features should similarly appear in their capability-aware navigation.

A hidden deep-link route does not count as surfaced.

For gated features:
- show them when product UX benefits from discoverability;
- clearly state why unavailable;
- provide upgrade/setup action where appropriate;
- do not reveal features that security/product policy says must remain invisible to that user class.

---

# TEST STANDARD

At minimum, add automated coverage for:

- surface navigation visibility;
- capability/role/entitlement gates;
- safe endpoint authority;
- happy path;
- unauthorized/forbidden path;
- unavailable/not-configured path where relevant;
- persistence across reload/re-read;
- tenant isolation;
- no internal-only data crossing into customer/support responses.

Prefer tests against real service/control-plane seams over snapshot-only UI tests.

---

# FINAL OUTPUTS

The run must finish with:

`docs/verification/UI_PARITY_MASTER_REPORT.md`

containing:

- starting SHA
- ending SHA
- local commits created
- files changed
- migrations added
- full surface inventory summary
- customer features surfaced
- Admin features surfaced
- Support features surfaced
- intentionally internal-only capabilities
- intentionally blocked/not-productized capabilities
- tests run
- exact pass/fail totals
- remaining blockers
- manual/live-provider tests still required
- statement that no push was performed

The final phase also creates:

`docs/verification/UI_PARITY_FINAL_MATRIX.md`

No feature discovered in Mox-owned code may remain silently unclassified.
