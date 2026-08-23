/**
 * Billing persistence contract plus an in-memory implementation for tests
 * and local development. A Drizzle/Postgres store maps 1:1 onto
 * packages/database schema/billing.ts tables.
 */

import { randomUUID } from "node:crypto";
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
  SubscriptionTransition,
  WebhookRecord,
} from "./types.js";

export interface BillingStore {
  // Catalog
  createProduct(product: Product): Promise<Product>;
  getProduct(id: string): Promise<Product | undefined>;
  getProductByCode(code: string): Promise<Product | undefined>;
  listProducts(): Promise<Product[]>;

  createPlanVersion(version: PlanVersion): Promise<PlanVersion>;
  getPlanVersion(id: string): Promise<PlanVersion | undefined>;
  listPlanVersions(productId: string): Promise<PlanVersion[]>;
  updatePlanVersion(version: PlanVersion): Promise<void>;

  /**
   * Durable plan entitlement values (Prompt 00 §D4). Values are persisted
   * business data — never authoritative in a process Map.
   */
  setPlanEntitlementValues(planVersionId: string, values: Record<string, boolean | number | string>): Promise<void>;
  getPlanEntitlementValues(planVersionId: string): Promise<Record<string, boolean | number | string>>;

  definePricingRegion(region: PricingRegion): Promise<PricingRegion>;
  getPricingRegion(code: string): Promise<PricingRegion | undefined>;
  listPricingRegions(): Promise<PricingRegion[]>;

  upsertPriceBook(book: PriceBook): Promise<PriceBook>;
  getPriceBook(id: string): Promise<PriceBook | undefined>;
  findPriceBook(productId: string, pricingRegionCode: string): Promise<PriceBook | undefined>;
  listPriceBooks(productId: string): Promise<PriceBook[]>;

  createPriceVersion(version: PriceVersion): Promise<PriceVersion>;
  getPriceVersion(id: string): Promise<PriceVersion | undefined>;
  listPriceVersions(priceBookId: string): Promise<PriceVersion[]>;

  defineAddon(addon: AddonDefinition): Promise<AddonDefinition>;
  getAddon(code: string): Promise<AddonDefinition | undefined>;

  // Customers / subscriptions
  upsertBillingCustomer(customer: BillingCustomer): Promise<BillingCustomer>;
  getBillingCustomer(orgId: string, providerName: string): Promise<BillingCustomer | undefined>;

  createSubscription(subscription: Subscription): Promise<Subscription>;
  getSubscription(id: string): Promise<Subscription | undefined>;
  getActiveSubscriptionForOrg(orgId: string): Promise<Subscription | undefined>;
  findSubscriptionByProviderRef(providerRef: string): Promise<Subscription | undefined>;
  updateSubscription(subscription: Subscription): Promise<void>;
  listSubscriptionsInState(states: string[]): Promise<Subscription[]>;

  addItem(item: SubscriptionItem): Promise<SubscriptionItem>;
  listItems(subscriptionId: string): Promise<SubscriptionItem[]>;

  recordTransition(transition: SubscriptionTransition): Promise<boolean>;
  listTransitions(subscriptionId: string): Promise<SubscriptionTransition[]>;

  // Checkout
  createCheckoutSession(session: CheckoutSession): Promise<CheckoutSession>;
  getCheckoutSession(id: string): Promise<CheckoutSession | undefined>;
  findCheckoutSessionsByOrg(orgId: string): Promise<CheckoutSession[]>;
  /** Authoritative lookup by the persisted provider-side reference. */
  findCheckoutSessionByProviderRef(providerRef: string): Promise<CheckoutSession | undefined>;
  updateCheckoutSession(session: CheckoutSession): Promise<void>;

  // Invoices
  createInvoice(invoice: Invoice): Promise<Invoice>;
  getInvoice(id: string): Promise<Invoice | undefined>;
  findInvoiceByPeriodAttempt(subscriptionId: string, periodStart: string, attempt: number): Promise<Invoice | undefined>;
  updateInvoice(invoice: Invoice): Promise<void>;
  listInvoices(subscriptionId: string): Promise<Invoice[]>;

  // Webhooks
  recordWebhook(record: WebhookRecord): Promise<boolean>;
  getWebhook(providerName: string, externalEventId: string): Promise<WebhookRecord | undefined>;
  updateWebhook(record: WebhookRecord): Promise<void>;
}

export class InMemoryBillingStore implements BillingStore {
  private readonly products = new Map<string, Product>();
  private readonly planVersions = new Map<string, PlanVersion>();
  private readonly planValues = new Map<string, Record<string, boolean | number | string>>();
  private readonly pricingRegions = new Map<string, PricingRegion>();
  private readonly priceBooks = new Map<string, PriceBook>();
  private readonly priceVersions = new Map<string, PriceVersion>();
  private readonly addons = new Map<string, AddonDefinition>();
  private readonly billingCustomers = new Map<string, BillingCustomer>();
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly items = new Map<string, SubscriptionItem[]>();
  private readonly transitions = new Map<string, SubscriptionTransition[]>();
  private readonly transitionKeys = new Set<string>();
  private readonly checkoutSessions = new Map<string, CheckoutSession>();
  private readonly checkoutByProviderRef = new Map<string, string>();
  private readonly invoices = new Map<string, Invoice>();
  private readonly webhooks = new Map<string, WebhookRecord>();

  async createProduct(product: Product): Promise<Product> {
    this.products.set(product.id, product);
    return product;
  }

  async getProduct(id: string): Promise<Product | undefined> {
    return this.products.get(id);
  }

  async getProductByCode(code: string): Promise<Product | undefined> {
    for (const product of this.products.values()) if (product.code === code) return product;
    return undefined;
  }

  async listProducts(): Promise<Product[]> {
    return [...this.products.values()];
  }

  async createPlanVersion(version: PlanVersion): Promise<PlanVersion> {
    this.planVersions.set(version.id, version);
    return version;
  }

  async getPlanVersion(id: string): Promise<PlanVersion | undefined> {
    return this.planVersions.get(id);
  }

  async listPlanVersions(productId: string): Promise<PlanVersion[]> {
    const rows = [...this.planVersions.values()].filter((v) => v.productId === productId);
    return rows.sort((a, b) => a.version - b.version);
  }

  async updatePlanVersion(version: PlanVersion): Promise<void> {
    this.planVersions.set(version.id, version);
  }

  async setPlanEntitlementValues(planVersionId: string, values: Record<string, boolean | number | string>): Promise<void> {
    this.planValues.set(planVersionId, { ...values });
  }

  async getPlanEntitlementValues(planVersionId: string): Promise<Record<string, boolean | number | string>> {
    return { ...(this.planValues.get(planVersionId) ?? {}) };
  }

  async definePricingRegion(region: PricingRegion): Promise<PricingRegion> {
    this.pricingRegions.set(region.code, region);
    return region;
  }

  async getPricingRegion(code: string): Promise<PricingRegion | undefined> {
    return this.pricingRegions.get(code);
  }

  async listPricingRegions(): Promise<PricingRegion[]> {
    return [...this.pricingRegions.values()];
  }

  async upsertPriceBook(book: PriceBook): Promise<PriceBook> {
    this.priceBooks.set(book.id, book);
    return book;
  }

  async getPriceBook(id: string): Promise<PriceBook | undefined> {
    return this.priceBooks.get(id);
  }

  async findPriceBook(productId: string, pricingRegionCode: string): Promise<PriceBook | undefined> {
    for (const book of this.priceBooks.values()) {
      if (book.productId === productId && book.pricingRegionCode === pricingRegionCode) return book;
    }
    return undefined;
  }

  async listPriceBooks(productId: string): Promise<PriceBook[]> {
    return [...this.priceBooks.values()].filter((b) => b.productId === productId);
  }

  async createPriceVersion(version: PriceVersion): Promise<PriceVersion> {
    this.priceVersions.set(version.id, version);
    return version;
  }

  async getPriceVersion(id: string): Promise<PriceVersion | undefined> {
    return this.priceVersions.get(id);
  }

  async listPriceVersions(priceBookId: string): Promise<PriceVersion[]> {
    const rows = [...this.priceVersions.values()].filter((v) => v.priceBookId === priceBookId);
    return rows.sort((a, b) => a.version - b.version || a.effectiveFrom.localeCompare(b.effectiveFrom));
  }

  async defineAddon(addon: AddonDefinition): Promise<AddonDefinition> {
    this.addons.set(addon.code, addon);
    return addon;
  }

  async getAddon(code: string): Promise<AddonDefinition | undefined> {
    return this.addons.get(code);
  }

  async upsertBillingCustomer(customer: BillingCustomer): Promise<BillingCustomer> {
    this.billingCustomers.set(`${customer.orgId}:${customer.providerName}`, customer);
    return customer;
  }

  async getBillingCustomer(orgId: string, providerName: string): Promise<BillingCustomer | undefined> {
    return this.billingCustomers.get(`${orgId}:${providerName}`);
  }

  /** Live states mirrored from the PG partial unique index (§D1). */
  static readonly LIVE_STATES = ["trial", "active", "past_due", "grace_period", "suspended"];

  async createSubscription(subscription: Subscription): Promise<Subscription> {
    // Mirrors the durable partial unique index: one LIVE row per org;
    // canceled/deleted history never blocks resubscription.
    for (const existing of this.subscriptions.values()) {
      if (
        existing.orgId === subscription.orgId &&
        InMemoryBillingStore.LIVE_STATES.includes(existing.state)
      ) {
        throw new Error(`org ${subscription.orgId} already has a live subscription (${existing.id})`);
      }
    }
    this.subscriptions.set(subscription.id, subscription);
    return subscription;
  }

  async getSubscription(id: string): Promise<Subscription | undefined> {
    return this.subscriptions.get(id);
  }

  async getActiveSubscriptionForOrg(orgId: string): Promise<Subscription | undefined> {
    for (const sub of this.subscriptions.values()) {
      if (sub.orgId === orgId && InMemoryBillingStore.LIVE_STATES.includes(sub.state)) return sub;
    }
    return undefined;
  }

  async findSubscriptionByProviderRef(providerRef: string): Promise<Subscription | undefined> {
    for (const sub of this.subscriptions.values()) if (sub.providerRef === providerRef) return sub;
    return undefined;
  }

  async updateSubscription(subscription: Subscription): Promise<void> {
    this.subscriptions.set(subscription.id, subscription);
  }

  async listSubscriptionsInState(states: string[]): Promise<Subscription[]> {
    return [...this.subscriptions.values()].filter((s) => states.includes(s.state));
  }

  async addItem(item: SubscriptionItem): Promise<SubscriptionItem> {
    const list = this.items.get(item.subscriptionId) ?? [];
    list.push(item);
    this.items.set(item.subscriptionId, list);
    return item;
  }

  async listItems(subscriptionId: string): Promise<SubscriptionItem[]> {
    return [...(this.items.get(subscriptionId) ?? [])];
  }

  /** Returns false when an identical idempotency key already applied. */
  async recordTransition(transition: SubscriptionTransition): Promise<boolean> {
    if (transition.idempotencyKey) {
      const key = `${transition.subscriptionId}:${transition.idempotencyKey}`;
      if (this.transitionKeys.has(key)) return false;
      this.transitionKeys.add(key);
    }
    const list = this.transitions.get(transition.subscriptionId) ?? [];
    list.push(transition);
    this.transitions.set(transition.subscriptionId, list);
    return true;
  }

  async listTransitions(subscriptionId: string): Promise<SubscriptionTransition[]> {
    return [...(this.transitions.get(subscriptionId) ?? [])];
  }

  async createCheckoutSession(session: CheckoutSession): Promise<CheckoutSession> {
    this.checkoutSessions.set(session.id, session);
    if (session.providerRef) this.checkoutByProviderRef.set(session.providerRef, session.id);
    return session;
  }

  async getCheckoutSession(id: string): Promise<CheckoutSession | undefined> {
    return this.checkoutSessions.get(id);
  }

  async findCheckoutSessionsByOrg(orgId: string): Promise<CheckoutSession[]> {
    return [...this.checkoutSessions.values()].filter((s) => s.orgId === orgId);
  }

  async findCheckoutSessionByProviderRef(providerRef: string): Promise<CheckoutSession | undefined> {
    const id = this.checkoutByProviderRef.get(providerRef);
    return id ? this.checkoutSessions.get(id) : undefined;
  }

  async updateCheckoutSession(session: CheckoutSession): Promise<void> {
    this.checkoutSessions.set(session.id, session);
    if (session.providerRef) this.checkoutByProviderRef.set(session.providerRef, session.id);
  }

  async createInvoice(invoice: Invoice): Promise<Invoice> {
    this.invoices.set(invoice.id, invoice);
    return invoice;
  }

  async getInvoice(id: string): Promise<Invoice | undefined> {
    return this.invoices.get(id);
  }

  async findInvoiceByPeriodAttempt(
    subscriptionId: string,
    periodStart: string,
    attempt: number,
  ): Promise<Invoice | undefined> {
    for (const invoice of this.invoices.values()) {
      if (
        invoice.subscriptionId === subscriptionId &&
        invoice.periodStart === periodStart &&
        invoice.attempt === attempt
      ) {
        return invoice;
      }
    }
    return undefined;
  }

  async updateInvoice(invoice: Invoice): Promise<void> {
    this.invoices.set(invoice.id, invoice);
  }

  async listInvoices(subscriptionId: string): Promise<Invoice[]> {
    return [...this.invoices.values()]
      .filter((i) => i.subscriptionId === subscriptionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Returns false when this (provider, externalEventId) was already seen. */
  async recordWebhook(record: WebhookRecord): Promise<boolean> {
    const key = `${record.providerName}:${record.externalEventId}`;
    if (this.webhooks.has(key)) return false;
    this.webhooks.set(key, record);
    return true;
  }

  async getWebhook(providerName: string, externalEventId: string): Promise<WebhookRecord | undefined> {
    return this.webhooks.get(`${providerName}:${externalEventId}`);
  }

  async updateWebhook(record: WebhookRecord): Promise<void> {
    this.webhooks.set(`${record.providerName}:${record.externalEventId}`, record);
  }
}

export function newId(): string {
  return randomUUID();
}
