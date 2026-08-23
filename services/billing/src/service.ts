/**
 * Billing service (Prompt 08): the commercial authority for subscription
 * state. Core rule: a browser redirect never grants entitlements — only
 * verified provider webhooks/reconciliation activate paid state.
 */

import { convert, type Money } from "@mox/money";
import type { EntitlementService } from "@mox/entitlements";
import {
  BillingProvider,
  digestPayload,
  supportsReconciliation,
  UnconfiguredBillingProvider,
  WebhookVerificationError,
  type ProviderCheckoutResult,
} from "./provider.js";
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
  SubscriptionItem,
  SubscriptionState,
  SubscriptionTransition,
  WebhookRecord,
} from "./types.js";

export class BillingError extends Error {}
export class InvalidTransitionError extends BillingError {}
export class PriceUnavailableError extends BillingError {}
export class NotFoundError extends BillingError {}

/** Explicit, auditable subscription state machine. */
const ALLOWED_TRANSITIONS: Record<SubscriptionState, SubscriptionState[]> = {
  trial: ["active", "canceled", "suspended"],
  active: ["past_due", "canceled", "suspended"],
  past_due: ["active", "grace_period", "canceled", "suspended"],
  grace_period: ["active", "suspended", "canceled"],
  suspended: ["active", "canceled"],
  canceled: ["retention"],
  retention: ["deleted", "retention"],
  deleted: [],
};

export interface BillingServiceOptions {
  periodDays?: number;
  graceDays?: number;
  retentionDays?: number;
}

interface ResolvedPrice {
  priceVersionId?: string;
  amount: Money;
  mode: "fixed" | "fx_derived";
}

export class BillingService {
  readonly store: BillingStore;
  private readonly providers = new Map<string, BillingProvider>();
  private readonly periodDays: number;
  private readonly graceDays: number;
  private readonly retentionDays: number;

  constructor(
    store: BillingStore = new InMemoryBillingStore(),
    options: BillingServiceOptions = {},
  ) {
    this.store = store;
    this.periodDays = options.periodDays ?? 30;
    this.graceDays = options.graceDays ?? 7;
    this.retentionDays = options.retentionDays ?? 30;
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
      currency,
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
   * event id and by business effect; out-of-order events converge because
   * every application is guarded by current-state checks.
   */
  async handleProviderWebhook(
    providerName: string,
    headers: Record<string, string>,
    rawBody: string,
  ): Promise<{ applied: boolean; duplicate?: boolean; rejected?: boolean; reason?: string }> {
    const provider = this.provider(providerName);
    let event;
    try {
      event = await provider.verifyWebhook(headers, rawBody);
    } catch (error) {
      const reason = error instanceof WebhookVerificationError ? error.message : String(error);
      // Keep an auditable rejection record without trusting the payload.
      await this.store.recordWebhook({
        id: newId(),
        providerName,
        externalEventId: `rejected:${digestPayload(rawBody).slice(0, 32)}:${headers["x-mox-timestamp"] ?? ""}`,
        type: "unverified",
        payloadDigest: digestPayload(rawBody),
        status: "rejected",
        receivedAt: new Date().toISOString(),
        rejectionReason: reason,
      });
      return { applied: false, rejected: true, reason };
    }

    // Applied events are duplicates; rejected events may be redelivered.
    const existing = await this.store.getWebhook(providerName, event.externalEventId);
    if (existing?.status === "applied") {
      return { applied: false, duplicate: true };
    }

    let record: WebhookRecord;
    if (!existing) {
      const fresh = await this.store.recordWebhook({
        id: newId(),
        providerName,
        externalEventId: event.externalEventId,
        type: event.type,
        sequence: event.sequence,
        payloadDigest: digestPayload(rawBody),
        status: "verified",
        receivedAt: new Date().toISOString(),
      });
      if (!fresh) {
        return { applied: false, duplicate: true };
      }
      record = (await this.store.getWebhook(providerName, event.externalEventId))!;
    } else {
      record = existing;
      record.status = "verified";
      record.rejectionReason = undefined;
      record.payloadDigest = digestPayload(rawBody);
      await this.store.updateWebhook(record);
    }

    try {
      await this.applyProviderEvent(event.type, event.subjectRef, event.payload, {
        providerName,
        environment: provider.environment,
        externalEventId: event.externalEventId,
        subscriptionRef: event.subscriptionRef,
        occurredAt: event.occurredAt,
        amountMinor: event.amountMinor,
        currency: event.currency,
      });
      // Normalized durable ledger (Prompt 01 §Durable): exactly-once per
      // (provider, externalEventId), safe metadata only.
      await this.store.recordProviderPayment({
        id: newId(),
        providerName,
        environment: provider.environment,
        externalEventId: event.externalEventId,
        eventType: event.type,
        providerSubscriptionRef: event.subscriptionRef ?? undefined,
        checkoutSessionRef:
          event.type === "checkout.completed" ? event.subjectRef : undefined,
        state: "applied",
        currency: event.currency,
        amountMinor: event.amountMinor,
        payloadDigest: digestPayload(rawBody),
        occurredAt: event.occurredAt,
        receivedAt: new Date().toISOString(),
      });
      record.status = "applied";
      record.appliedAt = new Date().toISOString();
      await this.store.updateWebhook(record);
      return { applied: true };
    } catch (error) {
      record.status = "rejected";
      record.rejectionReason = error instanceof Error ? error.message : String(error);
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
    await this.applyCheckoutCompleted(session.providerRef, { checkoutSessionId: session.id }, {
      occurredAt: verification.occurredAt,
      amountMinor: verification.amountMinor,
      currency: verification.currency,
      environment: provider.environment,
    });
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
      payloadDigest: digestPayload(`${session.providerRef}:${verification.amountMinor ?? ""}`),
      occurredAt: verification.occurredAt,
      receivedAt: new Date().toISOString(),
      reconciledAt: new Date().toISOString(),
    });
    return { applied: true };
  }

  private async applyProviderEvent(type: string, subjectRef: string, payload: unknown, event?: {
    providerName?: string;
    environment?: string;
    externalEventId?: string;
    subscriptionRef?: string;
    occurredAt?: string;
    amountMinor?: bigint | number;
    currency?: string;
  }): Promise<void> {
    switch (type) {
      case "checkout.completed":
        await this.applyCheckoutCompleted(subjectRef, payload as { orgId?: string; checkoutSessionId?: string }, event);
        break;
      case "payment.succeeded": {
        const sub =
          (await this.store.findSubscriptionByProviderRef(subjectRef)) ??
          (event?.subscriptionRef ? await this.store.findSubscriptionByProviderRef(event.subscriptionRef) : undefined);
        if (!sub) throw new BillingError(`payment.succeeded for unknown subject ${subjectRef}`);
        // Out-of-order protection: older events never regress newer state.
        if (!this.eventIsCurrent(sub, event)) return;
        if (event?.subscriptionRef && sub.providerRef !== event.subscriptionRef) {
          sub.providerRef = event.subscriptionRef;
        }
        this.touchSubscriptionEvent(sub, event);
        await this.markLatestOpenInvoicePaid(sub.id);
        if (sub.state === "past_due" || sub.state === "grace_period" || sub.state === "suspended") {
          await this.transition(sub.id, "active", "payment_recovered", {
            idempotencyKey: `recover:${sub.currentPeriodStart ?? ""}`,
          });
          sub.failedRenewals = 0;
          sub.graceEndsAt = undefined;
          await this.store.updateSubscription(sub);
        } else if (sub.state === "trial") {
          await this.transition(sub.id, "active", "trial_converted", {});
          await this.store.updateSubscription(sub);
        } else if (sub.state === "active") {
          // Provider-managed renewal success advances the period server-side.
          const periodStart = sub.currentPeriodEnd ?? sub.currentPeriodStart ?? new Date().toISOString();
          sub.currentPeriodStart = periodStart;
          sub.currentPeriodEnd = new Date(
            new Date(periodStart).getTime() + this.periodDays * 24 * 3600 * 1000,
          ).toISOString();
          await this.store.updateSubscription(sub);
        } else {
          await this.store.updateSubscription(sub);
        }
        break;
      }
      case "payment.failed": {
        const sub =
          (await this.store.findSubscriptionByProviderRef(subjectRef)) ??
          (event?.subscriptionRef ? await this.store.findSubscriptionByProviderRef(event.subscriptionRef) : undefined);
        if (!sub) throw new BillingError(`payment.failed for unknown subject ${subjectRef}`);
        if (!this.eventIsCurrent(sub, event)) return;
        if (event?.subscriptionRef && sub.providerRef !== event.subscriptionRef) {
          sub.providerRef = event.subscriptionRef;
        }
        sub.failedRenewals += 1;
        this.touchSubscriptionEvent(sub, event);
        await this.store.updateSubscription(sub);
        if (sub.state === "active") {
          await this.transition(sub.id, "past_due", "payment_failed", {
            idempotencyKey: `fail:${sub.currentPeriodStart ?? ""}:${sub.failedRenewals}`,
          });
        }
        break;
      }
      case "subscription.canceled": {
        const sub =
          (await this.store.findSubscriptionByProviderRef(subjectRef)) ??
          (event?.subscriptionRef ? await this.store.findSubscriptionByProviderRef(event.subscriptionRef) : undefined);
        if (!sub) throw new BillingError(`subscription.canceled for unknown subject ${subjectRef}`);
        if (!this.eventIsCurrent(sub, event)) return;
        this.touchSubscriptionEvent(sub, event);
        await this.store.updateSubscription(sub);
        if (!["canceled", "retention", "deleted"].includes(sub.state)) {
          await this.cancelSubscription(sub.id, { actorType: "user", reason: "provider_canceled" });
        }
        break;
      }
      default:
        throw new BillingError(`unsupported provider event type ${type}`);
    }
  }

  /** Older events must never regress newer state (Prompt 01 §Ordering). */
  private eventIsCurrent(
    sub: Subscription,
    event?: { occurredAt?: string },
  ): boolean {
    if (!event?.occurredAt || !sub.lastEventAt) return true;
    return Date.parse(event.occurredAt) >= Date.parse(sub.lastEventAt);
  }

  private touchSubscriptionEvent(
    sub: Subscription,
    event?: { occurredAt?: string; providerName?: string; environment?: string },
  ): void {
    if (event?.occurredAt) sub.lastEventAt = event.occurredAt;
    if (event?.environment) sub.providerEnvironment = event.environment;
  }

  private async applyCheckoutCompleted(
    providerCheckoutRef: string,
    payload: { orgId?: string; checkoutSessionId?: string },
    event?: {
      subscriptionRef?: string;
      occurredAt?: string;
      amountMinor?: bigint | number;
      currency?: string;
      environment?: string;
    },
  ): Promise<void> {
    // Authoritative lookup: embedded id first, then the persisted provider
    // reference — never a process-local index (Prompt 00 §D2).
    let session: CheckoutSession | undefined;
    if (payload.checkoutSessionId) {
      session = await this.store.getCheckoutSession(payload.checkoutSessionId);
    }
    if (!session) {
      session = await this.store.findCheckoutSessionByProviderRef(providerCheckoutRef);
    }
    if (!session) throw new BillingError(`checkout.completed for unknown session ref ${providerCheckoutRef}`);
    if (session.state === "completed") return; // business-level dedupe

    // Concurrent delivery guard: only one application per session may run.
    // Synchronous set check/mark closes the await-boundary race.
    if (this.applyingCheckouts.has(session.id)) return;
    this.applyingCheckouts.add(session.id);
    try {
      const priceVersion = await this.requirePriceVersion(session.priceVersionId);
      // Wrong amount/currency guard (Prompt 01): the provider-reported money
      // must match the server-pinned price exactly, or the event is rejected.
      if (event?.amountMinor !== undefined) {
        const expected = BigInt(priceVersion.amountMinor);
        if (BigInt(event.amountMinor) !== expected) {
          throw new BillingError(
            `provider amount mismatch: got ${event.amountMinor} ${event.currency ?? ""}, expected ${expected}`,
          );
        }
      }
      if (event?.currency && event.currency !== priceVersion.currency) {
        throw new BillingError(`provider currency mismatch: ${event.currency} != ${priceVersion.currency}`);
      }
      session.state = "completed";
      session.environment = event?.environment ?? session.environment;
      await this.store.updateCheckoutSession(session);
      await this.ensureBillingCustomer(session.orgId, session.providerName);

      const now = new Date();
      const periodEnd = new Date(now.getTime() + this.periodDays * 24 * 3600 * 1000);
      const existingSub = await this.store.getActiveSubscriptionForOrg(session.orgId);
      if (existingSub) {
        existingSub.planVersionId = session.planVersionId;
        existingSub.priceVersionId = session.priceVersionId;
        existingSub.providerRef = providerCheckoutRef;
        existingSub.currentPeriodStart = now.toISOString();
        existingSub.currentPeriodEnd = periodEnd.toISOString();
        existingSub.failedRenewals = 0;
        existingSub.providerEnvironment = event?.environment ?? existingSub.providerEnvironment;
        if (event?.subscriptionRef) existingSub.providerRef = event.subscriptionRef;
        this.touchSubscriptionEvent(existingSub, { occurredAt: event?.occurredAt });
        await this.store.updateSubscription(existingSub);
        await this.transition(existingSub.id, "active", "checkout_completed", {
          idempotencyKey: `checkout:${session.id}`,
        });
        return;
      }

      // History-preserving creation (§D1): a canceled prior subscription
      // never blocks resubscribing — a NEW row starts here.
      const sub = await this.store.createSubscription({
        id: newId(),
        orgId: session.orgId,
        planVersionId: session.planVersionId,
        priceVersionId: session.priceVersionId,
        state: "trial",
        providerRef: event?.subscriptionRef ?? providerCheckoutRef,
        providerEnvironment: event?.environment,
        lastEventAt: event?.occurredAt,
        failedRenewals: 0,
        cancelAtPeriodEnd: false,
        currentPeriodStart: now.toISOString(),
        currentPeriodEnd: periodEnd.toISOString(),
        createdAt: now.toISOString(),
      });
      await this.store.addItem({
        id: newId(),
        subscriptionId: sub.id,
        kind: "base",
        quantity: 1,
        priceVersionId: priceVersion.id,
      });
      await this.transition(sub.id, "active", "checkout_completed", {
        idempotencyKey: `checkout:${session.id}`,
      });
    } finally {
      this.applyingCheckouts.delete(session.id);
    }
  }

  private readonly applyingCheckouts = new Set<string>();

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
    if (!recorded) return { applied: false };

    const nowIso = options.now ?? new Date().toISOString();
    sub.state = toState;
    if (toState === "suspended") sub.suspendedAt = nowIso;
    if (toState === "canceled") sub.canceledAt = nowIso;
    if (toState === "deleted") sub.deletedAt = nowIso;
    if (toState === "active") {
      sub.graceEndsAt = undefined;
      sub.suspendedAt = undefined;
    }
    await this.store.updateSubscription(sub);
    return { applied: true };
  }

  /**
   * Renewal sweep. Charges subscriptions whose period has ended:
   * success advances the period; failure walks active→past_due→grace_period;
   * expired grace suspends. Concurrent workers never double-process a
   * subscription (in-flight claim closes the await-boundary race).
   */
  private readonly renewingSubs = new Set<string>();

  async runRenewals(now?: string): Promise<{ renewed: number; failed: number; suspended: number }> {
    const at = now ?? new Date().toISOString();
    let renewed = 0;
    let failed = 0;
    let suspended = 0;

    const due = await this.store.listSubscriptionsInState(["active", "past_due", "grace_period"]);
    for (const sub of due) {
      if (!sub.currentPeriodEnd || sub.currentPeriodEnd > at || sub.providerRef === undefined) continue;
      // Claim synchronously so racing workers skip in-flight subscriptions.
      if (this.renewingSubs.has(sub.id)) continue;
      this.renewingSubs.add(sub.id);
      try {
        const outcome = await this.renewOne(sub, at);
        renewed += outcome.renewed;
        failed += outcome.failed;
      } finally {
        this.renewingSubs.delete(sub.id);
      }
    }

    // Suspend subscriptions whose grace window lapsed without payment.
    for (const sub of await this.store.listSubscriptionsInState(["grace_period"])) {
      if (sub.graceEndsAt && sub.graceEndsAt <= at) {
        await this.transition(sub.id, "suspended", "grace_expired_unpaid", { now: at });
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
    await this.store.updateSubscription(sub);
    if (sub.state === "active") {
      await this.transition(sub.id, "past_due", `renewal_failed:${charge.failureReason}`, {
        idempotencyKey: `renew-fail:${periodStart}:${attempt}`,
        now: at,
      });
    } else if (sub.state === "past_due" && attempt >= 2) {
      sub.graceEndsAt = new Date(new Date(at).getTime() + this.graceDays * 24 * 3600 * 1000).toISOString();
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

  async cancelSubscription(
    subscriptionId: string,
    options: { actorType?: SubscriptionTransition["actorType"]; actorId?: string; reason?: string; now?: string } = {},
  ): Promise<void> {
    await this.transition(subscriptionId, "canceled", options.reason ?? "cancel_requested", {
      actorType: options.actorType ?? "user",
      actorId: options.actorId,
      now: options.now,
    });
    const sub = await this.requireSubscription(subscriptionId);
    if (sub.providerRef) {
      const provider = this.providerForSubscription(sub);
      await provider.cancelRemote(sub.providerRef);
    }
  }

  async adminSuspend(subscriptionId: string, adminId: string, reason: string): Promise<void> {
    await this.transition(subscriptionId, "suspended", reason, { actorType: "admin", actorId: adminId });
  }

  async adminReactivate(subscriptionId: string, adminId: string): Promise<void> {
    const sub = await this.requireSubscription(subscriptionId);
    if (sub.state !== "suspended") throw new InvalidTransitionError("only suspended subscriptions can be reactivated");
    await this.transition(subscriptionId, "active", "admin_reactivated", { actorType: "admin", actorId: adminId });
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
    const name = sub.providerRef?.split(":")[0];
    if (!name) throw new BillingError(`subscription ${sub.id} lacks a provider reference`);
    return this.provider(name);
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

  private async markLatestOpenInvoicePaid(subscriptionId: string): Promise<void> {
    const invoices = await this.store.listInvoices(subscriptionId);
    const open = [...invoices].reverse().find((i) => i.status === "open" || i.status === "failed");
    if (!open) return;
    open.status = "paid";
    open.paidAt = new Date().toISOString();
    await this.store.updateInvoice(open);
  }
}
