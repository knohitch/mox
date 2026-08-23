/**
 * Paystack adapter (Prompt 01) — current official recurring behavior.
 *
 * - Webhook: HMAC-SHA512 of the RAW body, hex, in `x-paystack-signature`,
 *   keyed with the SECRET key; constant-time compare (no timestamp exists,
 *   so replay protection relies on our PostgreSQL event dedupe).
 * - Checkout: POST /transaction/initialize with amount in minor units
 *   (kobo/pesewas/cents), reference = our checkout ref.
 * - Recurring: provider-managed subscriptions (plans); renewals arrive as
 *   charge.success / invoice.* webhooks — merchant charging is NOT faked.
 * - Cancellation: official /subscription/disable requires the email token;
 *   when the subscription lookup exposes it we disable, otherwise the
 *   limitation is surfaced honestly.
 */

import { createHmac } from "node:crypto";
import type { BillingProvider, ProviderCheckoutInput, ProviderCheckoutResult, ProviderEvent } from "../provider.js";
import { WebhookVerificationError } from "../provider.js";
import { httpJson, requireConfigured, safeEquals } from "./shared.js";

export interface PaystackConfig {
  environment: "test" | "live";
  /** sk_test_… / sk_live_… — server-side only. */
  secretKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

interface PaystackInitResponse {
  status: boolean;
  message: string;
  data: { authorization_url: string; access_code: string; reference: string };
}

export class PaystackProvider implements BillingProvider {
  readonly name = "paystack";
  readonly capabilities = ["checkout", "webhook_verification", "charge", "cancel"] as const;
  readonly environment: string;
  readonly configured: boolean;
  readonly blocker?: string;

  private readonly secretKey?: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: PaystackConfig) {
    this.environment = config.environment;
    this.secretKey = config.secretKey;
    this.baseUrl = config.baseUrl ?? "https://api.paystack.co";
    this.fetchImpl = config.fetchImpl ?? fetch.bind(globalThis);
    if (!config.secretKey) {
      this.configured = false;
      this.blocker = `missing Paystack secret key for ${config.environment} (set billing_provider_configs.secret_ref target)`;
    } else {
      this.configured = true;
    }
  }

  async createCheckout(input: ProviderCheckoutInput): Promise<ProviderCheckoutResult> {
    const secret = requireConfigured(this.secretKey, "secret key");
    const reference = `mox_${input.checkoutSessionId}`;
    const { data } = await httpJson<PaystackInitResponse>({
      url: `${this.baseUrl}/transaction/initialize`,
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
      body: {
        // Amount is already integer minor units from Mox PriceBook.
        amount: Number(input.amountMinor),
        currency: input.currency,
        reference,
        email: input.customerEmail ?? `org-${input.orgId}@billing.mox.internal`,
        callback_url: input.successUrl,
        metadata: { checkout_session_id: input.checkoutSessionId, org_id: input.orgId },
      },
      fetchImpl: this.fetchImpl,
    });
    if (!data.status) throw new Error(`paystack initialize failed: ${data.message}`);
    return { providerRef: reference, redirectUrl: data.data.authorization_url };
  }

  /**
   * Merchant-initiated charges are not part of Paystack's hosted-plan
   * recurring flow we implement — renewals are provider-managed and arrive
   * via webhooks. Never fake a charge.
   */
  async charge(): Promise<{ ok: boolean; failureReason: string }> {
    return { ok: false, failureReason: "unsupported: paystack recurring is provider-managed" };
  }

  /**
   * Official disable endpoint requires the subscription email token. When
   * the subscription lookup exposes it we disable; otherwise surface the
   * limitation honestly instead of pretending to cancel.
   */
  async cancelRemote(subscriptionRef: string): Promise<void> {
    const secret = requireConfigured(this.secretKey, "secret key");
    const lookup = await httpJson<{
      status: boolean;
      data?: Array<{ subscription_code: string; email_token?: string; id: number }>;
    }>({
      url: `${this.baseUrl}/subscription?perPage=100`,
      headers: { authorization: `Bearer ${secret}` },
      fetchImpl: this.fetchImpl,
    });
    const match = lookup.data?.data?.find((s) => s.subscription_code === subscriptionRef);
    const token = match?.email_token;
    if (!token) {
      throw new Error(
        "paystack cancellation requires the subscription email_token which is not exposed for this subscription; disable it in the Paystack dashboard",
      );
    }
    await httpJson({
      url: `${this.baseUrl}/subscription/disable`,
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
      body: { code: subscriptionRef, token },
      fetchImpl: this.fetchImpl,
    });
  }

  async verifyWebhook(headers: Record<string, string>, rawBody: string): Promise<ProviderEvent> {
    const signature = headers["x-paystack-signature"];
    const expected = createHmac("sha512", requireConfigured(this.secretKey, "secret key"))
      .update(rawBody)
      .digest("hex");
    if (!safeEquals(signature, expected)) {
      throw new WebhookVerificationError("x-paystack-signature mismatch");
    }
    let parsed: {
      event?: string;
      data?: {
        id?: number;
        reference?: string;
        status?: string;
        amount?: number;
        currency?: string;
        paid_at?: string;
        createdAt?: string;
        subscription_code?: string;
        subscription?: { subscription_code?: string };
      };
    };
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      throw new WebhookVerificationError("payload is not JSON");
    }
    const data = parsed.data ?? {};
    const occurredAt = data.paid_at ?? data.createdAt;
    switch (parsed.event) {
      case "charge.success":
        return {
          externalEventId: `charge.success:${data.id ?? data.reference}`,
          type: "checkout.completed",
          subjectRef: data.reference ?? "",
          subscriptionRef: data.subscription?.subscription_code ?? data.subscription_code,
          occurredAt,
          amountMinor: data.amount !== undefined ? BigInt(data.amount) : undefined,
          currency: data.currency,
          payload: parsed,
        };
      case "invoice.payment_failed":
      case "charge.failed":
        return {
          externalEventId: `${parsed.event}:${data.id ?? data.reference}`,
          type: "payment.failed",
          subjectRef: data.subscription?.subscription_code ?? data.subscription_code ?? data.reference ?? "",
          occurredAt,
          payload: parsed,
        };
      case "invoice.update":
        // Paid invoice update on an active subscription = renewal success.
        if (data.status === "paid") {
          return {
            externalEventId: `invoice.update:${data.id ?? data.reference}`,
            type: "payment.succeeded",
            subjectRef: data.subscription?.subscription_code ?? data.subscription_code ?? "",
            occurredAt,
            payload: parsed,
          };
        }
        throw new WebhookVerificationError(`unhandled invoice.update state: ${String(data.status)}`);
      case "subscription.disable":
      case "subscription.not_renew":
        return {
          externalEventId: `${parsed.event}:${data.id ?? data.subscription_code}`,
          type: "subscription.canceled",
          subjectRef: data.subscription_code ?? "",
          occurredAt,
          payload: parsed,
        };
      default:
        throw new WebhookVerificationError(`unsupported paystack event ${parsed.event}`);
    }
  }

  /** Reconciliation fallback: verify a transaction by reference. */
  async verifyCheckout(input: { providerRef: string }): Promise<{
    paid: boolean;
    amountMinor?: bigint;
    currency?: string;
    occurredAt?: string;
    transactionRef?: string;
  }> {
    const secret = requireConfigured(this.secretKey, "secret key");
    const res = await httpJson<{
      status: boolean;
      data?: { status?: string; amount?: number; currency?: string; paid_at?: string; id?: number };
    }>({
      url: `${this.baseUrl}/transaction/verify/${encodeURIComponent(input.providerRef)}`,
      headers: { authorization: `Bearer ${secret}` },
      fetchImpl: this.fetchImpl,
    });
    const tx = res.data?.data;
    return {
      paid: tx?.status === "success",
      amountMinor: tx?.amount !== undefined ? BigInt(tx.amount) : undefined,
      currency: tx?.currency,
      occurredAt: tx?.paid_at,
      transactionRef: tx?.id ? String(tx.id) : undefined,
    };
  }
}
