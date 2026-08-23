/**
 * Billing domain types (Prompt 08). Money is always @mox/money values:
 * integer minor units plus ISO-4217 currency. No floats anywhere.
 */

import type { Money } from "@mox/money";

export type PlanTier = "plus" | "pro" | "max" | "enterprise";
export type PlanVersionStatus = "draft" | "active" | "retired";

export interface Product {
  id: string;
  code: string;
  tier: PlanTier;
  displayName: string;
}

/** Immutable once active; changes ship as a new version, never in place. */
export interface PlanVersion {
  id: string;
  productId: string;
  version: number;
  status: PlanVersionStatus;
  createdAt: string;
  activatedAt?: string;
  retiredAt?: string;
}

export type PriceBookMode = "fixed" | "fx_derived" | "disabled";

export interface PricingRegion {
  code: string;
  displayName: string;
  chargeCurrency: string;
  displayCurrency: string;
}

export interface PriceBook {
  id: string;
  productId: string;
  pricingRegionCode: string;
  mode: PriceBookMode;
  /** For fx_derived books: base amount + rate used to derive local price. */
  baseCurrency?: string;
  baseAmountMinor?: bigint | number;
  fxRate?: number;
}

export interface PriceVersion {
  id: string;
  priceBookId: string;
  version: number;
  amountMinor: bigint | number;
  currency: string;
  effectiveFrom: string;
  createdAt: string;
}

export interface AddonDefinition {
  code: string;
  displayName: string;
  /** Consumables (AI credits) vs persistent resources (extra VPS). */
  consumable: boolean;
  unit: string;
}

export type SubscriptionState =
  | "trial"
  | "active"
  | "past_due"
  | "grace_period"
  | "suspended"
  | "canceled"
  | "retention"
  | "deleted";

export interface SubscriptionItem {
  id: string;
  subscriptionId: string;
  kind: "base" | "addon";
  addonCode?: string;
  quantity: number;
  priceVersionId?: string;
}

export interface Subscription {
  id: string;
  orgId: string;
  planVersionId: string;
  priceVersionId: string;
  state: SubscriptionState;
  providerRef?: string;
  /** test/live — set from the provider configuration that owns the ref. */
  providerEnvironment?: string;
  /**
   * Timestamp of the newest provider event APPLIED to this subscription
   * (Prompt 01 §Event ordering): older events must never regress newer
   * state.
   */
  lastEventAt?: string;
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
  createdAt: string;
}

export type CheckoutSessionState = "created" | "redirected" | "completed" | "expired";

export interface CheckoutSession {
  id: string;
  orgId: string;
  planVersionId: string;
  priceVersionId: string;
  state: CheckoutSessionState;
  providerName: string;
  /** test/live environment of the provider that owns the ref. */
  environment?: string;
  /** Provider-side checkout reference returned by provider.createCheckout. */
  providerRef?: string;
  redirectUrl?: string;
  expiresAt?: string;
  createdAt: string;
}

export interface BillingCustomer {
  orgId: string;
  providerName: string;
  providerCustomerId: string;
  billingRegion: string;
  defaultDisplayCurrency?: string;
  createdAt: string;
}

export type InvoiceStatus = "open" | "paid" | "failed" | "void";

export interface Invoice {
  id: string;
  subscriptionId: string;
  periodStart: string;
  periodEnd: string;
  amount: Money;
  status: InvoiceStatus;
  providerInvoiceRef?: string;
  attempt: number;
  createdAt: string;
  paidAt?: string;
}

export type WebhookStatus = "received" | "verified" | "applied" | "rejected";

export interface WebhookRecord {
  id: string;
  providerName: string;
  externalEventId: string;
  type: string;
  sequence?: number;
  payloadDigest: string;
  status: WebhookStatus;
  receivedAt: string;
  appliedAt?: string;
  rejectionReason?: string;
}

export interface SubscriptionTransition {
  id: string;
  subscriptionId: string;
  fromState?: SubscriptionState;
  toState: SubscriptionState;
  reason: string;
  actorType: "system" | "admin" | "user";
  actorId?: string;
  idempotencyKey?: string;
  at: string;
}

/** Normalized provider payment/event ledger row (Prompt 01 §Durable). */
export interface ProviderPaymentRecord {
  id: string;
  providerName: string;
  environment: string;
  externalEventId: string;
  eventType: string;
  orgId?: string;
  providerSubscriptionRef?: string;
  checkoutSessionRef?: string;
  providerTransactionRef?: string;
  invoiceRef?: string;
  state: string;
  currency?: string;
  amountMinor?: bigint | number;
  payloadDigest: string;
  occurredAt?: string;
  receivedAt: string;
  reconciledAt?: string;
}
