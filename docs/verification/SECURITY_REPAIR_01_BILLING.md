# Security Repair 01 - Billing and Commercial Authorization

Date: 2026-08-24

## Repository State

- Base SHA before repair: `649bf9facd6f00ab800bf5d00dba4045e8d65d26`
- New SHA: not committed; working tree contains this repair on the same base SHA.
- Pre-existing unrelated worktree changes: deleted `md/*` run-order files were present before this repair and were not modified.

## Migrations

- Added `packages/database/migrations/0011_security_repair_billing_commercial_auth.sql`.
- Adds `subscriptions.provider_name` so provider identity is persisted instead of inferred from `providerRef`.
- Adds `server_orders.request_fingerprint` for persisted server-order HTTP idempotency conflict detection.
- Backfills `subscriptions.provider_name` only when a subscription can be matched to exactly one checkout provider. Ambiguous legacy rows remain null and require reconciliation.

## Commercial Access Model

Billing now separates lifecycle participation from present paid capability:

- Lifecycle rows are still found with `getActiveSubscription`.
- Present paid access is evaluated by `BillingService.evaluateCommercialAccess`.
- Entitlement-bearing mutations use `BillingService.requireCommercialEntitlement`.
- Entitled states:
  - `active` only when period start/end exists and `currentPeriodEnd` is in the future.
  - `grace_period` only until `graceEndsAt`.
  - `trial` only with an explicit future `trialEndsAt`.
- Denied states:
  - expired active rows;
  - `past_due`;
  - `suspended`;
  - `canceled`;
  - `retention`;
  - `deleted`;
  - missing/invalid/sentinel plan versions.

## Provider Changes

Consulted current official provider docs:

- Paystack [webhooks](https://paystack.com/docs/payments/webhooks/), [refunds](https://paystack.com/docs/payments/refunds/), and [disputes](https://paystack.com/docs/payments/manage-disputes/).
- Flutterwave v3 [webhooks](https://developer.flutterwave.com/docs/webhooks), [refunds](https://developer.flutterwave.com/v3.0/docs/refunds), and [chargebacks](https://developer.flutterwave.com/v3.0/docs/chargebacks).
- Stripe [Checkout Sessions](https://docs.stripe.com/api/checkout/sessions/create) and [webhook signature](https://docs.stripe.com/webhooks) docs.
- PayPal REST [webhooks](https://developer.paypal.com/api/rest/webhooks) and [event names](https://developer.paypal.com/api/rest/webhooks/event-names).

Implemented changes:

- Stripe checkout completion now uses real-shaped `amount_total`, `payment_status`, `mode=subscription`, `livemode`, and raw-body signature rules.
- PayPal approval/subscription-created/activated events no longer grant access; verified sale completion with amount/currency is required.
- Paystack and Flutterwave refund/dispute/chargeback events normalize to canonical refund/dispute events when a subscription/payment binding is present.
- Payment success now requires exact expected amount, currency, environment, provider binding, and durable invoice/payment identifiers before renewal or restoration.
- Missing ordering data cannot regress a newer applied provider state.

## Server Orders

`POST /api/servers/orders` now requires:

- authenticated user;
- owner/admin org authority;
- commercially entitled subscription;
- real `planVersionId`;
- server-count entitlement;
- matching compute-class entitlement;
- quota capacity;
- caller-supplied `Idempotency-Key` header or explicit body key;
- persisted request fingerprint.

Same key plus same request returns the existing order. Same key plus different request fails with `409 idempotency_conflict`.

## Lifecycle

The Control Plane background ticker now runs:

- billing renewals;
- billing retention;
- compute reconciliation;
- compute retention;
- notifications;
- node-lost sweep.

This is a correct single-process lifecycle seam. Durable multi-worker claiming remains intentionally deferred to Repair 04.

## Verification

Passed:

- `pnpm --filter @mox/billing typecheck`
- `pnpm --filter @mox/billing test`
- `pnpm --filter @mox/compute-orchestrator typecheck`
- `pnpm --filter @mox/compute-orchestrator test`
- `pnpm --filter @mox/control-plane typecheck`
- `pnpm --filter @mox/control-plane test`
- `pnpm --filter @mox/agent-control typecheck`
- `pnpm --filter @mox/agent-control test`
- `pnpm --filter @mox/database typecheck`
- `pnpm lint` (exit 0; warnings only)
- `pnpm typecheck`
- `pnpm test` (57 passed files, 425 passed tests, 1 skipped file, 39 skipped tests)
- `pnpm build`
- `scripts/run-postgres-verification.ps1`
  - applied migrations `0000` through `0011_security_repair_billing_commercial_auth.sql` to an empty PostgreSQL database;
  - PostgreSQL-gated suites: 2 passed files, 46 passed tests;
  - pre-0006 to current upgrade drill: passed.

## Repair 04 Deferrals

- Multi-worker durable claiming for lifecycle workers.
- Live provider sandbox/account verification.
- Provider-specific reconciliation queues for ambiguous legacy refund/dispute mappings.

## Security Repair 02 Safe To Run

YES. Full repository verification and the real PostgreSQL verification script completed successfully.
