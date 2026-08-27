# Security Revalidation 10

## Working Tree Identity

- Original repository: `E:\MyCodes\Mox`
- Original snapshot branch: `master`
- Original committed SHA: `0fe5dd1b48fa6302c14bad1392f5d5f5bad4b7c4`
- Repair-07 historical working-tree digest: `cb9ee29ac7610150cec6e950e5c753201e84100c5acdca52af949e15fa41fd96`
- Final Revalidation Working Tree Digest (pre-audit): `6a924a8910a50f6d984738286f62db96e75e310b2140034236b2363e4cc7df19`
- Included file count: **15,239**
- `.git`: intentionally unavailable in this source-only environment.

The digest enumerates the current Repair-07 + Repair-09 tree, excludes generated/disposable material using the same deterministic rules as the prior source manifest, excludes this Revalidation-10 report itself, hashes every included file with SHA-256, sorts by relative path, and hashes the deterministic `path + NUL + file-hash + newline` manifest. Timestamps are not digest input.

## A — Outbound SSRF / Request Target

**Classification: CLOSED**

### Evidence

- Primary implementation: `packages/security/src/ssrf.ts`.
- Default production-shaped callers:
  - `services/channel-gateway/src/gateway.ts` — `HttpOutboundTransport`.
  - `services/integration-gateway/src/providers.ts` — `WebhookAutomationProvider`.
- Neither default constructor initializes an injected/global/native `fetch`. `fetchImpl` is included in `safeOutboundFetch()` options only when a caller explicitly supplied it. The ordinary/default path therefore reaches the pinned Node `http`/`https` transport.
- `assertSafeOutboundUrl()` rejects malformed URLs, non-HTTP(S) schemes, HTTP unless explicitly permitted, embedded username/password credentials, disallowed ports, blocked internal-style hostnames, private literal addresses, and encoded-address tricks.
- `resolveValidatedAddresses()` performs DNS resolution once per request hop and rejects the entire answer set if **any** answer is not an IP or is blocked/private. Source coverage includes loopback, RFC1918, link-local/cloud metadata, ULA/private IPv6, IPv4-mapped private IPv6, and other canonical blocked ranges.
- `pinnedLookup()` can return only addresses in the already-validated set. The socket layer receives this lookup function; it cannot perform an ordinary second DNS resolution that could observe a rebound address.
- `buildPinnedRequestOptions()` preserves the logical URL authority and request target:
  - `protocol` from the parsed URL;
  - logical `hostname` and `port`;
  - method and headers;
  - `path: parsed.pathname + parsed.search`;
  - pinned `lookup`;
  - TLS `servername` equal to the logical hostname.
- WHATWG `URL.pathname`/`URL.search` preserve encoded resource identity. Fragments are not part of either field and are therefore never sent as the HTTP request target.
- Embedded URL credentials are rejected before DNS/network activity and are not converted into request-target, Host, or Authorization material. The URL guard error exposes only a reason code, not the credential-bearing input URL.
- Redirects are followed by looping back through URL guard, parse, port validation, fresh DNS resolution, validation of every address, and a newly pinned request for that redirected URL. Each hop builds its own `pathname + search`.
- When the redirect hostname changes, `authorization`, `cookie`, and `proxy-authorization` are removed before the next request.
- TLS verification remains Node's default verification. There is no `rejectUnauthorized: false` and no permissive `checkServerIdentity` override in the repaired transport.
- The explicit `fetchImpl` option remains a deliberate test/fixture seam. Its own connection is **not** claimed to be DNS-pinned; production/default callers do not use it.

### Direct executable evidence

Supplemental probes against a CommonJS transpilation of the **current** `packages/security/src/ssrf.ts` (temporary files outside the repository) passed:

- `DIRECT_REQUEST_TARGET_TLS_CREDENTIALS_PRIVATE_OK`
  - `/`
  - `/hook/task`
  - `/hook/task?a=1&b=2`
  - encoded path and query components
  - empty-query canonical behavior
  - fragment exclusion
  - URL-credential rejection
  - private literal blocking
  - logical SNI and no TLS-disable option
- `DIRECT_REDIRECT_REPIN_STRIP_OK`
  - `one.example/start?a=1` resolved/pinned independently from `two.example/hooks/final?b=2`;
  - second-hop request target was `/hooks/final?b=2`;
  - cross-host authorization/cookie/proxy-authorization were stripped.
- `DIRECT_REBIND_MIXED_DNS_OK`
  - the request resolver was consulted once for the hop;
  - a hypothetical later `127.0.0.1` DNS answer could not affect the socket lookup;
  - mixed public/private DNS answer sets were rejected.

### Residual risk

The explicit injected `fetchImpl` seam does not provide socket-level pinning and must remain test-only as documented. This audit makes no claim that an arbitrary injected fetch transport is DNS-rebinding safe.

## B — HTTP Response Adaptation

**Classification: CLOSED**

### Evidence

`performPinnedRequest()` buffers the bounded Node response body and passes `null` to the Fetch `Response` constructor for exactly the null-body statuses:

- `204`
- `205`
- `304`

All other statuses retain the collected response bytes. Redirect decision-making still occurs from the HTTP status and `Location` header in `safeOutboundFetch()`; the null-body adaptation does not turn error statuses into successes or alter redirect classification.

A direct mocked-Node-response matrix against the current transpiled implementation passed as `DIRECT_RESPONSE_STATUS_MATRIX_OK`:

- `200` preserved `body-200`/ordinary body content;
- `201` preserved ordinary body content;
- `204` produced no body;
- `205` produced no body;
- `304` produced no body;
- `400` preserved its error body and remained an error status.

## C — Stripe Cumulative Refund

**Classification: CLOSED**

### Evidence

- Service authority: `services/billing/src/service.ts`.
- Store contract and in-memory parity: `services/billing/src/store.ts` and `services/billing/src/types.ts`.
- PostgreSQL authority: `packages/database/src/pg-billing-store.ts`.
- Schema: `packages/database/src/schema/payment-providers.ts`.
- Forward migration: `packages/database/migrations/0016_security_repair_07_refund_state.sql`.

The current Stripe refund flow is based on a provider charge billing identity rather than webhook event ID alone. Stripe's normalized cumulative `amount_refunded` crosses the adapter boundary as `bigint`; `applyRefund()` converts the event amount to `BigInt` and passes it to `advanceProviderRefundState()` as `cumulativeAmountMinor: bigint`.

### Monotonicity and replay

- First observation `3000` establishes durable cumulative state `3000`.
- Replay `3000` does not advance because only a strictly greater amount updates the authority row.
- `3000 -> 6000 -> 10000` can advance monotonically because every strictly larger cumulative amount replaces the prior maximum.
- A lower amount cannot replace a higher durable amount.
- Full refund is determined from the **durable authoritative cumulative value** against the canonical price amount, not from whether the current webhook event is a one-shot business effect.
- A full refund transitions to `suspended` with `suspensionSource: refund` / `full_refund_processed` and queues commercial reconciliation.
- A replay of the full cumulative amount returns `advanced: false` but still re-enters the idempotent full-refund convergence steps. This closes the crash window where durable refund authority advanced before suspension/reconciliation completed.
- Partial-refund observation updates touch only refund/reconciliation observation fields, preventing a racing stale partial event from overwriting a full-refund lifecycle suspension.
- Refund-state persistence has no path that grants or activates commercial entitlement.

### Tenant/provider/environment binding

The durable identity is the exact tuple `(provider_name, environment, billing_identity)`. The row also keeps the bound subscription. An existing identity bound to another subscription, or a historical row whose subscription binding was nulled after deletion, fails closed into reconciliation rather than being rebound by inference.

Provider-object resolution itself is provider/environment-scoped and typed. Ambiguous or unresolved mapping does not guess a tenant, and `assertProviderBinding()` verifies the subscription's provider/environment authority before financial effects.

### PostgreSQL concurrency authority

`advanceProviderRefundState()` executes inside one database transaction. It acquires a transaction-scoped advisory lock derived from the provider/environment/billing-identity tuple **before** the first read/insert. This serializes the previously unseen-row race as well as later updates. The database's exact unique index on `(provider_name, environment, billing_identity)` remains the correctness authority; an advisory-hash collision can only over-serialize unrelated work, not merge their rows.

The migration stores `cumulative_amount_minor` as PostgreSQL `bigint`; Drizzle maps it with `{ mode: "bigint" }`; the store interface and internal authoritative state use TypeScript `bigint`.

Actual PostgreSQL concurrent execution/restart behavior could not be executed in this environment and is listed under **Cannot Validate** rather than represented as runtime-proven.

### Payment-ordering regression

A terminal subscription is not resurrected by payment success. For refund/dispute/fraud/compliance suspension, missing ordering time requires reconciliation and an event at or before `lastEventAt` is stale. A genuinely newer, correctly priced, correctly bound, uniquely claimed provider payment can recover access as new financial authority; an old/replayed payment cannot trivially undo the suspension.

## D — Cancel Retry

**Classification: CLOSED**

### Evidence

- Service: `services/compute-orchestrator/src/service.ts`.
- Store contract/in-memory parity: `services/compute-orchestrator/src/store.ts`.
- PostgreSQL store: `packages/database/src/pg-orchestrator-store.ts`.

The canonical cancellation operation identity remains `${order.id}:cancel`.

- Terminal `canceled`, `destroyed`, and `retention` orders return as no-ops.
- A deliberate retry that finds the canonical operation `abandoned` calls `reviveAbandonedOperation()` on that exact row. PostgreSQL revival is a conditional update requiring `state = abandoned`, resets retry/lease fields, and otherwise re-reads the canonical operation to converge concurrent retries.
- The database operation uniqueness constraint ensures repeated/concurrent HTTP retries address one canonical operation identity rather than creating uncontrolled provider-delete operations.
- `cancelOrder()` requires runnable authority **before** writing `cancelling`.
- After writing `cancelling`, it re-reads the canonical operation. If authority is missing/abandoned/exhausted it converges the order to visible `error`; if already succeeded it converges to `retention`. This prevents a stale HTTP request from restoring a newer `retention` or abandoned/error outcome to stranded `cancelling`.
- Worker finalization is fenced by operation id, `running` state, lease owner, and lease version. A worker that loses its claim cannot persist operation success/failure and then write stale order state.
- Provider HTTP `404` is treated as the desired instance-absent state **inside the `cancel` operation branch only**. Other provider operations and other provider errors retain normal error/retry semantics.
- Successful cancellation advances to `retention`; abandoned cancellation advances to visible `error`. The canonical quota count includes live `cancelling` but excludes `retention` and `error`, so both converged outcomes release server capacity according to the established capacity policy.
- Revival occurs only on an explicit cancellation request against an abandoned operation. Exhaustion becomes visible `error`; there is no autonomous infinite revive loop.

A crash after the operation row reaches `succeeded`/`abandoned` but before its order write can temporarily leave an older order state, but the durable operation is explicitly reconcilable and a subsequent cancellation request converges it. The requested invariant was runnable **or explicitly reconcilable** authority; current source satisfies that invariant.

## E — Gateway Signing Secret

**Classification: CLOSED**

### Evidence

The one canonical policy is `validateGatewaySigningSecret()` in `packages/security/src/index.ts`.

It rejects:

- missing/blank values;
- `LEGACY_PUBLIC_GATEWAY_SECRET`;
- values shorter than 32 characters;
- values that do not contain at least three of lowercase, uppercase, digits, and symbols.

It accepts a sufficiently strong explicitly configured value.

All authority-establishing paths use the same validator:

- `gatewayTokenSecretFromEnv()` validates `MOX_GATEWAY_TOKEN_SECRET` as environment authority;
- `mintGatewayToken()` validates an injected secret or delegates to the environment helper;
- `verifyGatewayToken()` validates an injected secret or delegates to the environment helper and fails closed when validation/configuration fails;
- `ComputerGateway` validates direct `gatewaySecret` injection through the same function, otherwise delegates to `gatewayTokenSecretFromEnv()`.

No fallback production signing secret exists.

A corrected direct runtime probe of the transpiled current security module passed as `DIRECT_GATEWAY_SECRET_EGRESS_BINDING_OK`, including blank, legacy, short and low-diversity rejection; strong-secret acceptance; missing-environment rejection; mint/verify; wrong-secret rejection; and token org/agent/session claim checks. Initial temporary probe attempts that used an incomplete harness or the wrong helper-call/decision shape were discarded as harness errors, not repository failures.

## F — Computer/Browser Egress

**Classification: CLOSED**

### Evidence

`ComputerGateway` constructs its egress authority as:

`opts.egress ?? new EgressPolicy()`.

`EgressPolicy` defaults `defaultAction` to `deny`, therefore omission does not create unrestricted navigation.

- No supplied policy: unknown navigation is denied.
- Explicit deny rules are evaluated before allow rules and deny.
- Explicit test allow rules can allow their intended host and proceed to later entitlement/policy/approval/provider authority.
- Unknown destinations remain default-denied unless a caller deliberately constructs a different explicit policy.
- Agent-runtime tests that intentionally require successful navigation explicitly inject allowlisting for `example.com`; the policy-denial test also injects egress allowlisting so it still tests the later policy-denial layer rather than weakening the production default.
- `services/control-plane/src/api.ts` still returns HTTP `501` with `code: not_configured` from the production computer snapshot endpoint after authentication/commercial checks. No production browser provider is silently wired by this repair.
- Current source comments explicitly describe this egress policy as hostname-level authorization and do not claim browser-engine resolved-IP/DNS pinning. Historical verification documents likewise preserve that limitation.

The direct egress portion of `DIRECT_GATEWAY_SECRET_EGRESS_BINDING_OK` confirmed default deny, explicit allow, explicit deny precedence, and unknown-target deny in the current transpiled implementation.

## Bounded Regression Pass

| # | Adjacent control | Classification | Source evidence |
|---|---|---|---|
| 1 | Invoice sibling-event dedupe | CLOSED | Invoice success sibling events normalize to the same invoice billing identity and `claimProviderBillingEffect()` has a durable unique provider/environment/identity/effect authority. |
| 2 | Provider-object mapping authority | CLOSED | Typed mappings are provider/environment-scoped; ambiguous mappings fail into reconciliation instead of tenant guessing. |
| 3 | Refund/dispute tenant binding | CLOSED | Refund/dispute flows resolve typed provider objects, verify provider/environment binding, and refuse ambiguous/cross-subscription authority. |
| 4 | Commercial evaluator denies suspended/expired access | CLOSED | Commercial access is granted only for live permitted lifecycle/period states; suspended and expired states are denied. |
| 5 | Payment ordering cannot trivially resurrect financial suspension | CLOSED | Terminal states reject success; refund/dispute/fraud/compliance suspension requires a newer timestamped, canonical-price, uniquely claimed payment authority before recovery. |
| 6 | Compute operation fencing | CLOSED | Fenced writeback requires running state, claim owner and lease version before any worker emits dependent order-state effects. |
| 7 | Atomic server quota reservation | CLOSED | PostgreSQL takes a per-org allocation row lock and performs quota count plus order/operation insertion in one transaction. |
| 8 | Reboot request identity | CLOSED | Reboot identity includes caller request id or a fresh id; same request replays, later intentional request gets a new durable operation identity. |
| 9 | PAT scopes | CLOSED | API-token authentication retains explicit scope checks through `scopeSatisfied()` and required-scope route authority; no Repair-07/09 change bypasses it. |
| 10 | Gateway org/agent/session binding | CLOSED | Token claims must match addressed session; stored session owner must match both token org and agent before provider action. |
| 11 | Private literal URL blocking | CLOSED | `assertSafeOutboundUrl()` checks literal IPs through the canonical private-address policy before resolution/connection. |
| 12 | Runtime secret/log redaction | CLOSED | `redactMetadata()` / `scrubLogLine()` remain present and computer audit metadata is sanitized; SSRF credential rejection does not echo the raw credential URL. |
| 13 | Target-org audit attribution | CLOSED | Admin audit writes use the explicit target org; compute/runtime admin actions pass the resource order's org rather than silently attributing to the actor's home org. |
| 14 | Distributed SSE controls | CLOSED | `ClusterSseAdmission` and its durable lease/counter authority remain wired into control-plane SSE admission. |
| 15 | Auth rate limiting before expensive hashing | CLOSED | Setup/signup/login/token-login call `enforceAuthRateLimits()` before the authentication routines that perform password verification/hashing work. |
| 16 | Notification outbox/fencing interfaces | CLOSED | Prepared/sent/failed/uncertain dispatch states, uncertainty sweep, durable job claim version and fenced update interfaces remain present in memory and PostgreSQL stores. |
| 17 | Public branding controls | CLOSED | `node scripts/public-branding-scan.mjs` executed successfully during this revalidation. |

## Static / Interface Review

`NONE FOUND BY SOURCE INSPECTION`

Specifically rechecked:

- `SafeOutboundOptions.fetchImpl` remains optional and default channel/integration callers conditionally omit it;
- `buildPinnedRequestOptions()` uses valid Node HTTPS request option fields including `path`, `lookup`, and `servername` and does not set incompatible TLS-disable options;
- response adaptation uses `null` only for Fetch null-body statuses;
- `advanceProviderRefundState()` has matching in-memory/PostgreSQL signatures and `bigint` cumulative amount semantics;
- provider refund-state schema/row mapping uses `bigint` mode;
- `reviveAbandonedOperation()` has matching store implementations/call signature;
- cancellation fencing interfaces retain lease-version parity;
- `validateGatewaySigningSecret()` is exported/imported consistently;
- `ComputerGatewayOptions.egress` remains optional only because construction installs fail-closed `EgressPolicy()` when omitted;
- Repair-07/09 test constructors match the current optional transport/egress option shapes.

A dependency-complete Node 24 TypeScript project check was not possible, so this is source/interface inspection plus syntax transpilation, not a substitute for repository typecheck.

## Verification Actually Executed

### Repository scripts

- `node scripts/public-branding-scan.mjs` — **PASSED** (`public-branding-scan: clean`).
- `node scripts/authority-scan.mjs` — **PASSED** (`authority-scan: clean`).
- Filesystem-equivalent execution of the current secret-scan rules — **PASSED**, **453** active text/release files inspected, no findings. This is explicitly not represented as the official script passing because the official script requires Git enumeration.

### Source/static checks

- TypeScript `transpileModule` syntax validation of the **22 Repair-07/09 changed TypeScript files** using the installed global TypeScript 5.8.3 — **PASSED** (`TRANSPILE_SYNTAX_OK 22`).
- Deterministic pre-audit source manifest — **PASSED**, 15,239 included files, digest `6a924a8910a50f6d984738286f62db96e75e310b2140034236b2363e4cc7df19`.

### Supplemental direct runtime probes

These used temporary transpiled artifacts outside `/mnt/data/Mox_WORKING`; they did not modify repository production/test source and are not substitutes for Vitest/full-suite execution.

- `DIRECT_REQUEST_TARGET_TLS_CREDENTIALS_PRIVATE_OK` — **PASSED**.
- `DIRECT_RESPONSE_STATUS_MATRIX_OK` — **PASSED**.
- `DIRECT_REDIRECT_REPIN_STRIP_OK` — **PASSED**.
- `DIRECT_REBIND_MIXED_DNS_OK` — **PASSED**.
- `DIRECT_GATEWAY_SECRET_EGRESS_BINDING_OK` — **PASSED** after correcting temporary harness mistakes.

## Verification Unavailable

The following requested repository gates were attempted and are **UNEXECUTED**, not passed:

- `pnpm lint` — `pnpm: command not found`.
- `pnpm typecheck` — `pnpm: command not found`.
- `pnpm test` — `pnpm: command not found`.
- `pnpm build` — `pnpm: command not found`.
- Focused Repair-07/09 Vitest suites via `pnpm exec vitest ...` — `pnpm: command not found`.
- `pnpm dependency-security` — `pnpm: command not found`; repository dependency audit therefore did not execute.
- Official `node scripts/secret-scan.mjs` — attempted, but it calls `git ls-files --cached --others --exclude-standard`; `.git` is intentionally absent, so the command exits before scanning.

Environment constraints confirmed in this audit:

- `pnpm` absent;
- source snapshot intentionally excludes `node_modules`;
- Node is `v22.16.0` while repository `package.json` requires Node `>=24`;
- prior phases already established registry retrieval failure (`EAI_AGAIN`); dependency download was not repeatedly retried;
- `.git` absent;
- `powershell` and `pwsh` absent;
- PostgreSQL binaries `psql`, `initdb`, and `pg_ctl` absent.

## Remaining Critical

`NONE`

## Remaining High

`NONE`

## Remaining Medium

`NONE`

## Cannot Validate

Environment-limited verification that remains outstanding:

- full lint/typecheck/test/build on the required Node >=24 toolchain;
- actual focused Vitest Repair-07/09 suites;
- dependency audit against the installed lockfile/dependency graph;
- official Git-enumerated secret scanner;
- PostgreSQL first-insert refund concurrency, concurrent cumulative update, restart durability, fresh-migration and upgrade-migration execution;
- PostgreSQL cancellation revival/restart/fencing execution.

Security limitations intentionally not over-claimed:

- the explicit test-only `fetchImpl` seam does not provide socket-level DNS pinning;
- the reusable computer/browser hostname egress policy is not proof of browser-engine DNS/IP pinning;
- production computer/browser composition remains `501 not_configured` in this source tree.

## External / Live Validation Still Required

Code-source closure is separate from provider/live-system validation. Still required before production release where applicable:

- real Stripe sandbox webhook/refund/dispute/payment-ordering exercises;
- real PayPal sandbox lifecycle exercises;
- production provider credentials and commercial/provider approvals;
- production-safe computer/browser networking, including the network-level isolation/pinning controls chosen for the real browser runtime;
- dependency-complete deployment-environment verification.

## Final Source Digest Integrity

- Pre-audit digest: `6a924a8910a50f6d984738286f62db96e75e310b2140034236b2363e4cc7df19`
- Post-audit digest: `6a924a8910a50f6d984738286f62db96e75e310b2140034236b2363e4cc7df19`

The Revalidation-10 report itself is excluded from both digest inputs. The post-audit value must equal the pre-audit value before the final decision is considered valid.

## FINAL DECISION

**B. SOURCE SECURITY REVALIDATION CLOSED — READY FOR DEPENDENCY-COMPLETE LOCAL VERIFICATION**

This decision is source-security closure for the targeted Repair-07/Repair-09 scope only. It is **not** authorization to deploy, release, commit, or push. The unavailable Node >=24 / pnpm / Vitest / typecheck / build / dependency-audit / PostgreSQL gates must be run successfully in the dependency-complete local or CI environment before release decisions.
