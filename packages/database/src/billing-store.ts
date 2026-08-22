import { and, asc, eq, inArray, isNull, lte, or } from "drizzle-orm";
import type { MoxDb } from "./client.js";
import {
  addonDefinitions,
  billingCustomers,
  checkoutSessions,
  invoices,
  planEntitlementValues,
  planVersions,
  priceBooks,
  priceVersions,
  pricingRegions,
  products,
  subscriptionItems,
  subscriptions,
  subscriptionTransitions,
  verifiedWebhookEvents,
} from "./schema/index.js";

/**
 * Structural PostgreSQL adapter for @mox/billing. It stays in @mox/database so
 * billing business logic does not depend on Drizzle or PostgreSQL directly.
 */
export type PgPlanTier = "plus" | "pro" | "max" | "enterprise";
export type PgPlanVersionStatus = "draft" | "active" | "retired";
export type PgPlanEntitlementValue = boolean | number | string;
export type PgPriceBookMode = "fixed" | "fx_derived" | "disabled";
export type PgSubscriptionState =
  | "trial"
  | "active"
  | "past_due"
  | "grace_period"
  | "suspended"
  | "canceled"
  | "retention"
  | "deleted";
export type PgCheckoutState = "created" | "redirected" | "completed" | "expired";
export type PgInvoiceStatus = "open" | "paid" | "failed" | "void";
export type PgWebhookStatus = "received" | "verified" | "applied" | "rejected";

export interface PgProduct {
  id: string;
  code: string;
  tier: PgPlanTier;
  displayName: string;
}

export interface PgPlanVersion {
  id: string;
  productId: string;
  version: number;
  status: PgPlanVersionStatus;
  createdAt: string;
  activatedAt?: string;
  retiredAt?: string;
}

export interface PgPricingRegion {
  code: string;
  displayName: string;
  chargeCurrency: string;
  displayCurrency: string;
}

export interface PgPriceBook {
  id: string;
  productId: string;
  pricingRegionCode: string;
  mode: PgPriceBookMode;
  baseCurrency?: string;
  baseAmountMinor?: bigint | number;
  fxRate?: number;
}

export interface PgPriceVersion {
  id: string;
  priceBookId: string;
  version: number;
  amountMinor: bigint | number;
  currency: string;
  effectiveFrom: string;
  createdAt: string;
}

export interface PgAddonDefinition {
  code: string;
  displayName: string;
  consumable: boolean;
  unit: string;
}

export interface PgBillingCustomer {
  orgId: string;
  providerName: string;
  providerCustomerId?: string;
  billingRegion: string;
  defaultDisplayCurrency?: string;
  createdAt: string;
}

export interface PgSubscription {
  id: string;
  orgId: string;
  planVersionId: string;
  priceVersionId: string;
  state: PgSubscriptionState;
  providerName?: string;
  providerRef?: string;
  currentPeriodStart?: string;
  currentPeriodEnd?: string;
  trialEndsAt?: string;
  graceEndsAt?: string;
  retentionUntil?: string;
  failedRenewals: number;
  cancelAtPeriodEnd: boolean;
  canceledAt?: string;
  suspendedAt?: string;
  deletedAt?: string;
  renewalLeaseUntil?: string;
  createdAt: string;
}

export interface PgSubscriptionItem {
  id: string;
  subscriptionId: string;
  kind: "base" | "addon";
  addonCode?: string;
  quantity: number;
  priceVersionId?: string;
}

export interface PgSubscriptionTransition {
  id: string;
  subscriptionId: string;
  fromState?: PgSubscriptionState;
  toState: PgSubscriptionState;
  reason: string;
  actorType: "system" | "admin" | "user";
  actorId?: string;
  idempotencyKey?: string;
  at: string;
}

export interface PgCheckoutSession {
  id: string;
  orgId: string;
  planVersionId: string;
  priceVersionId: string;
  state: PgCheckoutState;
  providerName: string;
  providerRef?: string;
  redirectUrl?: string;
  expiresAt?: string;
  applyLeaseUntil?: string;
  createdAt: string;
}

export interface PgInvoice {
  id: string;
  subscriptionId: string;
  periodStart: string;
  periodEnd: string;
  amount: { currency: string; amountMinor: bigint };
  status: PgInvoiceStatus;
  providerInvoiceRef?: string;
  attempt: number;
  createdAt: string;
  paidAt?: string;
}

export interface PgWebhookRecord {
  id: string;
  providerName: string;
  externalEventId: string;
  type: string;
  sequence?: number;
  payloadDigest: string;
  status: PgWebhookStatus;
  receivedAt: string;
  appliedAt?: string;
  rejectionReason?: string;
}

export class PgBillingStore {
  constructor(private readonly db: MoxDb) {}

  async createProduct(product: PgProduct): Promise<PgProduct> {
    const [row] = await this.db
      .insert(products)
      .values({ id: product.id, code: product.code, tier: product.tier, displayName: product.displayName })
      .returning();
    if (!row) throw new Error("insert billing product returned no row");
    return toProduct(row);
  }

  async getProduct(id: string): Promise<PgProduct | undefined> {
    const [row] = await this.db.select().from(products).where(eq(products.id, id)).limit(1);
    return row ? toProduct(row) : undefined;
  }

  async getProductByCode(code: string): Promise<PgProduct | undefined> {
    const [row] = await this.db.select().from(products).where(eq(products.code, code)).limit(1);
    return row ? toProduct(row) : undefined;
  }

  async listProducts(): Promise<PgProduct[]> {
    return (await this.db.select().from(products).orderBy(asc(products.code))).map(toProduct);
  }

  async createPlanVersion(version: PgPlanVersion): Promise<PgPlanVersion> {
    const [row] = await this.db
      .insert(planVersions)
      .values({
        id: version.id,
        productId: version.productId,
        version: version.version,
        status: version.status,
        createdAt: new Date(version.createdAt),
        activatedAt: version.activatedAt ? new Date(version.activatedAt) : null,
        retiredAt: version.retiredAt ? new Date(version.retiredAt) : null,
      })
      .returning();
    if (!row) throw new Error("insert plan version returned no row");
    return toPlanVersion(row);
  }

  async getPlanVersion(id: string): Promise<PgPlanVersion | undefined> {
    const [row] = await this.db.select().from(planVersions).where(eq(planVersions.id, id)).limit(1);
    return row ? toPlanVersion(row) : undefined;
  }

  async listPlanVersions(productId: string): Promise<PgPlanVersion[]> {
    return (
      await this.db
        .select()
        .from(planVersions)
        .where(eq(planVersions.productId, productId))
        .orderBy(asc(planVersions.version))
    ).map(toPlanVersion);
  }

  async updatePlanVersion(version: PgPlanVersion): Promise<void> {
    await this.db
      .update(planVersions)
      .set({
        status: version.status,
        activatedAt: version.activatedAt ? new Date(version.activatedAt) : null,
        retiredAt: version.retiredAt ? new Date(version.retiredAt) : null,
      })
      .where(eq(planVersions.id, version.id));
  }

  async replacePlanEntitlementValues(
    planVersionId: string,
    values: Record<string, PgPlanEntitlementValue>,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(planEntitlementValues).where(eq(planEntitlementValues.planVersionId, planVersionId));
      const entries = Object.entries(values);
      if (entries.length > 0) {
        await tx.insert(planEntitlementValues).values(
          entries.map(([key, value]) => ({
            planVersionId,
            key,
            value,
          })),
        );
      }
    });
  }

  async getPlanEntitlementValues(planVersionId: string): Promise<Record<string, PgPlanEntitlementValue>> {
    const rows = await this.db
      .select({ key: planEntitlementValues.key, value: planEntitlementValues.value })
      .from(planEntitlementValues)
      .where(eq(planEntitlementValues.planVersionId, planVersionId));
    return Object.fromEntries(rows.map((row) => [row.key, row.value as PgPlanEntitlementValue]));
  }

  async definePricingRegion(region: PgPricingRegion): Promise<PgPricingRegion> {
    const [row] = await this.db
      .insert(pricingRegions)
      .values({
        code: region.code,
        displayName: region.displayName,
        chargeCurrency: region.chargeCurrency,
        displayCurrency: region.displayCurrency,
      })
      .onConflictDoUpdate({
        target: pricingRegions.code,
        set: {
          displayName: region.displayName,
          chargeCurrency: region.chargeCurrency,
          displayCurrency: region.displayCurrency,
        },
      })
      .returning();
    if (!row) throw new Error("upsert pricing region returned no row");
    return toPricingRegion(row);
  }

  async getPricingRegion(code: string): Promise<PgPricingRegion | undefined> {
    const [row] = await this.db.select().from(pricingRegions).where(eq(pricingRegions.code, code)).limit(1);
    return row ? toPricingRegion(row) : undefined;
  }

  async listPricingRegions(): Promise<PgPricingRegion[]> {
    return (await this.db.select().from(pricingRegions).orderBy(asc(pricingRegions.code))).map(toPricingRegion);
  }

  async upsertPriceBook(book: PgPriceBook): Promise<PgPriceBook> {
    const values = {
      id: book.id,
      productId: book.productId,
      pricingRegion: book.pricingRegionCode,
      mode: book.mode,
      baseCurrency: book.baseCurrency ?? null,
      baseAmountMinor: book.baseAmountMinor === undefined ? null : BigInt(book.baseAmountMinor),
      fxRate: book.fxRate ?? null,
    };
    const [row] = await this.db
      .insert(priceBooks)
      .values(values)
      .onConflictDoUpdate({
        target: [priceBooks.productId, priceBooks.pricingRegion],
        set: {
          mode: values.mode,
          baseCurrency: values.baseCurrency,
          baseAmountMinor: values.baseAmountMinor,
          fxRate: values.fxRate,
        },
      })
      .returning();
    if (!row) throw new Error("upsert price book returned no row");
    return toPriceBook(row);
  }

  async getPriceBook(id: string): Promise<PgPriceBook | undefined> {
    const [row] = await this.db.select().from(priceBooks).where(eq(priceBooks.id, id)).limit(1);
    return row ? toPriceBook(row) : undefined;
  }

  async findPriceBook(productId: string, pricingRegionCode: string): Promise<PgPriceBook | undefined> {
    const [row] = await this.db
      .select()
      .from(priceBooks)
      .where(and(eq(priceBooks.productId, productId), eq(priceBooks.pricingRegion, pricingRegionCode)))
      .limit(1);
    return row ? toPriceBook(row) : undefined;
  }

  async listPriceBooks(productId: string): Promise<PgPriceBook[]> {
    return (await this.db.select().from(priceBooks).where(eq(priceBooks.productId, productId))).map(toPriceBook);
  }

  async createPriceVersion(version: PgPriceVersion): Promise<PgPriceVersion> {
    const [row] = await this.db
      .insert(priceVersions)
      .values({
        id: version.id,
        priceBookId: version.priceBookId,
        version: version.version,
        amountMinor: BigInt(version.amountMinor),
        currency: version.currency,
        effectiveFrom: new Date(version.effectiveFrom),
        createdAt: new Date(version.createdAt),
      })
      .returning();
    if (!row) throw new Error("insert price version returned no row");
    return toPriceVersion(row);
  }

  async getPriceVersion(id: string): Promise<PgPriceVersion | undefined> {
    const [row] = await this.db.select().from(priceVersions).where(eq(priceVersions.id, id)).limit(1);
    return row ? toPriceVersion(row) : undefined;
  }

  async listPriceVersions(priceBookId: string): Promise<PgPriceVersion[]> {
    return (
      await this.db
        .select()
        .from(priceVersions)
        .where(eq(priceVersions.priceBookId, priceBookId))
        .orderBy(asc(priceVersions.version), asc(priceVersions.effectiveFrom))
    ).map(toPriceVersion);
  }

  async defineAddon(addon: PgAddonDefinition): Promise<PgAddonDefinition> {
    const [row] = await this.db
      .insert(addonDefinitions)
      .values(addon)
      .onConflictDoUpdate({
        target: addonDefinitions.code,
        set: { displayName: addon.displayName, consumable: addon.consumable, unit: addon.unit },
      })
      .returning();
    if (!row) throw new Error("upsert add-on returned no row");
    return toAddon(row);
  }

  async getAddon(code: string): Promise<PgAddonDefinition | undefined> {
    const [row] = await this.db.select().from(addonDefinitions).where(eq(addonDefinitions.code, code)).limit(1);
    return row ? toAddon(row) : undefined;
  }

  async upsertBillingCustomer(customer: PgBillingCustomer): Promise<PgBillingCustomer> {
    const values = {
      orgId: customer.orgId,
      providerName: customer.providerName,
      providerCustomerId: customer.providerCustomerId ?? null,
      billingRegion: customer.billingRegion,
      defaultDisplayCurrency: customer.defaultDisplayCurrency ?? null,
      createdAt: new Date(customer.createdAt),
    };
    const [row] = await this.db
      .insert(billingCustomers)
      .values(values)
      .onConflictDoUpdate({
        target: [billingCustomers.orgId, billingCustomers.providerName],
        set: {
          providerCustomerId: values.providerCustomerId,
          billingRegion: values.billingRegion,
          defaultDisplayCurrency: values.defaultDisplayCurrency,
        },
      })
      .returning();
    if (!row) throw new Error("upsert billing customer returned no row");
    return toBillingCustomer(row);
  }

  async getBillingCustomer(orgId: string, providerName: string): Promise<PgBillingCustomer | undefined> {
    const [row] = await this.db
      .select()
      .from(billingCustomers)
      .where(and(eq(billingCustomers.orgId, orgId), eq(billingCustomers.providerName, providerName)))
      .limit(1);
    return row ? toBillingCustomer(row) : undefined;
  }

  async createSubscription(subscription: PgSubscription): Promise<PgSubscription> {
    const [row] = await this.db.insert(subscriptions).values(toSubscriptionInsert(subscription)).returning();
    if (!row) throw new Error("insert subscription returned no row");
    return toSubscription(row);
  }

  async getSubscription(id: string): Promise<PgSubscription | undefined> {
    const [row] = await this.db.select().from(subscriptions).where(eq(subscriptions.id, id)).limit(1);
    return row ? toSubscription(row) : undefined;
  }

  async getActiveSubscriptionForOrg(orgId: string): Promise<PgSubscription | undefined> {
    const [row] = await this.db
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.orgId, orgId),
          inArray(subscriptions.state, ["trial", "active", "past_due", "grace_period", "suspended"]),
        ),
      )
      .limit(1);
    return row ? toSubscription(row) : undefined;
  }

  async findSubscriptionByProviderRef(providerName: string, providerRef: string): Promise<PgSubscription | undefined> {
    const [row] = await this.db
      .select()
      .from(subscriptions)
      .where(and(eq(subscriptions.providerName, providerName), eq(subscriptions.providerRef, providerRef)))
      .limit(1);
    return row ? toSubscription(row) : undefined;
  }

  async updateSubscription(subscription: PgSubscription): Promise<void> {
    await this.db
      .update(subscriptions)
      .set({
        planVersionId: subscription.planVersionId,
        priceVersionId: subscription.priceVersionId,
        state: subscription.state,
        providerName: subscription.providerName ?? null,
        providerRef: subscription.providerRef ?? null,
        currentPeriodStart: subscription.currentPeriodStart ? new Date(subscription.currentPeriodStart) : null,
        currentPeriodEnd: subscription.currentPeriodEnd ? new Date(subscription.currentPeriodEnd) : null,
        trialEndsAt: subscription.trialEndsAt ? new Date(subscription.trialEndsAt) : null,
        graceEndsAt: subscription.graceEndsAt ? new Date(subscription.graceEndsAt) : null,
        retentionUntil: subscription.retentionUntil ? new Date(subscription.retentionUntil) : null,
        failedRenewals: subscription.failedRenewals,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        canceledAt: subscription.canceledAt ? new Date(subscription.canceledAt) : null,
        suspendedAt: subscription.suspendedAt ? new Date(subscription.suspendedAt) : null,
        deletedAt: subscription.deletedAt ? new Date(subscription.deletedAt) : null,
        renewalLeaseUntil: subscription.renewalLeaseUntil ? new Date(subscription.renewalLeaseUntil) : null,
        updatedAt: new Date(),
      })
      .where(eq(subscriptions.id, subscription.id));
  }

  async listSubscriptionsInState(states: string[]): Promise<PgSubscription[]> {
    if (states.length === 0) return [];
    return (
      await this.db
        .select()
        .from(subscriptions)
        .where(inArray(subscriptions.state, states as PgSubscriptionState[]))
    ).map(toSubscription);
  }

  async claimSubscriptionRenewal(
    subscriptionId: string,
    nowIso: string,
    leaseUntilIso: string,
  ): Promise<PgSubscription | undefined> {
    const now = new Date(nowIso);
    const [row] = await this.db
      .update(subscriptions)
      .set({ renewalLeaseUntil: new Date(leaseUntilIso), updatedAt: now })
      .where(
        and(
          eq(subscriptions.id, subscriptionId),
          inArray(subscriptions.state, ["active", "past_due", "grace_period"]),
          or(isNull(subscriptions.renewalLeaseUntil), lte(subscriptions.renewalLeaseUntil, now)),
        ),
      )
      .returning();
    return row ? toSubscription(row) : undefined;
  }

  async addItem(item: PgSubscriptionItem): Promise<PgSubscriptionItem> {
    const [row] = await this.db
      .insert(subscriptionItems)
      .values({
        id: item.id,
        subscriptionId: item.subscriptionId,
        kind: item.kind,
        addonCode: item.addonCode ?? null,
        quantity: item.quantity,
        priceVersionId: item.priceVersionId ?? null,
      })
      .returning();
    if (!row) throw new Error("insert subscription item returned no row");
    return toSubscriptionItem(row);
  }

  async listItems(subscriptionId: string): Promise<PgSubscriptionItem[]> {
    return (
      await this.db.select().from(subscriptionItems).where(eq(subscriptionItems.subscriptionId, subscriptionId))
    ).map(toSubscriptionItem);
  }

  async recordTransition(transition: PgSubscriptionTransition): Promise<boolean> {
    const rows = await this.db
      .insert(subscriptionTransitions)
      .values({
        id: transition.id,
        subscriptionId: transition.subscriptionId,
        fromState: transition.fromState ?? null,
        toState: transition.toState,
        reason: transition.reason,
        actorType: transition.actorType,
        actorId: transition.actorId ?? null,
        idempotencyKey: transition.idempotencyKey ?? null,
        at: new Date(transition.at),
      })
      .onConflictDoNothing({
        target: [subscriptionTransitions.subscriptionId, subscriptionTransitions.idempotencyKey],
      })
      .returning({ id: subscriptionTransitions.id });
    return rows.length > 0;
  }

  async listTransitions(subscriptionId: string): Promise<PgSubscriptionTransition[]> {
    return (
      await this.db
        .select()
        .from(subscriptionTransitions)
        .where(eq(subscriptionTransitions.subscriptionId, subscriptionId))
        .orderBy(asc(subscriptionTransitions.at))
    ).map(toTransition);
  }

  async createCheckoutSession(session: PgCheckoutSession): Promise<PgCheckoutSession> {
    const [row] = await this.db
      .insert(checkoutSessions)
      .values(toCheckoutInsert(session))
      .returning();
    if (!row) throw new Error("insert checkout session returned no row");
    return toCheckout(row);
  }

  async getCheckoutSession(id: string): Promise<PgCheckoutSession | undefined> {
    const [row] = await this.db.select().from(checkoutSessions).where(eq(checkoutSessions.id, id)).limit(1);
    return row ? toCheckout(row) : undefined;
  }

  async findCheckoutSessionByProviderRef(providerName: string, providerRef: string): Promise<PgCheckoutSession | undefined> {
    const [row] = await this.db
      .select()
      .from(checkoutSessions)
      .where(and(eq(checkoutSessions.providerName, providerName), eq(checkoutSessions.providerRef, providerRef)))
      .limit(1);
    return row ? toCheckout(row) : undefined;
  }

  async findCheckoutSessionsByOrg(orgId: string): Promise<PgCheckoutSession[]> {
    return (
      await this.db.select().from(checkoutSessions).where(eq(checkoutSessions.orgId, orgId)).orderBy(asc(checkoutSessions.createdAt))
    ).map(toCheckout);
  }

  async updateCheckoutSession(session: PgCheckoutSession): Promise<void> {
    await this.db
      .update(checkoutSessions)
      .set({
        state: session.state,
        providerName: session.providerName,
        providerRef: session.providerRef ?? null,
        redirectUrl: session.redirectUrl ?? null,
        expiresAt: session.expiresAt ? new Date(session.expiresAt) : null,
        applyLeaseUntil: session.applyLeaseUntil ? new Date(session.applyLeaseUntil) : null,
      })
      .where(eq(checkoutSessions.id, session.id));
  }

  async claimCheckoutApplication(
    sessionId: string,
    nowIso: string,
    leaseUntilIso: string,
  ): Promise<PgCheckoutSession | undefined> {
    const now = new Date(nowIso);
    const [row] = await this.db
      .update(checkoutSessions)
      .set({ applyLeaseUntil: new Date(leaseUntilIso) })
      .where(
        and(
          eq(checkoutSessions.id, sessionId),
          inArray(checkoutSessions.state, ["created", "redirected"]),
          or(isNull(checkoutSessions.applyLeaseUntil), lte(checkoutSessions.applyLeaseUntil, now)),
        ),
      )
      .returning();
    return row ? toCheckout(row) : undefined;
  }

  async createInvoice(invoice: PgInvoice): Promise<PgInvoice> {
    const [row] = await this.db
      .insert(invoices)
      .values({
        id: invoice.id,
        subscriptionId: invoice.subscriptionId,
        periodStart: new Date(invoice.periodStart),
        periodEnd: new Date(invoice.periodEnd),
        amountMinor: BigInt(invoice.amount.amountMinor),
        currency: invoice.amount.currency,
        status: invoice.status,
        providerInvoiceRef: invoice.providerInvoiceRef ?? null,
        attempt: invoice.attempt,
        createdAt: new Date(invoice.createdAt),
        paidAt: invoice.paidAt ? new Date(invoice.paidAt) : null,
      })
      .returning();
    if (!row) throw new Error("insert invoice returned no row");
    return toInvoice(row);
  }

  async getInvoice(id: string): Promise<PgInvoice | undefined> {
    const [row] = await this.db.select().from(invoices).where(eq(invoices.id, id)).limit(1);
    return row ? toInvoice(row) : undefined;
  }

  async findInvoiceByPeriodAttempt(
    subscriptionId: string,
    periodStart: string,
    attempt: number,
  ): Promise<PgInvoice | undefined> {
    const [row] = await this.db
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.subscriptionId, subscriptionId),
          eq(invoices.periodStart, new Date(periodStart)),
          eq(invoices.attempt, attempt),
        ),
      )
      .limit(1);
    return row ? toInvoice(row) : undefined;
  }

  async updateInvoice(invoice: PgInvoice): Promise<void> {
    await this.db
      .update(invoices)
      .set({
        status: invoice.status,
        providerInvoiceRef: invoice.providerInvoiceRef ?? null,
        paidAt: invoice.paidAt ? new Date(invoice.paidAt) : null,
      })
      .where(eq(invoices.id, invoice.id));
  }

  async listInvoices(subscriptionId: string): Promise<PgInvoice[]> {
    return (
      await this.db
        .select()
        .from(invoices)
        .where(eq(invoices.subscriptionId, subscriptionId))
        .orderBy(asc(invoices.createdAt))
    ).map(toInvoice);
  }

  async recordWebhook(record: PgWebhookRecord): Promise<boolean> {
    const rows = await this.db
      .insert(verifiedWebhookEvents)
      .values({
        id: record.id,
        providerName: record.providerName,
        externalEventId: record.externalEventId,
        type: record.type,
        sequence: record.sequence ?? null,
        payloadDigest: record.payloadDigest,
        status: record.status,
        receivedAt: new Date(record.receivedAt),
        appliedAt: record.appliedAt ? new Date(record.appliedAt) : null,
        rejectionReason: record.rejectionReason ?? null,
      })
      .onConflictDoNothing({
        target: [verifiedWebhookEvents.providerName, verifiedWebhookEvents.externalEventId],
      })
      .returning({ id: verifiedWebhookEvents.id });
    return rows.length > 0;
  }

  async getWebhook(providerName: string, externalEventId: string): Promise<PgWebhookRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(verifiedWebhookEvents)
      .where(
        and(
          eq(verifiedWebhookEvents.providerName, providerName),
          eq(verifiedWebhookEvents.externalEventId, externalEventId),
        ),
      )
      .limit(1);
    return row ? toWebhook(row) : undefined;
  }

  async updateWebhook(record: PgWebhookRecord): Promise<void> {
    await this.db
      .update(verifiedWebhookEvents)
      .set({
        type: record.type,
        sequence: record.sequence ?? null,
        payloadDigest: record.payloadDigest,
        status: record.status,
        appliedAt: record.appliedAt ? new Date(record.appliedAt) : null,
        rejectionReason: record.rejectionReason ?? null,
      })
      .where(
        and(
          eq(verifiedWebhookEvents.providerName, record.providerName),
          eq(verifiedWebhookEvents.externalEventId, record.externalEventId),
        ),
      );
  }
}

function toProduct(row: typeof products.$inferSelect): PgProduct {
  return { id: row.id, code: row.code, tier: row.tier, displayName: row.displayName };
}

function toPlanVersion(row: typeof planVersions.$inferSelect): PgPlanVersion {
  return {
    id: row.id,
    productId: row.productId,
    version: row.version,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    activatedAt: row.activatedAt?.toISOString(),
    retiredAt: row.retiredAt?.toISOString(),
  };
}

function toPricingRegion(row: typeof pricingRegions.$inferSelect): PgPricingRegion {
  return {
    code: row.code,
    displayName: row.displayName,
    chargeCurrency: row.chargeCurrency,
    displayCurrency: row.displayCurrency,
  };
}

function toPriceBook(row: typeof priceBooks.$inferSelect): PgPriceBook {
  return {
    id: row.id,
    productId: row.productId,
    pricingRegionCode: row.pricingRegion,
    mode: row.mode,
    baseCurrency: row.baseCurrency ?? undefined,
    baseAmountMinor: row.baseAmountMinor ?? undefined,
    fxRate: typeof row.fxRate === "number" ? row.fxRate : row.fxRate === null ? undefined : Number(row.fxRate),
  };
}

function toPriceVersion(row: typeof priceVersions.$inferSelect): PgPriceVersion {
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

function toAddon(row: typeof addonDefinitions.$inferSelect): PgAddonDefinition {
  return { code: row.code, displayName: row.displayName, consumable: row.consumable, unit: row.unit };
}

function toBillingCustomer(row: typeof billingCustomers.$inferSelect): PgBillingCustomer {
  return {
    orgId: row.orgId,
    providerName: row.providerName,
    providerCustomerId: row.providerCustomerId ?? undefined,
    billingRegion: row.billingRegion,
    defaultDisplayCurrency: row.defaultDisplayCurrency ?? undefined,
    createdAt: row.createdAt.toISOString(),
  };
}

function toSubscriptionInsert(subscription: PgSubscription): typeof subscriptions.$inferInsert {
  return {
    id: subscription.id,
    orgId: subscription.orgId,
    planVersionId: subscription.planVersionId,
    priceVersionId: subscription.priceVersionId,
    state: subscription.state,
    providerName: subscription.providerName ?? null,
    providerRef: subscription.providerRef ?? null,
    currentPeriodStart: subscription.currentPeriodStart ? new Date(subscription.currentPeriodStart) : null,
    currentPeriodEnd: subscription.currentPeriodEnd ? new Date(subscription.currentPeriodEnd) : null,
    trialEndsAt: subscription.trialEndsAt ? new Date(subscription.trialEndsAt) : null,
    graceEndsAt: subscription.graceEndsAt ? new Date(subscription.graceEndsAt) : null,
    retentionUntil: subscription.retentionUntil ? new Date(subscription.retentionUntil) : null,
    failedRenewals: subscription.failedRenewals,
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    canceledAt: subscription.canceledAt ? new Date(subscription.canceledAt) : null,
    suspendedAt: subscription.suspendedAt ? new Date(subscription.suspendedAt) : null,
    deletedAt: subscription.deletedAt ? new Date(subscription.deletedAt) : null,
    renewalLeaseUntil: subscription.renewalLeaseUntil ? new Date(subscription.renewalLeaseUntil) : null,
    createdAt: new Date(subscription.createdAt),
    updatedAt: new Date(),
  };
}

function toSubscription(row: typeof subscriptions.$inferSelect): PgSubscription {
  return {
    id: row.id,
    orgId: row.orgId,
    planVersionId: row.planVersionId,
    priceVersionId: row.priceVersionId,
    state: row.state,
    providerName: row.providerName ?? undefined,
    providerRef: row.providerRef ?? undefined,
    currentPeriodStart: row.currentPeriodStart?.toISOString(),
    currentPeriodEnd: row.currentPeriodEnd?.toISOString(),
    trialEndsAt: row.trialEndsAt?.toISOString(),
    graceEndsAt: row.graceEndsAt?.toISOString(),
    retentionUntil: row.retentionUntil?.toISOString(),
    failedRenewals: row.failedRenewals,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    canceledAt: row.canceledAt?.toISOString(),
    suspendedAt: row.suspendedAt?.toISOString(),
    deletedAt: row.deletedAt?.toISOString(),
    renewalLeaseUntil: row.renewalLeaseUntil?.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

function toSubscriptionItem(row: typeof subscriptionItems.$inferSelect): PgSubscriptionItem {
  return {
    id: row.id,
    subscriptionId: row.subscriptionId,
    kind: row.kind,
    addonCode: row.addonCode ?? undefined,
    quantity: row.quantity,
    priceVersionId: row.priceVersionId ?? undefined,
  };
}

function toTransition(row: typeof subscriptionTransitions.$inferSelect): PgSubscriptionTransition {
  return {
    id: row.id,
    subscriptionId: row.subscriptionId,
    fromState: row.fromState ?? undefined,
    toState: row.toState,
    reason: row.reason,
    actorType: row.actorType as PgSubscriptionTransition["actorType"],
    actorId: row.actorId ?? undefined,
    idempotencyKey: row.idempotencyKey ?? undefined,
    at: row.at.toISOString(),
  };
}

function toCheckoutInsert(session: PgCheckoutSession): typeof checkoutSessions.$inferInsert {
  return {
    id: session.id,
    orgId: session.orgId,
    planVersionId: session.planVersionId,
    priceVersionId: session.priceVersionId,
    state: session.state,
    providerName: session.providerName,
    providerRef: session.providerRef ?? null,
    redirectUrl: session.redirectUrl ?? null,
    expiresAt: session.expiresAt ? new Date(session.expiresAt) : null,
    applyLeaseUntil: session.applyLeaseUntil ? new Date(session.applyLeaseUntil) : null,
    createdAt: new Date(session.createdAt),
  };
}

function toCheckout(row: typeof checkoutSessions.$inferSelect): PgCheckoutSession {
  return {
    id: row.id,
    orgId: row.orgId,
    planVersionId: row.planVersionId,
    priceVersionId: row.priceVersionId,
    state: row.state,
    providerName: row.providerName,
    providerRef: row.providerRef ?? undefined,
    redirectUrl: row.redirectUrl ?? undefined,
    expiresAt: row.expiresAt?.toISOString(),
    applyLeaseUntil: row.applyLeaseUntil?.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

function toInvoice(row: typeof invoices.$inferSelect): PgInvoice {
  return {
    id: row.id,
    subscriptionId: row.subscriptionId,
    periodStart: row.periodStart.toISOString(),
    periodEnd: row.periodEnd.toISOString(),
    amount: { currency: row.currency, amountMinor: row.amountMinor },
    status: row.status,
    providerInvoiceRef: row.providerInvoiceRef ?? undefined,
    attempt: row.attempt,
    createdAt: row.createdAt.toISOString(),
    paidAt: row.paidAt?.toISOString(),
  };
}

function toWebhook(row: typeof verifiedWebhookEvents.$inferSelect): PgWebhookRecord {
  return {
    id: row.id,
    providerName: row.providerName,
    externalEventId: row.externalEventId,
    type: row.type,
    sequence: row.sequence ?? undefined,
    payloadDigest: row.payloadDigest,
    status: row.status,
    receivedAt: row.receivedAt.toISOString(),
    appliedAt: row.appliedAt?.toISOString(),
    rejectionReason: row.rejectionReason ?? undefined,
  };
}
