# MOX UI COMPLETION REPAIR PACK — 00 RUN ALL

Work in `E:\MyCodes\Mox` on `master`.

Reference GitHub HEAD when this pack was authored:
`e78af1e685ebccde82d1d777ec0da9ed12bd221a`

This SHA is context only. Before editing run:

```cmd
git fetch --prune origin
git switch master
git branch --show-current
git rev-parse HEAD
git rev-parse origin/master
git status --short
```

Requirements:
- branch must be `master`;
- working tree must be clean;
- if HEAD legitimately advanced, do NOT reset it: re-scan current clean source and adapt;
- if dirty, STOP and report without discarding user work;
- do not push to GitHub.

Execute these prompts automatically in order:

1. `01_FIX_UI_STUDIO_ROUTING_VISIBILITY_AND_HIDDEN_FEATURES.md`
2. `02_REBUILD_CUSTOMER_ADMIN_SUPPORT_UI.md`
3. `03_FINAL_UI_EXPOSURE_AND_NAVIGATION_REVALIDATION.md`

Do not ask the user to continue between phases unless a genuine hard blocker prevents safe continuation.

After each successful phase:
- write the requested verification report;
- run focused tests and `git diff --check`;
- create the requested local commit;
- continue automatically.

## Product rule

Do NOT dump internal code into the UI.

Every Mox-owned capability must be classified as exactly one of:
- `CUSTOMER_VISIBLE`
- `CUSTOMER_ENTITLEMENT_GATED`
- `CUSTOMER_ROLE_GATED`
- `ADMIN_VISIBLE`
- `ADMIN_CAPABILITY_GATED`
- `SUPPORT_VISIBLE`
- `SUPPORT_CAPABILITY_GATED`
- `INTERNAL_ONLY`
- `NOT_PRODUCTIZED_BLOCKED`

There must be zero `UNCLASSIFIED` items at the end.

Customer capabilities must be discoverable on Customer. Admin capabilities must be discoverable for the Admin role that owns them. Support capabilities must be discoverable for the Support role that owns them. Internal security/credential/provider/database/runtime infrastructure stays internal.

## Known defects that must be re-verified

1. Admin Studio capability names have historically not matched canonical production capability names, causing real Admin sections to disappear.
2. Customer Studio sidebar links can leave `/__ui` and hit production routes instead of switching the preview page, causing blank/incorrect pages.
3. Admin and Support Studio do not have equivalent complete page selectors/navigation.
4. Support `Populated` preview can look empty until a search is manually performed.
5. Support Manager escalation visibility may be missing because Studio does not grant the canonical escalation capability.
6. Customer/Admin/Support dashboards still look like engineering consoles rather than a finished commercial product.
7. Some legitimate code/API/service functionality may still exist without a discoverable UI entry point.

## Security

Do not solve visual/testing problems by weakening production auth.

UI Studio must remain:
- Vite DEV only;
- explicit opt-in;
- localhost only;
- isolated fixtures;
- no fake production session;
- no Admin/Support auth bypass;
- no real privileged API mutations;
- no PostgreSQL mutation from fixtures.

Studio fixtures are allowed. Production hardcoded fake data is not.

Do not begin mandatory onboarding work in this pack. This pack must finish first so onboarding can inherit a stable dashboard design system.
