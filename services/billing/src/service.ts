/**
 * Billing service (Prompt 08, Security Repair 05A): the commercial
 * authority for subscription state. Core rule: a browser redirect never
 * grants entitlements — only verified provider webhooks/reconciliation
 * activate paid state.
 *
 * Security Repair 05A invariants enforced here:
 *  - A: refunds/disputes bind through durable TYPED provider-object
 *       mappings (charge/pi/invoice/sub/checkout); ambiguity fails closed
 *       as reconciliation_required — never guessed from id prefixes.
 *  - B: one provider invoice/sale creates exactly one period-extension
 *       business effect (provider_billing_effects), independent of webhook
 *       event dedupe.
 *  - C/D: Stripe/PayPal lifecycle states are handled intentionally;
 *       provider plan changes never silently remap Mox plan authority.
 *  - E: checkout application is a durable state machine
 *       (created → applying → completed) whose sub-steps are idempotent,
 *       so a crash at any line converges on replay to exactly one
 *       subscription/item/transition.
 *  - F: ordering outcomes are persisted (applied/duplicate/stale_ignored/
 *       reconciliation_required/rejected); financial identity + state
 *       machine — not wall-clock alone — drive monotonicity.
 *  - G: webhook abuse controls live at the HTTP edge; rejected junk is
 *       short-TTL, applied financial history is retained.
 *  - H: cancellation progress is durable (cancel_requested /
 *       provider_cancel_pending / canceled / reconciliation_required) with
 *       idempotent retries and visible reconciliation conditions.
 *  - I: suspension reason/source is tracked; generic admin reactivation of
 *       refund/dispute/fraud/compliance suspensions requires explicit
 *       financial reconciliation.
 */

import { convert, type Money } from "@mox/money";
import type { EntitlementKey, EntitlementService } from "@mox/entitlements";
import {
  BillingProvider,
  digestPayload,
  supportsReconciliation,
  UnconfiguredBillingProvider,
  WebhookVerificationError,
  type ProviderCheckoutResult,
  type ProviderEvent,
} from "./provider.js";
import { normalizeCurrency } from "./providers/shared.js";
import { InMemoryBillingStore, newId, type BillingStore } from "./store.js";
import type {
  AddonDefinition,
  BillingCustomer,
  CheckoutSession,
  Invoice,
  PriceBook,
  PriceVersion,
  PricingRegion,
  Product,
  PlanVersion,
  Subscription,
  SubscriptionCancellation,
  SubscriptionItem,
  SubscriptionState,
  SubscriptionTransition,
  WebhookRecord,
  BusinessEffectOutcome,
  BusinessEffectType,
} from "./types.js";

export class BillingError extends Error {}
export class InvalidTransitionError extends BillingError {}
export class PriceUnavailableError extends BillingError {}
export class NotFoundError extends BillingError {}
export class CommercialAccessError extends BillingError {}

/** Applies transition-driven state fields to a subscription object. */
function applyTransitionStateFields(
  sub: Subscription,
  toState: SubscriptionState,
  options: { now?: string; suspensionSource?: string; suspensionReason?: string },
  nowIso = options.now ?? new Date().toISOString(),
): void {
  if (toState === "suspended") {
    sub.suspendedAt = nowIso;
    sub.suspensionReason = options.suspensionReason ?? sub.suspensionReason;
    sub.suspensionSource = options.suspensionSource ?? sub.suspensionSource ?? "provider";
  }
  if (toState === "canceled") sub.canceledAt = nowIso;
  if (toState === "deleted") sub.deletedAt = nowIso;
  if (toState === "active") {
    sub.graceEndsAt = undefined;
    sub.suspendedAt = undefined;
    sub.suspensionReason = undefined;
    sub.suspensionSource = undefined;
  }
}

/** Explicit, auditable subscription state machine. */
const ALLOWED_TRANSITIONS: Record<SubscriptionState, SubscriptionState[]> = {
  trial: ["active", "canceled", "suspended"],
  active: ["past_due", "canceled", "suspended"],
  past_due: ["active", "grace_period", "canceled", "suspended"],
  grace_period: ["active", "suspended", "canceled"],
  suspended: ["active", "canceled"],
  // Provider uncancel reconciliation (Security Repair 05A §C) is the ONLY
  // caller allowed to move canceled → active; everything else goes through
  // retention.
  canceled: ["retention", "active"],
  retention: ["deleted", "retention"],
  deleted: [],
};

export interface BillingServiceOptions {
  periodDays?: number;
  graceDays?: number;
  retentionDays?: number;
  /** Claim lease length for checkout/webhook application (test seam). */
  claimLeaseMs?: number;
}

interface ResolvedPrice {
  priceVersionId?: string;
  amount: Money;
  mode: "fixed" | "fx_derived";
}

export interface CommercialAccessDecision {
  entitled: boolean;
  reason?: string;
  subscription?: Subscription;
  planVersionId?: string;
}

export interface CommercialAuthorizationDecision extends CommercialAccessDecision {
  entitlementKey?: EntitlementKey;
  value?: boolean | number | string;
}

/** Persisted distinct outcomes (Security Repair 05A §F). */
type EventOutcome = Extract<
  BusinessEffectOutcome,
  "applied" | "duplicate" | "stale_ignored" | "reconciliation_required"
>;

interface ApplyEventResult {
  outcome: EventOutcome;
  orgId?: string;
  providerRef?: string;
}

interface WebhookApplyResult {
  applied: boolean;
  duplicate?: boolean;
  staleIgnored?: boolean;
  reconciliationRequired?: boolean;
  rejected?: boolean;
  reason?: string;
  eventType?: string;
  orgId?: string;
  providerRef?: string;
}

export class BillingService {
  readonly store: BillingStore;
  private readonly providers = new Map<string, BillingProvider>();
  private readonly periodDays: number;
  private readonly graceDays: number;
  private readonly retentionDays: number;
  private readonly workerId = `billing-${newId()}`;
  private readonly claimLeaseMs: number;

  constructor(
    store: BillingStore = new InMemoryBillingStore(),
    options: BillingServiceOptions = {},
  ) {
    this.store = store;
    this.periodDays = options.periodDays ?? 30;
    this.graceDays = options.graceDays ?? 7;
    this.retentionDays = options.retentionDays ?? 30;
    this.claimLeaseMs = options.claimLeaseMs ?? 60_000;
  }

  // ---- Providers -----------------------------------------------------------

  registerProvider(provider: BillingProvider): void {
    this.providers.set(provider.name, provider);
  }

  /** Registers an explicit not-configured blocker for a gateway name. */
  registerBlockedProvider(name: string, blocker: string): void {
    this.providers.set(name, new UnconfiguredBillingProvider(blocker));
  }

  provider(name: string): BillingProvider {
    const provider = this.providers.get(name);
    if (!provider) throw new BillingError(`no billing provider registered under "${name}"`);
    return provider;
  }

  hasProvider(name: string): boolean {
    return this.providers.has(name);
  }

  requireConfiguredProvider(name: string): BillingProvider {
    const provider = this.provider(name);
    if (!provider.configured) {
      throw new BillingError(`billing provider "${name}" is not configured: ${provider.blocker}`);
    }
    return provider;
  }

  // ---- Catalog -------------------------------------------------------------

  async createProduct(input: { code: string; tier: Product["tier"]; displayName: string }): Promise<Product> {
    const existing = await this.store.getProductByCode(input.code);
    if (existing) return existing;
    return this.store.createProduct({ id: newId(), ...input });
  }

  /**
   * Create a plan version. Draft versions may be edited via
   * updatePlanEntitlements; activation freezes the version forever.
   */
  async createPlanVersion(productId: string, versionNumber: number): Promise<PlanVersion> {
    const product = await this.store.getProduct(productId);
    if (!product) throw new NotFoundError(`product ${productId}`);
    return this.store.createPlanVersion({
      id: newId(),
      productId,
      version: versionNumber,
      status: "draft",
      createdAt: new Date().toISOString(),
    });
  }

  async activatePlanVersion(planVersionId: string, entitlements?: EntitlementService): Promise<PlanVersion> {
    const version = await this.requirePlanVersion(planVersionId);
    if (version.status === "retired") throw new BillingError("cannot activate a retired plan version");
    const activated: PlanVersion = {
      ...version,
      status: "active",
      activatedAt: version.activatedAt ?? new Date().toISOString(),
    };
    await this.store.updatePlanVersion(activated);
    if (entitlements) await this.syncPlanEntitlements(activated.id, entitlements);
    return activated;
  }

  async retirePlanVersion(planVersionId: string): Promise<PlanVersion> {
    const version = await this.requirePlanVersion(planVersionId);
    const retired = { ...version, status: "retired" as const, retiredAt: new Date().toISOString() };
    await this.store.updatePlanVersion(retired);
    return retired;
  }

  /** Push plan-entitlement values into the authoritative entitlement service. */
  async syncPlanEntitlements(planVersionId: string, entitlements: EntitlementService): Promise<void> {
    const values = await this.getPlanEntitlementValues(planVersionId);
    await entitlements.setPlanValues(planVersionId, values);
  }

  /** Plan entitlement values live in the durable store (Prompt 00 §D4). */
  async getPlanEntitlementValues(planVersionId: string): Promise<Record<string, boolean | number | string>> {
    return this.store.getPlanEntitlementValues(planVersionId);
  }

  async setPlanEntitlementValues(
    planVersionId: string,
    values: Record<string, boolean | number | string>,
    entitlements?: EntitlementService,
  ): Promise<void> {
    const version = await this.requirePlanVersion(planVersionId);
    if (version.status !== "draft") {
      throw new BillingError("plan version is immutable once active; create a new version");
    }
    await this.store.setPlanEntitlementValues(planVersionId, { ...values });
    if (entitlements) await entitlements.setPlanValues(planVersionId, values);
  }

  async definePricingRegion(region: Omit<PricingRegion, never> & { code: string }): Promise<PricingRegion> {
    return this.store.definePricingRegion(region as PricingRegion);
  }

  async upsertPriceBook(book: Omit<PriceBook, "id"> & { id?: string }): Promise<PriceBook> {
    const existing = await this.store.findPriceBook(book.productId, book.pricingRegionCode);
    const full: PriceBook = { ...book, id: book.id ?? existing?.id ?? newId() } as PriceBook;
    return this.store.upsertPriceBook(full);
  }

  async addFixedPriceVersion(priceBookId: string, amountMinor: bigint | number, currency: string, effectiveFrom?: string): Promise<PriceVersion> {
    await this.requirePriceBook(priceBookId);
    const versions = await this.store.listPriceVersions(priceBookId);
    return this.store.createPriceVersion({
      id: newId(),
      priceBookId,
      version: versions.length + 1,
      amountMinor,
      currency: normalizeCurrency(currency) ?? currency,
      effectiveFrom: effectiveFrom ?? new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });
  }

  /**
   * Pin a derived FX price into an immutable snapshot version so that
   * subscriptions reference stable history.
   */
  async pinDerivedPrice(priceBookId: string): Promise<PriceVersion> {
    const book = await this.requirePriceBook(priceBookId);
    if (book.mode !== "fx_derived" || !book.baseCurrency || book.fxRate === undefined || book.baseAmountMinor === undefined) {
      throw new BillingError("price book is not fx_derived or lacks base amount/rate");
    }
    const region = await this.requirePricingRegion(book.pricingRegionCode);
    const derived = convert(
      { currency: book.baseCurrency, amountMinor: BigInt(book.baseAmountMinor) },
      region.chargeCurrency,
      book.fxRate,
    );
    const versions = await this.store.listPriceVersions(priceBookId);
    return this.store.createPriceVersion({
      id: newId(),
      priceBookId,
      version: versions.length + 1,
      amountMinor: derived.amountMinor,
      currency: derived.currency,
      effectiveFrom: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });
  }

  async defineAddon(addon: AddonDefinition): Promise<AddonDefinition> {
    return this.store.defineAddon(addon);
  }

  /**
   * Resolve the applicable price for a product in a pricing region.
   * fixed → newest effective version; fx_derived → live derivation;
   * disabled/missing → PriceUnavailableError.
   */
  async resolvePrice(productId: string, pricingRegionCode: string, now?: string): Promise<ResolvedPrice> {
    const at = now ?? new Date().toISOString();
    const book = await this.store.findPriceBook(productId, pricingRegionCode);
    if (!book || book.mode === "disabled") {
      throw new PriceUnavailableError(`price unavailable for region ${pricingRegionCode}`);
    }
    if (book.mode === "fixed") {
      const versions = await this.store.listPriceVersions(book.id);
      const applicable = [...versions].reverse().find((v) => v.effectiveFrom <= at);
      if (!applicable) throw new PriceUnavailableError("no effective price version");
      return {
        priceVersionId: applicable.id,
        amount: { currency: applicable.currency, amountMinor: BigInt(applicable.amountMinor) },
        mode: "fixed",
      };
    }
    // fx_derived: derive live from the base amount and stored rate.
    const region = await this.requirePricingRegion(pricingRegionCode);
    if (!book.baseCurrency || book.fxRate === undefined || book.baseAmountMinor === undefined) {
      throw new PriceUnavailableError("fx_derived price book lacks base configuration");
    }
    const derived = convert(
      { currency: book.baseCurrency, amountMinor: BigInt(book.baseAmountMinor) },
      region.chargeCurrency,
      book.fxRate,
    );
    return { amount: derived, mode: "fx_derived" };
  }

  // ---- Checkout / webhook flow ----------------------------------------------

  async ensureBillingCustomer(orgId: string, providerName: string, billingRegion = "GLOBAL"): Promise<BillingCustomer> {
    const existing = await this.store.getBillingCustomer(orgId, providerName);
    if (existing) return existing;
    const customer: BillingCustomer = {
      orgId,
      providerName,
      providerCustomerId: `${providerName}:cus_${orgId.slice(0, 8)}`,
      billingRegion,
      createdAt: new Date().toISOString(),
    };
    return this.store.upsertBillingCustomer(customer);
  }

  /**
   * Creates a checkout session. IMPORTANT: the returned redirect URL is
   * navigation only; it grants nothing until a verified webhook arrives.
   */
  async createCheckout(input: {
    orgId: string;
    productId: string;
    planVersionId: string;
    pricingRegionCode: string;
    successUrl: string;
    cancelUrl: string;
    providerName: string;
  }): Promise<{ session: CheckoutSession; price: ResolvedPrice }> {
    const provider = this.requireConfiguredProvider(input.providerName);
    const price = await this.resolvePrice(input.productId, input.pricingRegionCode);

    let priceVersionId: string;
    let amount: Money;
    if (price.mode === "fx_derived") {
      // Pin the live FX quote into an immutable snapshot for this checkout.
      const book = await this.store.findPriceBook(input.productId, input.pricingRegionCode);
      if (!book) throw new PriceUnavailableError("price book vanished");
      const versions = await this.store.listPriceVersions(book.id);
      const pinned = await this.store.createPriceVersion({
        id: newId(),
        priceBookId: book.id,
        version: versions.length + 1,
        amountMinor: price.amount.amountMinor,
        currency: price.amount.currency,
        effectiveFrom: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      });
      priceVersionId = pinned.id;
      amount = price.amount;
    } else {
      priceVersionId = price.priceVersionId!;
      amount = price.amount;
    }

    const session: CheckoutSession = {
      id: newId(),
      orgId: input.orgId,
      planVersionId: input.planVersionId,
      priceVersionId,
      state: "created",
      providerName: input.providerName,
      createdAt: new Date().toISOString(),
    };

    const result: ProviderCheckoutResult = await provider.createCheckout({
      orgId: input.orgId,
      checkoutSessionId: session.id,
      description: `Mox subscription (${input.productId})`,
      amountMinor: amount.amountMinor,
      currency: amount.currency,
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
    });

    // The provider-side reference is persisted with the session (§D2) so
    // webhook application never depends on process-local state.
    session.providerRef = result.providerRef;
    session.redirectUrl = result.redirectUrl;
    await this.store.createCheckoutSession(session);
    return { session, price: { priceVersionId, amount, mode: price?.mode ?? "fixed" } };
  }

  /**
   * Verify + apply one inbound provider webhook. Idempotent by external
   * event id AND by business effect; distinct outcomes are persisted
   * (applied / duplicate / stale_ignored / reconciliation_required /
   * rejected) instead of being conflated with "applied".
   */
  async handleProviderWebhook(
    providerName: string,
    headers: Record<string, string>,
    rawBody: string,
  ): Promise<WebhookApplyResult> {
    const provider = this.providers.get(providerName);
    if (!provider) {
      const nowIso = new Date().toISOString();
      await this.store.recordWebhook({
        id: newId(),
        providerName,
        externalEventId: `rejected:unknown:${digestPayload(rawBody).slice(0, 32)}`,
        type: "unverified",
        payloadDigest: digestPayload(rawBody),
        status: "rejected",
        receivedAt: nowIso,
        rejectionReason: "webhook rejected",
      });
      return { applied: false, rejected: true, reason: "webhook rejected" };
    }
    let event: ProviderEvent;
    try {
      event = await provider.verifyWebhook(headers, rawBody);
    } catch (error) {
      const reason = error instanceof WebhookVerificationError ? error.message : String(error);
      // Keep an auditable rejection record without trusting the payload.
      // Identical invalid bodies dedupe on the synthetic digest key, and
      // rejected rows are short-TTL (finding G).
      await this.store.recordWebhook({
        id: newId(),
        providerName,
        externalEventId: `rejected:${digestPayload(rawBody).slice(0, 32)}`,
        type: "unverified",
        payloadDigest: digestPayload(rawBody),
        status: "rejected",
        receivedAt: new Date().toISOString(),
        rejectionReason: "webhook signature rejected",
      });
      void reason;
      return { applied: false, rejected: true, reason: "webhook signature rejected" };
    }

    const nowIso = new Date().toISOString();
    const leaseUntil = new Date(Date.parse(nowIso) + this.claimLeaseMs).toISOString();
    const claim = await this.store.claimWebhookApplication({
      id: newId(),
      providerName,
      externalEventId: event.externalEventId,
      type: event.type,
      sequence: event.sequence,
      payloadDigest: digestPayload(rawBody),
      status: "processing",
      receivedAt: nowIso,
      processingOwner: this.workerId,
      processingExpiresAt: leaseUntil,
    }, this.workerId, leaseUntil);
    if (claim === "applied") {
      return { applied: false, duplicate: true };
    }
    if (claim === "busy") {
      return { applied: false, duplicate: true, reason: "event is already being applied" };
    }
    let record: WebhookRecord = (await this.store.getWebhook(providerName, event.externalEventId))!;

    try {
      const result = await this.applyProviderEvent(event.type, event, {
        providerName,
        environment: provider.environment,
      });
      // Normalized durable ledger (Prompt 01 §Durable): exactly-once per
      // (provider, externalEventId); the row's state carries the outcome.
      await this.store.recordProviderPayment({
        id: newId(),
        providerName,
        environment: provider.environment,
        externalEventId: event.externalEventId,
        eventType: event.type,
        orgId: result.orgId,
        providerSubscriptionRef: event.subscriptionRef ?? undefined,
        checkoutSessionRef:
          event.type === "checkout.completed" || event.type === "checkout.failed"
            ? event.subjectRef
            : undefined,
        providerTransactionRef: event.transactionRef,
        invoiceRef: event.invoiceRef,
        providerPaymentIntentRef: event.paymentIntentRef,
        providerChargeRef: event.chargeRef,
        providerCustomerRef: event.customerRef,
        billingIdentity: this.billingIdentityFor(event),
        state: result.outcome,
        currency: event.currency,
        amountMinor: event.amountMinor,
        payloadDigest: digestPayload(rawBody),
        occurredAt: event.occurredAt,
        receivedAt: new Date().toISOString(),
      });
      record.status = result.outcome === "applied" ? "applied" : result.outcome;
      record.appliedAt = result.outcome === "applied" ? new Date().toISOString() : undefined;
      record.processingOwner = undefined;
      record.processingExpiresAt = undefined;
      await this.store.updateWebhook(record);
      return {
        applied: result.outcome === "applied",
        duplicate: result.outcome === "duplicate",
        staleIgnored: result.outcome === "stale_ignored",
        reconciliationRequired: result.outcome === "reconciliation_required",
        eventType: event.type,
        orgId: result.orgId,
        providerRef: result.providerRef ?? event.subscriptionRef ?? event.subjectRef,
      };
    } catch (error) {
      record.status = "rejected";
      record.rejectionReason = error instanceof Error ? error.message : String(error);
      record.processingOwner = undefined;
      record.processingExpiresAt = undefined;
      await this.store.updateWebhook(record);
      return { applied: false, rejected: true, reason: record.rejectionReason };
    }
  }

  /**
   * Reconciliation fallback (Prompt 01): when a webhook was missed, verify
   * the checkout directly with the provider and apply the SAME guarded
   * completion path — dedupe guarantees it repairs state exactly once.
   */
  async reconcileCheckoutSession(input: {
    sessionId?: string;
    orgId?: string;
    providerName?: string;
    providerRef?: string;
  }): Promise<{ applied: boolean; reason?: string }> {
    let session: CheckoutSession | undefined;
    if (input.sessionId) session = await this.store.getCheckoutSession(input.sessionId);
    if (session && input.orgId && session.orgId !== input.orgId) {
      return { applied: false, reason: "no pending checkout session" };
    }
    if (!session && input.orgId) {
      const sessions = await this.store.findCheckoutSessionsByOrg(input.orgId);
      session = sessions
        .filter((s) => s.providerName === input.providerName || !input.providerName)
        .filter((s) => s.state !== "completed")
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    }
    if (!session?.providerRef) return { applied: false, reason: "no pending checkout session" };

    const provider = this.provider(session.providerName);
    if (!supportsReconciliation(provider)) {
      return { applied: false, reason: "provider does not support reconciliation" };
    }
    const verification = await provider.verifyCheckout({ providerRef: session.providerRef });
    if (!verification.paid) return { applied: false, reason: "provider reports unpaid" };

    // Amount/currency validation flows through the same completion path.
    const outcome = await this.applyCheckoutCompleted(session.providerRef, { checkoutSessionId: session.id }, {
      occurredAt: verification.occurredAt,
      amountMinor: verification.amountMinor,
      currency: verification.currency,
      environment: provider.environment,
      providerName: session.providerName,
      transactionRef: verification.transactionRef,
    });
    if (outcome.outcome === "reconciliation_required") {
      return { applied: false, reason: "checkout application requires reconciliation" };
    }
    await this.store.recordProviderPayment({
      id: newId(),
      providerName: session.providerName,
      environment: provider.environment,
      externalEventId: `reconciled:${session.providerRef}`,
      eventType: "checkout.completed",
      checkoutSessionRef: session.providerRef,
      state: "reconciled",
      currency: verification.currency,
      amountMinor: verification.amountMinor,
      providerTransactionRef: verification.transactionRef,
      billingIdentity: this.billingIdentityFor({
        externalEventId: `reconciled:${session.providerRef}`,
        type: "checkout.completed",
        subjectRef: session.providerRef,
        payload: undefined,
      }),
      payloadDigest: digestPayload(`${session.providerRef}:${verification.amountMinor ?? ""}`),
      occurredAt: verification.occurredAt,
      receivedAt: new Date().toISOString(),
      reconciledAt: new Date().toISOString(),
    });
    return { applied: outcome.outcome !== "duplicate", reason: outcome.outcome === "duplicate" ? "already applied" : undefined };
  }

  // ---- Provider event application ---------------------------------------------

  private async applyProviderEvent(
    type: ProviderEvent["type"],
    event: ProviderEvent,
    context: { providerName: string; environment: string },
  ): Promise<ApplyEventResult> {
    switch (type) {
      case "checkout.completed":
        return this.applyCheckoutCompleted(event.subjectRef, {}, {
          subscriptionRef: event.subscriptionRef,
          occurredAt: event.occurredAt,
          amountMinor: event.amountMinor,
          currency: event.currency,
          environment: context.environment,
          providerName: context.providerName,
          transactionRef: event.transactionRef,
          customerRef: event.customerRef,
          paymentIntentRef: event.paymentIntentRef,
        });
      case "checkout.failed":
        return this.applyCheckoutFailed(event, context);
      case "payment.succeeded":
        return this.applyPaymentSucceeded(event, context);
      case "payment.failed":
        return this.applyPaymentFailed(event, context);
      case "subscription.updated":
        return this.applySubscriptionUpdated(event, context);
      case "subscription.suspended":
        return this.applySubscriptionSuspended(event, context);
      case "subscription.reactivated":
        return this.applySubscriptionReactivated(event, context);
      case "subscription.canceled":
        return this.applyProviderCanceled(event, context);
      case "payment.refunded":
        return this.applyRefund(event, context);
      case "dispute.opened":
        return this.applyDisputeOpened(event, context);
      case "dispute.resolved":
        return this.applyDisputeResolved(event, context);
      default:
        throw new BillingError(`unsupported provider event type ${type}`);
    }
  }

  // ---- Binding (finding A): typed provider-object resolution ---------------------

  /**
   * Resolve the single Mox subscription an event refers to. Direct stored
   * provider_ref matches win; then typed provider-object mappings; then
   * legacy exact ref matches. Multiple DISTINCT subscriptions = ambiguous;
   * nothing = unresolved. Never inferred from ID prefixes.
   */
  private async resolveSubscriptionForEvent(
    event: ProviderEvent,
    providerName: string,
    environment: string,
  ): Promise<{ sub?: Subscription; ambiguous: boolean }> {
    // 1. Direct canonical subscription ref.
    if (event.subscriptionRef) {
      const sub = await this.store.findSubscriptionByProviderRef(event.subscriptionRef);
      if (sub) return { sub, ambiguous: false };
    }
    // 2. Durable typed mappings.
    const mappings = await this.store.findProviderObjectMappings(providerName, environment, {
      checkoutSessionRef:
        event.type === "checkout.completed" || event.type === "checkout.failed"
          ? event.subjectRef
          : undefined,
      providerSubscriptionRef: event.subscriptionRef,
      providerInvoiceRef: event.invoiceRef,
      providerPaymentRef: event.transactionRef,
      providerPaymentIntentRef: event.paymentIntentRef,
      providerChargeRef: event.chargeRef,
    });
    const subs = new Map<string, Subscription>();
    for (const mapping of mappings) {
      if (mapping.resolutionState === "reconciliation_required") continue;
      if (mapping.subscriptionId) {
        const sub = await this.store.getSubscription(mapping.subscriptionId);
        if (sub) subs.set(sub.id, sub);
      } else if (mapping.orgId) {
        const sub = await this.store.getActiveSubscriptionForOrg(mapping.orgId);
        if (sub) subs.set(sub.id, sub);
      }
    }
    if (subs.size === 1) return { sub: [...subs.values()][0], ambiguous: false };
    if (subs.size > 1) return { ambiguous: true };
    // 3. Legacy exact stored-ref matches (exact equality, never prefixes).
    for (const ref of [event.subjectRef, event.transactionRef, event.invoiceRef]) {
      if (!ref) continue;
      const sub = await this.store.findSubscriptionByProviderRef(ref);
      if (sub) return { sub, ambiguous: false };
    }
    return { ambiguous: false };
  }

  private async recordObjectMapping(
    sub: Subscription,
    event: ProviderEvent,
    providerName: string,
    environment: string,
  ): Promise<void> {
    await this.store.upsertProviderObjectMapping({
      id: newId(),
      providerName,
      environment,
      orgId: sub.orgId,
      subscriptionId: sub.id,
      providerCustomerRef: event.customerRef,
      checkoutSessionRef:
        event.type === "checkout.completed" || event.type === "checkout.failed"
          ? event.subjectRef
          : undefined,
      providerSubscriptionRef: event.subscriptionRef,
      providerInvoiceRef: event.invoiceRef,
      providerPaymentRef: event.transactionRef,
      providerPaymentIntentRef: event.paymentIntentRef,
      providerChargeRef: event.chargeRef,
      resolutionState: "resolved",
    });
  }

  /**
   * Durable provider billing identity (finding B): the immutable provider
   * object that one business effect belongs to — an invoice, a sale, a
   * charge, a checkout session. Never the webhook event id alone.
   */
  private billingIdentityFor(event: ProviderEvent): string | undefined {
    switch (event.type) {
      case "checkout.completed":
      case "checkout.failed":
        return event.subjectRef ? `checkout:${event.subjectRef}` : undefined;
      case "payment.succeeded":
        if (event.invoiceRef) return `invoice:${event.invoiceRef}`;
        if (event.transactionRef) return `sale:${event.transactionRef}`;
        return undefined;
      case "payment.failed":
        if (event.invoiceRef) return `invoice:${event.invoiceRef}`;
        if (event.transactionRef) return `sale:${event.transactionRef}`;
        if (event.subscriptionRef) return `subscription:${event.subscriptionRef}`;
        return event.subjectRef ? `subject:${event.subjectRef}` : undefined;
      case "payment.refunded":
        if (event.chargeRef) return `charge:${event.chargeRef}`;
        if (event.transactionRef) return `sale:${event.transactionRef}`;
        if (event.invoiceRef) return `invoice:${event.invoiceRef}`;
        return event.subjectRef ? `refund:${event.subjectRef}` : undefined;
      case "dispute.opened":
        if (event.disputeRef) return `dispute:${event.disputeRef}`;
        if (event.chargeRef) return `charge:${event.chargeRef}`;
        if (event.transactionRef) return `sale:${event.transactionRef}`;
        return event.subjectRef ? `dispute:${event.subjectRef}` : undefined;
      case "dispute.resolved":
        if (event.disputeRef) return `dispute-resolved:${event.disputeRef}`;
        if (event.chargeRef) return `dispute-resolved-charge:${event.chargeRef}`;
        if (event.transactionRef) return `dispute-resolved-sale:${event.transactionRef}`;
        return event.subjectRef ? `dispute-resolved:${event.subjectRef}` : undefined;
      case "subscription.updated":
        return event.subscriptionRef
          ? `sub:${event.subscriptionRef}:status:${event.subscriptionStatus ?? "unknown"}`
          : undefined;
      case "subscription.suspended":
        return `sub:${event.subscriptionRef ?? event.subjectRef}:suspended`;
      case "subscription.reactivated":
        return `sub:${event.subscriptionRef ?? event.subjectRef}:reactivated`;
      case "subscription.canceled":
        return `sub:${event.subscriptionRef ?? event.subjectRef}:canceled`;
      default:
        return undefined;
    }
  }

  private async claimBusinessEffect(
    event: ProviderEvent,
    effectType: BusinessEffectType,
    sub: Subscription | undefined,
    providerName: string,
    environment: string,
  ): Promise<boolean> {
    const identity = this.billingIdentityFor(event);
    if (!identity) return true; // no durable identity → cannot dedupe; caller decides
    return this.store.claimProviderBillingEffect({
      providerName,
      environment,
      billingIdentity: identity,
      effectType,
      subscriptionId: sub?.id,
      externalEventId: event.externalEventId,
    });
  }

  /** Older events must never regress newer state (Prompt 01 §Ordering). */
  private eventIsCurrent(
    sub: Subscription,
    event?: { occurredAt?: string },
    options: { regressive: boolean } = { regressive: true },
  ): boolean {
    if (!event?.occurredAt) return !sub.lastEventAt || !options.regressive;
    if (!sub.lastEventAt) return true;
    return Date.parse(event.occurredAt) >= Date.parse(sub.lastEventAt);
  }

  private touchSubscriptionEvent(
    sub: Subscription,
    event?: { occurredAt?: string; providerName?: string; environment?: string },
  ): void {
    if (event?.occurredAt) sub.lastEventAt = event.occurredAt;
    if (event?.environment) sub.providerEnvironment = event.environment;
    if (event?.providerName) sub.providerName = event.providerName;
  }

  // ---- Checkout completion (finding E): crash-replayable state machine ------------

  /**
   * Applies a verified checkout. Local durable writes run as idempotent
   * sub-steps driven by checkout_sessions.state (created → applying →
   * completed). A crash after ANY sub-step leaves only idempotent or
   * unclaimed writes: the retry re-claims (after lease expiry), re-runs
   * every sub-step and converges to exactly one subscription/item/
   * transition. No provider HTTP call is made here at all.
   */
  private async applyCheckoutCompleted(
    providerCheckoutRef: string,
    payload: { orgId?: string; checkoutSessionId?: string },
    event?: {
      subscriptionRef?: string;
      occurredAt?: string;
      amountMinor?: bigint | number;
      currency?: string;
      environment?: string;
      providerName?: string;
      transactionRef?: string;
      customerRef?: string;
      paymentIntentRef?: string;
    },
  ): Promise<ApplyEventResult> {
    // Authoritative lookup: embedded id first, then the persisted provider
    // reference — never a process-local index (Prompt 00 §D2).
    let session: CheckoutSession | undefined;
    if (payload.checkoutSessionId) {
      session = await this.store.getCheckoutSession(payload.checkoutSessionId);
    }
    if (!session) {
      session = await this.store.findCheckoutSessionByProviderRef(providerCheckoutRef);
    }
    if (!session) {
      return { outcome: "reconciliation_required", providerRef: providerCheckoutRef };
    }

    if (session.state === "completed") {
      // Business-level dedupe — but only when the full local effect is
      // provably durable; otherwise surface reconciliation (finding E).
      const live = await this.store.getActiveSubscriptionForOrg(session.orgId);
      if (live) {
        // Repair any effects that a crash left unclaimed (idempotent).
        await this.ensureCheckoutEffects(session, live, event, providerCheckoutRef);
        return { outcome: "duplicate", orgId: session.orgId };
      }
      const historical = await this.store.findSubscriptionByProviderRef(
        event?.subscriptionRef ?? providerCheckoutRef,
      );
      if (historical) return { outcome: "duplicate", orgId: session.orgId };
      return { outcome: "reconciliation_required", orgId: session.orgId };
    }

    // Validation BEFORE the claim: server-side canonical prices remain
    // authoritative; no write happens for a wrong-amount event.
    const priceVersion = await this.requirePriceVersion(session.priceVersionId);
    if (event?.amountMinor === undefined || !event.currency) {
      throw new BillingError("provider checkout completion missing amount or currency");
    }
    const expected = BigInt(priceVersion.amountMinor);
    if (BigInt(event.amountMinor) !== expected) {
      throw new BillingError(
        `provider amount mismatch: got ${event.amountMinor} ${event.currency ?? ""}, expected ${expected}`,
      );
    }
    if (normalizeCurrency(event.currency) !== normalizeCurrency(priceVersion.currency)) {
      throw new BillingError(`provider currency mismatch: ${event.currency} != ${priceVersion.currency}`);
    }
    if (session.environment && event?.environment && session.environment !== event.environment) {
      throw new BillingError(`provider environment mismatch: ${event.environment} != ${session.environment}`);
    }

    // 1. Claim: created/redirected/applying → applying (durable marker).
    const claimAt = new Date().toISOString();
    const claimedSession = await this.store.claimCheckoutSession(
      session.id,
      this.workerId,
      new Date(Date.parse(claimAt) + this.claimLeaseMs).toISOString(),
      claimAt,
    );
    if (!claimedSession) {
      const fresh = await this.store.getCheckoutSession(session.id);
      if (fresh?.state === "completed") {
        const live = await this.store.getActiveSubscriptionForOrg(session.orgId);
        if (live) {
          await this.ensureCheckoutEffects(session, live, event, providerCheckoutRef);
          return { outcome: "duplicate", orgId: session.orgId };
        }
        return { outcome: "reconciliation_required", orgId: session.orgId };
      }
      // Still `applying` under another worker's lease: the local commercial
      // effect is NOT proven durable yet. Never finalize this event as
      // applied/duplicate — it stays re-processable (finding E/F).
      return { outcome: "reconciliation_required", orgId: session.orgId, providerRef: providerCheckoutRef };
    }
    session = claimedSession;
    const env = event?.environment ?? session.environment;
    const providerName = event?.providerName ?? session.providerName;

    // 2. Customer (idempotent upsert).
    await this.ensureBillingCustomer(session.orgId, session.providerName);

    // 3. Subscription: update the existing live row or create (replay after
    //    a crash-after-create sees the live row and converges to update).
    const now = new Date();
    const periodEnd = new Date(now.getTime() + this.periodDays * 24 * 3600 * 1000);
    let sub: Subscription;
    const existingSub = await this.store.getActiveSubscriptionForOrg(session.orgId);
    if (existingSub) {
      existingSub.planVersionId = session.planVersionId;
      existingSub.priceVersionId = session.priceVersionId;
      existingSub.providerName = providerName;
      existingSub.providerRef = event?.subscriptionRef ?? providerCheckoutRef;
      existingSub.currentPeriodStart = now.toISOString();
      existingSub.currentPeriodEnd = periodEnd.toISOString();
      existingSub.failedRenewals = 0;
      existingSub.providerEnvironment = env ?? existingSub.providerEnvironment;
      this.touchSubscriptionEvent(existingSub, { occurredAt: event?.occurredAt });
      sub = existingSub;
    } else {
      // History-preserving creation (§D1): a canceled prior subscription
      // never blocks resubscribing — a NEW row starts here.
      sub = await this.store.createSubscription({
        id: newId(),
        orgId: session.orgId,
        planVersionId: session.planVersionId,
        priceVersionId: session.priceVersionId,
        state: "trial",
        providerName,
        providerRef: event?.subscriptionRef ?? providerCheckoutRef,
        providerEnvironment: env,
        lastEventAt: event?.occurredAt,
        failedRenewals: 0,
        cancelAtPeriodEnd: false,
        currentPeriodStart: now.toISOString(),
        currentPeriodEnd: periodEnd.toISOString(),
        createdAt: now.toISOString(),
      });
    }

    // 4. Base item (idempotent upsert — unique partial index).
    await this.store.addItem({
      id: newId(),
      subscriptionId: sub.id,
      kind: "base",
      quantity: 1,
      priceVersionId: priceVersion.id,
    });

    // 5. Transition (idempotency key = checkout session). Persist the
    //    subscription fields BEFORE the transition so the transition's fresh
    //    copy never overwrites them with stale state.
    await this.store.updateSubscription(sub);
    if (sub.state !== "active") {
      await this.transition(sub.id, "active", "checkout_completed", {
        idempotencyKey: `checkout:${session.id}`,
      });
    }

    // 6. Business-effect + mapping + final session mutation. All idempotent.
    const syntheticEvent: ProviderEvent = {
      externalEventId: `checkout:${providerCheckoutRef}`,
      type: "checkout.completed",
      subjectRef: providerCheckoutRef,
      subscriptionRef: event?.subscriptionRef,
      transactionRef: event?.transactionRef,
      customerRef: event?.customerRef,
      paymentIntentRef: event?.paymentIntentRef,
      occurredAt: event?.occurredAt,
      payload: undefined,
    };
    await this.claimBusinessEffect(syntheticEvent, "checkout_grant", sub, providerName, env ?? "test");
    await this.ensureCheckoutEffects(session, sub, event, providerCheckoutRef);
    await this.recordObjectMapping(
      sub,
      { ...syntheticEvent, subscriptionRef: event?.subscriptionRef },
      providerName,
      env ?? "test",
    );

    session.state = "completed";
    session.environment = env ?? session.environment;
    session.claimOwner = undefined;
    session.claimExpiresAt = undefined;
    await this.store.updateCheckoutSession(session);

    return { outcome: "applied", orgId: session.orgId, providerRef: sub.providerRef ?? providerCheckoutRef };
  }

  /**
   * When a PAYMENT event completes a checkout (PayPal first sale), the
   * sale's period-extension business effect is consumed AT checkout
   * completion — the grant already set the period, so the effect is claimed
   * without advancing it again. A redelivered sale then dedupes instead of
   * stacking paid time (finding B/D).
   */
  private async ensureCheckoutEffects(
    session: CheckoutSession,
    sub: Subscription,
    event?: { transactionRef?: string; occurredAt?: string },
    providerCheckoutRef?: string,
  ): Promise<void> {
    const providerName = session.providerName;
    const environment = session.environment ?? "test";
    const syntheticCheckout: ProviderEvent = {
      externalEventId: `checkout:${providerCheckoutRef ?? session.providerRef}`,
      type: "checkout.completed",
      subjectRef: providerCheckoutRef ?? session.providerRef ?? "",
      occurredAt: event?.occurredAt,
      payload: undefined,
    };
    await this.claimBusinessEffect(syntheticCheckout, "checkout_grant", sub, providerName, environment);
    if (event?.transactionRef) {
      const sale: ProviderEvent = {
        externalEventId: `checkout-sale:${event.transactionRef}`,
        type: "payment.succeeded",
        subjectRef: session.providerRef ?? "",
        transactionRef: event.transactionRef,
        occurredAt: event.occurredAt,
        payload: undefined,
      };
      await this.claimBusinessEffect(sale, "period_extension", sub, providerName, environment);
    }
  }

  /** async_payment_failed: the checkout never completed — no entitlement. */
  private async applyCheckoutFailed(
    event: ProviderEvent,
    context: { providerName: string; environment: string },
  ): Promise<ApplyEventResult> {
    const session = await this.store.findCheckoutSessionByProviderRef(event.subjectRef);
    if (!session) {
      return { outcome: "reconciliation_required", providerRef: event.subjectRef };
    }
    if (session.state === "completed") return { outcome: "duplicate", orgId: session.orgId };
    // The session can never complete from this event; expire it so a later
    // completion claim fails closed instead of silently reactivating.
    if (session.state !== "expired") {
      session.state = "expired";
      await this.store.updateCheckoutSession(session);
    }
    return { outcome: "applied", orgId: session.orgId, providerRef: event.subjectRef };
  }

  // ---- Payment success (findings B/F): one effect per provider billing identity ----

  private async applyPaymentSucceeded(
    event: ProviderEvent,
    context: { providerName: string; environment: string },
  ): Promise<ApplyEventResult> {
    const identity = this.billingIdentityFor(event);
    // A financial success without an immutable provider billing identity
    // cannot be deduped against its sibling events — fail closed.
    if (!identity) {
      return { outcome: "reconciliation_required", providerRef: event.subjectRef };
    }

    let sub: Subscription | undefined;
    const resolved = await this.resolveSubscriptionForEvent(event, context.providerName, context.environment);
    sub = resolved.sub;
    // PayPal-style first payment can still arrive against the checkout
    // session ref before a subscription row exists: it completes the
    // checkout (and consumes the sale's period effect) instead of binding.
    if (!sub && !resolved.ambiguous) {
      const session = await this.store.findCheckoutSessionByProviderRef(event.subjectRef);
      if (session) {
        return this.applyCheckoutCompleted(event.subjectRef, { checkoutSessionId: session.id }, {
          subscriptionRef: event.subscriptionRef,
          occurredAt: event.occurredAt,
          amountMinor: event.amountMinor,
          currency: event.currency,
          environment: context.environment,
          providerName: context.providerName,
          transactionRef: event.transactionRef,
          customerRef: event.customerRef,
          paymentIntentRef: event.paymentIntentRef,
        });
      }
    }
    if (resolved.ambiguous || !sub) {
      // Unknown/ambiguous subject: never apply value, never guess.
      return {
        outcome: "reconciliation_required",
        providerRef: event.subscriptionRef ?? event.subjectRef,
      };
    }
    this.assertProviderBinding(sub, { providerName: context.providerName, environment: context.environment });

    // Ordering / monotonicity (finding F): success must never resurrect
    // terminal or refund/dispute-suspended state.
    if (["canceled", "retention", "deleted"].includes(sub.state)) {
      return { outcome: "stale_ignored", orgId: sub.orgId };
    }
    if (
      sub.state === "suspended" &&
      ["refund", "dispute", "fraud", "compliance"].includes(sub.suspensionSource ?? "")
    ) {
      if (!event.occurredAt) {
        return { outcome: "reconciliation_required", orgId: sub.orgId };
      }
      if (sub.lastEventAt && Date.parse(event.occurredAt) <= Date.parse(sub.lastEventAt)) {
        return { outcome: "stale_ignored", orgId: sub.orgId };
      }
    }
    // Missing-time success cannot recover/extend state unrestrictedly when
    // newer applied events exist.
    if (!event.occurredAt && sub.lastEventAt) {
      return { outcome: "reconciliation_required", orgId: sub.orgId };
    }

    // Money validation (server-side canonical price authority).
    if (event.amountMinor === undefined || !event.currency) {
      throw new BillingError("provider payment success missing amount or currency");
    }
    const priceVersion = await this.requirePriceVersion(sub.priceVersionId);
    const expected = BigInt(priceVersion.amountMinor);
    if (BigInt(event.amountMinor) !== expected) {
      throw new BillingError(`provider renewal amount mismatch: got ${event.amountMinor} ${event.currency}, expected ${expected}`);
    }
    if (normalizeCurrency(event.currency) !== normalizeCurrency(priceVersion.currency)) {
      throw new BillingError(`provider renewal currency mismatch: ${event.currency} != ${priceVersion.currency}`);
    }
    if (expected > 0n && BigInt(event.amountMinor) === 0n) {
      throw new BillingError("zero-value provider payment cannot renew a paid plan");
    }

    // Business-effect claim: invoice.paid + invoice.payment_succeeded for
    // the SAME invoice extend the period exactly once.
    const claimed = await this.claimBusinessEffect(event, "period_extension", sub, context.providerName, context.environment);
    if (!claimed) {
      return { outcome: "duplicate", orgId: sub.orgId };
    }

    if (event.subscriptionRef && sub.providerRef !== event.subscriptionRef) {
      sub.providerRef = event.subscriptionRef;
    }
    if (context.providerName) sub.providerName = context.providerName;
    this.touchSubscriptionEvent(sub, event);

    const invoice = await this.reconcilePaymentSucceededInvoice(sub, event, identity);
    if (sub.state === "past_due" || sub.state === "grace_period" || sub.state === "suspended") {
      await this.transition(sub.id, "active", "payment_recovered", {
        idempotencyKey: `recover:${identity}`,
        suspensionSource: undefined,
        suspensionReason: undefined,
      });
      // Mirror the converged state so the write below cannot regress it.
      sub.state = "active";
      sub.failedRenewals = 0;
      sub.graceEndsAt = undefined;
      await this.store.updateSubscription(sub);
    } else if (sub.state === "trial") {
      await this.transition(sub.id, "active", "trial_converted", {
        idempotencyKey: `trial-converted:${identity}`,
      });
      sub.state = "active";
      await this.store.updateSubscription(sub);
    } else if (sub.state === "active") {
      // Provider-managed renewal success advances the period server-side.
      sub.currentPeriodStart = invoice.periodStart;
      sub.currentPeriodEnd = invoice.periodEnd;
      await this.store.updateSubscription(sub);
    } else {
      await this.store.updateSubscription(sub);
    }

    await this.recordObjectMapping(sub, event, context.providerName, context.environment);
    return { outcome: "applied", orgId: sub.orgId, providerRef: sub.providerRef };
  }

  private async applyPaymentFailed(
    event: ProviderEvent,
    context: { providerName: string; environment: string },
  ): Promise<ApplyEventResult> {
    const resolved = await this.resolveSubscriptionForEvent(event, context.providerName, context.environment);
    if (resolved.ambiguous || !resolved.sub) {
      return { outcome: "reconciliation_required", providerRef: event.subscriptionRef ?? event.subjectRef };
    }
    const sub = resolved.sub;
    this.assertProviderBinding(sub, { providerName: context.providerName, environment: context.environment });

    if (["canceled", "retention", "deleted"].includes(sub.state)) {
      return { outcome: "stale_ignored", orgId: sub.orgId };
    }
    // Missing ordering data must not silently mutate newer state.
    if (!event.occurredAt && sub.lastEventAt) {
      return { outcome: "stale_ignored", orgId: sub.orgId };
    }
    if (!this.eventIsCurrent(sub, event, { regressive: true })) {
      return { outcome: "stale_ignored", orgId: sub.orgId };
    }

    const claimed = await this.claimBusinessEffect(event, "payment_failure", sub, context.providerName, context.environment);
    if (!claimed) {
      return { outcome: "duplicate", orgId: sub.orgId };
    }

    if (event.subscriptionRef && sub.providerRef !== event.subscriptionRef) {
      sub.providerRef = event.subscriptionRef;
    }
    if (context.providerName) sub.providerName = context.providerName;
    if (sub.state === "active") {
      sub.failedRenewals += 1;
      this.touchSubscriptionEvent(sub, event);
      await this.store.updateSubscription(sub);
      await this.transition(sub.id, "past_due", "payment_failed", {
        idempotencyKey: `fail:${this.billingIdentityFor(event) ?? event.externalEventId}:${sub.failedRenewals}`,
      });
    } else {
      this.touchSubscriptionEvent(sub, event);
      await this.store.updateSubscription(sub);
    }
    await this.recordObjectMapping(sub, event, context.providerName, context.environment);
    return { outcome: "applied", orgId: sub.orgId, providerRef: sub.providerRef };
  }

  // ---- Stripe/PayPal lifecycle (findings C/D) --------------------------------------

  private async applySubscriptionUpdated(
    event: ProviderEvent,
    context: { providerName: string; environment: string },
  ): Promise<ApplyEventResult> {
    const resolved = await this.resolveSubscriptionForEvent(event, context.providerName, context.environment);
    if (resolved.ambiguous || !resolved.sub) {
      return { outcome: "reconciliation_required", providerRef: event.subscriptionRef ?? event.subjectRef };
    }
    const sub = resolved.sub;
    this.assertProviderBinding(sub, { providerName: context.providerName, environment: context.environment });
    const status = event.subscriptionStatus;

    // Provider-side plan changes MUST NOT silently remap Mox plan
    // authority: unknown/unmapped provider plans require reconciliation.
    if (event.providerPlanRefs && event.providerPlanRefs.length > 0) {
      const ref = event.providerPlanRefs[0] ?? "";
      if (ref) {
        const mapped = await this.store.findProviderPlanMapping(context.providerName, context.environment, ref);
        if (!mapped || mapped.moxPriceVersionId !== sub.priceVersionId) {
          sub.reconciliationRequired = true;
        }
        sub.providerPlanRef = ref;
      }
    }

    switch (status) {
      case "active": {
        sub.cancelAtPeriodEnd = event.cancelAtPeriodEnd ?? sub.cancelAtPeriodEnd;
        // Period sync only from events that are current: a stale
        // subscription.updated must never shrink or extend a newer period.
        if (this.eventIsCurrent(sub, event, { regressive: false })) {
          if (event.currentPeriodStart) sub.currentPeriodStart = event.currentPeriodStart;
          if (event.currentPeriodEnd) sub.currentPeriodEnd = event.currentPeriodEnd;
        }
        if (event.trialEndsAt) sub.trialEndsAt = event.trialEndsAt;
        this.touchSubscriptionEvent(sub, event);
        if (sub.state === "canceled") {
          // Cancellation reversal / uncancel: only when the provider is the
          // authority that canceled, and the provider now says active with
          // no pending period-end cancellation.
          const transitions = await this.store.listTransitions(sub.id);
          const lastCancel = [...transitions]
            .reverse()
            .find((t) => t.toState === "canceled");
          if (lastCancel?.reason === "provider_canceled" && event.cancelAtPeriodEnd === false) {
            await this.store.updateSubscription(sub);
            await this.transition(sub.id, "active", "provider_uncanceled", {
              idempotencyKey: `uncancel:${event.externalEventId}`,
            });
          } else {
            sub.reconciliationRequired = true;
            await this.store.updateSubscription(sub);
          }
        } else if (
          sub.state === "suspended" &&
          sub.suspensionSource === "provider" &&
          event.cancelAtPeriodEnd === false
        ) {
          // Resume from a provider pause: intentional recovery.
          await this.store.updateSubscription(sub);
          await this.transition(sub.id, "active", "provider_resumed", {
            idempotencyKey: `resume:${event.externalEventId}`,
          });
        } else if (!["active", "trial"].includes(sub.state)) {
          // Lifecycle alone never restores past_due/grace/suspended —
          // payment proof is the only path back (finding D).
          await this.store.updateSubscription(sub);
        } else {
          await this.store.updateSubscription(sub);
        }
        break;
      }
      case "trialing":
        if (sub.state === "trial" && event.trialEndsAt) {
          sub.trialEndsAt = event.trialEndsAt;
        }
        this.touchSubscriptionEvent(sub, event);
        await this.store.updateSubscription(sub);
        break;
      case "past_due":
      case "unpaid":
        this.touchSubscriptionEvent(sub, event);
        await this.store.updateSubscription(sub);
        if (sub.state === "active") {
          await this.transition(sub.id, "past_due", "provider_past_due", {
            idempotencyKey: `provider-past-due:${event.externalEventId}`,
          });
        }
        break;
      case "paused":
        this.touchSubscriptionEvent(sub, event);
        await this.store.updateSubscription(sub);
        if (!["suspended", "canceled", "retention", "deleted"].includes(sub.state)) {
          await this.transition(sub.id, "suspended", "provider_paused", {
            idempotencyKey: `provider-paused:${event.externalEventId}`,
            suspensionSource: "provider",
            suspensionReason: "provider_paused",
          });
        }
        break;
      case "canceled":
        return this.applyProviderCanceled(event, context);
      case "incomplete":
      case "incomplete_expired":
        // Checkout never concluded; no entitlement change, recorded only.
        this.touchSubscriptionEvent(sub, event);
        await this.store.updateSubscription(sub);
        break;
      default:
        return { outcome: "reconciliation_required", orgId: sub.orgId, providerRef: sub.providerRef };
    }
    await this.recordObjectMapping(sub, event, context.providerName, context.environment);
    return { outcome: "applied", orgId: sub.orgId, providerRef: sub.providerRef };
  }

  /** PayPal SUSPENDED: recoverable; never a destructive remote cancel. */
  private async applySubscriptionSuspended(
    event: ProviderEvent,
    context: { providerName: string; environment: string },
  ): Promise<ApplyEventResult> {
    const resolved = await this.resolveSubscriptionForEvent(event, context.providerName, context.environment);
    if (resolved.ambiguous || !resolved.sub) {
      return { outcome: "reconciliation_required", providerRef: event.subscriptionRef ?? event.subjectRef };
    }
    const sub = resolved.sub;
    this.assertProviderBinding(sub, { providerName: context.providerName, environment: context.environment });
    if (["canceled", "retention", "deleted"].includes(sub.state)) {
      return { outcome: "stale_ignored", orgId: sub.orgId };
    }
    // Ordering: a stale temporary suspension must not regress a newer
    // reactivated/paid state; missing-time events surface reconciliation.
    if (!event.occurredAt && sub.lastEventAt) {
      return { outcome: "reconciliation_required", orgId: sub.orgId, providerRef: sub.providerRef };
    }
    if (!this.eventIsCurrent(sub, event, { regressive: true })) {
      return { outcome: "stale_ignored", orgId: sub.orgId, providerRef: sub.providerRef };
    }
    const claimed = await this.claimBusinessEffect(event, "subscription_updated", sub, context.providerName, context.environment);
    if (!claimed) return { outcome: "duplicate", orgId: sub.orgId };
    this.touchSubscriptionEvent(sub, event);
    await this.store.updateSubscription(sub);
    if (sub.state !== "suspended") {
      // No remote cancellation is triggered — this is a temporary,
      // recoverable provider suspension (finding D).
      await this.transition(sub.id, "suspended", "provider_suspended_temporary", {
        idempotencyKey: `provider-suspended:${event.externalEventId}`,
        suspensionSource: "provider",
        suspensionReason: "provider_suspended_temporary",
      });
    }
    await this.recordObjectMapping(sub, event, context.providerName, context.environment);
    return { outcome: "applied", orgId: sub.orgId, providerRef: sub.providerRef };
  }

  /** PayPal RE-ACTIVATED: recovery only after authoritative reconciliation. */
  private async applySubscriptionReactivated(
    event: ProviderEvent,
    context: { providerName: string; environment: string },
  ): Promise<ApplyEventResult> {
    const resolved = await this.resolveSubscriptionForEvent(event, context.providerName, context.environment);
    if (resolved.ambiguous || !resolved.sub) {
      return { outcome: "reconciliation_required", providerRef: event.subscriptionRef ?? event.subjectRef };
    }
    const sub = resolved.sub;
    this.assertProviderBinding(sub, { providerName: context.providerName, environment: context.environment });
    if (sub.state === "active") return { outcome: "duplicate", orgId: sub.orgId };
    if (["canceled", "retention", "deleted"].includes(sub.state)) {
      return { outcome: "stale_ignored", orgId: sub.orgId };
    }

    // The event itself never grants entitlement: authoritative provider
    // reconciliation must prove payment (finding D).
    let provider: BillingProvider;
    try {
      provider = this.providerForSubscription(sub);
    } catch {
      return { outcome: "reconciliation_required", orgId: sub.orgId, providerRef: sub.providerRef };
    }
    if (!supportsReconciliation(provider)) {
      sub.reconciliationRequired = true;
      await this.store.updateSubscription(sub);
      return { outcome: "reconciliation_required", orgId: sub.orgId, providerRef: sub.providerRef };
    }
    const verification = await provider.verifyCheckout({ providerRef: sub.providerRef ?? event.subjectRef });
    if (!verification.paid) {
      sub.reconciliationRequired = true;
      await this.store.updateSubscription(sub);
      return { outcome: "reconciliation_required", orgId: sub.orgId, providerRef: sub.providerRef };
    }
    if (verification.amountMinor !== undefined && verification.currency) {
      const priceVersion = await this.requirePriceVersion(sub.priceVersionId);
      if (
        BigInt(verification.amountMinor) !== BigInt(priceVersion.amountMinor) ||
        normalizeCurrency(verification.currency) !== normalizeCurrency(priceVersion.currency)
      ) {
        sub.reconciliationRequired = true;
        await this.store.updateSubscription(sub);
        return { outcome: "reconciliation_required", orgId: sub.orgId, providerRef: sub.providerRef };
      }
    }
    sub.failedRenewals = 0;
    sub.graceEndsAt = undefined;
    sub.reconciliationRequired = false;
    this.touchSubscriptionEvent(sub, { occurredAt: verification.occurredAt ?? event.occurredAt });
    await this.store.updateSubscription(sub);
    // Active subscriptions returned early above; every remaining live state
    // (trial/past_due/grace/suspended) legally moves to active here.
    await this.transition(sub.id, "active", "payment_reactivated_reconciled", {
      idempotencyKey: `reactivated:${event.externalEventId}`,
      suspensionSource: undefined,
      suspensionReason: undefined,
    });
    return { outcome: "applied", orgId: sub.orgId, providerRef: sub.providerRef };
  }

  /** Provider-side terminal cancellation — no destructive remote call. */
  private async applyProviderCanceled(
    event: ProviderEvent,
    context: { providerName: string; environment: string },
  ): Promise<ApplyEventResult> {
    const resolved = await this.resolveSubscriptionForEvent(event, context.providerName, context.environment);
    if (resolved.ambiguous || !resolved.sub) {
      return { outcome: "reconciliation_required", providerRef: event.subscriptionRef ?? event.subjectRef };
    }
    const sub = resolved.sub;
    this.assertProviderBinding(sub, { providerName: context.providerName, environment: context.environment });
    if (["canceled", "retention", "deleted"].includes(sub.state)) {
      return { outcome: "duplicate", orgId: sub.orgId };
    }
    // Ordering (finding F): a cancellation older than the newest applied
    // event is stale_ignored; a missing-time cancellation that cannot be
    // ordered is surfaced as reconciliation_required — never silently
    // dropped and never guessed.
    if (!event.occurredAt && sub.lastEventAt) {
      return { outcome: "reconciliation_required", orgId: sub.orgId, providerRef: sub.providerRef };
    }
    if (!this.eventIsCurrent(sub, event, { regressive: true })) {
      return { outcome: "stale_ignored", orgId: sub.orgId, providerRef: sub.providerRef };
    }
    this.touchSubscriptionEvent(sub, event);
    await this.store.updateSubscription(sub);
    await this.transition(sub.id, "canceled", "provider_canceled", {
      actorType: "user",
      idempotencyKey: `provider-canceled:${event.externalEventId}`,
    });
    await this.store.upsertSubscriptionCancellation({
      subscriptionId: sub.id,
      state: "canceled",
      requestedBy: "provider",
      attempts: 0,
    });
    await this.recordObjectMapping(sub, event, context.providerName, context.environment);
    return { outcome: "applied", orgId: sub.orgId, providerRef: sub.providerRef };
  }

  // ---- Refunds / disputes (findings A/I) ------------------------------------------

  private async applyRefund(
    event: ProviderEvent,
    context: { providerName: string; environment: string },
  ): Promise<ApplyEventResult> {
    const resolved = await this.resolveSubscriptionForEvent(event, context.providerName, context.environment);
    if (resolved.ambiguous || !resolved.sub) {
      // A verified refund we cannot bind must never be dropped — it is
      // recorded as reconciliation_required (finding A/F).
      return { outcome: "reconciliation_required", providerRef: event.subjectRef };
    }
    const sub = resolved.sub;
    this.assertProviderBinding(sub, { providerName: context.providerName, environment: context.environment });

    const price = await this.requirePriceVersion(sub.priceVersionId);
    if (event.currency !== undefined && normalizeCurrency(event.currency) !== normalizeCurrency(price.currency)) {
      throw new BillingError(`refund currency mismatch: ${event.currency} != ${price.currency}`);
    }
    if (event.amountMinor === undefined) {
      // Cannot classify full vs partial — fail closed, never silently ignore.
      sub.reconciliationRequired = true;
      await this.store.updateSubscription(sub);
      return { outcome: "reconciliation_required", orgId: sub.orgId, providerRef: sub.providerRef };
    }
    const refundAmount = BigInt(event.amountMinor);
    if (refundAmount <= 0n) {
      return { outcome: "duplicate", orgId: sub.orgId };
    }

    const claimed = await this.claimBusinessEffect(event, "refund", sub, context.providerName, context.environment);
    if (!claimed) return { outcome: "duplicate", orgId: sub.orgId };

    this.touchSubscriptionEvent(sub, event);
    if (refundAmount >= BigInt(price.amountMinor)) {
      // FULL refund: revoke/suspend per policy; compute reconciliation is
      // QUEUED, never performed synchronously in the webhook (finding A).
      if (!["suspended", "canceled", "retention", "deleted"].includes(sub.state)) {
        await this.store.updateSubscription(sub);
        await this.transition(sub.id, "suspended", "full_refund_processed", {
          idempotencyKey: `refund:${this.billingIdentityFor(event) ?? event.externalEventId}`,
          suspensionSource: "refund",
          suspensionReason: "full_refund_processed",
        });
        await this.store.enqueueCommercialReconciliation(sub.id, "full_refund_processed");
      } else {
        await this.store.updateSubscription(sub);
      }
    } else {
      // PARTIAL refund (explicit documented policy, finding A): access is
      // intentionally preserved for the already-paid remainder of the
      // period, the subscription is flagged reconciliation_required, and no
      // further period extension can come from the refunded invoice (its
      // business effect is already consumed).
      sub.reconciliationRequired = true;
      await this.store.updateSubscription(sub);
    }
    await this.recordObjectMapping(sub, event, context.providerName, context.environment);
    return { outcome: "applied", orgId: sub.orgId, providerRef: sub.providerRef };
  }

  private async applyDisputeOpened(
    event: ProviderEvent,
    context: { providerName: string; environment: string },
  ): Promise<ApplyEventResult> {
    const resolved = await this.resolveSubscriptionForEvent(event, context.providerName, context.environment);
    if (resolved.ambiguous || !resolved.sub) {
      return { outcome: "reconciliation_required", providerRef: event.subjectRef };
    }
    const sub = resolved.sub;
    this.assertProviderBinding(sub, { providerName: context.providerName, environment: context.environment });

    const claimed = await this.claimBusinessEffect(event, "dispute_open", sub, context.providerName, context.environment);
    if (!claimed) return { outcome: "duplicate", orgId: sub.orgId };

    this.touchSubscriptionEvent(sub, event);
    await this.store.updateSubscription(sub);
    if (!["suspended", "canceled", "retention", "deleted"].includes(sub.state)) {
      await this.transition(sub.id, "suspended", "dispute_or_chargeback_opened", {
        idempotencyKey: `dispute-open:${this.billingIdentityFor(event) ?? event.externalEventId}`,
        suspensionSource: "dispute",
        suspensionReason: "dispute_or_chargeback_opened",
      });
      await this.store.enqueueCommercialReconciliation(sub.id, "dispute_or_chargeback_opened");
    }
    await this.recordObjectMapping(sub, event, context.providerName, context.environment);
    return { outcome: "applied", orgId: sub.orgId, providerRef: sub.providerRef };
  }

  private async applyDisputeResolved(
    event: ProviderEvent,
    context: { providerName: string; environment: string },
  ): Promise<ApplyEventResult> {
    const resolved = await this.resolveSubscriptionForEvent(event, context.providerName, context.environment);
    if (resolved.ambiguous || !resolved.sub) {
      return { outcome: "reconciliation_required", providerRef: event.subjectRef };
    }
    const sub = resolved.sub;
    this.assertProviderBinding(sub, { providerName: context.providerName, environment: context.environment });

    const claimed = await this.claimBusinessEffect(event, "dispute_resolved", sub, context.providerName, context.environment);
    if (!claimed) return { outcome: "duplicate", orgId: sub.orgId };

    this.touchSubscriptionEvent(sub, event);
    if (event.resolution === "won" && sub.state === "suspended") {
      // dispute-won must NOT blindly restore access (finding I): the
      // current paid period/state must still be financially valid.
      const valid = await this.financialStateValidForRestore(sub);
      if (valid) {
        await this.store.updateSubscription(sub);
        await this.transition(sub.id, "active", "dispute_won_restored", {
          idempotencyKey: `dispute-won:${this.billingIdentityFor(event) ?? event.externalEventId}`,
          suspensionSource: undefined,
          suspensionReason: undefined,
        });
      } else {
        sub.reconciliationRequired = true;
        await this.store.updateSubscription(sub);
      }
    } else if (
      (event.resolution === "lost" || event.resolution === "accepted" || event.resolution === "unknown") &&
      !["suspended", "canceled", "retention", "deleted"].includes(sub.state)
    ) {
      await this.store.updateSubscription(sub);
      await this.transition(sub.id, "suspended", "dispute_lost_or_accepted", {
        idempotencyKey: `dispute-lost:${this.billingIdentityFor(event) ?? event.externalEventId}`,
        suspensionSource: "dispute",
        suspensionReason: "dispute_lost_or_accepted",
      });
      await this.store.enqueueCommercialReconciliation(sub.id, "dispute_lost_or_accepted");
    } else {
      await this.store.updateSubscription(sub);
    }
    await this.recordObjectMapping(sub, event, context.providerName, context.environment);
    return { outcome: "applied", orgId: sub.orgId, providerRef: sub.providerRef };
  }

  /**
   * Financial validity for restoring a dispute/refund suspension: the
   * current period must be live AND a paid business effect must exist.
   */
  private async financialStateValidForRestore(sub: Subscription): Promise<boolean> {
    const now = Date.now();
    if (!sub.currentPeriodStart || !sub.currentPeriodEnd) return false;
    if (Date.parse(sub.currentPeriodStart) > now) return false;
    if (Date.parse(sub.currentPeriodEnd) <= now) return false;
    if (sub.reconciliationRequired) return false;
    return this.store.hasAppliedFinancialEffect(sub.id);
  }

  // ---- Lifecycle engine ------------------------------------------------------

  /** Auditable, idempotent transition. Throws on illegal moves. */
  async transition(
    subscriptionId: string,
    toState: SubscriptionState,
    reason: string,
    options: {
      actorType?: SubscriptionTransition["actorType"];
      actorId?: string;
      idempotencyKey?: string;
      now?: string;
      suspensionSource?: string;
      suspensionReason?: string;
    } = {},
  ): Promise<{ applied: boolean }> {
    const sub = await this.requireSubscription(subscriptionId);
    if (sub.state === toState && !options.idempotencyKey) {
      return { applied: false };
    }
    const allowed = ALLOWED_TRANSITIONS[sub.state] ?? [];
    if (sub.state !== toState && !allowed.includes(toState)) {
      throw new InvalidTransitionError(`${sub.state} → ${toState} is not allowed`);
    }
    const recorded = await this.store.recordTransition({
      id: newId(),
      subscriptionId,
      fromState: sub.state,
      toState,
      reason,
      actorType: options.actorType ?? "system",
      actorId: options.actorId,
      idempotencyKey: options.idempotencyKey,
      at: options.now ?? new Date().toISOString(),
    });
    if (!recorded) {
      // Idempotent replay after a crash: the transition row already exists,
      // so converge the local state to the recorded target instead of
      // returning with a divergent subscription (finding E).
      if (sub.state !== toState) {
        sub.state = toState;
        applyTransitionStateFields(sub, toState, options);
        await this.store.updateSubscription(sub);
      }
      return { applied: false };
    }

    const nowIso = options.now ?? new Date().toISOString();
    sub.state = toState;
    applyTransitionStateFields(sub, toState, options, nowIso);
    await this.store.updateSubscription(sub);
    return { applied: true };
  }

  /**
   * Renewal sweep. Charges subscriptions whose period has ended:
   * success advances the period; failure walks active→past_due→grace_period;
   * expired grace suspends. Concurrent workers never double-process a
   * subscription because renewal rows are claimed durably.
   */
  async runRenewals(now?: string): Promise<{ renewed: number; failed: number; suspended: number }> {
    const at = now ?? new Date().toISOString();
    let renewed = 0;
    let failed = 0;
    let suspended = 0;

    const due = await this.store.listSubscriptionsInState(["active", "past_due", "grace_period"]);
    for (const sub of due) {
      if (!sub.currentPeriodEnd || sub.currentPeriodEnd > at || sub.providerRef === undefined) continue;
      const claimed = await this.store.claimSubscriptionRenewal(
        sub.id,
        sub.currentPeriodEnd,
        this.workerId,
        new Date(Date.parse(at) + this.claimLeaseMs).toISOString(),
        at,
      );
      if (!claimed) continue;
      const outcome = await this.renewOne(claimed, at);
      renewed += outcome.renewed;
      failed += outcome.failed;
    }

    // Suspend subscriptions whose grace window lapsed without payment.
    for (const sub of await this.store.listSubscriptionsInState(["grace_period"])) {
      if (sub.graceEndsAt && sub.graceEndsAt <= at) {
        await this.transition(sub.id, "suspended", "grace_expired_unpaid", {
          now: at,
          suspensionSource: "payment_failure",
          suspensionReason: "grace_expired_unpaid",
        });
        suspended += 1;
      }
    }

    return { renewed, failed, suspended };
  }

  private async renewOne(sub: Subscription, at: string): Promise<{ renewed: number; failed: number }> {
    const attempt = sub.failedRenewals + 1;
    const priceVersion = await this.requirePriceVersion(sub.priceVersionId);
    const periodStart = sub.currentPeriodEnd;
    if (!periodStart) return { renewed: 0, failed: 0 };

    let invoice = await this.store.findInvoiceByPeriodAttempt(sub.id, periodStart, attempt);
    if (!invoice) {
      invoice = await this.store.createInvoice({
        id: newId(),
        subscriptionId: sub.id,
        periodStart,
        periodEnd: new Date(new Date(periodStart).getTime() + this.periodDays * 24 * 3600 * 1000).toISOString(),
        amount: { currency: priceVersion.currency, amountMinor: BigInt(priceVersion.amountMinor) },
        status: "open",
        attempt,
        createdAt: at,
      });
    }

    const providerRef = sub.providerRef;
    if (!providerRef) return { renewed: 0, failed: 0 };
    const provider = this.providerForSubscription(sub);
    const charge = await provider.charge({
      providerRef,
      amountMinor: invoice.amount.amountMinor,
      currency: invoice.amount.currency,
      idempotencyKey: `renew:${sub.id}:${periodStart}:${attempt}`,
    });

    if (charge.ok) {
      invoice.status = "paid";
      invoice.paidAt = at;
      invoice.providerInvoiceRef = charge.providerInvoiceRef;
      await this.store.updateInvoice(invoice);
      sub.currentPeriodStart = periodStart;
      sub.currentPeriodEnd = invoice.periodEnd;
      sub.failedRenewals = 0;
      sub.graceEndsAt = undefined;
      sub.renewalClaimOwner = undefined;
      sub.renewalClaimExpiresAt = undefined;
      await this.store.updateSubscription(sub);
      if (sub.state !== "active") {
        await this.transition(sub.id, "active", "renewal_succeeded", {
          idempotencyKey: `renew-ok:${periodStart}`,
          now: at,
        });
      }
      return { renewed: 1, failed: 0 };
    }

    invoice.status = "failed";
    await this.store.updateInvoice(invoice);
    sub.failedRenewals = attempt;
    sub.renewalClaimOwner = undefined;
    sub.renewalClaimExpiresAt = undefined;
    await this.store.updateSubscription(sub);
    if (sub.state === "active") {
      await this.transition(sub.id, "past_due", `renewal_failed:${charge.failureReason}`, {
        idempotencyKey: `renew-fail:${periodStart}:${attempt}`,
        now: at,
      });
    } else if (sub.state === "past_due" && attempt >= 2) {
      sub.graceEndsAt = new Date(new Date(at).getTime() + this.graceDays * 24 * 3600 * 1000).toISOString();
      sub.renewalClaimOwner = undefined;
      sub.renewalClaimExpiresAt = undefined;
      await this.store.updateSubscription(sub);
      await this.transition(sub.id, "grace_period", "grace_window_opened", {
        idempotencyKey: `grace:${periodStart}:${attempt}`,
        now: at,
      });
    }
    return { renewed: 0, failed: 1 };
  }

  /** Retention sweep: expired retention windows destroy remaining data refs. */
  async runRetentionSweep(now?: string): Promise<number> {
    const at = now ?? new Date().toISOString();
    let deleted = 0;
    for (const sub of await this.store.listSubscriptionsInState(["canceled", "retention"])) {
      if (sub.canceledAt && !sub.retentionUntil) {
        sub.retentionUntil = new Date(new Date(sub.canceledAt).getTime() + this.retentionDays * 24 * 3600 * 1000).toISOString();
        await this.store.updateSubscription(sub);
        await this.transition(sub.id, "retention", "retention_window_opened", { now: at });
      }
      if (sub.retentionUntil && sub.retentionUntil <= at && sub.state === "retention") {
        await this.transition(sub.id, "deleted", "retention_expired_purged", { now: at });
        deleted += 1;
      }
    }
    return deleted;
  }

  /**
   * Cancellation (finding H): durable progress. Local entitlement shutdown
   * is an explicit, immediate transition; the upstream provider
   * cancellation is tracked separately and retried idempotently. Remote
   * failures land in reconciliation_required and stay visible.
   */
  async cancelSubscription(
    subscriptionId: string,
    options: { actorType?: SubscriptionTransition["actorType"]; actorId?: string; reason?: string; now?: string } = {},
  ): Promise<void> {
    const sub = await this.requireSubscription(subscriptionId);
    const actor = options.actorType ?? "user";
    const nowIso = options.now ?? new Date().toISOString();

    // 1. Durable intent.
    await this.store.upsertSubscriptionCancellation({
      subscriptionId,
      state: "cancel_requested",
      requestedBy: actor,
      requestedById: options.actorId,
      attempts: 0,
      nextAttemptAt: nowIso,
    });

    // 2. Local entitlement shutdown: explicit policy — access shuts down
    //    immediately on customer/admin cancellation.
    if (!["canceled", "retention", "deleted"].includes(sub.state)) {
      await this.transition(subscriptionId, "canceled", options.reason ?? "cancel_requested", {
        actorType: actor,
        actorId: options.actorId,
        now: options.now,
      });
    }

    // 3. Upstream cancellation, tracked separately.
    const fresh = await this.requireSubscription(subscriptionId);
    if (!fresh.providerRef) {
      await this.store.upsertSubscriptionCancellation({
        subscriptionId,
        state: "reconciliation_required",
        requestedBy: actor,
        requestedById: options.actorId,
        attempts: 0,
        lastError: "ambiguous provider mapping: subscription has no provider reference",
        nextAttemptAt: undefined,
      });
      return;
    }
    let provider: BillingProvider;
    try {
      provider = this.providerForSubscription(fresh);
    } catch (error) {
      await this.store.upsertSubscriptionCancellation({
        subscriptionId,
        state: "reconciliation_required",
        requestedBy: actor,
        requestedById: options.actorId,
        attempts: 0,
        lastError: error instanceof Error ? error.message : String(error),
        nextAttemptAt: undefined,
      });
      return;
    }
    await this.store.upsertSubscriptionCancellation({
      subscriptionId,
      state: "provider_cancel_pending",
      requestedBy: actor,
      requestedById: options.actorId,
      attempts: 0,
    });
    try {
      await provider.cancelRemote(fresh.providerRef);
      await this.store.upsertSubscriptionCancellation({
        subscriptionId,
        state: "canceled",
        requestedBy: actor,
        requestedById: options.actorId,
        attempts: 0,
      });
    } catch (error) {
      const backoffMs = Math.min(60 * 60 * 1000, 60_000 * 2 ** 0);
      await this.store.upsertSubscriptionCancellation({
        subscriptionId,
        state: "reconciliation_required",
        requestedBy: actor,
        requestedById: options.actorId,
        attempts: 1,
        lastError: error instanceof Error ? error.message : String(error),
        nextAttemptAt: new Date(Date.now() + backoffMs).toISOString(),
      });
    }
  }

  /** Idempotent retry driver for pending/reconciliation-required cancellations. */
  async runCancellationRetries(now?: string): Promise<{ retried: number; canceled: number }> {
    const at = now ?? new Date().toISOString();
    const due = await this.store.listDueCancellationRetries(at, 50);
    let retried = 0;
    let canceled = 0;
    for (const record of due) {
      const sub = await this.store.getSubscription(record.subscriptionId);
      if (!sub) continue;
      retried += 1;
      if (!sub.providerRef) continue; // stays reconciliation_required (visible)
      let provider: BillingProvider;
      try {
        provider = this.providerForSubscription(sub);
      } catch (error) {
        await this.store.upsertSubscriptionCancellation({
          ...record,
          state: "reconciliation_required",
          lastError: error instanceof Error ? error.message : String(error),
          attempts: record.attempts + 1,
          nextAttemptAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        });
        continue;
      }
      try {
        await provider.cancelRemote(sub.providerRef);
        await this.store.upsertSubscriptionCancellation({
          ...record,
          state: "canceled",
          lastError: undefined,
          attempts: record.attempts + 1,
          nextAttemptAt: undefined,
        });
        canceled += 1;
      } catch (error) {
        const backoffMs = Math.min(60 * 60 * 1000, 60_000 * 2 ** Math.min(record.attempts, 6));
        await this.store.upsertSubscriptionCancellation({
          ...record,
          state: "reconciliation_required",
          lastError: error instanceof Error ? error.message : String(error),
          attempts: record.attempts + 1,
          nextAttemptAt: new Date(Date.now() + backoffMs).toISOString(),
        });
      }
    }
    return { retried, canceled };
  }

  async adminSuspend(subscriptionId: string, adminId: string, reason: string): Promise<void> {
    await this.transition(subscriptionId, "suspended", reason, {
      actorType: "admin",
      actorId: adminId,
      suspensionSource: "admin",
      suspensionReason: reason,
    });
  }

  /**
   * Admin reactivation (finding I). Refund/dispute/fraud/compliance
   * suspensions require EXPLICIT financial reconciliation and a currently
   * valid paid period — a generic admin click must never restore a
   * financially invalid subscription.
   */
  async adminReactivate(
    subscriptionId: string,
    adminId: string,
    options: { financialReconciled?: boolean } = {},
  ): Promise<void> {
    const sub = await this.requireSubscription(subscriptionId);
    if (sub.state !== "suspended") throw new InvalidTransitionError("only suspended subscriptions can be reactivated");
    const source = sub.suspensionSource;
    if (["refund", "dispute", "fraud", "compliance"].includes(source ?? "")) {
      if (!options.financialReconciled) {
        throw new CommercialAccessError(
          `subscription suspended by ${source}; admin reactivation requires explicit financial reconciliation`,
        );
      }
      const now = Date.now();
      if (!sub.currentPeriodEnd || Date.parse(sub.currentPeriodEnd) <= now) {
        throw new CommercialAccessError("the current paid period is no longer valid; reactivation requires a new payment");
      }
      if (sub.reconciliationRequired) {
        throw new CommercialAccessError("subscription has unresolved reconciliation conditions; resolve them before reactivating");
      }
    }
    await this.transition(subscriptionId, "active", "admin_reactivated", {
      actorType: "admin",
      actorId: adminId,
    });
  }

  async listTransitions(subscriptionId: string): Promise<SubscriptionTransition[]> {
    return this.store.listTransitions(subscriptionId);
  }

  async listInvoices(subscriptionId: string): Promise<Invoice[]> {
    return this.store.listInvoices(subscriptionId);
  }

  async getSubscription(id: string): Promise<Subscription> {
    return this.requireSubscription(id);
  }

  async getActiveSubscription(orgId: string): Promise<Subscription | undefined> {
    return this.store.getActiveSubscriptionForOrg(orgId);
  }

  async getSubscriptionCancellation(subscriptionId: string): Promise<SubscriptionCancellation | undefined> {
    return this.store.getSubscriptionCancellation(subscriptionId);
  }

  /** Webhook-junk retention (finding G): applied financial rows are exempt. */
  async purgeRejectedWebhooks(beforeIso: string): Promise<number> {
    return this.store.purgeRejectedWebhooks(beforeIso);
  }

  /** Commercial reconciliation queue passthrough (finding A). */
  async dequeueCommercialReconciliations(limit: number) {
    return this.store.dequeueCommercialReconciliations(limit);
  }

  async ackCommercialReconciliation(subscriptionId: string): Promise<void> {
    await this.store.ackCommercialReconciliation(subscriptionId);
  }

  async evaluateCommercialAccess(
    orgId: string,
    options: { now?: string; subscription?: Subscription } = {},
  ): Promise<CommercialAccessDecision> {
    const now = options.now ?? new Date().toISOString();
    const sub = options.subscription ?? await this.store.getActiveSubscriptionForOrg(orgId);
    if (!sub) return { entitled: false, reason: "no_subscription" };
    if (!sub.planVersionId || sub.planVersionId === "plan-version-current") {
      return { entitled: false, reason: "invalid_plan_version", subscription: sub };
    }
    const plan = await this.store.getPlanVersion(sub.planVersionId);
    if (!plan) return { entitled: false, reason: "unknown_plan_version", subscription: sub };
    if (sub.state === "trial") {
      return sub.trialEndsAt && sub.trialEndsAt > now
        ? { entitled: true, subscription: sub, planVersionId: sub.planVersionId }
        : { entitled: false, reason: "trial_expired_or_not_configured", subscription: sub, planVersionId: sub.planVersionId };
    }
    if (sub.state === "active") {
      if (!sub.currentPeriodStart || !sub.currentPeriodEnd) {
        return { entitled: false, reason: "missing_period", subscription: sub, planVersionId: sub.planVersionId };
      }
      if (sub.currentPeriodStart > now) {
        return { entitled: false, reason: "period_not_started", subscription: sub, planVersionId: sub.planVersionId };
      }
      if (sub.currentPeriodEnd <= now) {
        return { entitled: false, reason: "expired_period", subscription: sub, planVersionId: sub.planVersionId };
      }
      return { entitled: true, subscription: sub, planVersionId: sub.planVersionId };
    }
    if (sub.state === "grace_period") {
      return sub.graceEndsAt && sub.graceEndsAt > now
        ? { entitled: true, subscription: sub, planVersionId: sub.planVersionId }
        : { entitled: false, reason: "grace_expired", subscription: sub, planVersionId: sub.planVersionId };
    }
    return { entitled: false, reason: `state_${sub.state}`, subscription: sub, planVersionId: sub.planVersionId };
  }

  async requireCommercialEntitlement(
    orgId: string,
    entitlements: EntitlementService,
    key: EntitlementKey,
    options: { now?: string; min?: number; equals?: string } = {},
  ): Promise<CommercialAuthorizationDecision> {
    const access = await this.evaluateCommercialAccess(orgId, { now: options.now });
    if (!access.entitled || !access.planVersionId) return { ...access, entitled: false, entitlementKey: key };
    const resolved = await entitlements.resolve(orgId, key, access.planVersionId, options.now);
    const value = resolved.value;
    if (typeof value === "boolean" && value !== true) {
      return { ...access, entitled: false, reason: `entitlement_${key}_disabled`, entitlementKey: key, value };
    }
    if (typeof value === "number" && options.min !== undefined && value < options.min) {
      return { ...access, entitled: false, reason: `entitlement_${key}_insufficient`, entitlementKey: key, value };
    }
    if (typeof value === "string" && options.equals !== undefined && value !== options.equals) {
      return { ...access, entitled: false, reason: `entitlement_${key}_mismatch`, entitlementKey: key, value };
    }
    return { ...access, entitlementKey: key, value };
  }

  // ---- Add-ons -----------------------------------------------------------------

  async attachAddon(subscriptionId: string, addonCode: string, quantity: number, priceVersionId?: string): Promise<SubscriptionItem> {
    const addon = await this.store.getAddon(addonCode);
    if (!addon) throw new NotFoundError(`addon ${addonCode}`);
    const sub = await this.requireSubscription(subscriptionId);
    if (!["trial", "active"].includes(sub.state)) {
      throw new BillingError(`addons cannot be attached while subscription is ${sub.state}`);
    }
    return this.store.addItem({
      id: newId(),
      subscriptionId,
      kind: addon.consumable ? "base" : "addon",
      addonCode,
      quantity,
      priceVersionId,
    });
  }

  // ---- Internals -----------------------------------------------------------

  private providerForSubscription(sub: Subscription): BillingProvider {
    const name = sub.providerName;
    if (!name) throw new BillingError(`subscription ${sub.id} lacks authoritative provider identity`);
    return this.provider(name);
  }

  private assertProviderBinding(
    sub: Subscription,
    event?: { providerName?: string; environment?: string },
  ): void {
    if (event?.providerName && sub.providerName && sub.providerName !== event.providerName) {
      throw new BillingError(`provider mismatch: ${event.providerName} != ${sub.providerName}`);
    }
    if (event?.environment && sub.providerEnvironment && sub.providerEnvironment !== event.environment) {
      throw new BillingError(`provider environment mismatch: ${event.environment} != ${sub.providerEnvironment}`);
    }
  }

  private async requireSubscription(id: string): Promise<Subscription> {
    const sub = await this.store.getSubscription(id);
    if (!sub) throw new NotFoundError(`subscription ${id}`);
    return sub;
  }

  private async requirePlanVersion(id: string): Promise<PlanVersion> {
    const version = await this.store.getPlanVersion(id);
    if (!version) throw new NotFoundError(`plan version ${id}`);
    return version;
  }

  private async requirePriceBook(id: string): Promise<PriceBook> {
    const book = await this.store.getPriceBook(id);
    if (!book) throw new NotFoundError(`price book ${id}`);
    return book;
  }

  private async requirePriceVersion(id: string): Promise<PriceVersion> {
    const version = await this.store.getPriceVersion(id);
    if (!version) throw new NotFoundError(`price version ${id}`);
    return version;
  }

  private async requirePricingRegion(code: string): Promise<PricingRegion> {
    const region = await this.store.getPricingRegion(code);
    if (!region) throw new NotFoundError(`pricing region ${code}`);
    return region;
  }

  /**
   * Reconcile a provider payment success onto a local invoice, deduped by
   * the immutable provider invoice/sale identity — never by event id.
   */
  private async reconcilePaymentSucceededInvoice(
    sub: Subscription,
    event: {
      amountMinor?: bigint | number;
      currency?: string;
      invoiceRef?: string;
      transactionRef?: string;
      externalEventId?: string;
    },
    identity: string,
  ): Promise<Invoice> {
    if (event.amountMinor === undefined || !event.currency) {
      throw new BillingError("provider payment success missing amount or currency");
    }
    const priceVersion = await this.requirePriceVersion(sub.priceVersionId);
    const expected = BigInt(priceVersion.amountMinor);
    if (BigInt(event.amountMinor) !== expected) {
      throw new BillingError(`provider renewal amount mismatch: got ${event.amountMinor} ${event.currency}, expected ${expected}`);
    }
    if (normalizeCurrency(event.currency) !== normalizeCurrency(priceVersion.currency)) {
      throw new BillingError(`provider renewal currency mismatch: ${event.currency} != ${priceVersion.currency}`);
    }
    if (expected > 0n && BigInt(event.amountMinor) === 0n) {
      throw new BillingError("zero-value provider payment cannot renew a paid plan");
    }

    const providerRef = event.invoiceRef ?? event.transactionRef;
    let invoice: Invoice | undefined;
    if (providerRef) invoice = await this.store.findInvoiceByProviderRef(providerRef);
    if (!invoice) {
      const periodStart = sub.currentPeriodEnd ?? sub.currentPeriodStart ?? new Date().toISOString();
      invoice = await this.store.findInvoiceByPeriodAttempt(sub.id, periodStart, 1);
    }
    if (!invoice) {
      const periodStart = sub.currentPeriodEnd ?? sub.currentPeriodStart ?? new Date().toISOString();
      invoice = await this.store.createInvoice({
        id: newId(),
        subscriptionId: sub.id,
        periodStart,
        periodEnd: new Date(new Date(periodStart).getTime() + this.periodDays * 24 * 3600 * 1000).toISOString(),
        amount: { currency: normalizeCurrency(event.currency)!, amountMinor: expected },
        status: "open",
        providerInvoiceRef: providerRef ?? identity,
        attempt: 1,
        createdAt: new Date().toISOString(),
      });
    }
    if (invoice.status === "paid") return invoice;
    if (
      normalizeCurrency(invoice.amount.currency) !== normalizeCurrency(event.currency) ||
      BigInt(invoice.amount.amountMinor) !== BigInt(event.amountMinor)
    ) {
      throw new BillingError("provider payment does not match existing invoice");
    }
    invoice.status = "paid";
    invoice.paidAt = new Date().toISOString();
    invoice.providerInvoiceRef = invoice.providerInvoiceRef ?? providerRef ?? identity;
    await this.store.updateInvoice(invoice);
    return invoice;
  }
}
