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
  /** Authoritative provider adapter name; never inferred from providerRef. */
  providerName?: string;
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
  /**
   * Security Repair 05A: why/who suspended this subscription. Sources:
   * payment_failure | admin | refund | dispute | fraud | provider |
   * compliance. Admin reactivation of refund/dispute/fraud/compliance
   * suspensions requires explicit financial reconciliation.
   */
  suspensionReason?: string;
  suspensionSource?: string;
  /** Fail-closed: ambiguous mapping / unmapped plan / partial refund etc. */
  reconciliationRequired?: boolean;
  /** Provider plan/price id last seen on the provider object. */
  providerPlanRef?: string;
  renewalClaimOwner?: string;
  renewalClaimExpiresAt?: string;
  /** Security Repair 05B §A: fencing token set by every renewal claim. */
  renewalClaimVersion?: number;
  canceledAt?: string;
  suspendedAt?: string;
  deletedAt?: string;
  createdAt: string;
}

export type CheckoutSessionState = "created" | "redirected" | "applying" | "completed" | "expired";

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
  claimOwner?: string;
  claimExpiresAt?: string;
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

export type WebhookStatus =
  | "received"
  | "verified"
  | "processing"
  | "applied"
  | "duplicate"
  | "stale_ignored"
  | "reconciliation_required"
  | "rejected";

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
  processingOwner?: string;
  processingExpiresAt?: string;
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
  providerPaymentIntentRef?: string;
  providerChargeRef?: string;
  providerCustomerRef?: string;
  /** Provider invoice/sale identity used for business-effect idempotency. */
  billingIdentity?: string;
  state: string;
  currency?: string;
  amountMinor?: bigint | number;
  payloadDigest: string;
  occurredAt?: string;
  receivedAt: string;
  reconciledAt?: string;
}

/**
 * Durable typed provider-object mapping (Security Repair 05A §A): each
 * provider object type has its own column — never one ambiguous ref.
 */
export interface ProviderObjectMapping {
  id: string;
  providerName: string;
  environment: string;
  orgId?: string;
  subscriptionId?: string;
  providerCustomerRef?: string;
  checkoutSessionRef?: string;
  providerSubscriptionRef?: string;
  providerInvoiceRef?: string;
  providerPaymentRef?: string;
  providerPaymentIntentRef?: string;
  providerChargeRef?: string;
  resolutionState: "resolved" | "reconciliation_required";
  createdAt?: string;
  updatedAt?: string;
}

export type BusinessEffectType =
  | "checkout_grant"
  | "period_extension"
  | "payment_failure"
  | "refund"
  | "dispute_open"
  | "dispute_resolved"
  | "subscription_updated";

export type BusinessEffectOutcome =
  | "applied"
  | "duplicate"
  | "stale_ignored"
  | "reconciliation_required"
  | "rejected";

export interface ProviderBillingEffect {
  id: string;
  providerName: string;
  environment: string;
  billingIdentity: string;
  effectType: BusinessEffectType;
  subscriptionId?: string;
  outcome: BusinessEffectOutcome;
  externalEventId: string;
  createdAt?: string;
}

export type CancellationState =
  | "cancel_requested"
  | "provider_cancel_pending"
  | "canceled"
  | "reconciliation_required";

export interface SubscriptionCancellation {
  subscriptionId: string;
  state: CancellationState;
  requestedBy: string;
  requestedById?: string;
  attempts: number;
  lastError?: string;
  nextAttemptAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface CommercialReconciliationItem {
  subscriptionId: string;
  reason: string;
  enqueuedAt: string;
}
