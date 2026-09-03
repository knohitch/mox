# MOX — PHASE 02
# COMPLETE CUSTOMER SERVER PROVISIONING

Use **Gemini 3.1 Pro High**.

Work in `E:\MyCodes\Mox` on clean `master`. Re-scan current code. Preserve onboarding, DEV direct access, security boundaries and existing working server lifecycle. Do not push.

## GAP

Backend server-order authority exists, while Customer Servers has historically mainly listed existing servers/lifecycle actions. Turn `Provision Server` into a real Customer workflow.

## CUSTOMER ABSTRACTION

Never expose provider account, provider credentials, wholesale costs, internal margin, provider selection strategy, or provider SKU when Mox compute-class abstraction exists.

Customer works with:
- Mox compute class;
- CPU/RAM/storage description;
- permitted region;
- hostname/display name;
- SSH/public key if required;
- entitlement/plan impact;
- confirmation.

## UI FLOW

On `/servers` add a primary `Provision Server` action and real modal/wizard:

1. choose active Mox compute class;
2. choose permitted region if customer-selectable;
3. hostname/display name;
4. SSH/public-key access if required;
5. show entitlement/plan impact;
6. confirm;
7. submit one idempotent order;
8. show provisioning state;
9. auto-refresh server list.

## SAFE COMPUTE CATALOG

If no safe Customer compute-class read API exists, add one exposing only safe fields such as code/displayName/vCPU/RAM/storage/availability. Hide provider mapping/SKU/cost/account.

## IDEMPOTENCY

Double-click/retry must not buy two VPSs. Reuse current server-order idempotency and preserve one idempotency key across retriable failures.

## SSH

Re-scan existing SSH schema/API. Integrate existing customer public-key authority. If needed, expose safe list/add public-key operations. Never persist user private keys. Never return root secrets casually.

## BILLING / ENTITLEMENT

Gate by commercial access, server quota and compute-class entitlement before provisioning. Return a clear upgrade/plan state rather than fake success.

## STATES

Handle available, gated, submitting, provisioning, running, failed, stopping, canceled/retention, capacity unavailable, retry/reconcile where current authority supports it.

## TESTS

Cover safe catalog without provider internals, validation, one submit one order, double submit one order, entitlement denial, unavailable class, SSH ownership/validation, cross-org denial, UI refresh, honest provider failure, and populated DEV Customer fixture.

Run web/control-plane/compute/full gates plus PostgreSQL verification.

Report:
`docs/verification/PRODUCT_COMPLETION_02_CUSTOMER_SERVER_PROVISIONING.md`

Local commit:
`feat(servers): add customer provisioning workflow`

Do not push.
