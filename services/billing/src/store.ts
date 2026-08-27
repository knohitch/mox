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
  CommercialReconciliationItem,
  Invoice,
  PriceBook,
  PriceVersion,
  PricingRegion,
  Product,
  PlanVersion,
  ProviderBillingEffect,
  ProviderObjectMapping,
  ProviderPaymentRecord,
  ProviderRefundState,
  Subscription,
  SubscriptionCancellation,
  SubscriptionItem,
  SubscriptionTransition,
  WebhookRecord,
  BusinessEffectType,
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
  claimCheckoutSession(id: string, owner: string, leaseUntilIso: string, nowIso: string): Promise<CheckoutSession | undefined>;

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
  claimWebhookApplication(record: WebhookRecord, owner: string, leaseUntilIso: string): Promise<"claimed" | "applied" | "busy">;

  /**
   * Normalized provider-payment ledger (Prompt 01 §Durable). Returns false
   * when this (provider, externalEventId) was already recorded — the
   * PostgreSQL-backed guarantee that replays/restarts never duplicate value.
   */
  recordProviderPayment(record: ProviderPaymentRecord): Promise<boolean>;
  listProviderPayments(orgId: string): Promise<ProviderPaymentRecord[]>;

  claimSubscriptionRenewal(id: string, periodEndIso: string, owner: string, leaseUntilIso: string, nowIso: string): Promise<Subscription | undefined>;

  /**
   * Security Repair 05B §A: fenced renewal writeback. Applies the
   * subscription update ONLY while the renewal claim (owner + version) is
   * still held; a stale worker whose lease was stolen updates zero rows and
   * must stop without transitioning state.
   */
  completeSubscriptionRenewal(sub: Subscription, expectedClaimVersion: number): Promise<boolean>;

  // ---- Security Repair 05A: provider-object mappings (finding A) -------------

  /**
   * Merge typed provider-object refs into the durable mapping. Rows that
   * match any provided ref (or the subscription/org) are merged; refs that
   * would join two DIFFERENT subscriptions/orgs mark every involved row
   * reconciliation_required — never guessed.
   */
  upsertProviderObjectMapping(mapping: ProviderObjectMapping): Promise<void>;
  findProviderObjectMappings(
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
  ): Promise<ProviderObjectMapping[]>;

  // ---- Security Repair 05A: business-effect idempotency (finding B) -----------

  /** Returns true when this identity+effect was claimed by this call. */
  claimProviderBillingEffect(input: {
    providerName: string;
    environment: string;
    billingIdentity: string;
    effectType: BusinessEffectType;
    subscriptionId?: string;
    externalEventId: string;
  }): Promise<boolean>;
  hasAppliedFinancialEffect(subscriptionId: string): Promise<boolean>;

  /**
   * Atomically advance cumulative refund authority for one provider billing
   * identity. The returned state is the durable MAX observed amount; only a
   * strictly larger amount returns advanced:true. Cross-subscription reuse
   * of one provider identity is rejected.
   */
  advanceProviderRefundState(input: {
    providerName: string;
    environment: string;
    billingIdentity: string;
    subscriptionId: string;
    cumulativeAmountMinor: bigint;
    externalEventId: string;
  }): Promise<{ advanced: boolean; state: ProviderRefundState }>;

  /** Update only refund-observation fields; never overwrite lifecycle state. */
  recordRefundObservation(subscriptionId: string, occurredAt: string | undefined, reconciliationRequired: boolean): Promise<void>;

  // ---- Security Repair 05A: cancellations (finding H) ---------------------------

  upsertSubscriptionCancellation(record: SubscriptionCancellation): Promise<SubscriptionCancellation>;
  getSubscriptionCancellation(subscriptionId: string): Promise<SubscriptionCancellation | undefined>;
  listDueCancellationRetries(nowIso: string, limit: number): Promise<SubscriptionCancellation[]>;

  // ---- Security Repair 05A: commercial reconciliation queue (finding A) ---------

  enqueueCommercialReconciliation(subscriptionId: string, reason: string): Promise<void>;
  dequeueCommercialReconciliations(limit: number): Promise<CommercialReconciliationItem[]>;
  ackCommercialReconciliation(subscriptionId: string): Promise<void>;

  // ---- Security Repair 05A: rejected-webhook retention (finding G) --------------

  purgeRejectedWebhooks(beforeIso: string): Promise<number>;

  // ---- Security Repair 05A: invoice identity (finding B) -------------------------

  findInvoiceByProviderRef(providerInvoiceRef: string): Promise<Invoice | undefined>;

  // ---- Security Repair 05A: provider plan mapping (finding C) ---------------------

  findProviderPlanMapping(
    providerName: string,
    environment: string,
    providerPlanRef: string,
  ): Promise<{ moxPriceVersionId: string; productId: string } | undefined>;
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
  private readonly providerMappings = new Map<string, ProviderObjectMapping>();
  private readonly providerEffects = new Map<string, ProviderBillingEffect>();
  private readonly providerRefundStates = new Map<string, ProviderRefundState>();
  private readonly cancellations = new Map<string, SubscriptionCancellation>();
  private readonly reconciliationQueue = new Map<string, CommercialReconciliationItem>();
  private readonly planMappings = new Map<string, { moxPriceVersionId: string; productId: string }>();

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

  /** Base items are idempotent (crash-replay); add-ons keep append semantics. */
  async addItem(item: SubscriptionItem): Promise<SubscriptionItem> {
    const list = this.items.get(item.subscriptionId) ?? [];
    if (item.kind === "base") {
      const existing = list.find((i) => i.kind === "base");
      if (existing) return existing;
    }
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

  async claimCheckoutSession(id: string, owner: string, leaseUntilIso: string, nowIso: string): Promise<CheckoutSession | undefined> {
    const session = this.checkoutSessions.get(id);
    if (!session || session.state === "completed" || session.state === "expired") return undefined;
    if (session.claimExpiresAt && session.claimExpiresAt > nowIso) return undefined;
    session.claimOwner = owner;
    session.claimExpiresAt = leaseUntilIso;
    // State machine: created/redirected → applying; crash-replay re-claims.
    session.state = "applying";
    this.checkoutSessions.set(id, session);
    return { ...session };
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

  async claimWebhookApplication(record: WebhookRecord, owner: string, leaseUntilIso: string): Promise<"claimed" | "applied" | "busy"> {
    const key = `${record.providerName}:${record.externalEventId}`;
    const existing = this.webhooks.get(key);
    if (existing?.status === "applied") return "applied";
    if (existing?.status === "processing" && existing.processingExpiresAt && existing.processingExpiresAt > record.receivedAt) {
      return "busy";
    }
    this.webhooks.set(key, {
      ...(existing ?? record),
      ...record,
      status: "processing",
      processingOwner: owner,
      processingExpiresAt: leaseUntilIso,
      rejectionReason: undefined,
    });
    return "claimed";
  }

  private readonly providerPayments = new Map<string, ProviderPaymentRecord>();

  /** Exactly-once per (provider, externalEventId); outcome updates on replay. */
  async recordProviderPayment(record: ProviderPaymentRecord): Promise<boolean> {
    const key = `${record.providerName}:${record.externalEventId}`;
    const existing = this.providerPayments.get(key);
    if (existing) {
      if (existing.state !== record.state) {
        this.providerPayments.set(key, { ...existing, ...record, id: existing.id });
      }
      return false;
    }
    this.providerPayments.set(key, { ...record });
    return true;
  }

  async listProviderPayments(orgId: string): Promise<ProviderPaymentRecord[]> {
    return [...this.providerPayments.values()]
      .filter((p) => p.orgId === orgId)
      .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  }

  // ---- Security Repair 05A: provider-object mappings ---------------------------

  async upsertProviderObjectMapping(mapping: ProviderObjectMapping): Promise<void> {
    const provided = [
      ["checkoutSessionRef", mapping.checkoutSessionRef],
      ["providerSubscriptionRef", mapping.providerSubscriptionRef],
      ["providerInvoiceRef", mapping.providerInvoiceRef],
      ["providerPaymentRef", mapping.providerPaymentRef],
      ["providerPaymentIntentRef", mapping.providerPaymentIntentRef],
      ["providerChargeRef", mapping.providerChargeRef],
    ] as const;
    const refs = provided.filter(([, v]) => v !== undefined) as Array<[string, string]>;
    if (refs.length === 0) return;

    const matching = new Map<string, ProviderObjectMapping>();
    for (const row of this.providerMappings.values()) {
      if (row.providerName !== mapping.providerName || row.environment !== mapping.environment) continue;
      const sharesRef = refs.some(([field, value]) => (row as unknown as Record<string, unknown>)[field] === value);
      const sharesSub = mapping.subscriptionId && row.subscriptionId === mapping.subscriptionId;
      const sharesOrg = !mapping.subscriptionId && mapping.orgId && row.orgId === mapping.orgId;
      if (sharesRef || sharesSub || sharesOrg) matching.set(row.id, row);
    }

    const subIds = new Set([...matching.values()].map((r) => r.subscriptionId).filter(Boolean));
    const orgIds = new Set([...matching.values()].map((r) => r.orgId).filter(Boolean));
    const conflict = subIds.size > 1 || (subIds.size === 0 && orgIds.size > 1);
    if (conflict) {
      for (const row of matching.values()) {
        this.providerMappings.set(row.id, {
          ...row,
          resolutionState: "reconciliation_required",
          updatedAt: new Date().toISOString(),
        });
      }
      return;
    }

    let target = [...matching.values()].find((r) => mapping.subscriptionId && r.subscriptionId === mapping.subscriptionId)
      ?? [...matching.values()].find((r) => mapping.orgId && r.orgId === mapping.orgId)
      ?? [...matching.values()][0];

    if (!target) {
      target = {
        id: randomUUID(),
        providerName: mapping.providerName,
        environment: mapping.environment,
        resolutionState: "resolved",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }
    const merged: ProviderObjectMapping = { ...target, updatedAt: new Date().toISOString() };
    for (const [field, value] of refs) {
      if (!(merged as unknown as Record<string, unknown>)[field]) {
        (merged as unknown as Record<string, unknown>)[field] = value;
      }
    }
    if (!merged.orgId && mapping.orgId) merged.orgId = mapping.orgId;
    if (!merged.subscriptionId && mapping.subscriptionId) merged.subscriptionId = mapping.subscriptionId;
    if (!merged.providerCustomerRef && mapping.providerCustomerRef) merged.providerCustomerRef = mapping.providerCustomerRef;
    this.providerMappings.set(merged.id, merged);

    for (const row of matching.values()) {
      if (row.id === merged.id) continue;
      for (const [field, value] of refs) {
        if (!(merged as unknown as Record<string, unknown>)[field] && (row as unknown as Record<string, unknown>)[field]) {
          (merged as unknown as Record<string, unknown>)[field] = (row as unknown as Record<string, unknown>)[field];
        }
      }
      if (!merged.orgId && row.orgId) merged.orgId = row.orgId;
      if (!merged.subscriptionId && row.subscriptionId) merged.subscriptionId = row.subscriptionId;
      this.providerMappings.set(merged.id, merged);
      this.providerMappings.delete(row.id);
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
    const entries = Object.entries(refs).filter(([, v]) => v !== undefined) as Array<[string, string]>;
    const out: ProviderObjectMapping[] = [];
    for (const row of this.providerMappings.values()) {
      if (row.providerName !== providerName || row.environment !== environment) continue;
      if (entries.some(([field, value]) => (row as unknown as Record<string, unknown>)[field] === value)) {
        out.push({ ...row });
      }
    }
    return out;
  }

  // ---- Security Repair 05A: business-effect idempotency -------------------------

  async claimProviderBillingEffect(input: {
    providerName: string;
    environment: string;
    billingIdentity: string;
    effectType: BusinessEffectType;
    subscriptionId?: string;
    externalEventId: string;
  }): Promise<boolean> {
    const key = `${input.providerName}:${input.environment}:${input.billingIdentity}:${input.effectType}`;
    if (this.providerEffects.has(key)) return false;
    this.providerEffects.set(key, {
      id: randomUUID(),
      providerName: input.providerName,
      environment: input.environment,
      billingIdentity: input.billingIdentity,
      effectType: input.effectType,
      subscriptionId: input.subscriptionId,
      outcome: "applied",
      externalEventId: input.externalEventId,
      createdAt: new Date().toISOString(),
    });
    return true;
  }

  async hasAppliedFinancialEffect(subscriptionId: string): Promise<boolean> {
    for (const effect of this.providerEffects.values()) {
      if (
        effect.subscriptionId === subscriptionId &&
        effect.outcome === "applied" &&
        (effect.effectType === "checkout_grant" || effect.effectType === "period_extension")
      ) {
        return true;
      }
    }
    return false;
  }

  async advanceProviderRefundState(input: {
    providerName: string;
    environment: string;
    billingIdentity: string;
    subscriptionId: string;
    cumulativeAmountMinor: bigint;
    externalEventId: string;
  }): Promise<{ advanced: boolean; state: ProviderRefundState }> {
    const key = `${input.providerName}:${input.environment}:${input.billingIdentity}`;
    const existing = this.providerRefundStates.get(key);
    if (existing?.subscriptionId && existing.subscriptionId !== input.subscriptionId) {
      throw new Error("provider refund identity is already bound to another subscription");
    }
    if (existing && existing.cumulativeAmountMinor >= input.cumulativeAmountMinor) {
      return { advanced: false, state: { ...existing } };
    }
    const now = new Date().toISOString();
    const state: ProviderRefundState = {
      providerName: input.providerName,
      environment: input.environment,
      billingIdentity: input.billingIdentity,
      subscriptionId: input.subscriptionId,
      cumulativeAmountMinor: input.cumulativeAmountMinor,
      externalEventId: input.externalEventId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.providerRefundStates.set(key, state);
    return { advanced: true, state: { ...state } };
  }

  async recordRefundObservation(
    subscriptionId: string,
    occurredAt: string | undefined,
    reconciliationRequired: boolean,
  ): Promise<void> {
    const current = this.subscriptions.get(subscriptionId);
    if (!current) return;
    if (reconciliationRequired) current.reconciliationRequired = true;
    if (occurredAt && (!current.lastEventAt || Date.parse(occurredAt) > Date.parse(current.lastEventAt))) {
      current.lastEventAt = occurredAt;
    }
    this.subscriptions.set(subscriptionId, current);
  }

  // ---- Security Repair 05A: cancellations ----------------------------------------

  async upsertSubscriptionCancellation(record: SubscriptionCancellation): Promise<SubscriptionCancellation> {
    const existing = this.cancellations.get(record.subscriptionId);
    const merged: SubscriptionCancellation = {
      ...(existing ?? {
        subscriptionId: record.subscriptionId,
        state: "cancel_requested",
        requestedBy: record.requestedBy,
        attempts: 0,
        createdAt: new Date().toISOString(),
      }),
      ...record,
      updatedAt: new Date().toISOString(),
    };
    this.cancellations.set(record.subscriptionId, merged);
    return { ...merged };
  }

  async getSubscriptionCancellation(subscriptionId: string): Promise<SubscriptionCancellation | undefined> {
    const row = this.cancellations.get(subscriptionId);
    return row ? { ...row } : undefined;
  }

  async listDueCancellationRetries(nowIso: string, limit: number): Promise<SubscriptionCancellation[]> {
    return [...this.cancellations.values()]
      .filter(
        (c) =>
          ["provider_cancel_pending", "reconciliation_required"].includes(c.state) &&
          (!c.nextAttemptAt || c.nextAttemptAt <= nowIso),
      )
      .slice(0, limit)
      .map((c) => ({ ...c }));
  }

  // ---- Security Repair 05A: commercial reconciliation queue ----------------------

  async enqueueCommercialReconciliation(subscriptionId: string, reason: string): Promise<void> {
    this.reconciliationQueue.set(subscriptionId, {
      subscriptionId,
      reason,
      enqueuedAt: new Date().toISOString(),
    });
  }

  async dequeueCommercialReconciliations(limit: number): Promise<CommercialReconciliationItem[]> {
    return [...this.reconciliationQueue.values()].slice(0, limit).map((i) => ({ ...i }));
  }

  async ackCommercialReconciliation(subscriptionId: string): Promise<void> {
    this.reconciliationQueue.delete(subscriptionId);
  }

  // ---- Security Repair 05A: rejected-webhook retention ----------------------------

  async purgeRejectedWebhooks(beforeIso: string): Promise<number> {
    let purged = 0;
    for (const [key, record] of this.webhooks) {
      if (record.status === "rejected" && record.receivedAt < beforeIso) {
        this.webhooks.delete(key);
        purged += 1;
      }
    }
    return purged;
  }

  async findInvoiceByProviderRef(providerInvoiceRef: string): Promise<Invoice | undefined> {
    for (const invoice of this.invoices.values()) {
      if (invoice.providerInvoiceRef === providerInvoiceRef) return invoice;
    }
    return undefined;
  }

  async findProviderPlanMapping(
    providerName: string,
    environment: string,
    providerPlanRef: string,
  ): Promise<{ moxPriceVersionId: string; productId: string } | undefined> {
    return this.planMappings.get(`${providerName}:${environment}:${providerPlanRef}`);
  }

  /** Test/admin seam for data-driven provider plan mappings. */
  setProviderPlanMapping(
    providerName: string,
    environment: string,
    providerPlanRef: string,
    mapping: { moxPriceVersionId: string; productId: string },
  ): void {
    this.planMappings.set(`${providerName}:${environment}:${providerPlanRef}`, mapping);
  }

  async claimSubscriptionRenewal(id: string, periodEndIso: string, owner: string, leaseUntilIso: string, nowIso: string): Promise<Subscription | undefined> {
    const sub = this.subscriptions.get(id);
    if (!sub || sub.currentPeriodEnd !== periodEndIso) return undefined;
    if (sub.renewalClaimExpiresAt && sub.renewalClaimExpiresAt > nowIso) return undefined;
    sub.renewalClaimOwner = owner;
    sub.renewalClaimExpiresAt = leaseUntilIso;
    sub.renewalClaimVersion = (sub.renewalClaimVersion ?? 0) + 1;
    this.subscriptions.set(id, sub);
    return { ...sub };
  }

  /** Fencing mirror: check-and-set is atomic in single-threaded JS. */
  async completeSubscriptionRenewal(sub: Subscription, expectedClaimVersion: number): Promise<boolean> {
    const current = this.subscriptions.get(sub.id);
    if (!current) return false;
    if (current.renewalClaimOwner !== sub.renewalClaimOwner) return false;
    if ((current.renewalClaimVersion ?? 0) !== expectedClaimVersion) return false;
    current.renewalClaimOwner = undefined;
    current.renewalClaimExpiresAt = undefined;
    this.subscriptions.set(sub.id, { ...sub, renewalClaimOwner: undefined, renewalClaimExpiresAt: undefined });
    return true;
  }
}

export function newId(): string {
  return randomUUID();
}
