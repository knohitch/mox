/**
 * Billing provider abstraction (Prompt 08).
 *
 * Business logic binds to this interface only. A production gateway is
 * implemented ONLY when real credentials/configuration exist; otherwise
 * providers report not-configured honestly (no invented credentials,
 * no silent mock success in production paths).
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export interface ProviderCheckoutInput {
  orgId: string;
  checkoutSessionId: string;
  description: string;
  amountMinor: bigint | number;
  currency: string;
  successUrl: string;
  cancelUrl: string;
  /** Billing email when known; providers require one for receipts. */
  customerEmail?: string;
}

export interface ProviderCheckoutResult {
  providerRef: string;
  redirectUrl: string;
}

/** Normalized provider event after signature verification. */
export interface ProviderEvent {
  externalEventId: string;
  type:
    | "checkout.completed"
    | "payment.succeeded"
    | "payment.failed"
    | "subscription.canceled";
  sequence?: number;
  /** Checkout session or subscription provider reference. */
  subjectRef: string;
  /** Provider transaction/payment id when present (ledger enrichment). */
  transactionRef?: string;
  /**
   * Canonical subscription ref when the event carries one directly (e.g.
   * Stripe invoice events carry the subscription id). Lets the service
   * bind/refresh subscription.providerRef (Prompt 01 §Durable).
   */
  subscriptionRef?: string;
  /** Provider-side occurrence time; drives out-of-order protection. */
  occurredAt?: string;
  /** Integer minor units when the provider includes money in the event. */
  amountMinor?: bigint | number;
  currency?: string;
  payload: unknown;
}

export class WebhookVerificationError extends Error {
  constructor(reason: string) {
    super(`webhook verification failed: ${reason}`);
    this.name = "WebhookVerificationError";
  }
}

/** Honest capability flags — adapters never fake unsupported operations. */
export interface BillingProviderCapabilities {
  /** Provider-managed recurring renewals (Stripe/PayPal/Paystack plans). */
  managedRenewals?: boolean;
  /** Merchant-initiated charge of a stored authorization. */
  merchantCharge?: boolean;
  /** Checkout verification/reconciliation fallback. */
  reconciliation?: boolean;
}

export const BILLING_PROVIDER_CAPABILITIES = [
  "checkout",
  "webhook_verification",
  "charge",
  "cancel",
] as const;

export type BillingProviderCapability = (typeof BILLING_PROVIDER_CAPABILITIES)[number];

export interface BillingProvider {
  readonly name: string;
  readonly capabilities: readonly BillingProviderCapability[];
  /** test/live environment this configured instance operates in. */
  readonly environment: string;
  /** True when real credentials are configured; false means unusable. */
  readonly configured: boolean;
  /** Human-readable configuration blocker when configured is false. */
  readonly blocker?: string;
  createCheckout(input: ProviderCheckoutInput): Promise<ProviderCheckoutResult>;
  charge(input: {
    providerRef: string;
    amountMinor: bigint | number;
    currency: string;
    idempotencyKey: string;
  }): Promise<{ ok: boolean; providerInvoiceRef?: string; failureReason?: string }>;
  cancelRemote(providerRef: string): Promise<void>;
  /**
   * Verify an inbound webhook and normalize it. Throws
   * WebhookVerificationError for bad signatures/replays.
   */
  verifyWebhook(headers: Record<string, string>, rawBody: string): Promise<ProviderEvent>;
}

/**
 * Optional reconciliation seam (Prompt 01 §Reconciliation): providers that
 * support server-side checkout verification implement this so missed
 * webhooks can repair state exactly once.
 */
export interface ReconcilableBillingProvider extends BillingProvider {
  verifyCheckout(input: { providerRef: string }): Promise<{
    paid: boolean;
    amountMinor?: bigint | number;
    currency?: string;
    occurredAt?: string;
    transactionRef?: string;
  }>;
}

export function supportsReconciliation(p: BillingProvider): p is ReconcilableBillingProvider {
  return typeof (p as ReconcilableBillingProvider).verifyCheckout === "function";
}

export interface BillingProvider {
  readonly name: string;
  readonly capabilities: readonly BillingProviderCapability[];
  /** True when real credentials are configured; false means unusable. */
  readonly configured: boolean;
  /** Human-readable configuration blocker when configured is false. */
  readonly blocker?: string;
  createCheckout(input: ProviderCheckoutInput): Promise<ProviderCheckoutResult>;
  charge(input: {
    providerRef: string;
    amountMinor: bigint | number;
    currency: string;
    idempotencyKey: string;
  }): Promise<{ ok: boolean; providerInvoiceRef?: string; failureReason?: string }>;
  cancelRemote(providerRef: string): Promise<void>;
  /**
   * Verify an inbound webhook and normalize it. Throws
   * WebhookVerificationError for bad signatures/replays.
   */
  verifyWebhook(headers: Record<string, string>, rawBody: string): Promise<ProviderEvent>;
}

/** Shared HMAC-SHA256 webhook signing scheme used by Mox-compatible gateways. */
export function signPayload(secret: string, rawBody: string, timestamp: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

export function digestPayload(rawBody: string): string {
  return createHash("sha256").update(rawBody).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Test/development harness provider. Clearly flagged as a fake via `name`,
 * so production code never mistakes it for a configured gateway.
 */
export class FakeBillingProvider implements BillingProvider {
  readonly name: string;
  readonly capabilities = BILLING_PROVIDER_CAPABILITIES;
  readonly environment: string;
  readonly configured = true;

  private readonly secret: string;
  private eventCounter = 0;
  private failNextCharge = false;
  private readonly remoteRefs = new Set<string>();

  constructor(name = "fake-gateway", secret = "test-webhook-secret", environment = "test") {
    this.name = name;
    this.secret = secret;
    this.environment = environment;
  }

  /** Test hook: force the next charge attempt to decline. */
  declineNextCharge(): void {
    this.failNextCharge = true;
  }

  async createCheckout(input: ProviderCheckoutInput): Promise<ProviderCheckoutResult> {
    const providerRef = `${this.name}:co_${input.checkoutSessionId}`;
    return { providerRef, redirectUrl: `https://pay.example.test/checkout/${providerRef}` };
  }

  async charge(input: {
    providerRef: string;
    amountMinor: bigint | number;
    currency: string;
    idempotencyKey: string;
  }): Promise<{ ok: boolean; providerInvoiceRef?: string; failureReason?: string }> {
    if (!this.remoteRefs.has(input.providerRef)) {
      // Unknown payment method: honest failure.
      return { ok: false, failureReason: "no_payment_method" };
    }
    if (this.failNextCharge) {
      this.failNextCharge = false;
      return { ok: false, failureReason: "card_declined" };
    }
    return { ok: true, providerInvoiceRef: `${this.name}:in_${input.idempotencyKey}` };
  }

  async cancelRemote(providerRef: string): Promise<void> {
    this.remoteRefs.delete(providerRef);
  }

  async verifyWebhook(headers: Record<string, string>, rawBody: string): Promise<ProviderEvent> {
    const timestamp = headers["x-mox-timestamp"];
    const signature = headers["x-mox-signature"];
    if (!timestamp || !signature) {
      throw new WebhookVerificationError("missing signature headers");
    }
    const expected = signPayload(this.secret, rawBody, timestamp);
    if (!safeEqual(expected, signature)) {
      throw new WebhookVerificationError("signature mismatch");
    }
    let parsed: { eventId?: string; type?: string; subjectRef?: string; sequence?: number };
    try {
      parsed = JSON.parse(rawBody) as typeof parsed;
    } catch {
      throw new WebhookVerificationError("payload is not JSON");
    }
    if (!parsed.eventId || !parsed.type || !parsed.subjectRef) {
      throw new WebhookVerificationError("payload missing required fields");
    }
    this.remoteRefs.add(parsed.subjectRef);
    this.eventCounter += 1;
    return {
      externalEventId: parsed.eventId,
      type: parsed.type as ProviderEvent["type"],
      sequence: parsed.sequence ?? this.eventCounter,
      subjectRef: parsed.subjectRef,
      payload: parsed,
    };
  }
}

/**
 * Placeholder used when no real gateway credentials are configured.
 * Every operation reports honestly that billing is unavailable.
 */
export class UnconfiguredBillingProvider implements BillingProvider {
  readonly name: string;
  readonly capabilities = BILLING_PROVIDER_CAPABILITIES;
  readonly environment = "test";
  readonly configured = false;
  readonly blocker: string;

  constructor(blocker: string) {
    this.name = "unconfigured";
    this.blocker = blocker;
  }

  private unavailable(): never {
    throw new Error(`billing provider not configured: ${this.blocker}`);
  }

  createCheckout(): Promise<ProviderCheckoutResult> {
    return this.unavailable();
  }

  charge(): ReturnType<BillingProvider["charge"]> {
    return this.unavailable();
  }

  cancelRemote(): Promise<void> {
    return this.unavailable();
  }

  verifyWebhook(): Promise<ProviderEvent> {
    return this.unavailable();
  }
}
