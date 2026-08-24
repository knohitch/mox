/**
 * Flutterwave adapter — v3 API generation (Prompt 01).
 *
 * The v3 generation is selected INTENTIONALLY: webhook authenticity is the
 * `verif-hash` header compared to the dashboard secret hash (exact match,
 * constant-time). No obsolete signature scheme is mixed in.
 *
 * - Checkout: POST /payments with amount in MAJOR units (converted from
 *   Mox minor units using currency exponent) and tx_ref = our checkout ref.
 * - Recurring: provider-managed plans/subscriptions only; merchant-charging
   a stored credential is NOT faked.
 * - Cancellation: official POST /subscriptions/:id/cancel after lookup.
 * - Reconciliation: GET /transactions/verify_by_reference.
 */

import type { BillingProvider, ProviderCheckoutInput, ProviderCheckoutResult, ProviderEvent } from "../provider.js";
import { WebhookVerificationError } from "../provider.js";
import { httpJson, majorToMinor, requireConfigured, safeEquals } from "./shared.js";

export interface FlutterwaveConfig {
  environment: "test" | "live";
  secretKey?: string;
  /** Dashboard webhook "secret hash" sent back in `verif-hash`. */
  secretHash?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

interface FlwEnvelope<T> {
  status: string;
  message: string;
  data: T;
}

export class FlutterwaveProvider implements BillingProvider {
  readonly name = "flutterwave";
  readonly capabilities = ["checkout", "webhook_verification", "charge", "cancel"] as const;
  readonly environment: string;
  readonly configured: boolean;
  readonly blocker?: string;

  private readonly secretKey?: string;
  private readonly secretHash?: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: FlutterwaveConfig) {
    this.environment = config.environment;
    this.secretKey = config.secretKey;
    this.secretHash = config.secretHash;
    this.baseUrl = config.baseUrl ?? "https://api.flutterwave.com/v3";
    this.fetchImpl = config.fetchImpl ?? fetch.bind(globalThis);
    if (!config.secretKey || !config.secretHash) {
      this.configured = false;
      this.blocker = `missing Flutterwave ${!config.secretKey ? "secret key" : "webhook secret hash"} for ${config.environment}`;
    } else {
      this.configured = true;
    }
  }

  async createCheckout(input: ProviderCheckoutInput): Promise<ProviderCheckoutResult> {
    const secret = requireConfigured(this.secretKey, "secret key");
    const txRef = `mox_${input.checkoutSessionId}`;
    // FLW takes major-unit decimals; convert from our integer minor units.
    const exponent = input.currency === "JPY" ? 0 : 2;
    const major = Number(input.amountMinor) / 10 ** exponent;
    const res = await httpJson<FlwEnvelope<{ link: string }>>({
      url: `${this.baseUrl}/payments`,
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
      body: {
        tx_ref: txRef,
        amount: major,
        currency: input.currency,
        redirect_url: input.successUrl,
        customer: { email: input.customerEmail ?? `org-${input.orgId}@billing.mox.internal` },
        meta: { checkout_session_id: input.checkoutSessionId, org_id: input.orgId },
      },
      fetchImpl: this.fetchImpl,
    });
    if (res.data.status !== "success") throw new Error(`flutterwave payments failed: ${res.data.message}`);
    return { providerRef: txRef, redirectUrl: res.data.data.link };
  }

  /** Merchant-initiated tokenized charging is not faked. */
  async charge(): Promise<{ ok: boolean; failureReason: string }> {
    return { ok: false, failureReason: "unsupported: flutterwave recurring is provider-managed (v3)" };
  }

  async cancelRemote(subscriptionRef: string): Promise<void> {
    const secret = requireConfigured(this.secretKey, "secret key");
    await httpJson({
      url: `${this.baseUrl}/subscriptions/${encodeURIComponent(subscriptionRef)}/cancel`,
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
      fetchImpl: this.fetchImpl,
    });
  }

  async verifyWebhook(headers: Record<string, string>, rawBody: string): Promise<ProviderEvent> {
    // v3 verification: exact constant-time match of verif-hash to the
    // configured secret hash. Nothing else is trusted.
    if (!safeEquals(headers["verif-hash"], requireConfigured(this.secretHash, "secret hash"))) {
      throw new WebhookVerificationError("verif-hash mismatch");
    }
    let parsed: {
      event?: string;
      data?: {
        id?: number;
        tx_ref?: string;
        status?: string;
        amount?: number | string;
        currency?: string;
        created_at?: string;
        subscription_id?: number | string;
        flw_ref?: string;
        tx_id?: number | string;
        chargeback_id?: number | string;
      };
    };
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      throw new WebhookVerificationError("payload is not JSON");
    }
    const data = parsed.data ?? {};
    switch (parsed.event) {
      case "charge.completed": {
        const successful = data.status === "successful" || data.status === "success";
        return {
          externalEventId: `charge.completed:${data.id ?? data.tx_ref}`,
          type: successful ? "checkout.completed" : "payment.failed",
          subjectRef: data.tx_ref ?? "",
          subscriptionRef:
            data.subscription_id !== undefined ? String(data.subscription_id) : undefined,
          occurredAt: data.created_at,
          amountMinor: data.amount !== undefined ? majorToMinor(data.amount, data.currency ?? "USD") : undefined,
          currency: data.currency,
          payload: parsed,
        };
      }
      case "subscription.cancelled":
      case "subscription.cancelled.":
        return {
          externalEventId: `subscription.cancelled:${data.id ?? data.subscription_id}`,
          type: "subscription.canceled",
          subjectRef: data.subscription_id !== undefined ? String(data.subscription_id) : "",
          occurredAt: data.created_at,
          payload: parsed,
        };
      case "refund.completed":
      case "refund.processed":
        return {
          externalEventId: `${parsed.event}:${data.id ?? data.tx_id ?? data.tx_ref}`,
          type: "payment.refunded",
          subjectRef: data.subscription_id !== undefined ? String(data.subscription_id) : data.tx_ref ?? "",
          transactionRef: data.tx_ref ?? data.flw_ref,
          occurredAt: data.created_at,
          amountMinor: data.amount !== undefined ? majorToMinor(data.amount, data.currency ?? "USD") : undefined,
          currency: data.currency,
          payload: parsed,
        };
      case "chargeback.created":
      case "chargeback.initiated":
        return {
          externalEventId: `${parsed.event}:${data.chargeback_id ?? data.id ?? data.tx_ref}`,
          type: "dispute.opened",
          subjectRef: data.subscription_id !== undefined ? String(data.subscription_id) : data.tx_ref ?? "",
          transactionRef: data.tx_ref ?? data.flw_ref,
          occurredAt: data.created_at,
          amountMinor: data.amount !== undefined ? majorToMinor(data.amount, data.currency ?? "USD") : undefined,
          currency: data.currency,
          payload: parsed,
        };
      default:
        throw new WebhookVerificationError(`unsupported flutterwave event ${parsed.event}`);
    }
  }

  /** Reconciliation fallback: official verify-by-reference endpoint. */
  async verifyCheckout(input: { providerRef: string }): Promise<{
    paid: boolean;
    amountMinor?: bigint;
    currency?: string;
    occurredAt?: string;
    transactionRef?: string;
  }> {
    const secret = requireConfigured(this.secretKey, "secret key");
    const res = await httpJson<
      FlwEnvelope<{
        id?: number;
        status?: string;
        amount?: number | string;
        currency?: string;
        created_at?: string;
        tx_ref?: string;
      }>
    >({
      url: `${this.baseUrl}/transactions/verify_by_reference?url=${encodeURIComponent(input.providerRef)}`,
      headers: { authorization: `Bearer ${secret}` },
      fetchImpl: this.fetchImpl,
    });
    const tx = res.data?.data;
    void tx?.tx_ref;
    const paid = res.data?.status === "success" && tx?.status === "successful";
    return {
      paid,
      amountMinor: tx?.amount !== undefined ? majorToMinor(tx.amount, tx?.currency ?? "USD") : undefined,
      currency: tx?.currency,
      occurredAt: tx?.created_at,
      transactionRef: tx?.id !== undefined ? String(tx.id) : undefined,
    };
  }
}
