# Security Revalidation 08

## Working Tree Identity

- Original snapshot repository: `E:\MyCodes\Mox`
- Original snapshot branch: `master`
- Original snapshot SHA: `0fe5dd1b48fa6302c14bad1392f5d5f5bad4b7c4`
- Original snapshot working tree: `CLEAN`
- `.git` availability: **absent by design** in this source-only audit environment.
- Repair-07 Working Tree Digest: `cb9ee29ac7610150cec6e950e5c753201e84100c5acdca52af949e15fa41fd96`
- Digest construction: SHA-256 was computed for every non-generated/non-disposable file in the Repair-07 working tree (15,237 files), entries were sorted by relative path, and the overall SHA-256 was computed from deterministic `relative-path + NUL + file-sha256 + newline` records. Timestamps were not inputs. The Revalidation-08 report itself was excluded because it did not exist when the tree was fingerprinted.

## A — DNS-Rebinding SSRF

Classification: **PARTIALLY CLOSED**

The original HIGH DNS-rebinding/TOCTOU finding is closed by source inspection. However, Revalidation 08 found a separate production-reachable request-target regression in the pinned transport, so the Repair-07 outbound path as a whole cannot be declared closed.

### Evidence

- Files/symbols:
  - `packages/security/src/ssrf.ts`
    - `assertSafeOutboundUrl()`
    - `resolveValidatedAddresses()`
    - `pinnedLookup()`
    - `safeOutboundFetch()`
    - `buildPinnedRequestOptions()`
    - `performPinnedRequest()`
  - `services/channel-gateway/src/gateway.ts`
    - `HttpOutboundTransport`
  - `services/integration-gateway/src/providers.ts`
    - `WebhookAutomationProvider`
  - `packages/security/tests/security-repair-07.test.ts`
  - `services/channel-gateway/tests/security-repair-07.test.ts`
  - `services/integration-gateway/tests/security-repair-07.test.ts`

### SSRF-1 — Channel default transport

`HttpOutboundTransport` now stores `fetchImpl` only if a caller explicitly supplies it. `send()` adds `fetchImpl` to `safeOutboundFetch()` options only conditionally. `ChannelGateway` defaults to `new HttpOutboundTransport()` with no injected fetch implementation.

Result: default production-shaped channel execution does **not** inject global/native `fetch`; it reaches the pinned Node HTTP(S) path.

### SSRF-2 — Integration default transport

`WebhookAutomationProvider` stores `options.fetchImpl` exactly as supplied and does not default it to global `fetch`. `invoke()` passes it to `safeOutboundFetch()` only when defined.

Result: default production-shaped integration execution does **not** inject global/native `fetch`; it reaches the pinned Node HTTP(S) path.

### SSRF-3 — validation/connection authority

`safeOutboundFetch()` performs, for every hop:

1. URL parsing/canonical guard;
2. port validation;
3. one `resolveValidatedAddresses()` call;
4. validation of every returned address;
5. construction of a `pinnedLookup()` containing only those validated addresses;
6. Node `http.request`/`https.request` with that lookup.

A conceptual second DNS answer (`public.example -> 127.0.0.1`) cannot influence the socket after the first validated answer set has been established because Node receives the custom lookup and does not perform ordinary DNS for that request. The Repair-07 rebinding test also models a resolver that would return loopback on a second call and asserts that only the first public address is available to the socket lookup.

### SSRF-4 — mixed/private answers

`resolveValidatedAddresses()` rejects the entire DNS result if **any** answer is invalid/private. The canonical policy covers loopback, RFC1918, link-local/metadata ranges, ULA/private IPv6, multicast/special-use ranges included by policy, NAT64 private embeddings handled by the helper, and IPv4-mapped private IPv6. Literal private IP targets are also rejected before DNS.

A public + private mixed answer therefore fails before connection.

### SSRF-5 — TLS

`buildPinnedRequestOptions()` keeps `hostname = parsed.hostname` and sets `servername = hostname`. TLS verification is not weakened: no `rejectUnauthorized: false`, custom permissive `checkServerIdentity`, or equivalent bypass is present. The custom lookup changes only the IP chosen for the socket; the logical hostname remains the TLS authority/SNI name.

### SSRF-6 — redirects

When redirect following is enabled, `safeOutboundFetch()` loops back through URL guard, port validation, DNS resolution, all-IP validation, and pin construction for each redirect target. When hostname changes, `authorization`, `cookie`, and `proxy-authorization` are removed before the next hop.

### SSRF-7 — test seam leakage

`fetchImpl` remains an explicit optional seam. Current production call-site search found no production construction that supplies global `fetch` to either repaired caller. Omitting constructor options leaves the seam `undefined`; omission therefore cannot silently restore the old bypass.

### Actual defect found — pinned request target is lost

`buildPinnedRequestOptions()` constructs `https.RequestOptions` with protocol, hostname, port, method, headers, pinned lookup, and SNI server name, but it does **not** set `path` to `parsed.pathname + parsed.search` (or otherwise pass the original URL as the Node request target).

Reachable sequence:

1. a configured channel/integration URL is `https://api.example.com/hook/task?token=abc`;
2. default `HttpOutboundTransport` or `WebhookAutomationProvider` calls `safeOutboundFetch()`;
3. DNS is safely resolved/validated/pinned;
4. `performPinnedRequest()` calls `https.request(buildPinnedRequestOptions(...))`;
5. the options object has `path === undefined`;
6. Node's request target defaults to `/`;
7. the POST body and same-origin headers are therefore sent to `https://api.example.com/`, not the configured `/hook/task?token=abc` target.

Executable evidence in this audit transpiled the current `ssrf.ts`, called `buildPinnedRequestOptions()` with `/hook/task?token=abc`, and observed `PINNED_OPTIONS_PATH=<undefined>`. A local Node HTTP request created without a path was then observed by the server as `NODE_RECEIVED_PATH=/`.

Attacker/configuration prerequisite: ability to establish or influence a configured outbound webhook/channel URL, plus a host where `/` has behavior different from the intended route. This does **not** reopen private-network SSRF and does not let a second DNS answer influence the connection. It can, however, misroute authenticated payloads to an unintended same-origin handler or make all non-root webhook/channel deliveries fail.

Severity: **MEDIUM** (routing/integrity and availability regression in a production-sensitive outbound path; no private-network reachability demonstrated).

Matching Repair-07 tests currently verify pinning/TLS/redirect authority but do not assert the request pathname/query. The A5 test creates a URL containing `/path` but only checks hostname/SNI/TLS properties, which is why this regression is not covered.

Residual risk: DNS-rebinding HIGH is closed; the Node request-target regression requires a follow-up repair and regression test before the Repair-07 caller refactor can be considered production-complete.

## B — Stripe Cumulative Refund

Classification: **CLOSED** by source inspection; PostgreSQL runtime execution remains unavailable in this environment.

### Evidence

Files/symbols:

- `services/billing/src/service.ts` — `applyRefund()`, `billingIdentityFor()`, `resolveSubscriptionForEvent()`
- `services/billing/src/store.ts` — `BillingStore.advanceProviderRefundState()`, `InMemoryBillingStore.advanceProviderRefundState()`, `recordRefundObservation()`
- `services/billing/src/types.ts` — `ProviderRefundState`
- `packages/database/src/pg-billing-store.ts` — `PgBillingStore.advanceProviderRefundState()`, `recordRefundObservation()`
- `packages/database/src/schema/payment-providers.ts` — `providerRefundStates`
- `packages/database/migrations/0016_security_repair_07_refund_state.sql`
- `services/billing/tests/security-repair-07.test.ts`
- `services/control-plane/tests/security-repair-07.test.ts`

### REFUND-1 / REFUND-2 — 3000 and replay 3000

For Stripe `payment.refunded`, `billingIdentityFor()` prefers the immutable Charge identity (`charge:<chargeRef>`). `applyRefund()` converts the provider amount to `bigint` and calls `advanceProviderRefundState()`.

The stores advance only when the new cumulative amount is strictly greater than the persisted amount. Identical/lower replay returns `advanced: false`; the durable maximum remains unchanged. A partial amount does not execute full-refund suspension. `recordRefundObservation()` updates only refund-observation/reconciliation fields and does not write a stale subscription lifecycle state over a racing full-refund suspension.

### REFUND-3 — 3000 -> 6000 -> 10000

Each strict increase advances the durable maximum. Full-refund authority is computed from the **persisted authoritative maximum**, not from webhook event ID: `state.cumulativeAmountMinor >= BigInt(price.amountMinor)`.

At full refund, the service re-reads the current subscription and idempotently transitions it to `suspended` with `suspensionSource: "refund"` and `suspensionReason: "full_refund_processed"`, then enqueues commercial reconciliation. `evaluateCommercialAccess()` grants only trial/active/valid-grace states; suspended is denied.

### REFUND-4 — replay 10000 / crash convergence

A full cumulative replay may return `advanced: false`, but it still runs the idempotent suspension and reconciliation convergence steps. Transition idempotency uses the stable key `refund-full:<billingIdentity>`, and commercial reconciliation is keyed/upserted by subscription. This allows recovery from a crash after refund authority advanced but before suspension/reconciliation finished, without duplicating financial authority.

### REFUND-5 — PostgreSQL concurrency and tenant binding

Migration `0016_security_repair_07_refund_state.sql` creates one exact unique identity over `(provider_name, environment, billing_identity)` and stores `subscription_id` as the durable local binding.

`PgBillingStore.advanceProviderRefundState()` runs in one database transaction and acquires `pg_advisory_xact_lock(hashtext(JSON.stringify([providerName, environment, billingIdentity])))` **before** the first read/insert. This serializes the previously unseen-row race as well as later updates. At PostgreSQL's normal statement-snapshot behavior, the subsequent select occurs after lock acquisition and observes the committed predecessor. The exact unique DB key remains the correctness authority: advisory-hash collision can only over-serialize unrelated identities, not merge their rows.

After the lock:

- a previously deleted/null local subscription binding is not rebound;
- a different subscription attempting to reuse the same provider identity throws and is routed by the service to reconciliation rather than guessed;
- equal/lower cumulative values do not update;
- greater values update the same row;
- provider and environment are part of both lock authority material and the exact unique key.

Two workers observing 6000 and 10000 therefore serialize and converge to 10000 regardless of arrival order. Restart durability derives from the committed PostgreSQL row; a fresh store instance reads the same authority.

### REFUND-6 — bigint semantics

- Durable TS state: `ProviderRefundState.cumulativeAmountMinor: bigint`.
- Billing-store interface: input and returned cumulative authority use `bigint`.
- In-memory comparisons use bigint-to-bigint comparisons.
- PostgreSQL Drizzle mapping uses `bigint(..., { mode: "bigint" })`.
- Migration column is PostgreSQL `bigint` with a non-negative CHECK.
- `applyRefund()` compares bigint cumulative authority to `BigInt(price.amountMinor)`.
- Stripe's verified JSON adapter represents raw JSON numeric fields as JavaScript `number` and immediately converts `amount_refunded` to `BigInt(...)` when producing the internal `ProviderEvent`. No later cumulative-refund store path coerces the authority back to `number`.

Source-only caveat: exactness at the raw JSON-number boundary assumes the provider's signed amount is within JavaScript's safe-integer domain. This audit does not invent or validate Stripe's external maximum-value contract. The Repair-07 durable/refund-authority path itself is bigint end-to-end after the adapter boundary.

Residual risk: the real PostgreSQL first-insert/concurrent/restart test could not execute here; this is an environment-limited validation gap, not a source finding.

## C — Cancel Retry / Abandoned Operation

Classification: **CLOSED** by source inspection; PostgreSQL runtime execution remains unavailable in this environment.

### Evidence

Files/symbols:

- `services/compute-orchestrator/src/service.ts` — `cancelOrder()`, `reconcile()`, `executeOperation()`
- `services/compute-orchestrator/src/store.ts` — `reviveAbandonedOperation()`, fenced operation API, quota reservation
- `packages/database/src/pg-orchestrator-store.ts` — PostgreSQL revival, claim fencing, atomic quota reservation
- `services/compute-orchestrator/tests/security-repair-07.test.ts`
- `services/control-plane/tests/security-repair-07.test.ts`

### CANCEL-1 — abandoned -> error -> retry

When a cancel exhausts attempts, `reconcile()` first fenced-writes the operation to `abandoned`; only the authoritative worker then changes an order still in `cancelling` to visible `error` with the cancellation failure.

A later `cancelOrder()` uses the same canonical identity `<orderId>:cancel`. If the operation is abandoned, `reviveAbandonedOperation()` conditionally revives that same historical row to `queued`, resets attempts, clears lease/error state, and preserves its stable operation identity. Only after runnable authority exists does `cancelOrder()` write `cancelling`.

### CANCEL-2 — concurrent same retry

The PostgreSQL revival is a conditional update requiring `state='abandoned'`. One concurrent caller wins; another fetches the same canonical operation row after its conditional update affects zero rows. The unique `(order, kind, idempotency)` operation identity remains one row. Provider deletion is performed by claimed durable work, not directly by each HTTP retry.

### CANCEL-3 — stale request versus reconciler

After writing `cancelling`, `cancelOrder()` re-reads the canonical operation. If the worker has already succeeded, it converges the order to retention; if authority is missing/abandoned/exhausted, it converges to error. If the operation is still running/queued/retryable failed, runnable or lease-expiry reconciliation authority exists. Reconciler finalizers are fenced on operation id, running state, lease owner, and lease version before any order write.

The Repair-07 regression test explicitly covers a stale request whose write races a successful operation and verifies that the final order is retention rather than stranded cancelling.

### CANCEL-4 — provider 404 after remote delete

HTTP/provider 404 is treated as desired-state success **only inside `executeOperation()`'s `case "cancel"`**, and only when the thrown value is a `ProviderError` with `httpStatus === 404`. Other operation kinds and unrelated errors retain normal failure behavior. This safely handles remote deletion followed by a local crash before success was persisted.

### CANCEL-5 — terminal no-op

`cancelOrder()` returns immediately for `canceled`, `destroyed`, and `retention`.

### CANCEL-6 — quota release

Both in-memory and PostgreSQL quota counts include `cancelling` but exclude `error` and `retention`. Thus abandoned cancellation becoming error releases capacity, and successful retried cancellation becoming retention releases capacity. Atomic PostgreSQL order reservation still uses a per-org row lock around count + insert.

### CANCEL-7 — failed retry visibility

Exhausted/nonretryable cancellation writes the operation to `abandoned` under fencing, then changes a still-cancelling order to `error` with the cancel failure. Retryable failed operations retain `failed` state plus `nextAttemptAt`; running operations have lease-expiry reclaim authority. No source path found that intentionally leaves `cancelling` with zero runnable/reconcilable authority.

Residual risk: real multi-process/PostgreSQL restart execution was unavailable here.

## D — Gateway Secret

Classification: **CLOSED**

### Evidence

Files/symbols:

- `packages/security/src/index.ts`
  - `validateGatewaySigningSecret()`
  - `gatewayTokenSecretFromEnv()`
  - `mintGatewayToken()`
  - `verifyGatewayToken()`
- `runtime/computer-runtime/src/gateway.ts`
  - `ComputerGateway` constructor
- `packages/security/tests/security-repair-07.test.ts`
- `runtime/computer-runtime/tests/gateway.test.ts`

`validateGatewaySigningSecret()` is the single exported strength validator. It rejects blank/missing injected values, the legacy public test secret, values shorter than 32 characters, and values using fewer than three character classes. A deterministic strong value is accepted.

Authority paths:

- environment: `gatewayTokenSecretFromEnv()` -> canonical validator;
- direct helper injection: `mintGatewayToken(..., secret)` -> canonical validator;
- verification helper injection: `verifyGatewayToken(..., {secret})` -> canonical validator and fail-closed on validation failure;
- `ComputerGateway` direct constructor injection -> canonical validator;
- constructor omission -> environment helper -> canonical validator;
- `ComputerGateway` token verification then invokes the canonical verification helper with its already-validated secret.

A production-source call-site search found no alternate constructor/helper signing authority that bypasses this validator.

Required cases are represented in the Repair-07 tests: missing/blank, legacy, short, long low-diversity, and strong deterministic secret.

## E — Computer/Browser Egress

Classification: **CLOSED** for the currently composable code and production endpoint state.

### Evidence

Files/symbols:

- `packages/security/src/index.ts` — `EgressPolicy`
- `runtime/computer-runtime/src/gateway.ts` — `ComputerGateway` constructor and `executeAction()`
- `runtime/computer-runtime/tests/gateway.test.ts`
- `runtime/agent-runtime/tests/computer-tool.test.ts`
- `services/control-plane/src/api.ts` — `/api/computer/:agentId/snapshot`
- `services/control-plane/tests/security-repair-07-http.test.ts`

### EGRESS-1 — no policy

`ComputerGateway` installs `opts.egress ?? new EgressPolicy()`. `EgressPolicy` defaults to `defaultAction: "deny"` with no allow rules. A navigation action is checked before entitlement/policy/provider execution and is rejected when the decision is deny.

### EGRESS-2 — explicit deny

Deny rules are evaluated before allow rules and reject the target.

### EGRESS-3 — explicit test allowlist

An explicit allow rule permits the intended hostname to proceed to the entitlement/policy/provider authority layers. This is how successful navigation fixtures are configured.

### EGRESS-4 — unknown target

No matching rule returns default deny.

### EGRESS-5 — agent-runtime fixture

`runtime/agent-runtime/tests/computer-tool.test.ts` now injects an explicit test-only `EgressPolicy` allowing `example.com` into fixtures that intentionally need navigation to continue. The policy-denial fixture also supplies the allowlisted egress authority so that the test reaches the separate policy engine denial it is intended to verify. Production no-policy behavior was not weakened.

### EGRESS-6 — control plane

`GET /api/computer/:agentId/snapshot` still performs authentication/commercial authorization and then returns HTTP 501 with code `not_configured`. No production-safe browser wiring was introduced by Repair 07.

### EGRESS-7 — networking claim

Comments explicitly state that `EgressPolicy` is hostname-level authorization and that `ComputerGateway` does **not** itself pin a browser engine's DNS resolution. No false resolved-IP browser-SSRF claim was found.

Residual limitation: before a real browser engine is enabled, production composition must add network-layer controls for browser-originated DNS/connections, redirects, and any navigation caused by browser interaction. Current production 501 prevents this limitation from being silently presented as production-safe browser networking.

## Bounded Regression Pass

| Adjacent control | Classification | Source evidence |
| --- | --- | --- |
| Stripe invoice sibling-event period dedupe | **CLOSED** | `payment.succeeded` uses `invoice:<invoiceRef>` before event ID; `claimProviderBillingEffect` is unique on provider/environment/billing identity/effect, so `invoice.paid` and `invoice.payment_succeeded` for the same invoice cannot both extend the period. |
| Full refund cannot affect unrelated tenant | **CLOSED** | Event resolution uses exact provider refs/typed provider-object mappings; ambiguity becomes reconciliation. Refund-state row is bound to one subscription and rejects rebinding. |
| Refund/dispute suspension denies commercial entitlement | **CLOSED** | Both transitions use `suspended`; `evaluateCommercialAccess()` grants only valid trial/active/grace states. |
| Refund-state persistence cannot grant entitlement | **CLOSED** | Refund-state store only records monotonic financial authority; service effects are observation, suspension, reconciliation, or no-op. No grant/reactivation path is driven by `provider_refund_states`. |
| Payment success cannot improperly resurrect refund/dispute suspension | **CLOSED** | Missing-time success is reconciliation-required when prior event state exists; stale success is ignored for financial suspensions; a recovery must be a newer, canonical-amount/currency, durable-identity payment. Same-invoice sibling replay is business-effect duplicate. A genuinely new later paid invoice is new financial authority, not unguarded resurrection. |
| Provider-object mappings remain authoritative | **CLOSED** | Resolution is exact provider/environment typed mapping/direct provider ref; multiple distinct subscriptions are ambiguous and not guessed; ID-prefix inference is absent. |
| Compute operation fencing guards stale finalizers | **CLOSED** | PostgreSQL `updateOperationFenced()` matches operation id, running state, lease owner, and lease version before order side effects. |
| Atomic server quota reservation | **CLOSED** | PostgreSQL transaction inserts/locks one per-org allocation row, counts nonterminal capacity states, and inserts order + provision operation atomically. |
| Reboot operation identity repeatable/idempotent | **CLOSED** | `requestReboot(orderId, requestId)` uses `reboot:<requestId>`; same request ID returns the canonical row, a new request ID creates a new operation. |
| Cancellation revival cannot bypass fencing | **CLOSED** | Revival only changes abandoned durable authority to queued; later execution must be claimed and fenced like every operation. |
| Provider 404-as-success scope | **CLOSED** | Special case exists only in `executeOperation()` `case "cancel"` and only for `ProviderError.httpStatus === 404`. |
| URL literal private-address blocking | **CLOSED** | `assertSafeOutboundUrl()` detects literal addresses and invokes canonical private-IP policy before any network call. |
| Gateway token org/agent/session binding | **CLOSED** | Signed token requires org/agent/session claims; `ComputerGateway` requires exact token session and checks stored session owner org+agent before actions. |
| Runtime secret/log sanitization adjacent to Repair 07 | **CLOSED** | `ComputerGateway.audit()` still applies `redactMetadata()` before persistence; no Repair-07 import/interface change bypasses it. |
| Computer egress fail-closed change preserves policy-denial semantics | **CLOSED** | Egress is checked first; tests that need to exercise policy denial explicitly allow egress and still reach the policy engine. No-policy navigation remains denied earlier. |

No adjacent control above was found to have regressed. The separate pinned request-target defect is recorded under A and is not a DNS authority regression.

## Static / Interface Review

`NONE FOUND BY SOURCE INSPECTION`

Manual call-site/interface checks found:

- `BillingStore.advanceProviderRefundState()` is implemented by both in-memory and PostgreSQL stores with `bigint` parity.
- `recordRefundObservation()` exists in both stores with matching signature/semantics.
- `OrchestratorStore.reviveAbandonedOperation()` is implemented by both stores with matching signature.
- SSRF caller constructor fields are optional consistently and are conditionally forwarded.
- `validateGatewaySigningSecret` is exported and imported consistently.
- `ComputerGatewayOptions.egress` remains optional at the type level but omission is made fail-closed by construction.
- PostgreSQL refund row mapping returns `bigint` for the cumulative amount and string ISO timestamps consistently with `ProviderRefundState`.
- No stale direct production caller of the changed store methods was found.

The confirmed A request-target problem is a **functional request-options defect**, not a TypeScript signature mismatch, and is therefore listed under A rather than hidden in this section.

## Verification Actually Executed

The following checks actually ran against the current Repair-07 tree:

1. Deterministic SHA-256 working-tree manifest — completed; 15,237 files; digest `cb9ee29ac7610150cec6e950e5c753201e84100c5acdca52af949e15fa41fd96`.
2. Changed-TypeScript syntax/transpile validation using the locally installed TypeScript compiler library — **22 changed `.ts` files; `TRANSPILE_SYNTAX_OK`**.
3. `node scripts/public-branding-scan.mjs` — **PASS**: `public-branding-scan: clean — public surfaces use Mox branding`.
4. `node scripts/authority-scan.mjs` — **PASS**: `authority-scan: clean — no vendored-tree imports in Mox production code`.
5. Source-only equivalent of the repository secret scanner, using the same token/assignment patterns but filesystem enumeration instead of `git ls-files` — **CLEAN**.
6. Source-only changed-file whitespace/diff-style validation — **PASS** across the 25 Repair-07 changed files: no trailing whitespace, conflict markers, or missing final newline.
7. `git diff --no-index --check /mnt/data/Mox_BASELINE /mnt/data/Mox_WORKING` — executed as a supplemental no-repository comparison; it emitted **no whitespace diagnostics**. Exit 1 is expected from `--no-index` because the trees intentionally differ, so the exit code is not counted as a pass/fail gate.
8. Executable SSRF request-target probe using a transpiled copy of current `packages/security/src/ssrf.ts` outside the repository — confirmed `buildPinnedRequestOptions()` produces `path === undefined`; local Node request with no path arrived as `/`.

## Verification Unavailable

The following required gates were attempted or checked but could not perform their intended validation in this source-only container:

- `pnpm lint` — **UNEXECUTED**: `pnpm` executable absent (shell exit 127); `node_modules` absent.
- `pnpm typecheck` — **UNEXECUTED**: `pnpm` executable absent; `node_modules` absent.
- `pnpm test` — **UNEXECUTED**: `pnpm` executable absent; `node_modules` absent.
- `pnpm build` — **UNEXECUTED**: `pnpm` executable absent; `node_modules` absent.
- Focused Repair-07 Vitest suite through `pnpm exec vitest ...` — **UNEXECUTED**: `pnpm` executable absent; Vitest dependencies are not installed.
- `pnpm dependency-security` / `pnpm audit --audit-level high` — **UNEXECUTED**: `pnpm` absent and audit requires package-manager/network capability not present here.
- One Corepack attempt to obtain repository-declared `pnpm@10.15.1` failed with `getaddrinfo EAI_AGAIN registry.npmjs.org`; no repeated dependency-download attempts were made.
- `node scripts/secret-scan.mjs` — command launched but the scanner could not enumerate its input because it hard-depends on `git ls-files`; `.git` is intentionally absent. It terminated with `fatal: not a git repository`. Therefore the official scanner is **not counted as passed**; only the filesystem-equivalent check above is clean.
- Direct global `tsc` project checking could not provide a valid package typecheck because source dependencies/type packages are absent; the attempted security-package check reported missing `@types/node`. It is not counted as a pass.
- `powershell -ExecutionPolicy Bypass -File scripts/run-postgres-verification.ps1` — **UNEXECUTED**: neither `powershell` nor `pwsh` exists in the container.
- PostgreSQL verification also cannot be run directly: `psql`, `initdb`, and `pg_ctl` are absent.
- Runtime is Node `v22.16.0`, while repository `package.json` requires Node `>=24`; dependency-complete validation must use the required Node major.
- Ordinary Git status/diff/commit identity gates are unavailable because `.git` was intentionally omitted.

## Remaining Critical

`NONE`

## Remaining High

`NONE`

The original HIGH DNS-rebinding caller-path vulnerability is closed by current source: default channel/integration callers reach the validated/pinned Node transport and the socket lookup is constrained to the validated address set.

## Remaining Medium

1. **Pinned Node outbound transport drops the configured pathname/query.**
   - File: `packages/security/src/ssrf.ts`
   - Symbol: `buildPinnedRequestOptions()` / `performPinnedRequest()`
   - Reachable through: default `HttpOutboundTransport.send()` and `WebhookAutomationProvider.invoke()`
   - Proof: the request options omit `path`; executable audit probe observed undefined path and Node default `/` request target.
   - Impact: authenticated webhook/channel payload can be sent to the wrong same-origin route or fail entirely; this is production-reachable now that Repair 07 correctly routes defaults through the pinned transport.
   - DNS-rebinding/private-network authority remains protected.

## Cannot Validate

Environment-limited validation, distinct from source findings:

- Full Node 24 lint/typecheck/build/test suite.
- Focused Vitest execution of Repair-07 regression tests.
- PostgreSQL fresh-install migration execution.
- PostgreSQL upgrade migration execution.
- Real PostgreSQL concurrency/restart behavior for cumulative refund authority and cancellation revival.
- Package dependency vulnerability audit.
- Official Git-enumerated secret scan.

Source-level inspection supports B/C/D/E closure, but these unavailable runtime gates remain mandatory before release.

## Live External Validation Still Required

Separate from code-security closure:

- real Stripe sandbox webhook/refund sequences and provider contract behavior;
- real PayPal sandbox/payment-event sequences;
- production provider credentials and commercial approvals;
- live channel/integration webhook endpoint behavior after the request-target defect is repaired;
- production browser/computer networking design and enforcement before removing current `501 not_configured`, including browser-engine DNS/IP/network controls beyond hostname-level `EgressPolicy`;
- any provider-specific live failure/404 semantics with real credentials.

## Final Decision

**A. REPAIR 09 REQUIRED**

Reason: the original Repair-07 DNS-rebinding HIGH is closed, and B/C/D/E are source-closed, but the now-default pinned HTTP(S) transport does not preserve URL pathname/query. That is an actual production-reachable Medium request-routing defect in the caller path Repair 07 changed. Revalidation 08 is read-only, so it is deliberately not fixed here.

No release/push authorization is granted. After Repair 09 fixes the request target and adds a regression assertion for pathname + query, the dependency-complete Node 24/pnpm/PostgreSQL gates still need to run before commit/release.
