# Security Repair 07

Date: 2026-08-26

## Repository Identity

- Repository snapshot: `E:\MyCodes\Mox`
- Remote recorded in `_MOX_SOURCE_INFO.txt`: `https://github.com/knohitch/mox.git`
- Branch: `master`
- Starting SHA: `0fe5dd1b48fa6302c14bad1392f5d5f5bad4b7c4`
- Starting working-tree state recorded by the snapshot: `CLEAN`
- `_MOX_SOURCE_INFO.txt` records `0fe5dd1` immediately after `407db65`, with the
  `0fe5dd1` commit subject `docs: update security revalidation artifacts`.
- The repository snapshot intentionally excludes `.git`. The completed bootstrap
  check for this session accepted the `407db659115955ebaeab2fe60d3f78f4015f0419`
  → `0fe5dd1b48fa6302c14bad1392f5d5f5bad4b7c4` delta as documentation/
  revalidation-artifact only. This source-only environment cannot independently
  recompute `git diff 407db...HEAD`, `git log`, `git status`, or `git rev-parse`.

No commit or push was performed during Repair 07.

## Files Changed

1. `packages/database/migrations/0016_security_repair_07_refund_state.sql`
2. `packages/database/src/pg-billing-store.ts`
3. `packages/database/src/pg-orchestrator-store.ts`
4. `packages/database/src/schema/payment-providers.ts`
5. `packages/security/src/index.ts`
6. `packages/security/src/ssrf.ts`
7. `packages/security/tests/security-repair-07.test.ts`
8. `runtime/agent-runtime/tests/computer-tool.test.ts`
9. `runtime/computer-runtime/src/gateway.ts`
10. `runtime/computer-runtime/tests/gateway.test.ts`
11. `scripts/run-postgres-verification.ps1`
12. `services/billing/src/service.ts`
13. `services/billing/src/store.ts`
14. `services/billing/src/types.ts`
15. `services/billing/tests/security-repair-07.test.ts`
16. `services/channel-gateway/src/gateway.ts`
17. `services/channel-gateway/tests/security-repair-07.test.ts`
18. `services/compute-orchestrator/src/service.ts`
19. `services/compute-orchestrator/src/store.ts`
20. `services/compute-orchestrator/tests/security-repair-07.test.ts`
21. `services/control-plane/tests/security-repair-07-http.test.ts`
22. `services/control-plane/tests/security-repair-07.test.ts`
23. `services/integration-gateway/src/providers.ts`
24. `services/integration-gateway/tests/security-repair-07.test.ts`
25. `docs/verification/SECURITY_REPAIR_07_FINAL_RESIDUALS.md`

## Migration Added

`packages/database/migrations/0016_security_repair_07_refund_state.sql`

The repository's production migration script reads committed SQL migrations and
applies them in lexicographic order. `0016` is therefore the next forward-only
migration after `0015_security_repair_distributed_hardening.sql`; no historical
migration was rewritten.

The migration adds `provider_refund_states`, keyed uniquely by:

- provider name;
- provider environment;
- immutable provider billing identity.

It stores a PostgreSQL `bigint` cumulative amount, a durable subscription
binding, the provider event that most recently advanced the maximum, and
created/updated timestamps. The cumulative amount has a non-negative check.
Existing billing rows are preserved. Historical refund-effect rows cannot be
safely backfilled because they did not persist cumulative provider refund
amounts; the next verified cumulative refund event establishes the durable
maximum for that provider billing identity.

## A — DNS-Rebinding SSRF

### Files changed

- `packages/security/src/ssrf.ts`
- `services/channel-gateway/src/gateway.ts`
- `services/integration-gateway/src/providers.ts`
- `packages/security/tests/security-repair-07.test.ts`
- `services/channel-gateway/tests/security-repair-07.test.ts`
- `services/integration-gateway/tests/security-repair-07.test.ts`

### Old vulnerable flow

`safeOutboundFetch()` already had a secure default transport:

`resolve DNS → validate every answer → node:http/https connection using a pinned lookup`

However, both production-shaped callers defeated that default by constructing
an injected fetch transport even when the caller supplied nothing:

- `HttpOutboundTransport` defaulted its constructor `fetchImpl` to global
  `fetch`;
- `WebhookAutomationProvider` initialized `fetchImpl` to global/native fetch.

`safeOutboundFetch()` therefore validated one DNS result and then delegated the
connection to a fetch implementation that could resolve the hostname again.
That separated validation DNS from connection DNS and preserved a DNS-rebinding
TOCTOU path.

### Repaired flow

Both callers now store a fetch implementation only when one was explicitly
provided. Default/production construction leaves `fetchImpl` undefined and
calls `safeOutboundFetch()` without it.

Default execution is now:

1. parse and validate target URL/scheme/hostname/port;
2. resolve the hostname once for that hop;
3. reject the hop if **any** resolved address is blocked by canonical SSRF
   policy;
4. pass exactly the validated address set into a custom Node lookup;
5. connect with `node:http`/`node:https` using only that pinned set;
6. preserve the original hostname as the request hostname and TLS `servername`.

The validation and actual TCP/TLS connection therefore share the same address
authority. A later DNS answer cannot replace the validated address set on the
default path.

### Redirect behavior

When redirect following is enabled, every hop repeats the complete
parse/validate/resolve/validate/pin cycle. A redirect does not reuse the prior
hop's addresses. When the hostname changes, `authorization`, `cookie`, and
`proxy-authorization` are removed before the next request.

### TLS behavior

The original hostname is retained as `hostname` and `servername`; Node's normal
certificate hostname validation remains in effect. Repair 07 does not set
`rejectUnauthorized: false` or an equivalent bypass.

### Test seam

`fetchImpl` remains available for explicit fixtures/mocks. It is documented as
a test-only seam and does not provide resolved-IP pinning. Production/default
construction of both real callers no longer supplies it.

### Tests

- A1: default `HttpOutboundTransport` reaches Node HTTPS and does not call global
  fetch.
- A2: default `WebhookAutomationProvider` reaches Node HTTPS and does not call
  global fetch.
- A3: simulated rebinding proves the connection lookup can serve only the first
  validated public address and does not re-resolve.
- A4: mixed public/private answers reject if any answer is loopback, RFC1918,
  link-local/metadata, ULA, or IPv4-mapped private IPv6.
- A5: original hostname is preserved for SNI/certificate verification; TLS
  verification is not disabled.
- A6: redirect hops receive new resolve/validate/pin cycles and cross-host
  credentials are stripped.
- A7: explicit fixture injection remains possible but is not the production
  default.

## B — Stripe Cumulative Refund

### Files changed

- `packages/database/migrations/0016_security_repair_07_refund_state.sql`
- `packages/database/src/schema/payment-providers.ts`
- `packages/database/src/pg-billing-store.ts`
- `services/billing/src/types.ts`
- `services/billing/src/store.ts`
- `services/billing/src/service.ts`
- `services/billing/tests/security-repair-07.test.ts`
- `services/control-plane/tests/security-repair-07.test.ts`

### Durable authority

Stripe `charge.refunded` is treated as cumulative state for the immutable charge
identity rather than as a one-shot refund business effect. The durable key is:

`provider_name + environment + billing_identity`

where Stripe charge refunds use `charge:<charge id>` as the billing identity.
The durable row stores the maximum observed `amount_refunded` as PostgreSQL
`bigint`.

The PostgreSQL implementation enters a transaction and obtains a
transaction-scoped advisory lock derived from the complete provider/
environment/billing-identity tuple **before** reading or inserting the row.
That closes the first-insert race across workers. Hash collisions can only add
serialization; correctness remains protected by the full unique database key.

After the lock:

- no row → insert the first observed positive cumulative amount;
- strictly larger amount → update to that amount;
- identical or lower amount → do not advance;
- reuse of the same durable provider identity for another subscription → reject
  instead of guessing tenant/subscription binding;
- a row whose subscription was deleted and set to NULL is not rebound by
  inference.

Provider name and environment are included in both the advisory-lock authority
key and the unique database identity, so test/live and different providers are
isolated.

### Dedupe and partial → full behavior

For Stripe only:

- `3000` first observation advances durable state and retains the documented
  partial-refund access policy;
- replay `3000` does not advance state or duplicate a financial effect;
- `3000 → 6000 → 10000` legitimately advances the durable maximum each time;
- once the durable amount reaches/exceeds canonical Mox price authority, the
  subscription converges to `suspended` with source `refund` and reason
  `full_refund_processed`;
- the existing commercial reconciliation item is enqueued idempotently;
- replay `10000` remains duplicate at the cumulative-state layer while the
  suspension/reconciliation substeps are deliberately re-entered idempotently,
  repairing a crash that occurred after state advancement but before the local
  suspension completed.

Refund observation updates touch only refund/reconciliation observation fields.
They do not write a stale subscription lifecycle state, so a racing partial
refund cannot overwrite a concurrent full-refund suspension.

Non-Stripe refund adapters retain their previous provider-specific business-
effect behavior; Repair 07 does not reinterpret individual non-Stripe refund
amounts as cumulative state.

### Concurrency

The real PostgreSQL path serializes one provider/environment/billing identity
across workers with `pg_advisory_xact_lock` inside the same transaction that
reads/advances the row. Concurrent different amounts therefore converge to the
highest durable amount. Restarted store/orchestrator objects read the same row;
refund authority is not process memory.

### Tests

- B1: `3000 → 10000`, partial remains entitled, full refund suspends.
- B2: replay `3000` is idempotent.
- B3: `3000 → 6000 → 10000` converges to `10000`.
- B4: replay `10000` does not duplicate transition/reconciliation effects.
- B5: concurrent cumulative updates converge to the maximum and one full-refund
  transition.
- B6: PostgreSQL durability/restart plus concurrent worker advancement.

## C — Cancel Retry

### Files changed

- `services/compute-orchestrator/src/store.ts`
- `packages/database/src/pg-orchestrator-store.ts`
- `services/compute-orchestrator/src/service.ts`
- `services/compute-orchestrator/tests/security-repair-07.test.ts`
- `services/control-plane/tests/security-repair-07.test.ts`

### State-machine repair

The existing cancel operation identity remains:

`<order id>:cancel`

Historical operations are not deleted. A deliberate retry of an errored order
whose canonical cancel operation is `abandoned` performs a guarded revival of
that same durable operation:

- only an `abandoned` row can transition back to `queued`;
- attempts reset to zero for the new deliberate retry;
- max attempts/next attempt are refreshed;
- prior error and lease ownership are cleared;
- the historical operation id/idempotency identity is retained.

PostgreSQL revival is a conditional `UPDATE ... WHERE state='abandoned'
RETURNING ...`. A concurrent replay that loses that update reads the canonical
row after the other caller has revived/claimed/completed it.

### Runnable-authority invariant

`cancelOrder()` establishes or revives durable cancel work **before** writing
`order.state = cancelling`. A non-runnable state is refused.

The scoped Repair-07 re-scan found and repaired an adjacent race: a duplicate
HTTP retry could hold a stale order object while a reconciler completed or
abandoned the operation, then overwrite `retention`/`error` back to
`cancelling`. After the `cancelling` write, `cancelOrder()` now re-reads the
canonical cancel operation:

- `succeeded` → converge the order to canonical `retention`;
- missing/abandoned/exhausted authority → converge the order to visible
  `error`;
- queued/running/retryable failed authority → `cancelling` is valid because
  runnable/reconcilable work exists.

If the operation changes after that read, the reconciler's fenced operation
write occurs first and its subsequent order-state write performs the matching
convergence. The order therefore cannot remain indefinitely `cancelling` with
zero runnable/reconcilable cancel authority.

### Provider idempotency

If the provider delete completed but the worker crashed before persisting Mox
success, a retry can observe provider HTTP 404/not-found. For the **cancel**
operation only, normalized `ProviderError` with HTTP 404 is treated as the
already-satisfied desired provider state (instance absent) and converges to
retention. Other provider errors retain normal retry/abandon behavior.

### Idempotency and quota release

- duplicate cancel in `canceled`, `destroyed`, or `retention` is a no-op;
- same retry/double-click reuses one operation identity and cannot create
  uncontrolled provider deletes;
- a later intentional retry can revive the abandoned authority again if a
  prior retry also failed;
- abandoned cancellation remains visible as order `error`;
- successful retry reaches `retention`;
- canonical quota counts `cancelling` but not `retention`, so capacity is
  released when the successful cancellation reaches the capacity-releasing
  lifecycle state.

### Tests

- C1: abandon → order error → retry produces queued/runnable authority.
- C2: successful retry reaches retention.
- C3: same retry/double-click stays idempotent and emits one provider cancel.
- C3a: stale duplicate retry cannot overwrite completed cancel authority back to
  `cancelling`.
- C3b: provider 404 after an already-completed delete converges successfully.
- C4: a genuinely later retry can revive authority again.
- C5: terminal-state cancellation is a no-op.
- C6: quota=1 becomes available again after retried cancellation reaches
  retention.
- C7: PostgreSQL/restart test covers abandoned-operation revival and successful
  convergence after a fresh store/orchestrator instance.

## D — Gateway Secret

### Canonical validator

`packages/security/src/index.ts` now exports one signing-secret authority:

`validateGatewaySigningSecret()`

It rejects:

- missing/blank secret;
- the legacy public test secret;
- fewer than 32 characters;
- fewer than three of lowercase/uppercase/digit/symbol classes.

A valid explicitly configured strong secret is accepted.

### All authority-establishing paths

The same validator is now used by:

- `gatewayTokenSecretFromEnv()` for environment configuration;
- `mintGatewayToken()` for explicit injected signing authority;
- `verifyGatewayToken()` for explicit verification authority;
- `ComputerGateway` constructor for direct DI/construction.

If `ComputerGateway` is constructed without an injected secret, it uses the
environment helper, which invokes the same validator and fails closed when the
environment authority is absent/weak. There is no constructor-only weak-secret
path and no test-only production fallback.

### Tests

Direct gateway/helper coverage includes missing, legacy, short, long low-
diversity, and strong deterministic fixture secrets. Mint and verify helper
coverage confirms the same injected-secret policy.

## E — Browser/Computer Egress

### No-policy behavior

`ComputerGateway` now installs `new EgressPolicy()` when the caller omits an
egress policy. `EgressPolicy` is default-deny, so omission can no longer mean
unrestricted browser navigation.

### Explicit policy behavior

- explicit deny rule → navigation denied before provider execution;
- explicit allowlisted destination → navigation allowed when the rest of the
  capability/policy/entitlement flow permits it;
- unknown destination with the normal allowlist policy → default deny;
- malformed and non-HTTP(S) targets remain denied.

The existing agent-runtime browser test fixture that intentionally performs
successful navigation now injects a **test-only allowlist for `example.com`**.
The test that intentionally validates a policy-engine denial receives the same
test-only egress allowlist so the request reaches the policy layer and still
proves the intended policy denial. Production fail-closed behavior was not
weakened to preserve old tests.

### Production composition status

The control-plane endpoint
`GET /api/computer/:agentId/snapshot` still authenticates/authorizes and then
returns HTTP `501` with code `not_configured`. It does not instantiate a
`ComputerGateway` or claim a production browser networking path that does not
exist yet.

### Honest networking limitation

`ComputerGateway` egress authorization is hostname-level. It does **not** pin a
real browser engine's DNS resolution to an independently validated address set.
Repair 07 therefore makes no resolved-IP SSRF claim for future browser
composition. Production browser wiring must add a technically enforced network-
layer control before that claim can be made; until then the production endpoint
remains `not_configured`.

## Regression Results

### Tests added or updated

- `packages/security/tests/security-repair-07.test.ts`
- `runtime/agent-runtime/tests/computer-tool.test.ts`
- `runtime/computer-runtime/tests/gateway.test.ts`
- `services/billing/tests/security-repair-07.test.ts`
- `services/channel-gateway/tests/security-repair-07.test.ts`
- `services/compute-orchestrator/tests/security-repair-07.test.ts`
- `services/control-plane/tests/security-repair-07-http.test.ts`
- `services/control-plane/tests/security-repair-07.test.ts`
- `services/integration-gateway/tests/security-repair-07.test.ts`

`run-postgres-verification.ps1` was updated to include the Repair-07 PostgreSQL
suite.

### Verification commands actually executed successfully

- Changed-TypeScript transpile/syntax validation over all 22 changed `.ts`
  files: **PASS** (`TRANSPILE_SYNTAX_OK`).
- `node scripts/public-branding-scan.mjs`: **PASS** — clean.
- `node scripts/authority-scan.mjs`: **PASS** — clean.
- Supplemental source-only secret scan using the same patterns/exclusions as
  `scripts/secret-scan.mjs`, but enumerating the source snapshot without Git:
  **PASS** — clean.
- Supplemental source diff-style validation over all changed files: **PASS** —
  no trailing whitespace, conflict markers, or missing final newline.
- `git diff --no-index --check /mnt/data/Mox_BASELINE /mnt/data/Mox_WORKING`:
  emitted **no whitespace diagnostics**; exit status is 1 because the two trees
  intentionally differ, not because a whitespace diagnostic was emitted.
- Scoped static Repair-07 source invariant assertions for SSRF, refund-state,
  cancel authority, gateway-secret and browser-egress construction: **PASS**.
- Executed transpiled security runtime assertions for canonical gateway-secret
  validation plus default-deny/allowlist/deny egress behavior: **PASS**.
- Executed transpiled SSRF pure-runtime assertions for single DNS validation,
  pinned lookup, mixed/private rejection, hostname/SNI preservation and TLS
  verification posture: **PASS**.

### Required commands that could not execute as repository tests/builds

The uploaded snapshot intentionally excludes `node_modules`. The container has
no `pnpm` executable. Corepack is installed, but attempting to provision the
repository-declared `pnpm@10.15.1` fails because DNS/network access to the npm
registry is unavailable (`getaddrinfo EAI_AGAIN registry.npmjs.org`). Therefore
none of the following can honestly be counted as run/passed:

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- focused Vitest Repair-07 suites
- `pnpm build`
- `pnpm public-branding-scan` (the underlying Node script was run directly and
  passed)
- `pnpm secret-scan` (see dedicated limitation below)
- `pnpm scan:authority` (the underlying Node script was run directly and
  passed)
- `pnpm dependency-security`

A direct `pnpm lint` attempt returned `command not found`. A direct global
TypeScript project check (`tsc -p packages/security/tsconfig.json --noEmit`)
could not proceed because the excluded dependency tree also removes the
required Node type definitions (`TS2688: Cannot find type definition file for
'node'`). The changed-file transpile validation above therefore remains syntax
validation, not a substitute for repository typecheck.

The container is running Node `v22.16.0`, while the repository declares
`node >=24`; this is an additional reason not to present this container as a
full production-equivalent build/test environment.

### Secret-scan limitation

`node scripts/secret-scan.mjs` was attempted. It enumerates files using
`git ls-files --cached --others --exclude-standard`, so the intentional absence
of `.git` causes it to exit before scanning (`fatal: not a git repository`). It
is **not** recorded as passed. The supplemental source-only equivalent described
above was run and was clean.

### Dependency-security limitation

`corepack pnpm audit --audit-level high` was attempted. Corepack attempted to
obtain `pnpm@10.15.1` and failed with DNS error `EAI_AGAIN` for the npm registry.
No local alternative dependency vulnerability database/scanner is present, so
`pnpm dependency-security` is **not** recorded as passed.

### Git diff limitation

The exact repository command `git diff --check` requires Git repository
metadata and cannot run against this source-only snapshot. The supplemental
source diff-style checks listed above were clean.

## PostgreSQL Verification

**NOT EXECUTED / NOT PASSED IN THIS ENVIRONMENT.**

The required command was attempted:

`powershell -ExecutionPolicy Bypass -File scripts\run-postgres-verification.ps1`

The container has neither `powershell` nor `pwsh` (`command not found`). It also
has no local `psql`, `initdb`, or `pg_ctl` binaries. Therefore the required real
PostgreSQL verification cannot be represented as passed here.

The script now includes `tests/security-repair-07.test.ts`, which contains:

- cumulative refund restart/concurrent-worker authority coverage;
- abandoned cancellation revival across fresh PostgreSQL store/orchestrator
  objects.

Because migration `0016` was added, both of these still require execution in a
PostgreSQL-capable environment before commit/release:

1. fresh database → migrations through `0016`;
2. upgrade database → existing historical rows preserved while `0016` is
   applied.

The actual migration mechanism was inspected: `packages/database/scripts/migrate.mjs`
applies committed `.sql` files in lexicographic order and records checksums in
`mox_migrations`; `packages/database/scripts/pg-upgrade-drill.mjs` likewise
sorts all migration files and applies all files from `0006` through current
head during the upgrade phase.

## Remaining Code Security Blockers

### Critical

NONE

### High

NONE

### Medium

NONE

No additional Critical/High/Medium code-security finding remains known within
Repair-07 scope after the source re-scan. The stale duplicate-cancel overwrite
race discovered during that re-scan was repaired and regression-covered before
this report was finalized.

The unavailable package/PostgreSQL execution gates above are verification
gaps, not silently reclassified security findings. They must still be run in a
dependency-complete environment before commit/release confidence is claimed.

## External / Live Validation Still Required

These are separate from code-security closure:

- real Stripe sandbox webhook sequences for repeated cumulative partial/full
  `charge.refunded` events and webhook replay;
- real PayPal sandbox regression validation for unaffected refund/payment
  behavior;
- provider production credentials and provider/commercial approvals;
- production-safe computer/browser networking before enabling currently
  `not_configured` browser endpoints;
- technically enforced browser resolved-IP/network-layer egress controls before
  making any browser DNS-pinning claim.

## Repair-07 Targeted Revalidation

**SAFE TO RUN: YES.**

The five requested code repairs, the adjacent cancellation race found during
scoped re-inspection, the required regression fixtures/tests, the forward-only
migration, and this report are present in the current working tree. Targeted
Repair-07 revalidation should now run against this same modified tree in an
environment with the repository dependency set and PostgreSQL/PowerShell
verification prerequisites available.

This statement means the targeted revalidation is ready to begin; it does not
claim that the unavailable full Vitest/build/PostgreSQL gates passed in this
container.
