# MOX — PHASE 01
# DEV DIRECT ACCESS + FIRST SUPERADMIN BOOTSTRAP

> ✅ **STATUS: DONE** — implemented and verified. See
> `docs/verification/PRODUCT_COMPLETION_01_ADMIN_BOOTSTRAP_DEV_ACCESS.md`.
> Local commit: `feat(platform): add secure first-admin bootstrap and preserve dev access`.
> Dev direct access now opens populated Studio fixtures; first-superadmin
> bootstrap CLI added as `pnpm mox:bootstrap-admin` (existing-account only,
> idempotent, audited, fail-closed). Nothing pushed.

Use **Gemini 3.1 Pro High**.

## REPOSITORY

Work in `E:\MyCodes\Mox`, branch `master`, from a clean tree. Re-scan current HEAD; do not reset legitimate newer commits. Preserve onboarding and every prior security repair. Do not push.

## A. SAFE DEV DIRECT ACCESS

Preserve the current auth-page development shortcuts.

Make Customer shortcut open the populated Customer dashboard by default. Do the same for Admin and Support using populated fixture views.

Prefer explicit Studio URLs if supported:

```text
/__ui?surface=customer&page=/dashboard&state=populated
/__ui?surface=admin&page=dashboard&state=populated&role=superadmin
/__ui?surface=support&page=overview&state=populated&role=support_manager
```

Adapt to the real Studio URL contract.

Do NOT create hardcoded production demo credentials or a production auth bypass. Keep this behind `import.meta.env.DEV` and the existing UI Studio security gate. Studio must never mint real auth cookies or mutate PostgreSQL.

Every later new feature must be represented in the corresponding isolated fixture so this direct-access path remains useful for UI work.

## B. SECURE FIRST-SUPERADMIN BOOTSTRAP

Mox correctly separates customer org roles from platform staff. Preserve this.

Implement a secure operator-only mechanism so the first superadmin does not require manually editing PostgreSQL.

Preferred result:

```text
existing Mox account
→ explicit local/server CLI bootstrap
→ durable superadmin membership
→ /admin/login works
→ all later staff managed by Staff & Access
```

Requirements:
- local/server-side CLI/script, NOT public web endpoint;
- use existing `users` + `platform_staff_memberships` authority;
- identify existing account by email or user id;
- no duplicate user;
- audit the grant;
- idempotent for the same already-active superadmin;
- fail closed after initial bootstrap unless documented break-glass;
- do not log plaintext bootstrap secrets/tokens.

A root command may look like:

```text
pnpm mox:bootstrap-admin -- --email owner@example.com
```

Use repository conventions.

Do not remove existing `MOX_PLATFORM_ADMIN_USER_IDS`, roles or capability mappings if they are still a break-glass/deployment mechanism.

Verify:
- org owner without platform staff authority cannot enter Admin;
- durable superadmin can log in through `/admin/login`;
- Admin signup remains invite-only;
- Staff & Access remains superadmin-gated.

## TESTS

Cover:
- dev shortcuts present in development;
- production has no shortcut/bypass;
- all three fixture routes work;
- bootstrap existing user;
- no duplicate;
- audit;
- org owner denied Admin without grant;
- durable superadmin accepted.

Run affected web/control-plane/auth suites, then full lint/typecheck/test/build/branding/secret/authority/dependency gates and PostgreSQL verification if DB/auth changes.

Report:
`docs/verification/PRODUCT_COMPLETION_01_ADMIN_BOOTSTRAP_DEV_ACCESS.md`

Local commit:
`feat(platform): add secure first-admin bootstrap and preserve dev access`

Do not push.
