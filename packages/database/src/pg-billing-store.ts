import { and, asc, eq, inArray } from "drizzle-orm";
import type { Money } from "@mox/money";
import type { BillingStore } from "@mox/billing";
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
  ProviderPaymentRecord,
  Subscription,
  SubscriptionItem,
  SubscriptionTransition,
  WebhookRecord,
} from "@mox/billing";
import type { MoxDb } from "./client.js";
import {
  addonDefinitions,
  billingCustomers,
  checkoutSessions,
  currencies,
  entitlementDefinitions,
  invoices,
  planEntitlementValues,
  planVersions,
  priceBooks,
  priceVersions,
  pricingRegions,
  products,
  providerPayments,
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

  async addItem(item: SubscriptionItem): Promise<SubscriptionItem> {
    await this.db.insert(subscriptionItems).values({
      id: asUuid(item.id),
      subscriptionId: asUuid(item.subscriptionId),
      kind: item.kind,
      addonCode: item.addonCode ?? null,
      quantity: item.quantity,
      priceVersionId: item.priceVersionId ? asUuid(item.priceVersionId) : null,
    });
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

  private readonly providerPayments = new Map<string, ProviderPaymentRecord>();

  /** Exactly-once ledger insert per (provider, externalEventId). */
  async recordProviderPayment(record: ProviderPaymentRecord): Promise<boolean> {
    const inserted = await this.db
      .insert(providerPayments)
      .values({
        providerName: record.providerName,
        environment: record.environment,
        externalEventId: record.externalEventId,
        eventType: record.eventType,
        orgId: record.orgId ?? null,
        providerSubscriptionRef: record.providerSubscriptionRef ?? null,
        checkoutSessionRef: record.checkoutSessionRef ?? null,
        providerTransactionRef: record.providerTransactionRef ?? null,
        invoiceRef: record.invoiceRef ?? null,
        state: record.state,
        currency: record.currency ?? null,
        amountMinor:
          record.amountMinor !== undefined ? BigInt(record.amountMinor) : null,
        payloadDigest: record.payloadDigest,
        occurredAt: date(record.occurredAt),
        receivedAt: new Date(record.receivedAt),
        reconciledAt: date(record.reconciledAt),
      })
      .onConflictDoNothing({
        target: [providerPayments.providerName, providerPayments.externalEventId],
      })
      .returning({ id: providerPayments.id });
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
      state: row.state,
      currency: row.currency ?? undefined,
      amountMinor: row.amountMinor ?? undefined,
      payloadDigest: row.payloadDigest,
      occurredAt: iso(row.occurredAt),
      receivedAt: row.receivedAt.toISOString(),
      reconciledAt: iso(row.reconciledAt),
    }));
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
    providerRef: session.providerRef ?? null,
    redirectUrl: session.redirectUrl ?? null,
    expiresAt: date(session.expiresAt),
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
    providerRef: row.providerRef ?? undefined,
    redirectUrl: row.redirectUrl ?? undefined,
    expiresAt: iso(row.expiresAt),
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
    rejectionReason: row.rejectionReason ?? undefined,
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
