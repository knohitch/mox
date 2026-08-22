# Prompt 08 — Billing, pricing, entitlements and regional commerce

**Recommended Codex reasoning: Ultra**

Continue from Prompt 07.

## Goal

Build the complete commercial authority for Plus, Pro, Max and Enterprise recurring subscriptions, regional pricing, currencies, add-ons, usage allowances and suspension/retention lifecycle.

## Core rule

A browser redirect after checkout never grants entitlements.
Only verified provider webhooks/reconciliation can activate paid state.

## Domain model

Implement:

- products/plans;
- immutable plan versions where required;
- entitlement definitions;
- plan-entitlement values;
- price books;
- price versions;
- currencies;
- pricing regions;
- subscriptions;
- subscription items;
- add-ons;
- checkout sessions;
- billing customers;
- payment-provider references;
- invoices/payment records;
- verified webhook events;
- grace/retention state;
- coupons/promotions if cleanly supported.

## Plans

Seed/configure:
- Plus
- Pro
- Max
- Enterprise

Do not hard-code business limits in code.

Entitlement keys must support at least:
- included compute class;
- included server count;
- max agents;
- active/concurrent agents;
- agent rooms;
- agents per room;
- browser sessions;
- CLI sessions;
- developer mode;
- model connections;
- Mox AI credits;
- channel connections;
- integrations;
- storage;
- backup retention;
- team members;
- voice minutes;
- schedule/workflow limits.

Values remain admin-editable.

## Price books and currency

Support separate concepts:
- billing region;
- pricing region;
- display currency;
- charge currency.

Price books can be:
- fixed regional amount;
- FX-derived amount;
- disabled/unavailable.

Support at least:
- USD
- GBP
- NGN
- GHS
with extensible ISO currency handling.

Do not use floating-point for money.

## Price versions

Prices are immutable/versioned.
Existing subscriptions may:
- remain grandfathered;
- migrate at renewal after configured notice/process.

Never mutate history in place.

## Subscription state machine

Implement explicit states such as:
- TRIAL
- ACTIVE
- PAST_DUE
- GRACE_PERIOD
- SUSPENDED
- CANCELED
- RETENTION
- DELETED

Transitions must be auditable and idempotent.

## Add-ons

Support recurring add-ons for:
- additional VPS/node;
- larger compute;
- storage;
- backups;
- AI credits;
- messaging;
- voice;
- team seats.

Credits are for consumables; persistent resources are add-ons/subscription items.

## Provider abstraction

Create billing provider interface rather than binding business logic to one gateway.

Implement at least one production provider only if credentials/config are available in codebase expectations; otherwise create provider contract + verified webhook test harness and leave explicit configuration blockers.
Do not invent payment credentials.

## Admin

Admin must be able to:
- create/edit plan versions;
- configure entitlements;
- create regional prices;
- inspect subscriptions;
- suspend/reactivate;
- grant controlled overrides;
- view webhook/reconciliation state.

## Tests

Include:
- forged redirect cannot activate plan;
- duplicate webhook;
- out-of-order webhook;
- failed renewal;
- grace→suspend;
- cancel→retention;
- regional price selection;
- money precision;
- entitlement override precedence;
- enterprise custom contract.

## Acceptance criteria

- Billing is authoritative for subscription state.
- Entitlement service is authoritative for access limits.
- Plans/prices are data-driven.
- Regional pricing/currency architecture is production-grade.
- No plan capability is hard-coded into UI/business logic.
