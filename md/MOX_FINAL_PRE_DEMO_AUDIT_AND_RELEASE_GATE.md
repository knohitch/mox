# MOX — FINAL PRE-DEMO AUDIT + RELEASE GATE CLOSURE

## PURPOSE

This prompt is intentionally narrow.

Your job is to do only three things:

1. Fix the known stale CLI-engine PostgreSQL test correctly.
2. Run a targeted final audit for hidden/unexposed production functionality.
3. Run the existing release gates and return a clear **DEMO READY / NOT READY** verdict.

Do NOT redesign the UI.
Do NOT add new features.
Do NOT refactor unrelated code.
Do NOT push.
Do NOT deploy.
Do NOT alter correct production behavior merely to satisfy a stale test.

---

# REPOSITORY

Work in:

`E:\MyCodes\Mox`

Branch:

`master`

Before editing:

```cmd
cd /d E:\MyCodes\Mox
git branch --show-current
git status --short
git rev-parse HEAD
git fetch --prune origin
git rev-parse origin/master
```

Rules:

- work on the current `master`;
- if local legitimate changes exist, preserve them;
- do NOT reset;
- do NOT discard recent UI work;
- re-scan the current source before changing anything;
- do not rely only on old verification reports.

---

# PHASE 1 — FIX THE KNOWN STALE CLI-ENGINE TEST

A known failing PostgreSQL-gated test exists in:

`services/control-plane/tests/auth-integration.test.ts`

The stale test previously expected:

```ts
expect(engines.status).toBe(501);
expect(engines.body).toMatchObject({ code: "not_configured" });
```

for:

```text
GET /api/cli-engines
```

But CLI engine/runtime state was productized and the current endpoint legitimately returns:

```text
200
```

Do NOT change the endpoint back to `501`.

Do NOT disable the endpoint.

Do NOT weaken production behavior.

Instead:

1. inspect the current implementation of `/api/cli-engines`;
2. inspect its actual response contract;
3. confirm that `200` is the intended truthful behavior;
4. update only the stale test expectation so it validates the current contract;
5. validate meaningful response fields, not just the HTTP status;
6. ensure no secrets/credentials are returned;
7. ensure no fake/synthetic engine state is invented.

The replacement test must prove the endpoint behaves truthfully.

---

# PHASE 2 — TARGETED FINAL HIDDEN-FUNCTIONALITY AUDIT

Do NOT repeat a huge historical audit from scratch.

Re-scan only current Mox-owned production code for any remaining backend capability that is already implemented but not exposed on the intended UI.

Focus on:

```text
apps/
services/
packages/
runtime/
infra/
```

Reference/vendor trees such as:

```text
OpenBot-main/
OpenMausBot-main/
deepseek-harness-master/
```

are not product authority.

Check these product areas:

```text
Customer
Admin
Support
Agents
Agent Rooms
Threads
Thread archive
Agent versions
Version diff
Rollback
Deployments
Servers
Server ordering/provisioning
Models
CLI engines/runtime state
Integrations
Channels
Usage
Billing
Payments
Backups
API tokens
Workspace/team management
Onboarding
Computer
Files
Terminal
Logs
Notifications
Approvals
Support escalation
Admin customers
Admin plans
Admin payments
Admin compute
Admin intelligence/models
Admin runtime
Admin notifications
Admin operations
Admin staff/access
Enterprise contracts
```

For each meaningful backend capability, classify it as:

```text
EXPOSED
INTERNAL
EXTERNAL_DEPENDENCY
SECURITY_OR_OPERATIONS_ONLY
HIDDEN_REQUIRING_UI
DEAD_OR_OBSOLETE
```

Only `HIDDEN_REQUIRING_UI` is a release blocker.

Do NOT classify a capability as hidden merely because it is:

- entitlement-gated;
- role-gated;
- provider-dependent;
- runtime-dependent;
- unavailable until external infrastructure is configured.

If the UI exists and truthfully reports unavailable/not configured, that is acceptable.

---

# DEAD / FAKE / DISCONNECTED UI CHECK

Search current production code for suspicious patterns including:

```text
TODO
FIXME
not implemented
not_implemented
501
href="#"
void 0
onClick={() => void 0}
mock
fake
placeholder
stub
coming soon
return []
return {}
```

Do NOT automatically treat every match as a bug.

Identify only production-relevant cases where:

- a visible button has no real action;
- a form does not mutate authoritative state;
- a route is dead;
- UI invents success locally;
- backend capability exists but intended UI is absent;
- frontend creates fake IDs/state;
- a real error is silently converted into empty success;
- a hidden tab/page exists but cannot be reached legitimately.

Ignore test fixtures and development-only UI Studio data unless they leak into production behavior.

---

# AUTHORIZATION CHECK

Reconfirm only the critical surface boundaries.

## Customer

Customer users, including org owners, must not automatically gain:

```text
Admin
Support
platform staff capabilities
provider secrets
```

## Admin

Admin actions must remain capability-gated.

## Support

Support must remain support-safe and must not inherit unrestricted Admin authority.

Do NOT change authorization behavior.

---

# EXTERNAL DEPENDENCY CHECK

List remaining capabilities that require real deployment infrastructure, such as:

```text
MOX_RUNTIME_MODE=full
Mox Node
model/provider API credentials
MOX_CUSTOMER_CREDENTIALS_KEY
compute provider configuration
computer runtime/provider
live workloads
payment provider/webhook configuration
channel runtime
```

These are NOT release blockers for a UI/demo deployment if the product reports them truthfully.

They are blockers only if the planned demo explicitly needs those features to function live.

---

# PHASE 3 — RUN THE EXISTING RELEASE GATES

Run the repository's current checks.

## Install

```cmd
pnpm install --frozen-lockfile
```

## Lint

```cmd
pnpm lint
```

## Branding

```cmd
pnpm public-branding-scan
```

## Secrets

```cmd
pnpm secret-scan
```

## Dependency security

```cmd
pnpm dependency-security
```

If a non-blocking moderate advisory remains, report it.
Do NOT perform broad dependency upgrades in this task.

## Authority scan

```cmd
pnpm scan:authority
```

## Build

```cmd
pnpm -r run build
```

## Typecheck

```cmd
pnpm typecheck
```

## Unit/integration tests

```cmd
pnpm test
```

## PostgreSQL verification

```cmd
powershell -ExecutionPolicy Bypass -File scripts\run-postgres-verification.ps1
```

This MUST pass.

## Container builds

```cmd
pnpm container-builds
```

This MUST pass if the script is part of the current release gate.

## Browser E2E

```cmd
pnpm e2e
```

Run the existing Playwright UI Studio smoke tests.

Do NOT expand the browser suite unless a current failure reveals a real regression.

---

# DO NOT DO THESE THINGS

Do NOT:

- redesign Customer/Admin/Support UI;
- alter themes;
- change sidebar behavior;
- add features;
- remove features;
- change billing logic;
- change entitlement logic;
- change RBAC;
- bypass onboarding;
- change runtime authority;
- change provider behavior;
- modify database schema unless absolutely required by an existing bug;
- add new migrations for this task;
- weaken tests;
- convert failures into skipped tests;
- push to GitHub;
- deploy Mox;
- modify branch protection;
- perform performance refactors;
- code-split the frontend;
- clean unrelated repository files;
- rewrite operational docs unless a current release instruction is materially wrong.

Keep this task narrow.

---

# REQUIRED REPORT

Create:

`docs/verification/PRE_DEMO_FINAL_AUDIT.md`

Use this structure:

```md
# Mox Final Pre-Demo Audit

## Audited SHA

<sha>

## Working Tree

<clean / changed files>

## Known CLI Engine Test

Status:
PASS / FAIL

What changed:
<short explanation>

Current `/api/cli-engines` contract:
<short explanation>

## Hidden Functionality Audit

Exposed:
<number>

Internal:
<number>

External dependency:
<number>

Security/operations only:
<number>

Hidden requiring UI:
<number>

Dead/obsolete:
<number>

### Any Remaining Hidden Product Capability

<list or NONE>

## Fake / Dead UI Audit

<findings or NONE>

## Authorization Boundaries

Customer/Admin/Support:
PASS / FAIL

## Release Gates

| Gate | Result |
|---|---|
| Install | PASS/FAIL |
| Lint | PASS/FAIL |
| Branding scan | PASS/FAIL |
| Secret scan | PASS/FAIL |
| Dependency security | PASS/FAIL |
| Authority scan | PASS/FAIL |
| Build | PASS/FAIL |
| Typecheck | PASS/FAIL |
| Unit/integration | PASS/FAIL |
| PostgreSQL verification | PASS/FAIL |
| Container builds | PASS/FAIL |
| Playwright E2E | PASS/FAIL |

## Remaining External Dependencies

<list only real deployment/runtime requirements>

## Demo Readiness

Verdict:

DEMO READY

or

NOT DEMO READY

## Exact Blockers

<only if NOT DEMO READY>
```

---

# DEMO READY RULE

You may return:

```text
DEMO READY
```

only if:

1. the stale CLI-engine test is corrected;
2. PostgreSQL verification passes;
3. normal tests pass;
4. build passes;
5. typecheck passes;
6. authority scan passes;
7. secret scan passes;
8. branding scan passes;
9. container builds pass;
10. Playwright smoke passes;
11. no `HIDDEN_REQUIRING_UI` capability remains;
12. no production fake/no-op action remains;
13. Customer/Admin/Support authorization remains intact.

If a real external provider is not configured, report it separately rather than failing the whole product, unless that provider is required for the intended demo.

---

# FINAL OUTPUT TO ME

Return only:

1. current HEAD SHA;
2. files changed;
3. stale CLI test result;
4. hidden functionality verdict;
5. release-gate table;
6. remaining real external dependencies;
7. final verdict: `DEMO READY` or `NOT DEMO READY`;
8. exact blockers if any;
9. path to `docs/verification/PRE_DEMO_FINAL_AUDIT.md`.

Do not push.
Do not deploy.
