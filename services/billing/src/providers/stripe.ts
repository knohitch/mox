/**
 * Stripe adapter — Stripe Billing / Checkout (Prompt 01).
 *
 * - Webhook: `Stripe-Signature` = `t=<unix>,v1=<hmac_sha256_hex>` computed
 *   over `${t}.${rawBody}` with the webhook signing secret; ±5 min
 *   tolerance; any listed v1 accepted; constant-time compare.
 * - Checkout: server-created Checkout Session (mode=subscription,
 *   price_data recurring month) — client never supplies amount/currency.
 * - Recurring is provider-managed: invoice.paid / invoice.payment_failed
 *   drive renewal state; merchant-initiated charges are not faked.
 * - Cancellation: DELETE /v1/subscriptions/:id.
 */

import { createHmac } from "node:crypto";
import type { BillingProvider, ProviderCheckoutInput, ProviderCheckoutResult, ProviderEvent } from "../provider.js";
import { WebhookVerificationError } from "../provider.js";
import { httpJson, requireConfigured, safeEquals } from "./shared.js";

export interface StripeConfig {
  environment: "test" | "live";
  secretKey?: string;
  /** whsec_… webhook signing secret. */
  webhookSecret?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

const SIGNATURE_TOLERANCE_SECONDS = 300;

function formEncode(fields: Record<string, string | number | undefined>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.join("&");
}

interface StripeResponse {
  id: string;
  object: string;
  status?: string;
  payment_status?: string;
  subscription?: string;
  amount_total?: number;
  currency?: string;
  created?: number;
  current_period_end?: number;
}

export class StripeProvider implements BillingProvider {
  readonly name = "stripe";
  readonly capabilities = ["checkout", "webhook_verification", "charge", "cancel"] as const;
  readonly environment: string;
  readonly configured: boolean;
  readonly blocker?: string;

  private readonly secretKey?: string;
  private readonly webhookSecret?: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: StripeConfig) {
    this.environment = config.environment;
    this.secretKey = config.secretKey;
    this.webhookSecret = config.webhookSecret;
    this.baseUrl = config.baseUrl ?? "https://api.stripe.com";
    this.fetchImpl = config.fetchImpl ?? fetch.bind(globalThis);
    if (!config.secretKey || !config.webhookSecret) {
      this.configured = false;
      this.blocker = `missing Stripe ${!config.secretKey ? "secret key" : "webhook signing secret"} for ${config.environment}`;
    } else {
      this.configured = true;
    }
  }

  async createCheckout(input: ProviderCheckoutInput): Promise<ProviderCheckoutResult> {
    const key = requireConfigured(this.secretKey, "secret key");
    const res = await httpJson<StripeResponse>({
      url: `${this.baseUrl}/v1/checkout/sessions`,
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
      rawBody: formEncode({
        mode: "subscription",
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        client_reference_id: input.orgId,
        "line_items[0][quantity]": 1,
        "line_items[0][price_data][currency]": input.currency,
        // Integer minor units straight from the Mox PriceBook.
        "line_items[0][price_data][unit_amount]": Number(input.amountMinor),
        "line_items[0][price_data][recurring][interval]": "month",
        "line_items[0][price_data][product_data][name]": input.description,
        "metadata[checkout_session_id]": input.checkoutSessionId,
      }),
      fetchImpl: this.fetchImpl,
    });
    return { providerRef: res.data.id, redirectUrl: (res.data as { url?: string }).url ?? `https://checkout.stripe.com/c/pay/${res.data.id}` };
  }

  /** Renewals are provider-managed by Stripe Billing. */
  async charge(): Promise<{ ok: boolean; failureReason: string }> {
    return { ok: false, failureReason: "unsupported: stripe subscriptions are provider-managed" };
  }

  async cancelRemote(subscriptionRef: string): Promise<void> {
    const key = requireConfigured(this.secretKey, "secret key");
    await httpJson({
      url: `${this.baseUrl}/v1/subscriptions/${encodeURIComponent(subscriptionRef)}`,
      method: "DELETE",
      headers: { authorization: `Bearer ${key}` },
      fetchImpl: this.fetchImpl,
    });
  }

  async verifyWebhook(headers: Record<string, string>, rawBody: string): Promise<ProviderEvent> {
    const header = headers["stripe-signature"];
    if (!header) throw new WebhookVerificationError("missing stripe-signature header");
    const parts = Object.fromEntries(
      header.split(",").map((piece) => {
        const [k, v] = piece.split("=", 2);
        return [(k ?? "").trim(), (v ?? "").trim()];
      }),
    );
    const timestamp = parts["t"];
    const signatures = header
      .split(",")
      .filter((piece) => piece.trim().startsWith("v1="))
      .map((piece) => piece.trim().slice(3));
    if (!timestamp || signatures.length === 0) {
      throw new WebhookVerificationError("malformed stripe-signature scheme");
    }
    const age = Math.abs(Date.now() / 1000 - Number(timestamp));
    if (!Number.isFinite(age) || age > SIGNATURE_TOLERANCE_SECONDS) {
      throw new WebhookVerificationError("timestamp outside tolerance window");
    }
    const expected = createHmac("sha256", requireConfigured(this.webhookSecret, "webhook signing secret"))
      .update(`${timestamp}.${rawBody}`)
      .digest("hex");
    const matched = signatures.some((sig) => safeEquals(sig, expected));
    if (!matched) throw new WebhookVerificationError("v1 signature mismatch");

    let parsed: {
      id?: string;
      type?: string;
      created?: number;
      livemode?: boolean;
      data?: { object?: Record<string, unknown> };
    };
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      throw new WebhookVerificationError("payload is not JSON");
    }
    const obj = (parsed.data?.object ?? {}) as {
      id?: string;
      subscription?: string;
      subscription_details?: unknown;
      amount_total?: number;
      payment_status?: string;
      mode?: string;
      amount_due?: number;
      amount_paid?: number;
      currency?: string;
      created?: number;
      billing_reason?: string;
      status?: string;
    };
    const occurredAt =
      parsed.created !== undefined ? new Date(parsed.created * 1000).toISOString() : undefined;
    const eventEnvironment = parsed.livemode === true ? "live" : parsed.livemode === false ? "test" : undefined;
    if (eventEnvironment && eventEnvironment !== this.environment) {
      throw new WebhookVerificationError(`stripe livemode ${eventEnvironment} does not match ${this.environment}`);
    }

    switch (parsed.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded":
        if (obj.mode && obj.mode !== "subscription") {
          throw new WebhookVerificationError(`stripe checkout mode ${obj.mode} is not subscription`);
        }
        if (obj.payment_status !== "paid") {
          throw new WebhookVerificationError(`stripe checkout payment_status ${String(obj.payment_status)} is not paid`);
        }
        return {
          externalEventId: parsed.id ?? `checkout:${obj.id}`,
          type: "checkout.completed",
          subjectRef: obj.id ?? "",
          subscriptionRef: typeof obj.subscription === "string" ? obj.subscription : undefined,
          occurredAt,
          amountMinor: obj.amount_total !== undefined ? BigInt(obj.amount_total) : undefined,
          currency: obj.currency,
          payload: parsed,
        };
      case "invoice.paid":
      case "invoice.payment_succeeded":
        return {
          externalEventId: parsed.id ?? `invoice.paid:${obj.id}`,
          type: "payment.succeeded",
          subjectRef: typeof obj.subscription === "string" ? obj.subscription : "",
          subscriptionRef: typeof obj.subscription === "string" ? obj.subscription : undefined,
          occurredAt,
          amountMinor: (obj.amount_paid ?? obj.amount_due) !== undefined ? BigInt((obj.amount_paid ?? obj.amount_due)!) : undefined,
          currency: obj.currency,
          invoiceRef: obj.id,
          payload: parsed,
        };
      case "invoice.payment_failed":
        return {
          externalEventId: parsed.id ?? `invoice.failed:${obj.id}`,
          type: "payment.failed",
          subjectRef: typeof obj.subscription === "string" ? obj.subscription : "",
          subscriptionRef: typeof obj.subscription === "string" ? obj.subscription : undefined,
          occurredAt,
          payload: parsed,
        };
      case "customer.subscription.deleted":
        return {
          externalEventId: parsed.id ?? `sub.deleted:${obj.id}`,
          type: "subscription.canceled",
          subjectRef: obj.id ?? "",
          subscriptionRef: obj.id,
          occurredAt,
          payload: parsed,
        };
      case "charge.refunded":
        return {
          externalEventId: parsed.id ?? `charge.refunded:${obj.id}`,
          type: "payment.refunded",
          subjectRef: typeof obj.subscription === "string" ? obj.subscription : obj.id ?? "",
          subscriptionRef: typeof obj.subscription === "string" ? obj.subscription : undefined,
          transactionRef: obj.id,
          occurredAt,
          amountMinor: (obj as { amount_refunded?: number }).amount_refunded !== undefined ? BigInt((obj as { amount_refunded?: number }).amount_refunded!) : undefined,
          currency: obj.currency,
          payload: parsed,
        };
      case "charge.dispute.created":
        return {
          externalEventId: parsed.id ?? `charge.dispute.created:${obj.id}`,
          type: "dispute.opened",
          subjectRef: typeof (obj as { charge?: string }).charge === "string" ? (obj as { charge: string }).charge : obj.id ?? "",
          transactionRef: typeof (obj as { charge?: string }).charge === "string" ? (obj as { charge: string }).charge : undefined,
          occurredAt,
          amountMinor: (obj as { amount?: number }).amount !== undefined ? BigInt((obj as { amount?: number }).amount!) : undefined,
          currency: obj.currency,
          payload: parsed,
        };
      case "charge.dispute.closed": {
        const status = (obj as { status?: string }).status;
        return {
          externalEventId: parsed.id ?? `charge.dispute.closed:${obj.id}`,
          type: "dispute.resolved",
          subjectRef: typeof (obj as { charge?: string }).charge === "string" ? (obj as { charge: string }).charge : obj.id ?? "",
          transactionRef: typeof (obj as { charge?: string }).charge === "string" ? (obj as { charge: string }).charge : undefined,
          occurredAt,
          resolution: status === "won" ? "won" : status === "lost" ? "lost" : "unknown",
          payload: parsed,
        };
      }
      default:
        throw new WebhookVerificationError(`unsupported stripe event ${parsed.type}`);
    }
  }

  /** Reconciliation fallback: retrieve the Checkout Session. */
  async verifyCheckout(input: { providerRef: string }): Promise<{
    paid: boolean;
    amountMinor?: bigint;
    currency?: string;
    occurredAt?: string;
    transactionRef?: string;
  }> {
    const key = requireConfigured(this.secretKey, "secret key");
    const res = await httpJson<StripeResponse>({
      url: `${this.baseUrl}/v1/checkout/sessions/${encodeURIComponent(input.providerRef)}`,
      headers: { authorization: `Bearer ${key}` },
      fetchImpl: this.fetchImpl,
    });
    return {
      paid: res.data.payment_status === "paid",
      amountMinor: res.data.amount_total !== undefined ? BigInt(res.data.amount_total) : undefined,
      currency: res.data.currency,
      occurredAt:
        res.data.created !== undefined ? new Date(res.data.created * 1000).toISOString() : undefined,
      transactionRef: res.data.id,
    };
  }
}
