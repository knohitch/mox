# Prompt 08 — Billing, pricing, entitlements and regional commerce

## What was built

- `packages/money` — integer minor-unit money with explicit ISO-4217 currencies
  (USD/GBP/NGN/GHS seeded, extensible registry). No floating point: all
  arithmetic is bigint minor units; FX conversion/proration round half-up.
- `packages/entitlements` — entitlement definitions/keys (compute class,
  server count, agents, rooms, browser/CLI sessions, developer mode, credits,
  channels, integrations, storage, backup retention, seats, voice, workflows).
  Resolution precedence: custom contract > org override > plan version >
  default. Values are admin-editable data; feature code never checks plan names.
- `services/billing` — commercial authority:
  - products, immutable plan versions (draft→active→retired), per-version
    entitlement values;
  - pricing regions vs billing regions; charge vs display currency;
  - price books (`fixed` / `fx_derived` / `disabled`) with immutable price
    versions; FX prices pinned to snapshot versions at checkout;
  - checkout sessions — **a redirect never grants entitlements**; only HMAC-
    verified provider webhooks activate paid state;
  - webhook pipeline: signature verify → dedupe by external event id → apply
    with business-level idempotency (out-of-order safe); rejected events are
    recorded and may be redelivered;
  - subscription state machine TRIAL→ACTIVE→PAST_DUE→GRACE_PERIOD→SUSPENDED
    plus CANCELED→RETENTION→DELETED; every transition audited and idempotent;
  - renewal engine (charge at period end; failure ladder), retention sweep,
    admin suspend/reactivate, add-on catalog (consumable vs persistent).
- `packages/database/src/schema/billing.ts` + migration `0002_kind_archangel.sql`
  mirror the domain for Postgres deployment.

## Provider status

No payment gateway credentials exist in this repository, so no production
provider is enabled. `UnconfiguredBillingProvider` records an explicit blocker
(e.g. `MOX_BILLING_STRIPE_SECRET missing`). `FakeBillingProvider` is a clearly
named test harness used by the suite.

## Tests

27 new tests cover: forged redirect cannot activate, duplicate webhooks,
forged signatures, out-of-order delivery, renewal failure ladder
(active→past_due→grace→suspend), recovery payment, successful renewal with
exact integer invoice amounts, cancel→retention→deleted audit chain, regional
price selection incl. disabled/unavailable regions, plan version immutability,
admin suspension, add-on gating, honest not-configured reporting, money
precision/half-up rounding, entitlement override precedence and enterprise
custom contracts.
