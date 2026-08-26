Repository: E:\MyCodes\Mox
Branch: master

Mission

Perform a read-only targeted security revalidation after Final Repairs 05A and 05B.

Do not modify code.
Do not abuse tokens.
Do not fix.
Do not commit.
Do not push.

Re-scan current master and record the exact SHA.

Do NOT run another exhaustive repository audit yet. Trace only the residual attack paths below plus the bounded regression pass.

For each path classify:

CLOSED

PARTIALLY CLOSED

STILL EXPLOITABLE

REGRESSED

CANNOT VALIDATE

For every classification provide:

current file/symbol;

authoritative guard/state transition;

attacker prerequisites;

sensitive sink;

whether sink remains reachable;

regression test;

residual risk.

Do not accept a test name as proof without tracing the current implementation.

Billing / provider attack paths

Real Stripe charge.refunded resolves to the correct Mox subscription and revokes/suspends commercial access.

Real Stripe dispute-created resolves to the correct Mox subscription.

Charge IDs / PaymentIntent IDs / invoice IDs cannot fail binding merely because subscription authority is stored as sub_....

Full Stripe refund cannot leave subscription commercially entitled.

Stripe invoice.paid + invoice.payment_succeeded for one invoice produce exactly one period extension.

Two distinct Stripe event IDs pointing to the same invoice produce one business effect.

Replayed same event still produces one effect.

Stripe lowercase currency (usd) correctly matches canonical USD.

Stripe customer.subscription.updated material state changes are intentionally handled.

Stripe provider plan change cannot silently change Mox plan/price authority.

PayPal SUSPENDED does not cause destructive provider cancellation by itself.

PayPal RE-ACTIVATED cannot restore paid access without authoritative payment/state reconciliation.

PayPal failed-payment events bind to the billing agreement/subscription.

Repeated PayPal SALE.COMPLETED for one provider payment cannot stack entitlement periods.

Checkout process crash after local verification cannot permanently strand a paid customer without subscription.

Crash/replay at each local checkout step converges to exactly one subscription/item/transition.

A unique older refund cannot be permanently discarded solely because a newer event timestamp exists.

Missing-time payment success cannot resurrect a newer refund/dispute/canceled financial state.

Event outcome ledger distinguishes applied/duplicate/stale/reconciliation/rejected correctly.

Invalid webhook unique-body flood is bounded by rate limits/retention/aggregation.

Rejected-event cleanup cannot delete valid applied financial audit history.

Remote cancellation failure remains pending/reconcilable instead of disappearing.

Refund/dispute-suspended subscription cannot be generically admin-reactivated without financial reconciliation.

GET /api/billing/entitlements reflects actual commercial entitlement rather than lifecycle row existence.

Distributed authority / compute

Worker A lease expires, worker B reclaims and succeeds, worker A stale failure write is rejected by fencing.

Stale worker cannot overwrite order state after losing operation authority.

Equivalent stale-write protection exists for billing renewal/application where applicable.

Equivalent stale-finalizer protection exists for notification jobs where applicable.

Server quota=1 + two concurrent requests with distinct idempotency keys => exactly one order.

Server quota=2 + three concurrent requests => exactly two orders.

Same-key server retry remains idempotent after quota changes.

Quota is not released/consumed incorrectly by failed/retention/destroyed lifecycle states.

Gateway / runtime / SSRF

Production without MOX_GATEWAY_TOKEN_SECRET cannot silently use a hardcoded public fallback.

Weak gateway secret is rejected according to documented policy.

Valid configured secret mints/verifies correctly.

Gateway replay semantics match production configuration and are not merely optional unused hooks.

DNS rebinding public-at-validation/private-at-connect cannot reach private network.

Pinned DNS connection still preserves TLS hostname/certificate validation.

Redirect performs fresh resolution, validation and connection pinning.

Computer/browser capability remains fail-closed if equivalent egress enforcement is absent.

StdioRuntimeTransport stderr cannot expose raw bearer/API/DB/private-key secrets.

Computer gateway audit metadata cannot persist raw free-form secret-bearing values.

Sanitization changes do not corrupt benign UUIDs/resource IDs.

Admin / notification / abuse controls

Cross-tenant compute platform-admin action is audited against target org, not admin home org.

Cross-tenant runtime-agent admin action is audited against target org.

listUnread does not contain/use a hardcoded "u1" production identity.

Same-org user A cannot read user B's unread notification state.

Auth rate limiting produces actual 429 before expensive password hashing.

Known and unknown account behavior does not create an enumeration oracle.

Forged X-Forwarded-For from untrusted peer cannot rotate rate-limit identity.

Configured trusted proxy path behaves as documented.

First/concurrent rate-limit bucket initialization cannot fail open.

SSE per-user cap is cluster-wide across multiple instances.

SSE per-IP/global caps are cluster-wide according to design.

Process crash does not permanently leak distributed SSE count/lease.

URL tokens remain rejected and PAT scope remains enforced.

Server / notification lifecycle

Duplicate cancel on terminal/retention/error server cannot move it back to cancelling.

Failed/abandoned cancel reaches a visible reconciliable state rather than indefinite limbo.

Replay of same reboot request is idempotent.

A genuinely new reboot request can execute later if repeated reboot is valid product behavior.

Notification send accepted by downstream then local crash does not blindly duplicate where provider idempotency exists.

Where exactly-once delivery cannot be guaranteed, code/reporting honestly represents at-least-once/uncertain semantics.

Bounded new-regression pass

Check only for regressions introduced by 05A/05B:

new free-entitlement path;

valid payment lost;

refund incorrectly revokes unrelated tenant;

invoice business-effect key collides across org/provider/environment;

checkout transaction deadlock/long lock;

billing state stuck in applying forever;

cancellation retry loops indefinitely;

fencing blocks a legitimate current worker;

quota reservation leaks permanently;

quota race still exists under two PG connections;

custom DNS pinning disables TLS certificate verification;

DNS pinning breaks normal HTTPS redirects;

gateway secret validation makes test/dev impossible without explicit configuration;

replay cache creates cross-instance inconsistency;

runtime sanitizer leaks secrets or destroys ordinary identifiers;

distributed SSE count leaks on crash;

rate limiter permanently locks account;

target-org audit exposes another tenant's data;

notification outbox loses successful sends or endlessly duplicates.

Do not expand into a full source audit.

Verification evidence expected

The auditor should inspect:

current implementation;

current migrations;

new verification reports;

current regression tests.

Where possible, execute:

pnpm test

powershell -ExecutionPolicy Bypass -File scripts\run-postgres-verification.ps1

Do not use live payment/provider credentials unless explicitly authorized.

If a claim depends on real Stripe/PayPal behavior not safely testable from fixtures, mark it CANNOT VALIDATE — LIVE SANDBOX REQUIRED rather than guessing.

Output files


GROK_SECURITY_REVALIDATION_FINAL.md

End with

closure count;

any Critical still open;

any High still open;

Medium still open;

regressions;

cannot-validate items;

whether live Stripe/PayPal sandbox validation is still required;

whether a final full independent repository audit is warranted;

whether current code may proceed to final production release-gate validation.

No code changes.

Stop after the report.