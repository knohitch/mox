# Repair Prompt 01 — Paystack, Flutterwave, Stripe and PayPal recurring billing

**Reasoning: Ultra**

Run only after Repair Prompt 00 passes.

## Goal
Implement real production billing-provider integrations for:
- Paystack
- Flutterwave
- Stripe
- PayPal

Before coding, consult the current **official documentation** for every provider. Do not guess event names/signatures or mix old/new API generations.

Mox Billing remains the sole subscription authority. Redirect/callback pages never grant entitlements.

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

## Canonical webhook pipeline
For all providers:

`HTTP webhook → verify → persist safe digest/metadata → dedupe provider+event id → acknowledge quickly → queue → normalize to Mox Billing event → subscription state machine → entitlements → notifications → compute eligibility`

Rules:
- raw body where required;
- no slow VPS provisioning in webhook handler;
- duplicate events never duplicate value;
- out-of-order events cannot regress newer state;
- no secrets in logs.

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

## Acceptance criteria
- four real production adapters exist;
- recurring behavior follows each provider's actual capabilities;
- secrets are server/vault only;
- verified webhook/reconciliation drives Mox subscription state;
- redirect cannot activate;
- dedupe/out-of-order handling works;
- user can choose enabled providers;
- admin can configure providers without code changes.
