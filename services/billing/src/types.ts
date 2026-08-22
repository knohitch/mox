/** Billing domain types. Money is integer minor units plus ISO currency. */

import type { Money } from "@mox/money";

export type PlanTier = "plus" | "pro" | "max" | "enterprise";
export type PlanVersionStatus = "draft" | "active" | "retired";
export type PlanEntitlementValue = boolean | number | string;

export interface Product {
  id: string;
  code: string;
  tier: PlanTier;
  displayName: string;
}

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
  /** Explicit gateway identity. Never infer this from providerRef formatting. */
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

export type CheckoutSessionState = "created" | "redirected" | "completed" | "expired";

export interface CheckoutSession {
  id: string;
  orgId: string;
  planVersionId: string;
  priceVersionId: string;
  state: CheckoutSessionState;
  providerName: string;
  providerRef?: string;
  redirectUrl?: string;
  expiresAt?: string;
  applyLeaseUntil?: string;
  createdAt: string;
}

export interface BillingCustomer {
  orgId: string;
  providerName: string;
  /** Only set when the real gateway returns a customer id. */
  providerCustomerId?: string;
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
