# MOX — REMAINING PRODUCT COMPLETION AUTORUN
# EXECUTE PROMPTS 01–08 SEQUENTIALLY

Use **Gemini 3.1 Pro High** if running in Antigravity.

## REPOSITORY / SAFETY

Repository: `E:\MyCodes\Mox`  
Branch: `master`  
Reference HEAD when authored: `7a8910cf3891cbf9bbf19a9173cd38fc1d765e77`

At start:

```cmd
git fetch --prune origin
git switch master
git branch --show-current
git rev-parse HEAD
git rev-parse origin/master
git status --short
```

Requirements:
- start clean on `master`;
- if `master` legitimately advanced, do NOT reset it; re-scan current source;
- preserve all prior security repairs;
- onboarding is already fixed: preserve it and do not recreate/redesign it;
- do not weaken auth, RBAC, entitlements, tenant isolation, billing authority, credential isolation, SSRF, runtime egress, auditability;
- never fabricate production success/data;
- test/dev fixtures stay isolated;
- never expose provider SKU/wholesale cost/system credentials/raw secrets/root tokens/staff-only data to customers;
- extend canonical stores/services/APIs instead of creating competing authorities;
- inspect migration head before choosing the next migration number;
- do not push automatically.

## MANDATORY DEV DIRECT-ACCESS INVARIANT

The current auth UI contains a development-only `DEV MODE DIRECT ACCESS` block with safe UI-Studio shortcuts for Customer/Admin/Support. Preserve it in every phase.

Current concept:

```text
User Dashboard    -> /__ui?surface=customer
Admin Dashboard   -> /__ui?surface=admin
Support Dashboard -> /__ui?surface=support
```

For any new surface/feature:
- update UI Studio fixtures so it is inspectable through the relevant shortcut;
- keep shortcuts behind `import.meta.env.DEV` and existing Studio security;
- use isolated deterministic fixtures;
- never create production demo credentials;
- never set real auth cookies from Studio;
- never bypass server authorization;
- never mutate PostgreSQL from Studio;
- production builds must not have a usable direct-access bypass.

## USER DECISION

Onboarding has already been fixed. Treat it as completed protected functionality.

## EXECUTION CONTRACT

Read and execute these files strictly in order:

1. `01_DEV_DIRECT_ACCESS_AND_FIRST_ADMIN_BOOTSTRAP.md`
2. `02_CUSTOMER_SERVER_PROVISIONING.md`
3. `03_AGENT_ROOMS_SHARED_CONVERSATION.md`
4. `04_RUNTIME_WORKSPACE_SURFACES.md`
5. `05_MODEL_PROBES_AND_CLI_RUNTIME_STATE.md`
6. `06_SUPPORT_ESCALATION_AND_STAFF_ROLE_UNIFICATION.md`
7. `07_AGENT_VERSION_DIFF_AND_RESIDUAL_PRODUCTIZATION.md`
8. `08_BROWSER_E2E_AND_FINAL_REVALIDATION.md`

For each phase:
1. re-scan current tree;
2. implement only that phase;
3. add/update tests;
4. run phase verification;
5. write requested report;
6. run `git diff --check`;
7. create requested local commit;
8. confirm clean tree;
9. continue.

Do NOT push.

STOP immediately on failing tests, migration failure, Critical/High security regression, or unresolved destructive architecture conflict. Do not weaken tests to continue.

## GLOBAL COMPLETION TARGET

At the end:
- dev direct access remains safe and useful for Customer/Admin/Support;
- first superadmin bootstrap is productized for operators;
- Customer server provisioning is real;
- Agent Rooms have durable shared conversations;
- Computer/Files/Terminal/Logs use real runtime authority where underlying runtime exists;
- model probes are vault-backed and real;
- CLI/runtime state is truthful/productized;
- Support escalation is durable;
- staff roles are unified;
- Agent version diff is visible;
- hidden/blocked capability matrix is closed/reclassified;
- repeatable browser E2E exists;
- light/dark/system themes and onboarding remain intact;
- production auth stays fail-closed.

Final output: starting SHA, final local SHA, local commits, migrations, verification results, external deployment requirements, remaining intentional unavailability, and confirmation nothing was pushed.
