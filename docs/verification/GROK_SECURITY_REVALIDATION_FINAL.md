# Grok Security Revalidation (post 05A / 05B)

Date: 2026-08-26  
Auditor: Grok 4.6 (read-only; no code changes, no commit, no push)  
Repository: `E:\MyCodes\Mox`  
Branch: `master`  
SHA: `407db659115955ebaeab2fe60d3f78f4015f0419`

```
407db65 fix(security): harden distributed authority and runtime controls   ← 05B
dd0f731 fix(security): harden payment lifecycle and billing reconciliation ← 05A
```

This is a targeted residual-path revalidation, not a full repository audit. Test names are not accepted as proof; each path is classified from the current implementation, migrations `0014`/`0015`, and what the matching tests actually assert.

## Verification evidence executed

| Command | Result |
|---|---|
| `pnpm test` | 60 files passed, 2 skipped (PG-gated), **495 passed**, 61 skipped, exit 0 |
| `powershell -ExecutionPolicy Bypass -File scripts\run-postgres-verification.ps1` | exit 0 |
| Fresh PG cluster migrations | `0000`–`0015` applied, including `0014_security_repair_payments_billing.sql` and `0015_security_repair_distributed_hardening.sql` |
| PG-gated suites | `restart` + `auth-integration` + `security-repair-05b` = **71/71 passed** |
| Pre-0006 → current upgrade drill | PASS (legacy rows preserved, resubscribe works, FX migrated) |

Live Stripe/PayPal credentials were not used.

Note: `packages/database/migrations/meta/_journal.json` still ends at `0013`. Production apply is `packages/database/scripts/migrate.mjs`, which applies every `*.sql` in lexicographic order (not the drizzle journal). `0014`/`0015` **do** apply. The journal is a tooling snapshot gap, not a schema-apply gap.

---

## Billing / provider attack paths

### 1. Real Stripe `charge.refunded` resolves to the correct Mox subscription and revokes/suspends commercial access

**CLOSED** for a single full-refund Charge-shaped event that carries `payment_intent` (and/or invoice) matching a persisted mapping.

| Field | Evidence |
|---|---|
| Current file/symbol | `StripeProvider.verifyWebhook` (`services/billing/src/providers/stripe.ts` `charge.refunded`); `BillingService.resolveSubscriptionForEvent` / `applyRefund` |
| Authoritative guard | Typed `provider_object_mappings` lookup (charge / PI / invoice / sub). No ID-prefix guessing. Full refund (`amount_refunded >= period price`) → `suspended` + `suspensionSource=refund` + commercial-reconciliation queue. Compute is **not** destroyed inside the webhook. |
| Attacker prerequisites | Valid Stripe-signed `charge.refunded` for a mapped payment. |
| Sensitive sink | Commercial entitlement / subscription state. |
| Sink reachable? | No, for the single full-refund fixture shape. Unmapped charge → `reconciliation_required` (fail-closed, not silent ignore). |
| Regression test | `charge refund resolves through persisted provider-object mapping and suspends` — checkout stores `pi_2`; refund carries only `ch_2`+`pi_2`+`in_2`; asserts `suspended` / `refund` / queue row. |
| Residual risk | Live Charge objects with expanded (non-string) `invoice` and missing `payment_intent` are **CANNOT VALIDATE — LIVE SANDBOX REQUIRED**. Incremental refunds: see path 4. |

### 2. Real Stripe `dispute-created` resolves to the correct Mox subscription

**CLOSED** (fixture-shaped Dispute with `payment_intent`).

| Field | Evidence |
|---|---|
| Current file/symbol | `stripe.ts` `charge.dispute.created` → `dispute.opened`; `applyDisputeOpened` |
| Authoritative guard | Same mapping resolver; suspends with `suspensionSource=dispute`; queues commercial reconciliation. |
| Attacker prerequisites | Valid signed `charge.dispute.created`. |
| Sensitive sink | Entitlement. |
| Sink reachable? | No, for mapped PI. Unmapped → `reconciliation_required`. |
| Regression test | `dispute-created resolves through the mapping and suspends the correct subscription` |
| Residual risk | Live Dispute payload variants (expanded charge object) — **CANNOT VALIDATE — LIVE SANDBOX REQUIRED**. |

### 3. Charge / PaymentIntent / invoice IDs cannot fail binding merely because subscription authority is stored as `sub_…`

**CLOSED**

| Field | Evidence |
|---|---|
| Current file/symbol | `resolveSubscriptionForEvent`; `upsertProviderObjectMapping` / `findProviderObjectMappings` (in-memory + `PgBillingStore`); unique typed indexes in `0014` |
| Authoritative guard | Direct `subscriptions.provider_ref` match, then OR of typed mapping columns, then exact legacy ref equality. Never prefix inference. Ambiguous distinct subscriptions → `reconciliation_required`. |
| Attacker prerequisites | Event that only carries `ch_` / `pi_` / `in_`. |
| Sensitive sink | Wrong-tenant subscription bind. |
| Sink reachable? | No. Cross-org ref merge marks every involved mapping `reconciliation_required` and refuses the merge. |
| Regression test | 05A charge-refund and dispute tests (no `subscription` on the Charge/Dispute object). |
| Residual risk | Mapping is populated at checkout/invoice time. A refund arriving **before** any mapping exists fails closed as `reconciliation_required`. |

### 4. Full Stripe refund cannot leave subscription commercially entitled

**PARTIALLY CLOSED**

| Field | Evidence |
|---|---|
| Current file/symbol | `applyRefund`; `billingIdentityFor` refund → `charge:{chargeRef}`; `evaluateCommercialAccess` |
| Authoritative guard | One-shot: `amount_refunded >= period price` → `suspended`. Entitlements then return `commerciallyEntitled: false` (`state_suspended`). |
| Attacker prerequisites | Two (or more) `charge.refunded` events on the **same charge**, first one partial. |
| Sensitive sink | Paid access after the charge is fully refunded. |
| Sink reachable? | **Yes, for incremental refunds.** Business-effect identity is per-charge, not per refund increment. First partial claims `charge:ch_x` + `refund`; a later `charge.refunded` with cumulative `amount_refunded` equal to the period price is `duplicate` and **does not suspend**. |
| Regression test | Full-refund test uses a single event with `amount_refunded: 2000`. Partial-refund test asserts access preserved. **No test for partial-then-full on the same charge.** |
| Residual risk | Stripe does emit a new `charge.refunded` per refund with cumulative `amount_refunded`. Documented partial-refund policy is intentional; the full-refund path does not re-evaluate after the first claim. Medium. |

### 5. Stripe `invoice.paid` + `invoice.payment_succeeded` for one invoice produce exactly one period extension

**CLOSED**

| Field | Evidence |
|---|---|
| Current file/symbol | Both events → `payment.succeeded` with `invoiceRef=obj.id`; `billingIdentityFor` → `invoice:{invoiceRef}`; unique `(provider, environment, billing_identity, effect_type)` |
| Authoritative guard | `claimProviderBillingEffect` (`ON CONFLICT DO NOTHING` in PG). Second sibling returns `duplicate` and does not advance `currentPeriodEnd`. |
| Attacker prerequisites | Two signed sibling events for one invoice. |
| Sensitive sink | Stacked paid time. |
| Sink reachable? | No. |
| Regression test | `invoice.paid + invoice.payment_succeeded for the SAME invoice extend the period exactly once` — asserts sibling `duplicate` and identical `currentPeriodEnd`. |
| Residual risk | Identity is not org-scoped; Stripe invoice IDs are globally unique per environment, and `environment` is in the key. |

### 6. Two distinct Stripe event IDs pointing to the same invoice produce one business effect

**CLOSED** — same mechanism as path 5. Event-id ledger stores both webhook rows; business effect is invoice-identity, not event-id.

### 7. Replayed same event still produces one effect

**CLOSED**

| Field | Evidence |
|---|---|
| Current file/symbol | `claimWebhookApplication` unique on `(provider_name, external_event_id)`; already-`applied` returns `"applied"` → HTTP duplicate |
| Authoritative guard | Durable webhook claim **and** business-effect claim. |
| Attacker prerequisites | Redeliver identical event id. |
| Sensitive sink | Double grant. |
| Sink reachable? | No. |
| Regression test | Same 05A invoice test replays `evt_invoice_paid_1`; `restart.test.ts` `duplicate webhook remains deduped after restart` and `concurrent duplicate webhooks across service instances apply once` (PG). |
| Residual risk | Non-`applied` outcomes (`reconciliation_required`) may be retried. That is intended. |

### 8. Stripe lowercase currency (`usd`) correctly matches canonical USD

**CLOSED**

| Field | Evidence |
|---|---|
| Current file/symbol | `normalizeCurrency` in `providers/shared.ts`; applied in `verifyWebhook` before service money compare |
| Authoritative guard | Uppercase ISO-4217 before equality against PriceBook. |
| Attacker prerequisites | Lowercase `currency` on a paid checkout. |
| Sensitive sink | False amount/currency mismatch reject (lost payment) or wrong-currency accept. |
| Sink reachable? | No. |
| Regression test | `real-shaped paid checkout canonicalizes lowercase currency and activates` |
| Residual risk | None on this path. |

### 9. Stripe `customer.subscription.updated` material state changes are intentionally handled

**CLOSED**

| Field | Evidence |
|---|---|
| Current file/symbol | `applySubscriptionUpdated` switch on `active` / `trialing` / `past_due` / `unpaid` / `paused` / `canceled` / `incomplete*` |
| Authoritative guard | Material states map to explicit local transitions. Unknown status → `reconciliation_required`. Lifecycle-alone cannot restore `past_due`/`grace`/`refund-suspended`. Period sync only when `eventIsCurrent`. |
| Attacker prerequisites | Signed `customer.subscription.updated`. |
| Sensitive sink | Silent entitlement change. |
| Sink reachable? | No for handled statuses; unknown fails closed. |
| Regression test | `subscription.updated is handled intentionally: past_due, pause, and unmapped-plan safety` |
| Residual risk | Stripe statuses added after this mapping land in `reconciliation_required`. |

### 10. Stripe provider plan change cannot silently change Mox plan/price authority

**CLOSED**

| Field | Evidence |
|---|---|
| Current file/symbol | `applySubscriptionUpdated` `providerPlanRefs` vs `findProviderPlanMapping`; mismatch sets `reconciliationRequired` and stores `providerPlanRef` but **does not** rewrite `priceVersionId` / `planVersionId` |
| Authoritative guard | Server-side PriceBook remains authority. |
| Attacker prerequisites | Provider-side price id change on the Stripe subscription. |
| Sensitive sink | Silent Mox plan/price remap. |
| Sink reachable? | No. |
| Regression test | Same 05A subscription.updated test (unmapped-plan safety). |
| Residual risk | Entitlement continues on the **old** Mox plan until reconciliation — fail-closed, not fail-open. |

### 11. PayPal `SUSPENDED` does not cause destructive provider cancellation by itself

**CLOSED**

| Field | Evidence |
|---|---|
| Current file/symbol | `paypal.ts` `BILLING.SUBSCRIPTION.SUSPENDED` → `subscription.suspended`; `applySubscriptionSuspended` |
| Authoritative guard | Local `suspended` + `suspensionSource=provider`. **No** `cancelRemote` call. |
| Attacker prerequisites | Signed SUSPENDED event. |
| Sensitive sink | Destructive remote cancel / local `canceled`. |
| Sink reachable? | No. |
| Regression test | `SUSPENDED is recoverable and never triggers a destructive remote cancel` — spies `/cancel` (zero calls) and asserts no `canceledAt`. |
| Residual risk | Live event resource shape — **CANNOT VALIDATE — LIVE SANDBOX REQUIRED**. |

### 12. PayPal `RE-ACTIVATED` cannot restore paid access without authoritative payment/state reconciliation

**CLOSED**

| Field | Evidence |
|---|---|
| Current file/symbol | `applySubscriptionReactivated` |
| Authoritative guard | Event itself never grants. Requires `verifyCheckout` (`status=ACTIVE` **and** last-payment amount/currency matching canonical price). Failure → stay suspended + `reconciliation_required`. |
| Attacker prerequisites | Signed RE-ACTIVATED without a paid last payment. |
| Sensitive sink | Restored entitlement. |
| Sink reachable? | No. |
| Regression test | Restores only after mocked ACTIVE+payment; without payment proof stays suspended. |
| Residual risk | `verifyCheckout` treats PayPal `ACTIVE` + last_payment as paid. Live billing_info shape — **CANNOT VALIDATE — LIVE SANDBOX REQUIRED**. |

### 13. PayPal failed-payment events bind to the billing agreement/subscription

**CLOSED**

| Field | Evidence |
|---|---|
| Current file/symbol | `BILLING.SUBSCRIPTION.PAYMENT.FAILED` binds `subscriptionRef=resource.id`; `PAYMENT.SALE.DENIED` binds `subscriptionRef=billing_agreement_id` (never the sale id as authority) |
| Authoritative guard | Resolver then `past_due` on active. |
| Attacker prerequisites | Failed-payment webhook. |
| Sensitive sink | Unrelated subscription / missed past_due. |
| Sink reachable? | No when agreement id is present. Missing agreement on SALE.DENIED → unresolved → `reconciliation_required`. |
| Regression test | `payment-failed binds to the billing agreement and moves to recoverable past_due` |
| Residual risk | Live SALE.DENIED without `billing_agreement_id` — **CANNOT VALIDATE — LIVE SANDBOX REQUIRED**. |

### 14. Repeated PayPal `SALE.COMPLETED` for one provider payment cannot stack entitlement periods

**CLOSED**

| Field | Evidence |
|---|---|
| Current file/symbol | `billingIdentityFor` → `sale:{transactionRef}`; first-sale checkout path `ensureCheckoutEffects` claims `period_extension` at checkout completion |
| Authoritative guard | Same-sale redelivery is `duplicate`. Distinct sales (real renewals) may extend — intended. |
| Attacker prerequisites | Redelivered SALE.COMPLETED with the same sale id. |
| Sensitive sink | Stacked paid time. |
| Sink reachable? | No. |
| Regression test | `SALE.COMPLETED grants once; repeated same sale never stacks paid time` |
| Residual risk | None on same-sale identity. |

### 15. Checkout process crash after local verification cannot permanently strand a paid customer without subscription

**CLOSED**

| Field | Evidence |
|---|---|
| Current file/symbol | `applyCheckoutCompleted` state machine `created/redirected → applying → completed`; `reconcileCheckoutSession` uses the same path |
| Authoritative guard | Webhook is marked `applied` only after session → `completed`. Crash mid-apply leaves `applying`; lease expiry allows re-claim. Stripe retries + reconcile endpoint repair. |
| Attacker prerequisites | Process crash after provider paid, before local completion. |
| Sensitive sink | Paid customer with no subscription. |
| Sink reachable? | Not permanently, if the event is retried or reconcile is invoked. |
| Regression test | Fault-injection suite `crash after ${crashPoint} recovers…` for claim / customer / session / subscription / item / transition. |
| Residual risk | If webhooks stop **and** reconcile is never called, session can remain `applying` until a retry. Visible, not silently entitled. |

### 16. Crash/replay at each local checkout step converges to exactly one subscription/item/transition

**CLOSED** — same suite as 15. Partial unique index `subscription_items_base_key`; transition idempotency key `checkout:{sessionId}`; history-preserving one-live-row-per-org.

### 17. A unique older refund cannot be permanently discarded solely because a newer event timestamp exists

**CLOSED**

| Field | Evidence |
|---|---|
| Current file/symbol | `applyRefund` does **not** call `eventIsCurrent` / drop on older timestamps |
| Authoritative guard | Refund/dispute are financial facts. Older refund after newer success still suspends. |
| Attacker prerequisites | Out-of-order refund vs success. |
| Sensitive sink | Discarded refund → continued entitlement. |
| Sink reachable? | No. |
| Regression test | `an older REAL refund after a newer success still suspends` |
| Residual risk | `occurredAt` is Stripe `event.created`, not charge created-time. |

### 18. Missing-time payment success cannot resurrect a newer refund/dispute/canceled financial state

**CLOSED**

| Field | Evidence |
|---|---|
| Current file/symbol | `applyPaymentSucceeded` |
| Authoritative guard | Terminal `canceled/retention/deleted` → `stale_ignored`. Refund/dispute/fraud/compliance suspension + missing `occurredAt` → `reconciliation_required`. Missing time + existing `lastEventAt` → `reconciliation_required`. Older-or-equal timestamp vs lastEvent → `stale_ignored`. |
| Attacker prerequisites | Success event with no timestamp after a refund. |
| Sensitive sink | Resurrected entitlement. |
| Sink reachable? | No. |
| Regression test | `a missing-time success cannot resurrect refund-suspended state` |
| Residual risk | A **newer-timestamp** genuine later payment **can** recover (`payment_recovered`). That is intended for a real subsequent invoice. |

### 19. Event outcome ledger distinguishes applied / duplicate / stale / reconciliation / rejected correctly

**CLOSED**

| Field | Evidence |
|---|---|
| Current file/symbol | `webhook_status` enum + `handleProviderWebhook` mapping `result.outcome` onto the webhook row and `provider_payments.state` |
| Authoritative guard | Distinct persisted outcomes, not collapsed into `applied`. |
| Attacker prerequisites | Mixed event classes. |
| Sensitive sink | Audit/idempotency confusion. |
| Sink reachable? | No. |
| Regression test | 05A ordering + webhook-junk tests; types in `services/billing/src/types.ts`. |
| Residual risk | Replay of an already-`applied` event is reported as `duplicate` at the HTTP layer (claim short-circuit), which is correct. |

### 20. Invalid webhook unique-body flood is bounded by rate limits / retention / aggregation

**CLOSED**

| Field | Evidence |
|---|---|
| Current file/symbol | `readRawBody` 256 KB → 413; durable PG limiter scopes `billing_webhook_ip` / `_path` / `_global`; identical invalid bodies share `rejected:{digest}` |
| Authoritative guard | 429 before verification work is bounded by the limiter; rejected rows store digest + generic reason, not payload. |
| Attacker prerequisites | Unauthenticated POST `/webhooks/billing/:provider`. |
| Sensitive sink | Unbounded storage / CPU. |
| Sink reachable? | No under configured caps. |
| Regression test | HTTP: per-IP 429, oversized 413, legitimate burst accepted (PG `auth-integration`). Service: identical invalid bodies dedupe. |
| Residual risk | Unique-body flood is bounded by **rate limits**, not by a unique-payload cap. Defaults are generous (`perIpLimit=120/min`). |

### 21. Rejected-event cleanup cannot delete valid applied financial audit history

**CLOSED**

| Field | Evidence |
|---|---|
| Current file/symbol | `purgeRejectedWebhooks` deletes **only** `status='rejected'` older than TTL; ticker in `server.ts` |
| Authoritative guard | Applied/duplicate/stale/reconciliation rows are exempt. |
| Attacker prerequisites | TTL elapsed. |
| Sensitive sink | Deleted financial audit. |
| Sink reachable? | No. |
| Regression test | `rejected junk purges with a short TTL; applied financial history is retained` |
| Residual risk | None on this path. |

### 22. Remote cancellation failure remains pending / reconcilable instead of disappearing

**CLOSED**

| Field | Evidence |
|---|---|
| Current file/symbol | `cancelSubscription` / `runCancellationRetries`; table `subscription_cancellations` |
| Authoritative guard | Remote failure → `reconciliation_required` + `last_error` + `next_attempt_at` (exponential backoff, cap 1 h). Ticker retries. Visible on `/api/billing/subscription`. No provider ref → reconciliation immediately, never guessed. |
| Attacker prerequisites | Provider cancel API fails. |
| Sensitive sink | Silent lost cancel intent. |
| Sink reachable? | No. |
| Regression test | `transient remote cancel failure → reconciliation_required; retry completes exactly once` |
| Residual risk | Retries are unbounded in time (backoff, not a tight loop). Local entitlement is already shut down. |

### 23. Refund / dispute-suspended subscription cannot be generically admin-reactivated without financial reconciliation

**CLOSED**

| Field | Evidence |
|---|---|
| Current file/symbol | `BillingService.adminReactivate`; API `POST /api/admin/customers/:orgId/reactivate` passes `financialReconciled: body?.financialReconciled === true` |
| Authoritative guard | `refund|dispute|fraud|compliance` requires explicit flag **and** live paid period **and** `reconciliationRequired=false`. Generic click throws `CommercialAccessError`. |
| Attacker prerequisites | Platform admin without asserting reconciliation. |
| Sensitive sink | Restored paid access after refund/dispute. |
| Sink reachable? | No. |
| Regression test | `generic admin reactivation of a refund-suspended subscription is refused without financial reconciliation`; `financial reconciliation cannot restore an expired paid period`; `dispute-won cannot restore a financially invalid subscription` |
| Residual risk | An admin who **does** set `financialReconciled: true` while period is still valid can restore. That is the documented escape hatch. |

### 24. `GET /api/billing/entitlements` reflects actual commercial entitlement rather than lifecycle row existence

**CLOSED**

| Field | Evidence |
|---|---|
| Current file/symbol | `api.ts` `GET /api/billing/entitlements` → `evaluateCommercialAccess`; values only if `decision.entitled` |
| Authoritative guard | Same authority as entitlement-bearing mutations. `active` + expired period → `expired_period`. `suspended` → `state_suspended`. No sub → `no_subscription`. |
| Attacker prerequisites | Read the entitlements endpoint. |
| Sensitive sink | UI treating a live row as paid capability. |
| Sink reachable? | No. |
| Regression test | HTTP `GET /api/billing/entitlements uses the same commercial-access authority as mutations (05A §J)` — none / entitled / suspended / expired_period, empty `values` when denied. |
| Residual risk | `getActiveSubscriptionForOrg` includes `suspended` in LIVE_STATES so the row is returned; entitlement boolean is still false. |

---

## Distributed authority / compute / SSE / server lifecycle

### 1. Worker A lease expires, worker B reclaims and succeeds, worker A stale failure write is rejected by fencing

**CLOSED**

| Field | Evidence |
|---|---|
| Current file/symbol | `PgOrchestratorStore.claimDueOperations` increments `lease_version`; `updateOperationFenced` CAS on `id + state='running' + lease_owner + lease_version` |
| Authoritative guard | Stale write updates zero rows; `reconcile` skips order-state writes when `owned=false`. |
| Attacker prerequisites | Overlapping workers, expired lease. |
| Sensitive sink | Order overwritten to error after a successful reclaim. |
| Sink reachable? | No. |
| Regression test | PG: `A: stale compute worker cannot overwrite a reclaimer's success (provision/cancel/reboot)`. In-memory mirror in `@mox/compute-orchestrator`. |
| Residual risk | `updateOperation` (unfenced) still exists; production reconciler uses the fenced API. |

### 2. Stale worker cannot overwrite order state after losing operation authority

**CLOSED** — order patches and enrollment-token revocation in `reconcile` run only after a successful fenced writeback. Enrollment revoke on provision failure is behind the same fence.

### 3. Equivalent stale-write protection exists for billing renewal / application

**CLOSED** for renewal writebacks.

| Field | Evidence |
|---|---|
| Current file/symbol | `subscriptions.renewal_claim_version`; `claimSubscriptionRenewal` / `completeSubscriptionRenewal` |
| Authoritative guard | Success **and** failure renewal writebacks are fenced. Stale worker cannot regress period or transition. |
| Regression test | PG: `A: stale billing renewal worker cannot regress a reclaimer's period write` |
| Residual risk | Checkout `applying` uses a **lease**, not `renewal_claim_version`. Checkout fencing is claim-expiry, not the same token. |

### 4. Equivalent stale-finalizer protection exists for notification jobs

**CLOSED**

| Field | Evidence |
|---|---|
| Current file/symbol | `notification_jobs.claim_version`; `updateJobFenced` |
| Authoritative guard | Terminal completed/failed writebacks are fenced. Fan-out cursors remain dedupe-keyed. |
| Regression test | PG: `A: stale notification finalizer cannot regress a reclaimer's job` |

### 5. Server quota=1 + two concurrent requests with distinct idempotency keys => exactly one order

**CLOSED**

| Field | Evidence |
|---|---|
| Current file/symbol | `createOrderReserved`: upsert `org_compute_allocations` + `SELECT … FOR UPDATE`, then idempotency check, then count non-terminal orders, then insert order+op in one transaction |
| Authoritative guard | Over-quota order is never inserted. HTTP 402 `server_quota_exceeded`. |
| Regression test | PG two instances: `B: quota=1 with two distinct concurrent PG keys yields exactly one order`. In-memory mirror. |

### 6. Server quota=2 + three concurrent requests => exactly two orders

**CLOSED** on the same serialized path. Dedicated test is in-memory (`quota=2 with three distinct concurrent keys yields exactly two orders`). No separate two-connection PG test for quota=2; the lock is the same.

### 7. Same-key server retry remains idempotent after quota changes

**CLOSED** — idempotency lookup is **inside** the org row lock. Replay of the same key returns `idempotent` even if quota later drops. In-memory test `same-key replay remains one order even under the reservation path`. Fingerprint mismatch throws.

### 8. Quota is not released/consumed incorrectly by failed / retention / destroyed lifecycle states

**CLOSED** for the documented count set.

Counted: `requested/provisioning/running/resizing/stopping/stopped/cancelling`.  
Not counted: `error/canceled/retention/destroyed`. Abandoned provision → `error` releases capacity. Residual: an order stuck in `cancelling` (see server-lifecycle 9) **holds** quota.

### 9. Duplicate cancel on terminal / retention / error server cannot move it back to cancelling

**PARTIALLY CLOSED**

| Field | Evidence |
|---|---|
| Current file/symbol | `ComputeOrchestrator.cancelOrder` |
| Authoritative guard | No-op for `canceled` / `destroyed` / `retention`. **`error` is not in that set** — it is treated as an intentional retry and moved to `cancelling`. |
| Attacker prerequisites | Duplicate cancel after an abandoned cancel (`error`). |
| Sensitive sink | Order returned to `cancelling` with no runnable cancel op. |
| Sink reachable? | **Yes.** `upsertOperation` refuses to re-queue `abandoned`/`succeeded` ops. Retry from `error` sets `cancelling` then no-ops the enqueue. Quota stays consumed while `cancelling`. |
| Regression test | `duplicate cancel in terminal states is a no-op (retention/destroyed)` — does **not** cover `error`. |
| Residual risk | Medium. First abandon is visible (`error` + `cancel abandoned:`). Retry can strand. |

### 10. Failed / abandoned cancel reaches a visible reconciliable state rather than indefinite limbo

**CLOSED** for the first abandon. `reconcile` on abandoned cancel with order still `cancelling` writes `error` + `lastError: cancel abandoned: …`. Test: `an abandoned cancel reaches a visible reconciliable state, not cancelling limbo`. Residual: path 9 retry.

### 11. Replay of same reboot request is idempotent

**CLOSED** — identity `{orderId}:reboot:{requestId}`; `enqueue` returns the canonical row. Test: `reboots use request identities: replay dedupes, a new request creates a new operation`.

### 12. A genuinely new reboot request can execute later

**CLOSED** — new `requestId` creates a new operation. Same test.

### 13–15. SSE caps cluster-wide; crash does not permanently leak

**CLOSED**

| Field | Evidence |
|---|---|
| Current file/symbol | `ClusterSseAdmission` (`sse_admission_state` + `sse_connections` leases); ticker `sweep()` |
| Authoritative guard | Per-user / per-IP / global counters row-locked. Heartbeat extends lease (default 90 s). Sweep decrements. |
| Regression test | PG: `I: cluster-wide SSE admission shares caps across instances and releases on close/crash` — 6th stream on instance B denied after 5 on A; close reopens on the other instance; expired lease reclaimed. |
| Residual risk | Capacity can be overstated until TTL (≤90 s), not permanently. |

### 16. URL tokens remain rejected and PAT scope remains enforced

**CLOSED** — `/api/streams/org-events` and `/api/streams/user-notifications` reject `?token` / `?authorization` (`no_token_in_url`). PAT requires `threads` / `notifications` respectively. HTTP tests in `auth-integration`.

---

## Gateway / runtime / SSRF / sanitization

### 1. Production without `MOX_GATEWAY_TOKEN_SECRET` cannot silently use a hardcoded public fallback

**CLOSED**

| Field | Evidence |
|---|---|
| Current file/symbol | `gatewayTokenSecretFromEnv` / `requireStrongGatewaySecret`; `LEGACY_PUBLIC_GATEWAY_SECRET` is a denylist, not a default |
| Authoritative guard | Missing → throw / verify `{ok:false, reason:"gateway secret not configured"}`. Exact public string refused. `ComputerGateway` ctor throws if neither option nor env. |
| Regression test | `fails closed without a configured secret`; `refuses the legacy public test secret and weak secrets` |
| Residual risk | `ComputerGateway({ gatewaySecret })` does **not** run the strength policy (path 2). That is injection, not a silent fallback. |

### 2. Weak gateway secret is rejected according to documented policy

**PARTIALLY CLOSED** — env and `mintGatewayToken`/`verifyGatewayToken({secret})` enforce ≥32 chars and ≥3 character classes. `new ComputerGateway({ gatewaySecret })` assigns the option verbatim. Control plane does not construct `ComputerGateway` today.

### 3. Valid configured secret mints / verifies correctly

**CLOSED** — HMAC-SHA256 over base64url claims; timing-safe compare; org/agent/session/jti/exp required. Tests round-trip a strong injected secret.

### 4. Gateway replay semantics match production configuration and are not merely optional unused hooks

**CLOSED** (matches the documented production model, which is **TTL reuse**, not one-time jti).

`ComputerGateway.verify` does **not** pass `seenJti`/`consumeReplay`. Tokens are reusable until `expiresAt`, bound to org/agent/session. The optional hook is inert unless a caller supplies it. There is no false one-time-use claim on the production path. Residual: a stolen token works for its TTL.

### 5. DNS rebinding public-at-validation / private-at-connect cannot reach private network

**STILL EXPLOITABLE** on the only production-shaped `safeOutboundFetch` callers.

| Field | Evidence |
|---|---|
| Current file/symbol | `safeOutboundFetch` (`packages/security/src/ssrf.ts`); `HttpOutboundTransport.send`; `WebhookApiTokenProvider.invoke` |
| Authoritative guard (default path) | Resolve once → validate every IP → `performPinnedRequest` with `lookup: pinnedLookup(pinned)`. Mixed public+private fails closed. |
| Why the sink remains reachable | If `options.fetchImpl` is set, the pinned addresses are computed and **discarded**; the request uses the injected/global `fetch`, which re-resolves DNS. Both production-shaped callers **always** pass `fetchImpl` (defaulting to global `fetch`): `services/channel-gateway/src/gateway.ts`, `services/integration-gateway/src/providers.ts`. 05B’s claim that “production callers pass nothing and get the pinned path” is **false**. |
| Attacker prerequisites | Ability to set `outboundUrl` / `webhookUrl` to a hostname whose DNS can rebind between the validation lookup and `fetch` (short TTL). |
| Sensitive sink | HTTP(S) to RFC1918 / link-local / metadata from the control-plane egress network. |
| Sink reachable? | **Yes, in those services.** They are **not** currently composed into `composeControlPlane`, so the **current control-plane HTTP surface** does not expose them. The shipped default constructors still use unpinned `fetch`. |
| Regression test | Pinning tests exercise `resolveValidatedAddresses` / `pinnedLookup` helpers, or `safeOutboundFetch` **with** `fetchImpl` — they do **not** prove `performPinnedRequest` on the caller path. |
| Residual risk | **High** for channel/integration when wired. Port allowlist is `[443]` and HTTP is not enabled by default, which blocks classic IMDS `:80`, but internal HTTPS on 443 remains reachable via rebinding. |

### 6. Pinned DNS connection still preserves TLS hostname / certificate validation

**CLOSED** in `performPinnedRequest` (`servername` = original hostname; TLS verify not disabled). **CANNOT VALIDATE** at a real TLS handshake (no cert-mismatch test). Production callers never reach this function (path 5). Regression “pinning disables TLS verify”: **not present in code**.

### 7. Redirect performs fresh resolution, validation and connection pinning

**PARTIALLY CLOSED** — the loop re-runs `assertSafeOutboundUrl` + `resolveValidatedAddresses` per hop and strips auth/cookies on host change. Production callers do not set `redirect: "follow"` (redirects=0). Tests that do follow still pass `fetchImpl`, so hop 2 validates but does **not** pin.

### 8. Computer / browser capability remains fail-closed if equivalent egress enforcement is absent

**PARTIALLY CLOSED**

Production control-plane computer routes return **501 `not_configured`**. No `ComputerGateway` in `composeControlPlane`. The library itself: `navigate` egress is applied only `if (this.opts.egress)` — omitting egress allows navigate. Happy-path tests omit egress and succeed. First future wiring of `ComputerGateway` without an egress policy would open unconstrained navigate (browser cannot pin resolved IPs).

### 9. `StdioRuntimeTransport` stderr cannot expose raw bearer / API / DB / private-key secrets

**CLOSED** for exported surfaces.

`onClosed` error, `stderrTailText()`, and `crashDiagnostic().diagnostic` all go through `scrubLogLine`. Raw tail is in-process only; `rawDiagnosticSha256` is a hash. Test: `scrubs secret-shaped stderr before it reaches errors and diagnostics` (postgres URL, `ghp_`, `password=`, Bearer; UUID/`compute-1234ab` survive). Residual: denylist (unknown secret shapes); raw tail in memory.

### 10. Computer gateway audit metadata cannot persist raw free-form secret-bearing values

**CLOSED** on the persist path — `redactMetadata` before `audit.record`. No dedicated gateway-level audit assertion (unit tests cover `redactMetadata` / `scrubLogLine`). Residual: keys like `takenBy`/`reason` are value-regex only.

### 11. Sanitization changes do not corrupt benign UUIDs / resource IDs

**CLOSED** for UUIDs and short slugs. Card redaction uses Luhn + digit-boundary lookarounds. Base64 redaction requires ≥40 chars **and** upper+lower+digit+separator. Residual: long mixed-case hyphenated tokens (≥40) will be redacted.

---

## Admin / notification / abuse controls

### 1. Cross-tenant compute platform-admin action is audited against target org, not admin home org

**CLOSED** — `appendAdminAudit` defaults `orgId` to `null`, never the admin’s home org. Compute actions pass `targetOrgId: order.orgId`. HTTP test: `compute order admin actions audit the AFFECTED org, not the admin's home org`.

### 2. Cross-tenant runtime-agent admin action is audited against target org

**CLOSED** — `targetOrgId: order.orgId` on `runtime.agent.*`. HTTP test: `runtime agent admin actions audit the order's org, never the admin's org`.

### 3. `listUnread` does not contain / use a hardcoded `"u1"` production identity

**CLOSED** — `listUnread(orgId, userId)` requires the caller’s user id and delegates to `unreadCount`. HTTP unread-count uses `auth.userId`.

### 4. Same-org user A cannot read user B’s unread notification state

**CLOSED** — store is `(orgId, userId)` scoped. Service test + HTTP `same-org user A cannot read B's unread state over HTTP`.

### 5. Auth rate limiting produces actual 429 before expensive password hashing

**CLOSED** — `POST /api/auth/login` calls `enforceAuthRateLimits` **before** `loginAccount` → `verifyPassword`. HTTP test: 8×401 then 429 (~12 ms vs ~180 ms hash), for known and unknown accounts.

### 6. Known and unknown account behavior does not create an enumeration oracle

**CLOSED** — unknown emails still run `verifyPassword` against `DUMMY_HASH`; both return `invalid credentials` 401 until the account bucket 429s at the same threshold.

### 7. Forged `X-Forwarded-For` from untrusted peer cannot rotate rate-limit identity

**CLOSED** — `clientIp` uses `X-Forwarded-For` only when `socket.remoteAddress` is in `trustedProxyIps`. HTTP test present.

### 8. Configured trusted proxy path behaves as documented

**CLOSED** — when the peer **is** trusted, the first XFF hop is used (webhook abuse test isolates onto `203.0.113.77` via trusted `127.0.0.1`). Residual: only the first hop is taken (standard).

### 9. First / concurrent rate-limit bucket initialization cannot fail open

**CLOSED** under the tested driver.

`DurableRateLimiter.check`: `INSERT … ON CONFLICT DO NOTHING` then `SELECT … FOR UPDATE`. PG test: `H: simultaneous first bucket creation cannot bypass the durable limiter` — exactly one of two concurrent first checks is allowed. Residual: `if (!row) return { allowed: true }` is a fail-open if `execute()` returned no row; that path did not fire in the PG suite.

### 10. Notification send accepted by downstream then local crash does not blindly duplicate where provider idempotency exists

**CLOSED** — `recordDispatchPrepared` writes `sending` **before** `transport.send`. Success → `sent`. Crash leaves `sending`; sweep → `uncertain`, **not** silently resent. Retries only if `transport.idempotent === true` (≤3 attempts), passing `dedupeKey`.

### 11. Where exactly-once delivery cannot be guaranteed, code/reporting honestly represents at-least-once / uncertain semantics

**CLOSED** — non-idempotent routes go `failed`; crash window is `uncertain`. Comments and types state at-least-once / uncertain. No exactly-once claim.

---

## Bounded 05A / 05B regression pass

| Item | Classification | Notes |
|---|---|---|
| New free-entitlement path | **CLOSED** | No new grant without payment/trial/grace. Partial refund preserves remainder **by documented policy**. |
| Valid payment lost | **CLOSED** | Wrong money throws (rejected, retryable via provider). Unmapped financials persist `reconciliation_required`. Checkout crash-replay converges. |
| Refund incorrectly revokes unrelated tenant | **CLOSED** | Mapping + `assertProviderBinding`; ambiguous → reconciliation, never guessed. Commercial drain uses `sub.orgId`. |
| Invoice business-effect key collides across org/provider/environment | **CLOSED** | Unique `(provider_name, environment, billing_identity, effect_type)`. Org is not in the key; Stripe/PayPal identities are globally unique per environment. |
| Checkout transaction deadlock / long lock | **CANNOT VALIDATE** | Claim is a single `UPDATE`; no multi-row checkout transaction. No lock-contention test. |
| Billing state stuck in `applying` forever | **CLOSED** | Lease expiry allows re-claim; webhook retry / reconcile. Residual: no retry → stays `applying` (not entitled). |
| Cancellation retry loops indefinitely | **CLOSED** as a tight loop | Backoff to 1 h; state remains visible. Unbounded calendar time is the design. |
| Fencing blocks a legitimate current worker | **CLOSED** | Current owner+version matches; PG fencing tests pass. |
| Quota reservation leaks permanently | **PARTIALLY CLOSED** | `error`/`destroyed`/`retention` release. Stuck `cancelling` (lifecycle 9) holds quota. |
| Quota race still exists under two PG connections | **CLOSED** | PG two-instance quota=1 test passed. |
| Custom DNS pinning disables TLS certificate verification | **CLOSED** | Not present. Pinning path unwired by callers. |
| DNS pinning breaks normal HTTPS redirects | **CANNOT VALIDATE** | No real-TLS follow test; production callers do not follow. |
| Gateway secret validation makes test/dev impossible without explicit configuration | **CLOSED** | Tests inject a strong deterministic key. No `NODE_ENV` relaxation. |
| Replay cache creates cross-instance inconsistency | **CLOSED** | Production does not use `seenJti`. Enabling a process-local Set would split-brain. |
| Runtime sanitizer leaks secrets or destroys ordinary identifiers | **CLOSED** for UUIDs / short ids | Denylist residuals remain. |
| Distributed SSE count leaks on crash | **CLOSED** | Lease TTL + sweep. PG test reclaims. |
| Rate limiter permanently locks account | **CLOSED** | Account lock 15 min; IP 5 min. Window reset. |
| Target-org audit exposes another tenant’s data | **CLOSED** | `org_id` is the affected tenant or NULL. `after` is the action payload, redacted. |
| Notification outbox loses successful sends or endlessly duplicates | **CLOSED** | `sent` is durable; `uncertain` is visible; retries bounded and idempotent-only. |

No previously closed Repair 01–04 control (raw-body webhook verify, org RBAC, PAT intersection, commercial gate, CSRF/CORS/session, secret hashing) was observed to regress in this pass.

---

## Closure count

Classifications below count the numbered residual paths (billing 24 + distributed/SSE/lifecycle 16 + gateway/SSRF/sanitization 11 + admin/notification/abuse 11 = **62**). Regression-pass rows are separate.

| Classification | Count |
|---|---|
| CLOSED | 52 |
| PARTIALLY CLOSED | 6 |
| STILL EXPLOITABLE | 1 |
| REGRESSED | 0 |
| CANNOT VALIDATE (path-level) | 3 (TLS handshake of unused pin path; checkout deadlock; HTTPS-redirect pin) plus live-provider payload variants called out on several CLOSED billing paths |

**PARTIALLY CLOSED (6)**

1. Full refund after a prior partial on the **same charge** (billing path 4)  
2. Duplicate cancel from `error` can re-enter `cancelling` with no op (lifecycle 9)  
3. Weak `ComputerGateway` constructor-injected secret bypasses strength policy (gateway 2)  
4. Redirect re-validate without pin on `fetchImpl` callers (gateway 7)  
5. Computer/browser fail-closed: HTTP 501 yes; library navigate without egress no (gateway 8)  
6. Quota held by stuck `cancelling` (regression: quota leak)

**STILL EXPLOITABLE (1)**

1. DNS-rebinding TOCTOU on `safeOutboundFetch` when `fetchImpl` is passed — the only production-shaped callers (channel outbound, integration webhook) always pass it. **High.** Not currently mounted on `composeControlPlane`.

**REGRESSED:** none.

---

## Any Critical still open

**None.**

The SSRF pinning bypass is **High**, not Critical, because: (a) the current control-plane composition does not mount channel/integration gateways; (b) default allowlist is HTTPS `:443` only, which blocks classic IMDS `:80`. It becomes Critical the moment those services are wired to tenant-controlled URLs without pinning.

---

## Any High still open

1. **DNS rebinding SSRF** on `safeOutboundFetch` + `fetchImpl` (gateway path 5). 05B claimed this closed; the helper’s default path is closed, the callers are not. First production wiring of channel/integration without removing `fetchImpl` (or teaching `fetchImpl` to use the pinned lookup) re-opens private-network HTTPS.

---

## Medium still open

1. Incremental Stripe refunds on one charge do not re-evaluate full-refund suspension.  
2. Cancel retry from `error` can strand the order in `cancelling` (quota held).  
3. `ComputerGateway` option secret is not strength-checked (dormant: gateway not composed).  
4. Computer `navigate` is not fail-closed when `egress` is omitted (dormant: 501 `not_configured`).

---

## Regressions

**None observed** against Repairs 01–04 or against the 05A billing state machine.

05B **over-claimed** SSRF closure. That is an incomplete repair, not a regression of a previously working production pin (the pin was never on the caller path).

---

## Cannot-validate items

Mark **CANNOT VALIDATE — LIVE SANDBOX REQUIRED** (no live provider credentials in this repo):

- Real Stripe Charge / Dispute / Invoice object variants (expanded objects, missing PI, tax/proration vs period price).  
- Real Stripe event.created vs financial-object time for late sibling events after a fast refund.  
- Real PayPal webhook verification (`verify-webhook-signature`) and resource shapes for SALE / SUSPENDED / RE-ACTIVATED / PAYMENT.FAILED / REFUNDED.  
- Real PayPal `GET /v1/billing/subscriptions/:id` as the RE-ACTIVATED payment proof.

Also cannot validate from this pass (no safe fixture):

- Checkout lock contention / deadlock under load.  
- Real TLS certificate validation with IP pinning (`servername` vs pinned address).  
- Whether pinning would break legitimate HTTPS redirects (callers do not follow).

---

## Whether live Stripe / PayPal sandbox validation is still required

**Yes.** Adapters and service guards are fixture-complete for the official object relationships 05A modeled. They have not been driven with signed live sandbox events. Do not treat this revalidation as a substitute for a sandbox run of: paid checkout → invoice siblings → charge.refunded (single and incremental) → dispute open/won/lost → PayPal SALE / SUSPENDED / RE-ACTIVATED / PAYMENT.FAILED.

---

## Whether a final full independent repository audit is warranted

**Yes, after the High SSRF caller-path is closed (or explicitly scoped out of the release).**

Warranted because:

- 05B’s written closure of DNS pinning does not match the caller code. A full audit should re-check other “production callers pass nothing” / “fail-closed” claims.  
- Channel, integration, and computer surfaces are present as packages but not composed; a release-gate audit must state which surfaces are in-scope.  
- This pass was **targeted**. It did not re-audit RBAC, PAT, node enrollment, CSRF, or secret storage except where a residual path touched them.

Not warranted as a blocking *re-scan of the same 62 paths* once the High item is repaired and the Medium residuals are accepted or fixed.

---

## Whether current code may proceed to final production release-gate validation

**No — not until the High SSRF caller-path is dispositioned.**

05A billing/lifecycle controls traced here are in good shape (one Medium incremental-refund residual). 05B fencing, quota, SSE, rate-limit, audit, and sanitizer controls traced here hold under real PostgreSQL.

Release-gate may proceed only after one of:

1. Channel/integration `safeOutboundFetch` calls drop `fetchImpl` (or pass a fetch that uses the pinned lookup), **and** a test proves `performPinnedRequest` on that path; or  
2. An explicit release decision that channel-gateway and integration-gateway are **out of this production cut**, remain uncomposed, and cannot be enabled without a follow-up repair.

Even then, live Stripe/PayPal sandbox validation remains required before calling payments production-ready.

Stop. No code changes beyond this report.
