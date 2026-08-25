# Security Repair 05A: Payments, Billing, Webhook, Lifecycle and Provider-State Correctness

Date: 2026-08-25

## Repository State

- Base SHA before repair: `ad72d37c09dc0bdc7557835c1b83f82b5873df84`
- New SHA: not created. Per the no-push/stop instruction this repair is a
  working-tree change on the same base SHA.
- Pre-existing unrelated worktree changes (deleted `md/*` run-order files)
  were present before this repair and were not modified.
- Prior repair reports present:
  - `docs/verification/SECURITY_REPAIR_01_BILLING.md`
  - `docs/verification/SECURITY_REPAIR_02_AUTHORIZATION.md`
  - `docs/verification/SECURITY_REPAIR_03_RUNTIME_NODE.md`
  - `docs/verification/SECURITY_REPAIR_04_CONCURRENCY.md`

## Scope

Repair the independently confirmed payment, billing, webhook, lifecycle,
crash-consistency and provider-state findings A–J without redesigning the
billing system and without weakening any already-closed control:

- expired active subscriptions still do not grant commercial access;
- unpaid orgs still cannot order VPS;
- wrong/zero renewal money still cannot extend a paid plan;
- browser redirects/approval pages still never grant access;
- exact raw-body webhook verification is unchanged;
- server-side canonical prices remain authoritative;
- provider environment separation remains enforced;
- durable event dedupe remains;
- org billing mutation still requires correct org authority + PAT scope;
- PostgreSQL remains authoritative.

Official provider documentation consulted for this repair:

- Stripe: [Checkout Sessions / events](https://docs.stripe.com/api/checkout/sessions),
  [Disputes](https://docs.stripe.com/api/disputes), [Subscriptions object](https://docs.stripe.com/docs/api/subscriptions/object),
  [Events](https://edge-docs.stripe.com/api/events/types).
- PayPal: [Subscriptions webhooks](https://developer.paypal.com/docs/subscriptions/reference/webhooks/),
  [webhook event names](https://developer.paypal.com/api/rest/webhooks/event-names/).
- Paystack: [webhooks](https://paystack.com/docs/payments/webhooks/),
  [refunds](https://paystack.com/docs/payments/refunds/),
  [disputes](https://support.paystack.com/en/articles/2125442).
- Flutterwave v3: [webhooks](https://developer.flutterwave.com/docs/webhooks),
  [refund webhook](https://developer.flutterwave.com/reference/refund_completed_webhook).

Provider object relationships (Charge → PaymentIntent → Invoice →
Subscription; Dispute → Charge/PaymentIntent; Invoice → Subscription) are
modeled per these references, not guessed.

## Migrations

Added `packages/database/migrations/0014_security_repair_payments_billing.sql`:

- `checkout_state` gains `applying` (crash-replayable checkout state machine).
- `webhook_status` gains `duplicate`, `stale_ignored`,
  `reconciliation_required` (persisted distinct outcomes, finding F).
- New table `provider_object_mappings` — durable typed provider-object
  mapping (finding A) with partial unique indexes per typed ref
  (checkout/subscription/invoice/payment/payment-intent/charge).
- New table `provider_billing_effects` — business-effect idempotency
  (finding B), unique on (provider, environment, billing_identity,
  effect_type).
- New table `subscription_cancellations` — durable cancellation progress
  (finding H).
- New table `commercial_reconciliation_queue` — queue for
  commercial-ineligibility reconciliation (finding A); webhook handlers
  never destroy compute synchronously.
- `subscriptions` gains `suspension_reason`, `suspension_source`,
  `reconciliation_required`, `provider_plan_ref` (findings C/I/F).
- `provider_payments` gains `provider_payment_intent_ref`,
  `provider_charge_ref`, `provider_customer_ref`, `billing_identity`
  (findings A/B).
- Partial unique index `invoices_provider_ref_key` (one provider invoice =
  one row) and `subscription_items_base_key` (one base item per
  subscription — crash-replay idempotency).
- `verified_webhook_events_status_received_idx` for the short-TTL rejected
  junk cleanup (finding G); applied financial rows are never purged.
- Backfill: provider-object mappings are created ONLY from unambiguous
  rows (subscriptions with provider identity + ref; checkout sessions
  merged on the same provider/environment/org; cross-org ref collisions
  become `reconciliation_required` rows — never guessed).

Fresh-schema apply and the pre-0006 → current upgrade drill both pass (see
Verification).

## Provider-Object Mapping Model (finding A)

Refund/dispute events commonly reference a Charge (`ch_`), PaymentIntent
(`pi_`) or Invoice (`in_`) while subscriptions store `sub_`/checkout refs.
Mox now persists one mapping row per provider relationship with a typed
column per object kind:

`provider_name`, `environment`, `org_id`, `subscription_id`,
`provider_customer_ref`, `checkout_session_ref`,
`provider_subscription_ref`, `provider_invoice_ref`,
`provider_payment_ref`, `provider_payment_intent_ref`,
`provider_charge_ref`, `resolution_state`, timestamps.

Rules:

- Checkout completion stores checkout + subscription + customer refs (and
  payment intent when present).
- Invoice success/failure stores invoice + subscription + payment intent.
- Charge/dispute/refund events resolve through the persisted
  charge/pi/invoice/subscription relationships.
- Each event merges its refs into the existing row(s) it touches; refs that
  would join two different local subscriptions/orgs mark every involved row
  `reconciliation_required` — the merge is refused.
- Resolution order: direct stored `subscriptions.provider_ref` match on the
  event's subscription ref → typed mapping rows → legacy exact stored-ref
  matches. Multiple distinct subscriptions = ambiguous; zero = unresolved.
  Ambiguous/unresolved financial events are persisted as
  `reconciliation_required`, never guessed from ID prefixes.
- Full refund / opened-or-lost dispute suspends with source `refund` /
  `dispute` and enqueues a `commercial_reconciliation_queue` row. Compute
  destruction runs from the control-plane ticker drain, never inside the
  webhook handler.

## Partial-Refund Policy (finding A, documented)

A partial refund (0 < refund < period price):

- access is intentionally preserved for the already-paid remainder of the
  current period;
- the subscription is flagged `reconciliation_required` (visible in
  `/api/billing/subscription`, `/api/billing/entitlements` and admin views);
- the refunded invoice's business effect is already consumed, so no further
  period extension can come from it;
- a zero-amount refund is a duplicate/no-op; a missing refund amount fails
  closed as `reconciliation_required`.

Full refund (refund ≥ period price) suspends immediately.

## Checkout Crash-Recovery Model (finding E)

`applyCheckoutCompleted` is a durable state machine over
`checkout_sessions.state`:

`created → applying (claim) → completed`, with `expired` for
`async_payment_failed` and `reconciliation_required` surfaced when a
"completed" session provably lacks its local commercial effect.

Sub-steps are individually idempotent, so a crash after ANY write converges
on replay:

1. claim (durable `applying` + lease; replay re-claims after lease expiry);
2. billing customer upsert (`ON CONFLICT DO UPDATE`);
3. subscription create-or-update (replay after create sees the live row and
   updates instead; history-preserving partial unique index unchanged);
4. base item upsert (partial unique index `(subscription_id) WHERE kind='base'`);
5. transition with idempotency key `checkout:{sessionId}` (transition replay
   converges state even when the key is already recorded);
6. business-effect + provider-object mapping claims (idempotent);
7. session → `completed` last.

The webhook record is marked `applied` only after step 7 — the provider
event never becomes permanently applied before the full local commercial
effect is durable. No provider HTTP call happens inside this path at all.

Fault-injection tests crash after each of: checkout claim, customer create,
session mutation, subscription create, item create, transition create — and
prove replay yields exactly one active subscription, one base item, one
activation transition and a completed session.

## Business-Effect Dedupe Model (finding B)

Durable `provider_billing_effects`, unique on
`(provider_name, environment, billing_identity, effect_type)`, distinct
from webhook-event dedupe. Billing identities:

- Stripe invoice success/failure → `invoice:{invoiceRef}`;
- PayPal sale → `sale:{saleId}`;
- Paystack invoice → `invoice:{paystack-invoice:{id}}`;
- Flutterwave charge → `flw:{ref}`;
- refunds/disputes → `charge:{ref}` / `sale:{ref}` / `dispute:{ref}`;
- checkout grant → `checkout:{checkoutSessionRef}`;
- subscription lifecycle → `sub:{ref}:status:{...}` / `sub:{ref}:suspended`
  / `sub:{ref}:reactivated` / `sub:{ref}:canceled`.

`invoice.paid` + `invoice.payment_succeeded` for the same invoice produce
exactly one period-extension effect; multiple webhook event ids may be
stored (one per event), but the second event's outcome is `duplicate`.
Transition and invoice rows dedupe against the same identity (transition
idempotency keys `recover:{identity}`, `trial-converted:{identity}`,
`fail:{identity}:{n}`; invoices are unique on `provider_invoice_ref`).
PayPal first-sale completes the checkout AND consumes the sale's
period-extension effect at the same durable point, so a redelivered sale
never stacks paid time. A success without an immutable identity fails
closed as `reconciliation_required`.

## Event-Ordering Model (finding F)

Distinct outcomes are persisted on the webhook record and provider-payment
ledger: `applied`, `duplicate`, `stale_ignored`,
`reconciliation_required`, `rejected`.

- Refund/dispute events are financial facts keyed by provider identity —
  they are NEVER dropped solely for an older timestamp.
- Success events gate on: effect claim (duplicate), terminal state
  (stale_ignored), refund/dispute-suspended state with older-or-equal
  timestamp (stale_ignored), and missing-time success when newer applied
  events exist (reconciliation_required). Missing time can never resurrect
  or extend refunded/canceled state.
- Cancellation/suspension events keep the Repair-01 monotonicity control:
  older-than-newest events are persisted as `stale_ignored` (not silently
  skipped) and missing-time events become `reconciliation_required`.
- `subscription.updated` period sync only applies from current events, so a
  stale update cannot shrink/extend a newer period.
- Monotonicity derives from financial identity + the explicit state
  machine; wall-clock time is a secondary signal only.

## Webhook Abuse / Retention Model (finding G)

The endpoint stays HTTP-public. Controls:

- 256 KB body cap enforced in `readRawBody` BEFORE parsing/verification
  (now returns a real 413 instead of a bare connection reset);
- durable per-IP (`billing_webhook_ip`), per-provider-path
  (`billing_webhook_path`) and global emergency cap
  (`billing_webhook_global`) rate limits via the existing PostgreSQL
  `auth_rate_limits` row-locking limiter; limits are env-tunable
  (`MOX_WEBHOOK_PER_IP_LIMIT`, `MOX_WEBHOOK_PER_PATH_LIMIT`,
  `MOX_WEBHOOK_GLOBAL_LIMIT`, `MOX_WEBHOOK_LOCK_MS`), with generous
  defaults so legitimate provider bursts/retries remain accepted;
- identical invalid bodies dedupe on the synthetic digest event id;
- rejected rows store only a digest and a generic reason — never full
  payloads — and are purged by a ticker job with a short TTL
  (`MOX_WEBHOOK_REJECTED_TTL_MS`, default 24 h); applied financial history
  is exempt from this cleanup and retained;
- security-event logging is rate-limit-driven (one row per bucket lock) and
  a 30-day retention purge keeps it bounded.

## Cancellation / Reconciliation Model (finding H)

`subscription_cancellations` records durable progress:

`cancel_requested → provider_cancel_pending → canceled`, or
`reconciliation_required` on remote failure/ambiguity (with `attempts`,
`last_error`, `next_attempt_at`).

- Local entitlement shutdown is an explicit, immediate transition to
  `canceled` (retention sweep unchanged).
- Upstream provider cancellation is tracked separately and retried
  idempotently by the control-plane ticker (`runCancellationRetries`) with
  exponential backoff.
- Remote failures are never silently lost: they stay visible via
  `/api/billing/subscription` (`cancellation.state`, `lastError`,
  `nextAttemptAt`).
- A subscription with no provider ref (legacy/ambiguous mapping) is marked
  `reconciliation_required` immediately — never guessed.
- Provider-initiated cancellations record `state=canceled` without
  re-issuing a destructive remote call.

## Suspension / Reactivation Safety (finding I)

Every suspension records `suspension_source`
(`payment_failure | admin | refund | dispute | fraud | provider |
compliance`) and `suspension_reason`.

- Generic admin reactivation of refund/dispute/fraud/compliance suspensions
  is REFUSED unless the admin explicitly asserts financial reconciliation
  (`financialReconciled: true` on the admin API) AND the current paid
  period is still valid AND no unresolved reconciliation flag exists.
- `dispute.closed` with `status=won` restores access only when the paid
  period is live and an applied financial effect exists; otherwise the
  subscription stays suspended with `reconciliation_required`.
- Payment recovery and provider resume paths use the same state machine
  (payment proof or authoritative reconciliation), never lifecycle events
  alone.

## Entitlements Read Endpoint (finding J)

`GET /api/billing/entitlements` now uses the SAME
`BillingService.evaluateCommercialAccess` authority as entitlement-bearing
mutations and returns:

- `state` (subscription lifecycle state),
- `commerciallyEntitled` (boolean),
- `denialReason` when denied (e.g. `expired_period`, `state_suspended`,
  `state_past_due`, `no_subscription`),
- `values` (effective entitlement values) ONLY while currently entitled,
- `suspensionReason` / `suspensionSource` / `reconciliationRequired` /
  `currentPeriodEnd`.

Expired, suspended and refunded subscriptions can no longer appear as
paid-capability active to the UI; the web client reads
`commerciallyEntitled` before exposing capability flags.

## Provider Adapter Changes

### Stripe (`services/billing/src/providers/stripe.ts`)

- Currency normalized to uppercase ISO-4217 (`usd → USD`) before comparison.
- `checkout.session.completed` / `async_payment_succeeded` → checkout
  completion with customer + subscription + payment-intent refs;
  `async_payment_failed` → `checkout.failed` (session expires, no
  entitlement).
- `invoice.paid` / `invoice.payment_succeeded` → `payment.succeeded` with
  invoice + subscription + payment-intent refs; `invoice.payment_failed` →
  `payment.failed`.
- `customer.subscription.updated` → `subscription.updated` carrying status,
  `cancel_at_period_end`, price ids, period bounds, trial end.
- `customer.subscription.deleted` → `subscription.canceled`.
- `charge.refunded` → `payment.refunded` with charge + payment-intent +
  invoice refs; `charge.dispute.created/.closed` → dispute events with
  dispute + charge + payment-intent refs.

### PayPal (`services/billing/src/providers/paypal.ts`)

- `CREATED` / `ACTIVATED` / `APPROVED` remain non-proof-of-payment
  (rejected).
- `SALE.COMPLETED` → `payment.succeeded` bound to the billing agreement,
  identity `sale:{id}`.
- `BILLING.SUBSCRIPTION.PAYMENT.FAILED` / `SALE.DENIED` → `payment.failed`
  bound to the billing agreement/subscription — never an unrelated sale id.
- `SUSPENDED` → `subscription.suspended` (recoverable; no remote cancel).
- `RE-ACTIVATED` → `subscription.reactivated` (service reconciles
  authoritatively before restoring).
- `CANCELLED` / `EXPIRED` → terminal `subscription.canceled` (retention).
- `REFUNDED` / `REVERSED` → refund/dispute events with sale identities.

### Paystack / Flutterwave

Refund/dispute events carry explicit transaction/dispute identities for
business-effect dedupe; currency is normalized; `invoice.update` paid
carries the invoice id + money.

## Verification

Passed:

- `pnpm lint` — exit 0; warnings only (14, all pre-existing).
- `pnpm typecheck` — exit 0.
- `pnpm --filter @mox/billing test` — 4 files, 67 tests passed, including
  the new 29-test `security-repair-05a.test.ts` suite.
- `pnpm test` — 58 files passed, 1 skipped (PG-gated), 472 tests passed,
  50 skipped, exit 0.
- `powershell -ExecutionPolicy Bypass -File scripts\run-postgres-verification.ps1`
  — exit 0:
  - fresh disposable PostgreSQL cluster; migrations `0000`–`0014` applied
    cleanly to an empty database;
  - PG-gated `restart.test.ts` + `auth-integration.test.ts`: 60 tests
    passed, including the new 05A HTTP tests (per-IP webhook rate limit,
    oversized-body 413, legitimate burst acceptance, entitlements-endpoint
    consistency);
  - pre-0006 → current upgrade drill passed: legacy rows preserved
    (including the provider-name-less legacy subscription which the 0014
    backfill deliberately leaves unmapped), resubscribe works, FX migration
    intact.
- `pnpm build` — exit 0.
- `pnpm secret-scan` — clean.
- `pnpm dependency-security` — exit 0 (`--audit-level high`; one pre-existing
  moderate advisory remains, unchanged from Repair 04).
- `pnpm scan:authority` — clean (no vendored-tree imports in production
  code).
- `git diff --check` — clean.

## Mandatory Regression Coverage

Stripe: real-shaped paid checkout with lowercase currency (canonicalizes to
USD); charge refund resolves through persisted provider-object mapping;
dispute-created resolves to the correct subscription; full refund
revokes/suspends; partial refund follows the documented policy;
`invoice.paid` + `invoice.payment_succeeded` for the same invoice → one
period extension; duplicate same event → one effect; different event ids
same invoice → one effect; `subscription.updated` states handled
intentionally; unmapped provider plan cannot remap Mox plan; dispute-won
cannot restore a financially invalid subscription.

PayPal: APPROVED/ACTIVATED without paid reconciliation → no entitlement;
`SALE.COMPLETED` → one renewal/grant; repeated same sale → no stacked time;
payment-failed binds to the billing agreement → recoverable past_due;
`SUSPENDED` never triggers a destructive remote cancel; `RE-ACTIVATED`
requires authoritative payment reconciliation (both directions); terminal
cancellation behaves terminally.

Checkout crash recovery: crash after claim / customer write / session
mutation / subscription create / item insert / transition create → replay
yields exactly one active subscription, one base item, one activation
transition, a completed session and working commercial access.

Ordering: older real refund after newer success still reconciles safely;
missing-time success cannot resurrect refund-suspended state; stale
ambiguous success is persisted as `reconciliation_required` — never
finalized as applied.

Webhook abuse: identical invalid bodies dedupe to one rejected row; 1,000
unique invalid bodies produce no full-detail financial rows and purge under
the rejected TTL while the applied financial record survives; per-IP rate
limiting (HTTP) returns 429 while the endpoint stays public; oversized
bodies are rejected before any processing; legitimate provider bursts
remain accepted.

Cancellation: transient remote failure → durable `reconciliation_required`
with visible error; retry completes exactly once; local entitlement
shutdown stays explicit; ambiguous mapping is never guessed.

Entitlement read: valid active → entitled with real effective values;
suspended → `commerciallyEntitled: false` + explicit denial reason; expired
active → `commerciallyEntitled: false` (`expired_period`); values are empty
whenever not entitled.

## Blockers / Residual Notes

- No push was performed; no new commit was created (no post-repair SHA).
- Live provider sandbox/account verification remains out of scope for this
  repository (no provider credentials exist here); adapters are driven by
  scripted `fetch` fixtures shaped after current official documentation.
- `pnpm audit` still reports one pre-existing moderate advisory (unchanged
  from Repair 04).
- Pre-existing unrelated working-tree changes (deleted `md/*` files) remain
  untouched.

## Security Repair 05B Safe To Run

YES. Full repository verification and the real PostgreSQL verification
script completed successfully.
