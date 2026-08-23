# Mox Remaining Full Build + Debug Pack

Current known baseline before Prompt 01:
`28bf0a311cf97128ed9355e59e43be2c07d1a7f5`

Prompt 01 (payments) has already been launched separately.

## Execution rule

Run the remaining prompts **sequentially**, never in parallel:

1. `02_ADMIN_TO_USER_NOTIFICATIONS.md`
2. `03_FULL_MOX_ADMIN_APP.md`
3. `04_MOX_RUNTIME_COMPLETENESS.md`
4. `05_MOX_ONLY_PUBLIC_BRANDING.md`
5. `06_FULL_SYSTEM_DEEP_DEBUG_SWEEP.md`
6. `07_FINAL_PRODUCTION_RELEASE_GATE.md`

Do not automatically proceed if the current prompt introduces a migration or changes core contracts and its test suite fails.

## Shared rules for all prompts

- Full system, not MVP.
- Product identity is Mox.
- No donor-project/runtime branding in customer-facing surfaces.
- Generic UI must not use “GPT” as a synonym for AI.
- Actual model/provider names are allowed where technically necessary.
- PostgreSQL is durable business truth.
- Redis is queues/cache/locks/rate limits/ephemeral state only.
- No production `InMemory*` authority.
- No demo fallback in production.
- No fake provider success.
- No silent catch-and-success.
- Preserve real auth:
  - browser = HttpOnly cookie session;
  - CLI/programmatic = scoped PAT;
  - PAT scope never creates user/org/admin role;
  - sensitive mutations require both API scope and real server-side authorization.
- Customer VPS is untrusted.
- Mox Node cannot grant itself subscription/entitlement authority.
- All external side effects are idempotent and audited.
- Any schema change requires migrations + PostgreSQL tests.
- Do not push automatically unless explicitly instructed.
- Stop after each prompt and produce a structured report.

## Required final report for every prompt

- old SHA
- new SHA
- branch
- files changed
- migrations
- tests
- typecheck/lint/build results
- remaining blockers
- next prompt number
