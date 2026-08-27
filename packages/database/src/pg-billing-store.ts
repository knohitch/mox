import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Money } from "@mox/money";
import type { BillingStore } from "@mox/billing";
import type {
  AddonDefinition,
  BillingCustomer,
  CheckoutSession,
  CommercialReconciliationItem,
  Invoice,
  PriceBook,
  PriceVersion,
  PricingRegion,
  Product,
  PlanVersion,
  ProviderObjectMapping,
  ProviderPaymentRecord,
  ProviderRefundState,
  Subscription,
  SubscriptionCancellation,
  SubscriptionItem,
  SubscriptionTransition,
  WebhookRecord,
  BusinessEffectType,
} from "@mox/billing";
import type { MoxDb } from "./client.js";
import {
  addonDefinitions,
  billingCustomers,
  checkoutSessions,
  commercialReconciliationQueue,
  currencies,
  entitlementDefinitions,
  invoices,
  planEntitlementValues,
  planVersions,
  priceBooks,
  priceVersions,
  pricingRegions,
  products,
  providerBillingEffects,
  providerObjectMappings,
  providerPayments,
  providerPlanMappings,
  providerRefundStates,
  subscriptionCancellations,
  subscriptionItems,
  subscriptionTransitions,
  subscriptions,
  verifiedWebhookEvents,
} from "./schema/index.js";

/**
 * PostgreSQL billing store (Prompt 00 §C/§D): the durable authority behind
 * BillingService. Maps 1:1 onto schema/billing.ts. Money is bigint minor
 * units end-to-end; FX rates are stored as integers scaled by 1e9.
 */

const FX_SCALE = 1_000_000_000n;

/** Live subscription states mirrored from the partial unique index (§D1). */
type LiveSubscriptionState = "trial" | "active" | "past_due" | "grace_period" | "suspended";
const LIVE_STATES: readonly LiveSubscriptionState[] = [
  "trial",
  "active",
  "past_due",
  "grace_period",
  "suspended",
];

function iso(value: Date | null | undefined): string | undefined {
  return value ? value.toISOString() : undefined;
}

function date(value: string | null | undefined): Date | undefined {
  return value ? new Date(value) : undefined;
}

export class PgBillingStore implements BillingStore {
  constructor(private readonly db: MoxDb) {}

  // ---- Catalog -------------------------------------------------------------

  async createProduct(product: Product): Promise<Product> {
    await this.db.insert(products).values({
      id: asUuid(product.id),
      code: product.code,
      tier: product.tier,
      displayName: product.displayName,
    });
    return product;
  }

  async getProduct(id: string): Promise<Product | undefined> {
    const rows = await this.db.select().from(products).where(eq(products.id, asUuid(id))).limit(1);
    return rows[0] ? toProduct(rows[0]) : undefined;
  }

  async getProductByCode(code: string): Promise<Product | undefined> {
    const rows = await this.db.select().from(products).where(eq(products.code, code)).limit(1);
    return rows[0] ? toProduct(rows[0]) : undefined;
  }

  async listProducts(): Promise<Product[]> {
    const rows = await this.db.select().from(products);
    return rows.map(toProduct);
  }

  async createPlanVersion(version: PlanVersion): Promise<PlanVersion> {
    await this.db.insert(planVersions).values({
      id: asUuid(version.id),
      productId: asUuid(version.productId),
      version: version.version,
      status: version.status,
      createdAt: new Date(version.createdAt),
      activatedAt: date(version.activatedAt),
      retiredAt: date(version.retiredAt),
    });
    return version;
  }

  async getPlanVersion(id: string): Promise<PlanVersion | undefined> {
    const rows = await this.db.select().from(planVersions).where(eq(planVersions.id, asUuid(id))).limit(1);
    return rows[0] ? toPlanVersion(rows[0]) : undefined;
  }

  async listPlanVersions(productId: string): Promise<PlanVersion[]> {
    const rows = await this.db
      .select()
      .from(planVersions)
      .where(eq(planVersions.productId, asUuid(productId)))
      .orderBy(asc(planVersions.version));
    return rows.map(toPlanVersion);
  }

  async updatePlanVersion(version: PlanVersion): Promise<void> {
    await this.db
      .update(planVersions)
      .set({
        status: version.status,
        activatedAt: date(version.activatedAt),
        retiredAt: date(version.retiredAt),
      })
      .where(eq(planVersions.id, asUuid(version.id)));
  }

  /**
   * Transactional plan-entitlement replacement (Prompt 00B §E): keys and
   * value types are validated BEFORE any destructive change, and the
   * delete+insert runs in one PostgreSQL transaction so a failed insert
   * leaves the previous values fully intact.
   */
  async setPlanEntitlementValues(planVersionId: string, values: Record<string, boolean | number | string>): Promise<void> {
    const entries = Object.entries(values);
    await this.db.transaction(async (tx) => {
      const definitions = await tx.select().from(entitlementDefinitions);
      const known = new Map(definitions.map((d) => [d.key, d.valueType]));
      for (const [key, value] of entries) {
        const valueType = known.get(key);
        if (!valueType) throw new Error(`unknown entitlement key: ${key}`);
        assertValueMatchesType(key, valueType, value);
      }
      await tx.delete(planEntitlementValues).where(eq(planEntitlementValues.planVersionId, asUuid(planVersionId)));
      if (entries.length === 0) return;
      await tx.insert(planEntitlementValues).values(
        entries.map(([key, value]) => ({
          planVersionId: asUuid(planVersionId),
          key,
          value: value as unknown as object,
        })),
      );
    });
  }

  async getPlanEntitlementValues(planVersionId: string): Promise<Record<string, boolean | number | string>> {
    const rows = await this.db
      .select()
      .from(planEntitlementValues)
      .where(eq(planEntitlementValues.planVersionId, asUuid(planVersionId)));
    const out: Record<string, boolean | number | string> = {};
    for (const row of rows) out[row.key] = row.value as boolean | number | string;
    return out;
  }

  async definePricingRegion(region: PricingRegion): Promise<PricingRegion> {
    await this.db
      .insert(currencies)
      .values([
        { code: region.chargeCurrency, exponent: defaultExponent(region.chargeCurrency), displayName: region.chargeCurrency },
        { code: region.displayCurrency, exponent: defaultExponent(region.displayCurrency), displayName: region.displayCurrency },
      ])
      .onConflictDoNothing();
    await this.db.insert(pricingRegions).values({
      code: region.code,
      displayName: region.displayName,
      chargeCurrency: region.chargeCurrency,
      displayCurrency: region.displayCurrency,
    }).onConflictDoNothing();
    return region;
  }

  async getPricingRegion(code: string): Promise<PricingRegion | undefined> {
    const rows = await this.db.select().from(pricingRegions).where(eq(pricingRegions.code, code)).limit(1);
    return rows[0]
      ? {
          code: rows[0].code,
          displayName: rows[0].displayName,
          chargeCurrency: rows[0].chargeCurrency,
          displayCurrency: rows[0].displayCurrency,
        }
      : undefined;
  }

  async listPricingRegions(): Promise<PricingRegion[]> {
    const rows = await this.db.select().from(pricingRegions);
    return rows.map((r) => ({
      code: r.code,
      displayName: r.displayName,
      chargeCurrency: r.chargeCurrency,
      displayCurrency: r.displayCurrency,
    }));
  }

  async upsertPriceBook(book: PriceBook): Promise<PriceBook> {
    const values = {
      id: asUuid(book.id),
      productId: asUuid(book.productId),
      pricingRegion: book.pricingRegionCode,
      mode: book.mode,
      baseCurrency: book.baseCurrency ?? null,
      baseAmountMinor: book.baseAmountMinor !== undefined ? BigInt(book.baseAmountMinor) : null,
      fxRateScaled: book.fxRate !== undefined ? BigInt(Math.round(book.fxRate * Number(FX_SCALE))) : null,
    };
    await this.db
      .insert(priceBooks)
      .values(values)
      .onConflictDoUpdate({ target: priceBooks.id, set: values });
    return book;
  }

  async getPriceBook(id: string): Promise<PriceBook | undefined> {
    const rows = await this.db.select().from(priceBooks).where(eq(priceBooks.id, asUuid(id))).limit(1);
    return rows[0] ? toPriceBook(rows[0]) : undefined;
  }

  async findPriceBook(productId: string, pricingRegionCode: string): Promise<PriceBook | undefined> {
    const rows = await this.db
      .select()
      .from(priceBooks)
      .where(and(eq(priceBooks.productId, asUuid(productId)), eq(priceBooks.pricingRegion, pricingRegionCode)))
      .limit(1);
    return rows[0] ? toPriceBook(rows[0]) : undefined;
  }

  async listPriceBooks(productId: string): Promise<PriceBook[]> {
    const rows = await this.db.select().from(priceBooks).where(eq(priceBooks.productId, asUuid(productId)));
    return rows.map(toPriceBook);
  }

  async createPriceVersion(version: PriceVersion): Promise<PriceVersion> {
    await this.db.insert(priceVersions).values({
      id: asUuid(version.id),
      priceBookId: asUuid(version.priceBookId),
      version: version.version,
      amountMinor: BigInt(version.amountMinor),
      currency: version.currency,
      effectiveFrom: new Date(version.effectiveFrom),
      createdAt: new Date(version.createdAt),
    });
    return version;
  }

  async getPriceVersion(id: string): Promise<PriceVersion | undefined> {
    const rows = await this.db.select().from(priceVersions).where(eq(priceVersions.id, asUuid(id))).limit(1);
    return rows[0] ? toPriceVersion(rows[0]) : undefined;
  }

  async listPriceVersions(priceBookId: string): Promise<PriceVersion[]> {
    const rows = await this.db
      .select()
      .from(priceVersions)
      .where(eq(priceVersions.priceBookId, asUuid(priceBookId)))
      .orderBy(asc(priceVersions.version), asc(priceVersions.effectiveFrom));
    return rows.map(toPriceVersion);
  }

  async defineAddon(addon: AddonDefinition): Promise<AddonDefinition> {
    await this.db
      .insert(addonDefinitions)
      .values({
        code: addon.code,
        displayName: addon.displayName,
        consumable: addon.consumable,
        unit: addon.unit,
      })
      .onConflictDoNothing();
    return addon;
  }

  async getAddon(code: string): Promise<AddonDefinition | undefined> {
    const rows = await this.db.select().from(addonDefinitions).where(eq(addonDefinitions.code, code)).limit(1);
    return rows[0]
      ? {
          code: rows[0].code,
          displayName: rows[0].displayName,
          consumable: rows[0].consumable,
          unit: rows[0].unit,
        }
      : undefined;
  }

  // ---- Customers / subscriptions --------------------------------------------

  async upsertBillingCustomer(customer: BillingCustomer): Promise<BillingCustomer> {
    const values = {
      orgId: asUuid(customer.orgId),
      providerName: customer.providerName,
      providerCustomerId: customer.providerCustomerId,
      billingRegion: customer.billingRegion,
      defaultDisplayCurrency: customer.defaultDisplayCurrency ?? null,
    };
    await this.db
      .insert(billingCustomers)
      .values(values)
      .onConflictDoUpdate({
        target: [billingCustomers.orgId, billingCustomers.providerName],
        set: values,
      });
    return customer;
  }

  async getBillingCustomer(orgId: string, providerName: string): Promise<BillingCustomer | undefined> {
    const rows = await this.db
      .select()
      .from(billingCustomers)
      .where(and(eq(billingCustomers.orgId, asUuid(orgId)), eq(billingCustomers.providerName, providerName)))
      .limit(1);
    const row = rows[0];
    return row
      ? {
          orgId: row.orgId,
          providerName: row.providerName,
          providerCustomerId: row.providerCustomerId,
          billingRegion: row.billingRegion,
          defaultDisplayCurrency: row.defaultDisplayCurrency ?? undefined,
          createdAt: row.createdAt.toISOString(),
        }
      : undefined;
  }

  /**
   * History-preserving insert (§D1): canceled/deleted subscriptions remain;
   * the DB's partial unique index rejects a second LIVE row per org.
   */
  async createSubscription(subscription: Subscription): Promise<Subscription> {
    await this.db.insert(subscriptions).values(toSubscriptionRow(subscription));
    return subscription;
  }

  async getSubscription(id: string): Promise<Subscription | undefined> {
    const rows = await this.db.select().from(subscriptions).where(eq(subscriptions.id, asUuid(id))).limit(1);
    return rows[0] ? toSubscription(rows[0]) : undefined;
  }

  async getActiveSubscriptionForOrg(orgId: string): Promise<Subscription | undefined> {
    const rows = await this.db
      .select()
      .from(subscriptions)
      .where(and(eq(subscriptions.orgId, asUuid(orgId)), inArray(subscriptions.state, LIVE_STATES)))
      .limit(1);
    return rows[0] ? toSubscription(rows[0]) : undefined;
  }

  async findSubscriptionByProviderRef(providerRef: string): Promise<Subscription | undefined> {
    const rows = await this.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.providerRef, providerRef))
      .limit(1);
    return rows[0] ? toSubscription(rows[0]) : undefined;
  }

  async updateSubscription(subscription: Subscription): Promise<void> {
    const row = toSubscriptionRow(subscription);
    await this.db
      .update(subscriptions)
      .set({ ...row, updatedAt: new Date() })
      .where(eq(subscriptions.id, asUuid(subscription.id)));
  }

  async listSubscriptionsInState(states: string[]): Promise<Subscription[]> {
    const rows = await this.db
      .select()
      .from(subscriptions)
      .where(inArray(subscriptions.state, states as Subscription["state"][]));
    return rows.map(toSubscription);
  }

  /** Base items are idempotent (crash-replay); add-ons keep append semantics. */
  async addItem(item: SubscriptionItem): Promise<SubscriptionItem> {
    const inserted = await this.db
      .insert(subscriptionItems)
      .values({
        id: asUuid(item.id),
        subscriptionId: asUuid(item.subscriptionId),
        kind: item.kind,
        addonCode: item.addonCode ?? null,
        quantity: item.quantity,
        priceVersionId: item.priceVersionId ? asUuid(item.priceVersionId) : null,
      })
      .onConflictDoNothing()
      .returning({ id: subscriptionItems.id });
    if (inserted.length > 0) return item;
    const existing = await this.db
      .select()
      .from(subscriptionItems)
      .where(
        and(
          eq(subscriptionItems.subscriptionId, asUuid(item.subscriptionId)),
          eq(subscriptionItems.kind, "base"),
        ),
      )
      .limit(1);
    const row = existing[0];
    if (row) {
      return {
        id: row.id,
        subscriptionId: row.subscriptionId,
        kind: row.kind,
        addonCode: row.addonCode ?? undefined,
        quantity: row.quantity,
        priceVersionId: row.priceVersionId ?? undefined,
      };
    }
    return item;
  }

  async listItems(subscriptionId: string): Promise<SubscriptionItem[]> {
    const rows = await this.db
      .select()
      .from(subscriptionItems)
      .where(eq(subscriptionItems.subscriptionId, asUuid(subscriptionId)));
    return rows.map((row) => ({
      id: row.id,
      subscriptionId: row.subscriptionId,
      kind: row.kind,
      addonCode: row.addonCode ?? undefined,
      quantity: row.quantity,
      priceVersionId: row.priceVersionId ?? undefined,
    }));
  }

  /** Returns false when the same idempotency key was already applied. */
  async recordTransition(transition: SubscriptionTransition): Promise<boolean> {
    const inserted = await this.db
      .insert(subscriptionTransitions)
      .values({
        id: asUuid(transition.id),
        subscriptionId: asUuid(transition.subscriptionId),
        fromState: transition.fromState ?? null,
        toState: transition.toState,
        reason: transition.reason,
        actorType: transition.actorType,
        actorId: transition.actorId ?? null,
        idempotencyKey: transition.idempotencyKey ?? null,
        at: new Date(transition.at),
      })
      .onConflictDoNothing({
        target: [
          subscriptionTransitions.subscriptionId,
          subscriptionTransitions.idempotencyKey,
        ],
      })
      .returning({ id: subscriptionTransitions.id });
    return inserted.length > 0;
  }

  async listTransitions(subscriptionId: string): Promise<SubscriptionTransition[]> {
    const rows = await this.db
      .select()
      .from(subscriptionTransitions)
      .where(eq(subscriptionTransitions.subscriptionId, asUuid(subscriptionId)));
    return rows.map((row) => ({
      id: row.id,
      subscriptionId: row.subscriptionId,
      fromState: row.fromState ?? undefined,
      toState: row.toState,
      reason: row.reason,
      actorType: row.actorType as SubscriptionTransition["actorType"],
      actorId: row.actorId ?? undefined,
      idempotencyKey: row.idempotencyKey ?? undefined,
      at: row.at.toISOString(),
    }));
  }

  // ---- Checkout ----------------------------------------------------------------

  async createCheckoutSession(session: CheckoutSession): Promise<CheckoutSession> {
    await this.db.insert(checkoutSessions).values(toCheckoutRow(session));
    return session;
  }

  async getCheckoutSession(id: string): Promise<CheckoutSession | undefined> {
    const rows = await this.db.select().from(checkoutSessions).where(eq(checkoutSessions.id, asUuid(id))).limit(1);
    return rows[0] ? toCheckoutSession(rows[0]) : undefined;
  }

  async findCheckoutSessionsByOrg(orgId: string): Promise<CheckoutSession[]> {
    const rows = await this.db
      .select()
      .from(checkoutSessions)
      .where(eq(checkoutSessions.orgId, asUuid(orgId)));
    return rows.map(toCheckoutSession);
  }

  /** Authoritative provider-ref lookup persisted with the session (§D2). */
  async findCheckoutSessionByProviderRef(providerRef: string): Promise<CheckoutSession | undefined> {
    const rows = await this.db
      .select()
      .from(checkoutSessions)
      .where(eq(checkoutSessions.providerRef, providerRef))
      .limit(1);
    return rows[0] ? toCheckoutSession(rows[0]) : undefined;
  }

  async updateCheckoutSession(session: CheckoutSession): Promise<void> {
    await this.db
      .update(checkoutSessions)
      .set(toCheckoutRow(session))
      .where(eq(checkoutSessions.id, asUuid(session.id)));
  }

  async claimCheckoutSession(id: string, owner: string, leaseUntilIso: string, nowIso: string): Promise<CheckoutSession | undefined> {
    const rows = await this.db
      .update(checkoutSessions)
      .set({
        claimOwner: owner,
        claimExpiresAt: new Date(leaseUntilIso),
        // State machine: created/redirected → applying; crash-replay re-claims.
        state: "applying",
      })
      .where(
        and(
          eq(checkoutSessions.id, asUuid(id)),
          inArray(checkoutSessions.state, ["created", "redirected", "applying"]),
          sql`(${checkoutSessions.claimExpiresAt} IS NULL OR ${checkoutSessions.claimExpiresAt} <= ${new Date(nowIso)})`,
        ),
      )
      .returning();
    return rows[0] ? toCheckoutSession(rows[0]) : undefined;
  }

  // ---- Invoices ---------------------------------------------------------------

  async createInvoice(invoice: Invoice): Promise<Invoice> {
    await this.db.insert(invoices).values({
      id: asUuid(invoice.id),
      subscriptionId: asUuid(invoice.subscriptionId),
      periodStart: new Date(invoice.periodStart),
      periodEnd: new Date(invoice.periodEnd),
      amountMinor: invoice.amount.amountMinor,
      currency: invoice.amount.currency,
      status: invoice.status,
      providerInvoiceRef: invoice.providerInvoiceRef ?? null,
      attempt: invoice.attempt,
      createdAt: new Date(invoice.createdAt),
      paidAt: date(invoice.paidAt),
    });
    return invoice;
  }

  async getInvoice(id: string): Promise<Invoice | undefined> {
    const rows = await this.db.select().from(invoices).where(eq(invoices.id, asUuid(id))).limit(1);
    return rows[0] ? toInvoice(rows[0]) : undefined;
  }

  async findInvoiceByPeriodAttempt(subscriptionId: string, periodStart: string, attempt: number): Promise<Invoice | undefined> {
    const rows = await this.db
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.subscriptionId, asUuid(subscriptionId)),
          eq(invoices.periodStart, new Date(periodStart)),
          eq(invoices.attempt, attempt),
        ),
      )
      .limit(1);
    return rows[0] ? toInvoice(rows[0]) : undefined;
  }

  /** Business-effect dedupe anchor: one provider invoice ref = one row. */
  async findInvoiceByProviderRef(providerInvoiceRef: string): Promise<Invoice | undefined> {
    const rows = await this.db
      .select()
      .from(invoices)
      .where(eq(invoices.providerInvoiceRef, providerInvoiceRef))
      .limit(1);
    return rows[0] ? toInvoice(rows[0]) : undefined;
  }

  async updateInvoice(invoice: Invoice): Promise<void> {
    await this.db
      .update(invoices)
      .set({
        status: invoice.status,
        providerInvoiceRef: invoice.providerInvoiceRef ?? null,
        paidAt: date(invoice.paidAt),
      })
      .where(eq(invoices.id, asUuid(invoice.id)));
  }

  async listInvoices(subscriptionId: string): Promise<Invoice[]> {
    const rows = await this.db
      .select()
      .from(invoices)
      .where(eq(invoices.subscriptionId, asUuid(subscriptionId)))
      .orderBy(asc(invoices.createdAt));
    return rows.map(toInvoice);
  }

  // ---- Webhooks ---------------------------------------------------------------

  /** Returns false when this (provider, externalEventId) was already seen. */
  async recordWebhook(record: WebhookRecord): Promise<boolean> {
    const inserted = await this.db
      .insert(verifiedWebhookEvents)
      .values({
        id: asUuid(record.id),
        providerName: record.providerName,
        externalEventId: record.externalEventId,
        type: record.type,
        sequence: record.sequence ?? null,
        payloadDigest: record.payloadDigest,
        status: record.status,
        receivedAt: new Date(record.receivedAt),
        appliedAt: date(record.appliedAt),
        rejectionReason: record.rejectionReason ?? null,
      })
      .onConflictDoNothing({
        target: [verifiedWebhookEvents.providerName, verifiedWebhookEvents.externalEventId],
      })
      .returning({ id: verifiedWebhookEvents.id });
    return inserted.length > 0;
  }

  async getWebhook(providerName: string, externalEventId: string): Promise<WebhookRecord | undefined> {
    const rows = await this.db
      .select()
      .from(verifiedWebhookEvents)
      .where(
        and(
          eq(verifiedWebhookEvents.providerName, providerName),
          eq(verifiedWebhookEvents.externalEventId, externalEventId),
        ),
      )
      .limit(1);
    return rows[0] ? toWebhook(rows[0]) : undefined;
  }

  async updateWebhook(record: WebhookRecord): Promise<void> {
    await this.db
      .update(verifiedWebhookEvents)
      .set({
        type: record.type,
        payloadDigest: record.payloadDigest,
        status: record.status,
        appliedAt: date(record.appliedAt),
        processingOwner: record.status === "processing" ? (record.processingOwner ?? null) : null,
        processingExpiresAt: record.status === "processing" ? date(record.processingExpiresAt) : null,
        rejectionReason: record.rejectionReason ?? null,
        sequence: record.sequence ?? null,
      })
      .where(
        and(
          eq(verifiedWebhookEvents.providerName, record.providerName),
          eq(verifiedWebhookEvents.externalEventId, record.externalEventId),
        ),
      );
  }

  async claimWebhookApplication(record: WebhookRecord, owner: string, leaseUntilIso: string): Promise<"claimed" | "applied" | "busy"> {
    const values = {
      id: asUuid(record.id),
      providerName: record.providerName,
      externalEventId: record.externalEventId,
      type: record.type,
      sequence: record.sequence ?? null,
      payloadDigest: record.payloadDigest,
      status: "processing" as const,
      receivedAt: new Date(record.receivedAt),
      processingOwner: owner,
      processingExpiresAt: new Date(leaseUntilIso),
      rejectionReason: null,
    };
    const inserted = await this.db
      .insert(verifiedWebhookEvents)
      .values(values)
      .onConflictDoNothing({
        target: [verifiedWebhookEvents.providerName, verifiedWebhookEvents.externalEventId],
      })
      .returning({ id: verifiedWebhookEvents.id });
    if (inserted.length > 0) return "claimed";

    const existing = await this.getWebhook(record.providerName, record.externalEventId);
    if (existing?.status === "applied") return "applied";
    const updated = await this.db
      .update(verifiedWebhookEvents)
      .set({
        type: record.type,
        sequence: record.sequence ?? null,
        payloadDigest: record.payloadDigest,
        status: "processing",
        processingOwner: owner,
        processingExpiresAt: new Date(leaseUntilIso),
        rejectionReason: null,
      })
      .where(
        and(
          eq(verifiedWebhookEvents.providerName, record.providerName),
          eq(verifiedWebhookEvents.externalEventId, record.externalEventId),
          sql`${verifiedWebhookEvents.status} <> 'applied'`,
          sql`(${verifiedWebhookEvents.status} <> 'processing' OR ${verifiedWebhookEvents.processingExpiresAt} IS NULL OR ${verifiedWebhookEvents.processingExpiresAt} <= ${new Date(record.receivedAt)})`,
        ),
      )
      .returning({ id: verifiedWebhookEvents.id });
    return updated.length > 0 ? "claimed" : "busy";
  }

  /** Exactly-once ledger insert per (provider, externalEventId); the row's
   *  state carries the persisted outcome (applied/duplicate/…). */
  async recordProviderPayment(record: ProviderPaymentRecord): Promise<boolean> {
    const values = {
      providerName: record.providerName,
      environment: record.environment,
      externalEventId: record.externalEventId,
      eventType: record.eventType,
      orgId: record.orgId ?? null,
      providerSubscriptionRef: record.providerSubscriptionRef ?? null,
      checkoutSessionRef: record.checkoutSessionRef ?? null,
      providerTransactionRef: record.providerTransactionRef ?? null,
      invoiceRef: record.invoiceRef ?? null,
      providerPaymentIntentRef: record.providerPaymentIntentRef ?? null,
      providerChargeRef: record.providerChargeRef ?? null,
      providerCustomerRef: record.providerCustomerRef ?? null,
      billingIdentity: record.billingIdentity ?? null,
      state: record.state,
      currency: record.currency ?? null,
      amountMinor:
        record.amountMinor !== undefined ? BigInt(record.amountMinor) : null,
      payloadDigest: record.payloadDigest,
      occurredAt: date(record.occurredAt),
      receivedAt: new Date(record.receivedAt),
      reconciledAt: date(record.reconciledAt),
    };
    const inserted = await this.db
      .insert(providerPayments)
      .values(values)
      .onConflictDoNothing({
        target: [providerPayments.providerName, providerPayments.externalEventId],
      })
      .returning({ id: providerPayments.id });
    if (inserted.length === 0) {
      // Re-processed event: the persisted outcome advances to the newest
      // conclusion (e.g. reconciliation_required → applied).
      await this.db
        .update(providerPayments)
        .set({
          state: record.state,
          orgId: record.orgId ?? null,
          billingIdentity: record.billingIdentity ?? null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(providerPayments.providerName, record.providerName),
            eq(providerPayments.externalEventId, record.externalEventId),
          ),
        );
    }
    return inserted.length > 0;
  }

  async listProviderPayments(orgId: string): Promise<ProviderPaymentRecord[]> {
    const rows = await this.db
      .select()
      .from(providerPayments)
      .where(eq(providerPayments.orgId, orgId))
      .orderBy(asc(providerPayments.receivedAt));
    return rows.map((row) => ({
      id: row.id,
      providerName: row.providerName,
      environment: row.environment,
      externalEventId: row.externalEventId,
      eventType: row.eventType,
      orgId: row.orgId ?? undefined,
      providerSubscriptionRef: row.providerSubscriptionRef ?? undefined,
      checkoutSessionRef: row.checkoutSessionRef ?? undefined,
      providerTransactionRef: row.providerTransactionRef ?? undefined,
      invoiceRef: row.invoiceRef ?? undefined,
      providerPaymentIntentRef: row.providerPaymentIntentRef ?? undefined,
      providerChargeRef: row.providerChargeRef ?? undefined,
      providerCustomerRef: row.providerCustomerRef ?? undefined,
      billingIdentity: row.billingIdentity ?? undefined,
      state: row.state,
      currency: row.currency ?? undefined,
      amountMinor: row.amountMinor ?? undefined,
      payloadDigest: row.payloadDigest,
      occurredAt: iso(row.occurredAt),
      receivedAt: row.receivedAt.toISOString(),
      reconciledAt: iso(row.reconciledAt),
    }));
  }

  async claimSubscriptionRenewal(id: string, periodEndIso: string, owner: string, leaseUntilIso: string, nowIso: string): Promise<Subscription | undefined> {
    const rows = await this.db
      .update(subscriptions)
      .set({
        renewalClaimOwner: owner,
        renewalClaimExpiresAt: new Date(leaseUntilIso),
        renewalClaimVersion: sql`coalesce(${subscriptions.renewalClaimVersion}, 0) + 1`,
        updatedAt: new Date(nowIso),
      })
      .where(
        and(
          eq(subscriptions.id, asUuid(id)),
          eq(subscriptions.currentPeriodEnd, new Date(periodEndIso)),
          inArray(subscriptions.state, ["active", "past_due", "grace_period"]),
          sql`(${subscriptions.renewalClaimExpiresAt} IS NULL OR ${subscriptions.renewalClaimExpiresAt} <= ${new Date(nowIso)})`,
        ),
      )
      .returning();
    return rows[0] ? toSubscription(rows[0]) : undefined;
  }

  /**
   * Security Repair 05B §A: fenced renewal writeback — the update applies
   * only while the renewal claim (owner + version) is still held. A stale
   * worker whose lease was stolen updates zero rows and must stop.
   */
  async completeSubscriptionRenewal(sub: Subscription, expectedClaimVersion: number): Promise<boolean> {
    const ownerMatch = sub.renewalClaimOwner
      ? eq(subscriptions.renewalClaimOwner, sub.renewalClaimOwner)
      : isNull(subscriptions.renewalClaimOwner);
    const updated = await this.db
      .update(subscriptions)
      .set({
        ...toSubscriptionRow({ ...sub, renewalClaimOwner: undefined, renewalClaimExpiresAt: undefined }),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(subscriptions.id, asUuid(sub.id)),
          ownerMatch,
          eq(subscriptions.renewalClaimVersion, BigInt(expectedClaimVersion)),
        ),
      )
      .returning({ id: subscriptions.id });
    return updated.length > 0;
  }

  // ---- Security Repair 05A: provider-object mappings (finding A) ---------------

  private static readonly MAPPING_REF_FIELDS = [
    "checkoutSessionRef",
    "providerSubscriptionRef",
    "providerInvoiceRef",
    "providerPaymentRef",
    "providerPaymentIntentRef",
    "providerChargeRef",
  ] as const;

  async upsertProviderObjectMapping(mapping: ProviderObjectMapping): Promise<void> {
    const refs = PgBillingStore.MAPPING_REF_FIELDS
      .map((field) => ({ field, value: mapping[field] }))
      .filter((entry): entry is { field: (typeof PgBillingStore.MAPPING_REF_FIELDS)[number]; value: string } => entry.value !== undefined);
    if (refs.length === 0) return;

    await this.db.transaction(async (tx) => {
      const refConditions = refs.map(({ field, value }) =>
        eq(PgBillingStore.columnForRef(field), value),
      );
      const matched = await tx
        .select()
        .from(providerObjectMappings)
        .where(
          and(
            eq(providerObjectMappings.providerName, mapping.providerName),
            eq(providerObjectMappings.environment, mapping.environment),
            or(...refConditions),
          ),
        );
      const bySub = mapping.subscriptionId
        ? await tx
            .select()
            .from(providerObjectMappings)
            .where(
              and(
                eq(providerObjectMappings.providerName, mapping.providerName),
                eq(providerObjectMappings.environment, mapping.environment),
                eq(providerObjectMappings.subscriptionId, asUuid(mapping.subscriptionId)),
              ),
            )
        : [];
      const byOrg = !mapping.subscriptionId && mapping.orgId
        ? await tx
            .select()
            .from(providerObjectMappings)
            .where(
              and(
                eq(providerObjectMappings.providerName, mapping.providerName),
                eq(providerObjectMappings.environment, mapping.environment),
                eq(providerObjectMappings.orgId, asUuid(mapping.orgId)),
              ),
            )
        : [];
      const seen = new Map<string, typeof matched[number]>();
      for (const row of [...matched, ...bySub, ...byOrg]) seen.set(row.id, row);
      const all = [...seen.values()];

      const subIds = new Set(all.map((r) => r.subscriptionId).filter(Boolean));
      const orgIds = new Set(all.map((r) => r.orgId).filter(Boolean));
      const conflict = subIds.size > 1 || (subIds.size === 0 && orgIds.size > 1);
      if (conflict) {
        // Refs that would join two different local subscriptions/orgs can
        // never be guessed: mark every involved row reconciliation-required.
        for (const row of all) {
          await tx
            .update(providerObjectMappings)
            .set({ resolutionState: "reconciliation_required", updatedAt: new Date() })
            .where(eq(providerObjectMappings.id, row.id));
        }
        return;
      }

      type MappingRow = typeof providerObjectMappings.$inferSelect;
      let target: MappingRow | undefined =
        all.find((r) => mapping.subscriptionId && r.subscriptionId === asUuid(mapping.subscriptionId)) ??
        all.find((r) => mapping.orgId && r.orgId === asUuid(mapping.orgId)) ??
        all[0];

      if (!target) {
        const inserted = await tx
          .insert(providerObjectMappings)
          .values({
            providerName: mapping.providerName,
            environment: mapping.environment,
            orgId: mapping.orgId ? asUuid(mapping.orgId) : null,
            subscriptionId: mapping.subscriptionId ? asUuid(mapping.subscriptionId) : null,
            providerCustomerRef: mapping.providerCustomerRef ?? null,
            checkoutSessionRef: mapping.checkoutSessionRef ?? null,
            providerSubscriptionRef: mapping.providerSubscriptionRef ?? null,
            providerInvoiceRef: mapping.providerInvoiceRef ?? null,
            providerPaymentRef: mapping.providerPaymentRef ?? null,
            providerPaymentIntentRef: mapping.providerPaymentIntentRef ?? null,
            providerChargeRef: mapping.providerChargeRef ?? null,
            resolutionState: "resolved",
          })
          .onConflictDoNothing()
          .returning();
        if (inserted.length === 0) return;
        target = inserted[0]!;
      }

      // Merge every other matched row into the target (fill empty refs),
      // then drop the merged rows.
      let current: MappingRow = target;
      for (const row of all) {
        if (row.id === current.id) continue;
        const merged: MappingRow = {
          ...current,
          checkoutSessionRef: current.checkoutSessionRef ?? row.checkoutSessionRef,
          providerSubscriptionRef: current.providerSubscriptionRef ?? row.providerSubscriptionRef,
          providerInvoiceRef: current.providerInvoiceRef ?? row.providerInvoiceRef,
          providerPaymentRef: current.providerPaymentRef ?? row.providerPaymentRef,
          providerPaymentIntentRef: current.providerPaymentIntentRef ?? row.providerPaymentIntentRef,
          providerChargeRef: current.providerChargeRef ?? row.providerChargeRef,
          providerCustomerRef: current.providerCustomerRef ?? row.providerCustomerRef,
          orgId: current.orgId ?? row.orgId,
          subscriptionId: current.subscriptionId ?? row.subscriptionId,
        };
        await tx
          .update(providerObjectMappings)
          .set({
            checkoutSessionRef: merged.checkoutSessionRef,
            providerSubscriptionRef: merged.providerSubscriptionRef,
            providerInvoiceRef: merged.providerInvoiceRef,
            providerPaymentRef: merged.providerPaymentRef,
            providerPaymentIntentRef: merged.providerPaymentIntentRef,
            providerChargeRef: merged.providerChargeRef,
            providerCustomerRef: merged.providerCustomerRef,
            orgId: merged.orgId,
            subscriptionId: merged.subscriptionId,
            updatedAt: new Date(),
          })
          .where(eq(providerObjectMappings.id, current.id));
        current = merged;
        await tx.delete(providerObjectMappings).where(eq(providerObjectMappings.id, row.id));
      }

      // Apply the incoming refs onto the surviving target.
      const incoming = {
        checkoutSessionRef: current.checkoutSessionRef ?? mapping.checkoutSessionRef ?? null,
        providerSubscriptionRef: current.providerSubscriptionRef ?? mapping.providerSubscriptionRef ?? null,
        providerInvoiceRef: current.providerInvoiceRef ?? mapping.providerInvoiceRef ?? null,
        providerPaymentRef: current.providerPaymentRef ?? mapping.providerPaymentRef ?? null,
        providerPaymentIntentRef: current.providerPaymentIntentRef ?? mapping.providerPaymentIntentRef ?? null,
        providerChargeRef: current.providerChargeRef ?? mapping.providerChargeRef ?? null,
        providerCustomerRef: current.providerCustomerRef ?? mapping.providerCustomerRef ?? null,
        orgId: current.orgId ?? (mapping.orgId ? asUuid(mapping.orgId) : null),
        subscriptionId: current.subscriptionId ?? (mapping.subscriptionId ? asUuid(mapping.subscriptionId) : null),
      };
      await tx
        .update(providerObjectMappings)
        .set({ ...incoming, updatedAt: new Date() })
        .where(eq(providerObjectMappings.id, current.id));
    });
  }

  private static columnForRef(field: (typeof PgBillingStore.MAPPING_REF_FIELDS)[number]) {
    switch (field) {
      case "checkoutSessionRef":
        return providerObjectMappings.checkoutSessionRef;
      case "providerSubscriptionRef":
        return providerObjectMappings.providerSubscriptionRef;
      case "providerInvoiceRef":
        return providerObjectMappings.providerInvoiceRef;
      case "providerPaymentRef":
        return providerObjectMappings.providerPaymentRef;
      case "providerPaymentIntentRef":
        return providerObjectMappings.providerPaymentIntentRef;
      case "providerChargeRef":
        return providerObjectMappings.providerChargeRef;
    }
  }

  async findProviderObjectMappings(
    providerName: string,
    environment: string,
    refs: {
      checkoutSessionRef?: string;
      providerSubscriptionRef?: string;
      providerInvoiceRef?: string;
      providerPaymentRef?: string;
      providerPaymentIntentRef?: string;
      providerChargeRef?: string;
    },
  ): Promise<ProviderObjectMapping[]> {
    const conditions: ReturnType<typeof eq>[] = [];
    if (refs.checkoutSessionRef) conditions.push(eq(providerObjectMappings.checkoutSessionRef, refs.checkoutSessionRef));
    if (refs.providerSubscriptionRef) conditions.push(eq(providerObjectMappings.providerSubscriptionRef, refs.providerSubscriptionRef));
    if (refs.providerInvoiceRef) conditions.push(eq(providerObjectMappings.providerInvoiceRef, refs.providerInvoiceRef));
    if (refs.providerPaymentRef) conditions.push(eq(providerObjectMappings.providerPaymentRef, refs.providerPaymentRef));
    if (refs.providerPaymentIntentRef) conditions.push(eq(providerObjectMappings.providerPaymentIntentRef, refs.providerPaymentIntentRef));
    if (refs.providerChargeRef) conditions.push(eq(providerObjectMappings.providerChargeRef, refs.providerChargeRef));
    if (conditions.length === 0) return [];
    const rows = await this.db
      .select()
      .from(providerObjectMappings)
      .where(
        and(
          eq(providerObjectMappings.providerName, providerName),
          eq(providerObjectMappings.environment, environment),
          or(...conditions),
        ),
      );
    return rows.map(toProviderObjectMapping);
  }

  // ---- Security Repair 05A: business-effect idempotency (finding B) ---------------

  async claimProviderBillingEffect(input: {
    providerName: string;
    environment: string;
    billingIdentity: string;
    effectType: BusinessEffectType;
    subscriptionId?: string;
    externalEventId: string;
  }): Promise<boolean> {
    const inserted = await this.db
      .insert(providerBillingEffects)
      .values({
        providerName: input.providerName,
        environment: input.environment,
        billingIdentity: input.billingIdentity,
        effectType: input.effectType,
        subscriptionId: input.subscriptionId ? asUuid(input.subscriptionId) : null,
        outcome: "applied",
        externalEventId: input.externalEventId,
      })
      .onConflictDoNothing({
        target: [
          providerBillingEffects.providerName,
          providerBillingEffects.environment,
          providerBillingEffects.billingIdentity,
          providerBillingEffects.effectType,
        ],
      })
      .returning({ id: providerBillingEffects.id });
    return inserted.length > 0;
  }

  async hasAppliedFinancialEffect(subscriptionId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: providerBillingEffects.id })
      .from(providerBillingEffects)
      .where(
        and(
          eq(providerBillingEffects.subscriptionId, asUuid(subscriptionId)),
          eq(providerBillingEffects.outcome, "applied"),
          inArray(providerBillingEffects.effectType, ["checkout_grant", "period_extension"]),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async advanceProviderRefundState(input: {
    providerName: string;
    environment: string;
    billingIdentity: string;
    subscriptionId: string;
    cumulativeAmountMinor: bigint;
    externalEventId: string;
  }): Promise<{ advanced: boolean; state: ProviderRefundState }> {
    // Serialize one provider billing identity even while the row does not yet
    // exist. A transaction-scoped advisory lock closes the first-insert race;
    // the durable row then carries the monotonic maximum across workers and
    // restarts. Hash collisions only add contention — they cannot weaken the
    // authority invariant.
    return this.db.transaction(async (tx) => {
      const authorityKey = JSON.stringify([input.providerName, input.environment, input.billingIdentity]);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${authorityKey}))`);

      const existingRows = await tx
        .select()
        .from(providerRefundStates)
        .where(
          and(
            eq(providerRefundStates.providerName, input.providerName),
            eq(providerRefundStates.environment, input.environment),
            eq(providerRefundStates.billingIdentity, input.billingIdentity),
          ),
        )
        .limit(1);
      const existing = existingRows[0];
      if (existing && !existing.subscriptionId) {
        // ON DELETE SET NULL intentionally preserves financial history. Once
        // that binding is gone, never attach the old provider charge to a
        // different subscription by inference. Reconciliation must resolve it.
        throw new Error("provider refund identity no longer has a durable subscription binding");
      }
      if (existing?.subscriptionId && existing.subscriptionId !== input.subscriptionId) {
        throw new Error("provider refund identity is already bound to another subscription");
      }

      let advanced = false;
      let row = existing;
      if (!row) {
        const inserted = await tx
          .insert(providerRefundStates)
          .values({
            providerName: input.providerName,
            environment: input.environment,
            billingIdentity: input.billingIdentity,
            subscriptionId: asUuid(input.subscriptionId),
            cumulativeAmountMinor: input.cumulativeAmountMinor,
            externalEventId: input.externalEventId,
          })
          .returning();
        row = inserted[0];
        advanced = true;
      } else if (input.cumulativeAmountMinor > row.cumulativeAmountMinor) {
        const updated = await tx
          .update(providerRefundStates)
          .set({
            cumulativeAmountMinor: input.cumulativeAmountMinor,
            subscriptionId: row.subscriptionId ?? asUuid(input.subscriptionId),
            externalEventId: input.externalEventId,
            updatedAt: new Date(),
          })
          .where(eq(providerRefundStates.id, row.id))
          .returning();
        row = updated[0];
        advanced = true;
      }
      if (!row) throw new Error("failed to establish provider refund state");
      return {
        advanced,
        state: {
          providerName: row.providerName,
          environment: row.environment,
          billingIdentity: row.billingIdentity,
          subscriptionId: row.subscriptionId ?? undefined,
          cumulativeAmountMinor: row.cumulativeAmountMinor,
          externalEventId: row.externalEventId,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        },
      };
    });
  }

  async recordRefundObservation(
    subscriptionId: string,
    occurredAt: string | undefined,
    reconciliationRequired: boolean,
  ): Promise<void> {
    const observed = occurredAt ? new Date(occurredAt) : undefined;
    await this.db
      .update(subscriptions)
      .set({
        updatedAt: new Date(),
        ...(reconciliationRequired ? { reconciliationRequired: true } : {}),
        ...(observed
          ? {
              lastEventAt: sql`CASE
                WHEN ${subscriptions.lastEventAt} IS NULL OR ${subscriptions.lastEventAt} < ${observed}
                  THEN ${observed}
                ELSE ${subscriptions.lastEventAt}
              END`,
            }
          : {}),
      })
      .where(eq(subscriptions.id, asUuid(subscriptionId)));
  }

  // ---- Security Repair 05A: cancellations (finding H) -------------------------------

  async upsertSubscriptionCancellation(record: SubscriptionCancellation): Promise<SubscriptionCancellation> {
    const values = {
      state: record.state,
      requestedBy: record.requestedBy,
      requestedById: record.requestedById ?? null,
      attempts: record.attempts,
      lastError: record.lastError ?? null,
      nextAttemptAt: date(record.nextAttemptAt),
      updatedAt: new Date(),
    };
    await this.db
      .insert(subscriptionCancellations)
      .values({
        subscriptionId: asUuid(record.subscriptionId),
        ...values,
      })
      .onConflictDoUpdate({
        target: subscriptionCancellations.subscriptionId,
        set: values,
      });
    return record;
  }

  async getSubscriptionCancellation(subscriptionId: string): Promise<SubscriptionCancellation | undefined> {
    const rows = await this.db
      .select()
      .from(subscriptionCancellations)
      .where(eq(subscriptionCancellations.subscriptionId, asUuid(subscriptionId)))
      .limit(1);
    const row = rows[0];
    return row
      ? {
          subscriptionId: row.subscriptionId,
          state: row.state as SubscriptionCancellation["state"],
          requestedBy: row.requestedBy,
          requestedById: row.requestedById ?? undefined,
          attempts: row.attempts,
          lastError: row.lastError ?? undefined,
          nextAttemptAt: iso(row.nextAttemptAt),
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        }
      : undefined;
  }

  async listDueCancellationRetries(nowIso: string, limit: number): Promise<SubscriptionCancellation[]> {
    const rows = await this.db
      .select()
      .from(subscriptionCancellations)
      .where(
        and(
          inArray(subscriptionCancellations.state, ["provider_cancel_pending", "reconciliation_required"]),
          sql`(${subscriptionCancellations.nextAttemptAt} IS NULL OR ${subscriptionCancellations.nextAttemptAt} <= ${new Date(nowIso)})`,
        ),
      )
      .limit(limit);
    return rows.map((row) => ({
      subscriptionId: row.subscriptionId,
      state: row.state as SubscriptionCancellation["state"],
      requestedBy: row.requestedBy,
      requestedById: row.requestedById ?? undefined,
      attempts: row.attempts,
      lastError: row.lastError ?? undefined,
      nextAttemptAt: iso(row.nextAttemptAt),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  // ---- Security Repair 05A: commercial reconciliation queue (finding A) ---------------

  async enqueueCommercialReconciliation(subscriptionId: string, reason: string): Promise<void> {
    await this.db
      .insert(commercialReconciliationQueue)
      .values({ subscriptionId: asUuid(subscriptionId), reason })
      .onConflictDoUpdate({
        target: commercialReconciliationQueue.subscriptionId,
        set: { reason, updatedAt: new Date() },
      });
  }

  async dequeueCommercialReconciliations(limit: number): Promise<CommercialReconciliationItem[]> {
    const rows = await this.db
      .select()
      .from(commercialReconciliationQueue)
      .orderBy(asc(commercialReconciliationQueue.enqueuedAt))
      .limit(limit);
    return rows.map((row) => ({
      subscriptionId: row.subscriptionId,
      reason: row.reason,
      enqueuedAt: row.enqueuedAt.toISOString(),
    }));
  }

  async ackCommercialReconciliation(subscriptionId: string): Promise<void> {
    await this.db
      .delete(commercialReconciliationQueue)
      .where(eq(commercialReconciliationQueue.subscriptionId, asUuid(subscriptionId)));
  }

  // ---- Security Repair 05A: rejected-webhook retention (finding G) ---------------------

  async purgeRejectedWebhooks(beforeIso: string): Promise<number> {
    const result = await this.db
      .delete(verifiedWebhookEvents)
      .where(
        and(
          eq(verifiedWebhookEvents.status, "rejected"),
          sql`${verifiedWebhookEvents.receivedAt} < ${new Date(beforeIso)}`,
        ),
      )
      .returning({ id: verifiedWebhookEvents.id });
    return result.length;
  }

  async findProviderPlanMapping(
    providerName: string,
    environment: string,
    providerPlanRef: string,
  ): Promise<{ moxPriceVersionId: string; productId: string } | undefined> {
    const rows = await this.db
      .select()
      .from(providerPlanMappings)
      .where(
        and(
          eq(providerPlanMappings.providerName, providerName),
          eq(providerPlanMappings.environment, environment),
          eq(providerPlanMappings.providerPlanRef, providerPlanRef),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row ? { moxPriceVersionId: row.moxPriceVersionId, productId: row.productId } : undefined;
  }
}

// ---- Row mappers -----------------------------------------------------------

type ProductRow = typeof products.$inferSelect;
type PlanVersionRow = typeof planVersions.$inferSelect;
type PriceBookRow = typeof priceBooks.$inferSelect;
type PriceVersionRow = typeof priceVersions.$inferSelect;
type SubscriptionRow = typeof subscriptions.$inferSelect;
type CheckoutRow = typeof checkoutSessions.$inferSelect;
type InvoiceRow = typeof invoices.$inferSelect;
type WebhookRow = typeof verifiedWebhookEvents.$inferSelect;

function toProduct(row: ProductRow): Product {
  return { id: row.id, code: row.code, tier: row.tier, displayName: row.displayName };
}

function toPlanVersion(row: PlanVersionRow): PlanVersion {
  return {
    id: row.id,
    productId: row.productId,
    version: row.version,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    activatedAt: iso(row.activatedAt),
    retiredAt: iso(row.retiredAt),
  };
}

function toPriceBook(row: PriceBookRow): PriceBook {
  return {
    id: row.id,
    productId: row.productId,
    pricingRegionCode: row.pricingRegion,
    mode: row.mode,
    baseCurrency: row.baseCurrency ?? undefined,
    baseAmountMinor: row.baseAmountMinor ?? undefined,
    fxRate: row.fxRateScaled !== null ? Number(row.fxRateScaled) / Number(FX_SCALE) : undefined,
  };
}

function toPriceVersion(row: PriceVersionRow): PriceVersion {
  return {
    id: row.id,
    priceBookId: row.priceBookId,
    version: row.version,
    amountMinor: row.amountMinor,
    currency: row.currency,
    effectiveFrom: row.effectiveFrom.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

function toSubscriptionRow(sub: Subscription) {
  return {
    id: asUuid(sub.id),
    orgId: asUuid(sub.orgId),
    planVersionId: asUuid(sub.planVersionId),
    priceVersionId: asUuid(sub.priceVersionId),
    state: sub.state,
    providerName: sub.providerName ?? null,
    providerRef: sub.providerRef ?? null,
    providerEnvironment: sub.providerEnvironment ?? null,
    lastEventAt: date(sub.lastEventAt),
    currentPeriodStart: date(sub.currentPeriodStart),
    currentPeriodEnd: date(sub.currentPeriodEnd),
    trialEndsAt: date(sub.trialEndsAt),
    graceEndsAt: date(sub.graceEndsAt),
    retentionUntil: date(sub.retentionUntil),
    failedRenewals: sub.failedRenewals,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    suspensionReason: sub.suspensionReason ?? null,
    suspensionSource: sub.suspensionSource ?? null,
    reconciliationRequired: sub.reconciliationRequired ?? false,
    providerPlanRef: sub.providerPlanRef ?? null,
    renewalClaimOwner: sub.renewalClaimOwner ?? null,
    renewalClaimExpiresAt: date(sub.renewalClaimExpiresAt),
    renewalClaimVersion: BigInt(sub.renewalClaimVersion ?? 0),
    canceledAt: date(sub.canceledAt),
    suspendedAt: date(sub.suspendedAt),
    deletedAt: date(sub.deletedAt),
  };
}

function toSubscription(row: SubscriptionRow): Subscription {
  return {
    id: row.id,
    orgId: row.orgId,
    planVersionId: row.planVersionId,
    priceVersionId: row.priceVersionId,
    state: row.state,
    providerName: row.providerName ?? undefined,
    providerRef: row.providerRef ?? undefined,
    providerEnvironment: row.providerEnvironment ?? undefined,
    lastEventAt: iso(row.lastEventAt),
    currentPeriodStart: iso(row.currentPeriodStart),
    currentPeriodEnd: iso(row.currentPeriodEnd),
    trialEndsAt: iso(row.trialEndsAt),
    graceEndsAt: iso(row.graceEndsAt),
    retentionUntil: iso(row.retentionUntil),
    failedRenewals: row.failedRenewals,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    suspensionReason: row.suspensionReason ?? undefined,
    suspensionSource: row.suspensionSource ?? undefined,
    reconciliationRequired: row.reconciliationRequired,
    providerPlanRef: row.providerPlanRef ?? undefined,
    renewalClaimOwner: row.renewalClaimOwner ?? undefined,
    renewalClaimExpiresAt: iso(row.renewalClaimExpiresAt),
    renewalClaimVersion: Number(row.renewalClaimVersion ?? 0),
    canceledAt: iso(row.canceledAt),
    suspendedAt: iso(row.suspendedAt),
    deletedAt: iso(row.deletedAt),
    createdAt: row.createdAt.toISOString(),
  };
}

function toCheckoutRow(session: CheckoutSession) {
  return {
    id: asUuid(session.id),
    orgId: asUuid(session.orgId),
    planVersionId: asUuid(session.planVersionId),
    priceVersionId: asUuid(session.priceVersionId),
    state: session.state,
    providerName: session.providerName,
    environment: session.environment ?? null,
    providerRef: session.providerRef ?? null,
    redirectUrl: session.redirectUrl ?? null,
    expiresAt: date(session.expiresAt),
    claimOwner: session.claimOwner ?? null,
    claimExpiresAt: date(session.claimExpiresAt),
  };
}

function toCheckoutSession(row: CheckoutRow): CheckoutSession {
  return {
    id: row.id,
    orgId: row.orgId,
    planVersionId: row.planVersionId,
    priceVersionId: row.priceVersionId,
    state: row.state,
    providerName: row.providerName,
    environment: row.environment ?? undefined,
    providerRef: row.providerRef ?? undefined,
    redirectUrl: row.redirectUrl ?? undefined,
    expiresAt: iso(row.expiresAt),
    claimOwner: row.claimOwner ?? undefined,
    claimExpiresAt: iso(row.claimExpiresAt),
    createdAt: row.createdAt.toISOString(),
  };
}

function toInvoice(row: InvoiceRow): Invoice {
  const amount: Money = { currency: row.currency, amountMinor: row.amountMinor };
  return {
    id: row.id,
    subscriptionId: row.subscriptionId,
    periodStart: row.periodStart.toISOString(),
    periodEnd: row.periodEnd.toISOString(),
    amount,
    status: row.status,
    providerInvoiceRef: row.providerInvoiceRef ?? undefined,
    attempt: row.attempt,
    createdAt: row.createdAt.toISOString(),
    paidAt: iso(row.paidAt),
  };
}

function toWebhook(row: WebhookRow): WebhookRecord {
  return {
    id: row.id,
    providerName: row.providerName,
    externalEventId: row.externalEventId,
    type: row.type,
    sequence: row.sequence ?? undefined,
    payloadDigest: row.payloadDigest,
    status: row.status,
    receivedAt: row.receivedAt.toISOString(),
    appliedAt: iso(row.appliedAt),
    processingOwner: row.processingOwner ?? undefined,
    processingExpiresAt: iso(row.processingExpiresAt),
    rejectionReason: row.rejectionReason ?? undefined,
  };
}

type ProviderObjectMappingRow = typeof providerObjectMappings.$inferSelect;

function toProviderObjectMapping(row: ProviderObjectMappingRow): ProviderObjectMapping {
  return {
    id: row.id,
    providerName: row.providerName,
    environment: row.environment,
    orgId: row.orgId ?? undefined,
    subscriptionId: row.subscriptionId ?? undefined,
    providerCustomerRef: row.providerCustomerRef ?? undefined,
    checkoutSessionRef: row.checkoutSessionRef ?? undefined,
    providerSubscriptionRef: row.providerSubscriptionRef ?? undefined,
    providerInvoiceRef: row.providerInvoiceRef ?? undefined,
    providerPaymentRef: row.providerPaymentRef ?? undefined,
    providerPaymentIntentRef: row.providerPaymentIntentRef ?? undefined,
    providerChargeRef: row.providerChargeRef ?? undefined,
    resolutionState: row.resolutionState as ProviderObjectMapping["resolutionState"],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Currencies table requires an exponent; safe default for region setup. */
function defaultExponent(code: string): number {
  return code === "JPY" ? 0 : 2;
}

/**
 * Hosted identifiers are UUIDs. Opaque runtime-facing ids must be resolved
 * to UUIDs before reaching this store; passing them through keeps the seam
 * identical to the in-memory store while failing loudly on real FK misuse.
 */
function asUuid(id: string): string {
  return id;
}

/** Prompt 00B §E: value type must agree with the entitlement definition. */
function assertValueMatchesType(key: string, valueType: string, value: boolean | number | string): void {
  const valid =
    (valueType === "boolean" && typeof value === "boolean") ||
    (valueType === "integer" && typeof value === "number" && Number.isInteger(value)) ||
    (valueType === "text" && typeof value === "string");
  if (!valid) {
    throw new Error(`entitlement key ${key} expects ${valueType}`);
  }
}
