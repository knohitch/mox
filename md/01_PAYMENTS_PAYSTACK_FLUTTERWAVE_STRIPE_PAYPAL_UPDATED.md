# Repair Prompt 01 — Paystack, Flutterwave, Stripe and PayPal recurring billing

**Reasoning: Ultra**

Run only after Repairs 00 through 00D pass. Current audited baseline: `28bf0a311cf97128ed9355e59e43be2c07d1a7f5`.

## Goal
Implement real production billing-provider integrations for:
- Paystack
- Flutterwave
- Stripe
- PayPal

Before coding, consult the current **official documentation** for every provider. Do not guess event names/signatures or mix old/new API generations.

Mox Billing remains the sole subscription authority. Redirect/callback pages never grant entitlements.


## Authentication and authorization

The control plane now has cookie sessions plus scoped PATs. Preserve that model.

- All customer billing reads require authenticated organization context.
- PAT callers must require the `billing` scope.
- Subscription-changing mutations (checkout creation, plan change, add-on purchase, cancellation, payment-method/customer-portal creation, manual retry where applicable) require BOTH:
  1. the `billing` API scope when the caller is a PAT; and
  2. a real server-side organization capability/role authorized to manage billing.
- Until a finer-grained billing-manager permission exists, use organization `owner` / `admin` for billing mutations. Do not allow a plain `member` to alter the organization's subscription merely by holding a scoped PAT.
- `*` on a PAT never creates organization/admin privilege; normal role/capability checks still apply.
- Provider configuration, secrets, live/test switching, webhook administration and reconciliation administration are Mox-admin operations only.
- Webhook endpoints are not user-authenticated; they authenticate solely through the provider's official webhook verification plus Mox replay/idempotency controls.

Add authorization tests for cookie sessions and PATs, including a `billing`-scoped plain member being denied subscription mutation.

## Shared architecture
Extend the existing `BillingProvider` abstraction.

Each adapter should expose only capabilities the provider actually supports:
- customer mapping where applicable
- checkout/subscription initiation
- provider customer/subscription/transaction refs
- recurring renewal
- cancellation
- plan/price mapping
- verification/reconciliation
- signature/origin verification
- event normalization
- refunds where appropriate
- test/live separation
- health/config state

Never fake unsupported operations.

## Paystack
Implement current official recurring-subscription behavior:
- plan mapping
- customer/subscription references
- initial authorization where required
- official webhook signature verification using raw request body
- renewal success/failure
- enable/disable/cancel semantics
- verification/reconciliation fallback
- surface supported recurring payment-method/currency limitations honestly
- secret key server-side only

## Flutterwave
Implement the current official recurring flow:
- intentionally select the current API generation
- do not mix obsolete/current webhook verification schemes
- use official raw-body signature verification for the chosen API generation
- recurring/tokenized/credential-on-file only as officially supported
- verification/reconciliation fallback
- renewal/cancellation/failure normalization
- no raw card storage

## Stripe
Implement Stripe Billing/Subscriptions:
- server-created Checkout/subscription flow
- Customer + Subscription refs
- raw-body webhook signature verification
- initial incomplete/action-required states
- successful renewal
- failed renewal/past_due
- cancellation/update
- invoice paid/failure
- outbound idempotency keys
- optional customer portal remains non-authoritative

## PayPal
Implement PayPal Subscriptions REST:
- product/plan/subscription mapping
- client credentials server-side
- buyer approval/subscription flow
- official webhook verification flow
- activation/suspension/cancellation/payment event normalization
- reconciliation queries
- provider-supported request idempotency identifiers


## Durable provider mapping and payment records

Extend PostgreSQL/Drizzle with migrations where required. Provider-side identifiers must be durable and normalized, not hidden in process memory.

Persist enough information to reconcile safely, including as applicable:
- provider name + environment (test/live)
- Mox billing customer/org
- provider customer id
- provider product/plan/price id
- provider subscription id
- checkout/order/session id
- transaction/payment/capture id
- invoice reference
- provider event id
- current normalized provider state
- currency and integer minor-unit amount
- raw-event digest / safe metadata, not secrets or full sensitive payloads
- created/updated/reconciled timestamps

Provider-specific external plan/product mappings must be data-driven and admin-configurable. Do not hard-code live Paystack/Stripe/Flutterwave/PayPal IDs into source.

All new schema changes require:
- clean-database migration test
- upgrade migration test from current schema
- PostgreSQL-backed persistence/restart tests.

## Canonical webhook pipeline
For all providers:

`HTTP webhook → verify → persist safe digest/metadata → dedupe provider+event id → acknowledge quickly → queue → normalize to Mox Billing event → subscription state machine → entitlements → notifications → compute eligibility`

Rules:
- raw body where required;
- no slow VPS provisioning in webhook handler;
- duplicate events never duplicate value;
- out-of-order events cannot regress newer state;
- no secrets in logs.


## Event/state ordering

Provider events are eventually consistent and may arrive duplicated or out of order.

Implement state application rules using provider event timestamps/version/order information where available plus Mox state-machine rules.

Requirements:
- an older event cannot regress a newer subscription/payment state;
- a webhook received before the checkout redirect is still valid;
- redirect before webhook grants nothing;
- reconciliation can repair a missed webhook without duplicating billing state;
- the same provider event after process restart remains deduped because idempotency is PostgreSQL-backed;
- webhook handler records/queues quickly and does not provision VPSs inline.

Emit canonical Mox billing/domain events after committed state transitions so Notification and Compute systems can consume them later.

## Provider configuration
Admin-configurable:
- enabled
- test/live
- public/client identifiers
- vault secret refs
- webhook secret/ref
- supported regions/currencies
- priority
- health
- maintenance mode

Frontend receives safe public config only.

## Checkout
Mox-owned checkout:
- provider names may appear because customer must understand payment method;
- price/currency resolved server-side from Mox PriceBook/PriceVersion;
- never trust frontend amount/currency;
- display-currency switching cannot bypass pricing region.

## Tests for each provider
- valid/invalid signature
- duplicate/replay
- success redirect without webhook does NOT activate
- verified first payment activates
- renewal success/failure
- cancellation
- out-of-order event
- provider outage
- reconciliation
- wrong amount/currency
- wrong customer/org mapping
- test/live separation

Use sandboxes/fakes; never hit live accounts automatically.


Additional mandatory tests:
- plain org member cannot create/cancel/change subscription;
- owner/admin can perform authorized billing mutation;
- PAT without `billing` scope is denied;
- PAT with `billing` scope but insufficient org role is still denied;
- `*` PAT for a non-privileged user does not bypass org role;
- provider configuration endpoints reject customer credentials and require Mox admin authority;
- provider external IDs survive restart;
- missed webhook reconciliation repairs state exactly once;
- older provider event cannot regress newer state;
- all payment amounts are integer minor units and server-derived.


## Acceptance criteria
- four real production adapters exist;
- billing mutations enforce both API scope and real organization billing authority;
- provider mappings and event idempotency are durable in PostgreSQL;
- real webhook verification consumes the exact `rawBody` infrastructure established in 00C;
- recurring behavior follows each provider's actual capabilities;
- secrets are server/vault only;
- verified webhook/reconciliation drives Mox subscription state;
- redirect cannot activate;
- dedupe/out-of-order handling works;
- user can choose enabled providers;
- admin can configure providers without code changes.
