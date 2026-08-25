/**
 * PayPal adapter — Subscriptions REST (Prompt 01).
 *
 * - Auth: OAuth2 client-credentials, server-side only, token cached.
 * - Checkout: POST /v1/billing/subscriptions requires an admin-mapped
 *   plan (providerPlanRef) — PayPal has no ad-hoc price_data; without a
 *   mapping the adapter fails honestly instead of inventing a plan.
 * - Webhook: OFFICIAL postback verification — transmission headers + raw
 *   event posted to /v1/notifications/verify-webhook-signature; SUCCESS is
 *   required. Event ids dedupe via our PostgreSQL ledger.
 * - Recurring is provider-managed: PAYMENT.SALE.COMPLETED /
 *   BILLING.SUBSCRIPTION.* events normalize to Mox state.
 */

import type { BillingProvider, ProviderCheckoutInput, ProviderCheckoutResult, ProviderEvent } from "../provider.js";
import { WebhookVerificationError } from "../provider.js";
import { httpJson, majorToMinor, normalizeCurrency, requireConfigured } from "./shared.js";

export interface PayPalConfig {
  environment: "test" | "live";
  clientId?: string;
  clientSecret?: string;
  webhookId?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

interface PayPalLink {
  rel: string;
  href: string;
}

export class PayPalProvider implements BillingProvider {
  readonly name = "paypal";
  readonly capabilities = ["checkout", "webhook_verification", "charge", "cancel"] as const;
  readonly environment: string;
  readonly configured: boolean;
  readonly blocker?: string;

  private readonly clientId?: string;
  private readonly clientSecret?: string;
  private readonly webhookId?: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private cachedToken?: { value: string; expiresAt: number };

  constructor(config: PayPalConfig) {
    this.environment = config.environment;
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.webhookId = config.webhookId;
    this.baseUrl = config.baseUrl ?? (config.environment === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com");
    this.fetchImpl = config.fetchImpl ?? fetch.bind(globalThis);
    if (!config.clientId || !config.clientSecret || !config.webhookId) {
      this.configured = false;
      this.blocker = `missing PayPal ${!config.clientId ? "client id" : !config.clientSecret ? "client secret" : "webhook id"} for ${config.environment}`;
    } else {
      this.configured = true;
    }
  }

  private async accessToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAt > now + 30_000) return this.cachedToken.value;
    const basic = Buffer.from(`${requireConfigured(this.clientId, "client id")}:${requireConfigured(this.clientSecret, "client secret")}`).toString("base64");
    const res = await httpJson<{ access_token: string; expires_in: number }>({
      url: `${this.baseUrl}/v1/oauth2/token`,
      method: "POST",
      headers: { authorization: `Basic ${basic}` },
      rawBody: "grant_type=client_credentials",
      fetchImpl: this.fetchImpl,
    });
    this.cachedToken = {
      value: res.data.access_token,
      expiresAt: now + res.data.expires_in * 1000,
    };
    return this.cachedToken.value;
  }

  async createCheckout(input: ProviderCheckoutInput & { providerPriceRef?: string }): Promise<ProviderCheckoutResult> {
    const planId = input.providerPriceRef;
    if (!planId) {
      // PayPal Subscriptions REQUIRES a pre-created plan id. Ad-hoc prices
      // are not supported — fail honestly rather than guessing.
      throw new Error(
        "paypal checkout requires an admin-configured provider plan mapping (provider_plan_mappings) for this price version",
      );
    }
    const token = await this.accessToken();
    const res = await httpJson<{ id: string; links: PayPalLink[] }>({
      url: `${this.baseUrl}/v1/billing/subscriptions`,
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: {
        plan_id: planId,
        custom_id: input.checkoutSessionId,
        application_context: {
          brand_name: "Mox",
          user_action: "SUBSCRIBE_NOW",
          success_url: input.successUrl,
          cancel_url: input.cancelUrl,
        },
      },
      fetchImpl: this.fetchImpl,
    });
    const approve = res.data.links?.find((l) => l.rel === "approve")?.href;
    if (!approve) throw new Error("paypal subscription response lacks approve link");
    return { providerRef: res.data.id, redirectUrl: approve };
  }

  /** Provider-managed recurring — merchant charges are not faked. */
  async charge(): Promise<{ ok: boolean; failureReason: string }> {
    return { ok: false, failureReason: "unsupported: paypal subscriptions are provider-managed" };
  }

  async cancelRemote(subscriptionRef: string): Promise<void> {
    const token = await this.accessToken();
    await httpJson({
      url: `${this.baseUrl}/v1/billing/subscriptions/${encodeURIComponent(subscriptionRef)}/cancel`,
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: { reason: "canceled via Mox" },
      fetchImpl: this.fetchImpl,
    });
  }

  async verifyWebhook(headers: Record<string, string>, rawBody: string): Promise<ProviderEvent> {
    let parsed: {
      id?: string;
      event_type?: string;
      create_time?: string;
      resource?: Record<string, unknown>;
    };
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      throw new WebhookVerificationError("payload is not JSON");
    }
    // OFFICIAL verification flow: postback to PayPal with the exact event
    // plus transmission headers; SUCCESS is mandatory.
    const token = await this.accessToken();
    const verification = await httpJson<{ verification_status: string }>({
      url: `${this.baseUrl}/v1/notifications/verify-webhook-signature`,
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: {
        auth_algo: headers["paypal-auth-algo"],
        cert_url: headers["paypal-cert-url"],
        transmission_id: headers["paypal-transmission-id"],
        transmission_sig: headers["paypal-transmission-sig"],
        transmission_time: headers["paypal-transmission-time"],
        webhook_id: requireConfigured(this.webhookId, "webhook id"),
        webhook_event: parsed,
      },
      fetchImpl: this.fetchImpl,
    });
    if (verification.data.verification_status !== "SUCCESS") {
      throw new WebhookVerificationError(`paypal verify-webhook-signature returned ${verification.data.verification_status}`);
    }

    const resource = parsed.resource ?? {};
    const occurredAt = typeof resource.update_time === "string" ? resource.update_time : parsed.create_time;
    const resourceId = typeof resource.id === "string" ? resource.id : undefined;
    const agreementId = typeof resource.billing_agreement_id === "string" ? resource.billing_agreement_id : undefined;
    const amount = resource.amount as { total?: string; currency?: string } | undefined;
    const currency = normalizeCurrency(amount?.currency);
    switch (parsed.event_type) {
      case "BILLING.SUBSCRIPTION.ACTIVATED":
      case "BILLING.SUBSCRIPTION.CREATED":
        // Activation/creation alone never proves payment (Prompt 01 + 05A).
        throw new WebhookVerificationError(`${parsed.event_type} is not proof of payment`);
      case "CHECKOUT.ORDER.APPROVED":
        throw new WebhookVerificationError("paypal approval is not proof of payment");
      case "BILLING.SUBSCRIPTION.RE-ACTIVATED":
        // Recovery requires authoritative payment/state reconciliation in the
        // service — the event itself never grants entitlement.
        return {
          externalEventId: parsed.id ?? `RE-ACTIVATED:${resourceId ?? ""}`,
          type: "subscription.reactivated",
          subjectRef: resourceId ?? "",
          subscriptionRef: resourceId,
          occurredAt,
          payload: parsed,
        };
      case "PAYMENT.SALE.COMPLETED": {
        return {
          externalEventId: parsed.id ?? `PAYMENT.SALE.COMPLETED:${String(resource.id)}`,
          type: "payment.succeeded",
          subjectRef: agreementId ?? resourceId ?? "",
          subscriptionRef: agreementId ?? resourceId,
          transactionRef: resourceId,
          occurredAt,
          amountMinor: amount?.total !== undefined ? majorToMinor(amount.total, amount?.currency ?? "USD") : undefined,
          currency,
          payload: parsed,
        };
      }
      case "BILLING.SUBSCRIPTION.PAYMENT.FAILED":
        // Resource IS the subscription/billing agreement object.
        return {
          externalEventId: parsed.id ?? `${parsed.event_type}:${resourceId ?? ""}`,
          type: "payment.failed",
          subjectRef: resourceId ?? "",
          subscriptionRef: resourceId,
          occurredAt,
          payload: parsed,
        };
      case "PAYMENT.SALE.DENIED":
        // Bind to the billing agreement/subscription — never to an unrelated
        // sale id as the local authority.
        return {
          externalEventId: parsed.id ?? `PAYMENT.SALE.DENIED:${resourceId ?? ""}`,
          type: "payment.failed",
          subjectRef: agreementId ?? "",
          subscriptionRef: agreementId,
          transactionRef: resourceId,
          occurredAt,
          payload: parsed,
        };
      case "BILLING.SUBSCRIPTION.SUSPENDED":
        // Temporary suspension (failed payment) — recoverable, and MUST NOT
        // behave like a permanent cancellation or trigger remote cancel.
        return {
          externalEventId: parsed.id ?? `${parsed.event_type}:${resourceId ?? ""}`,
          type: "subscription.suspended",
          subjectRef: resourceId ?? "",
          subscriptionRef: resourceId,
          occurredAt,
          payload: parsed,
        };
      case "BILLING.SUBSCRIPTION.CANCELLED":
      case "BILLING.SUBSCRIPTION.EXPIRED":
        return {
          externalEventId: parsed.id ?? `${parsed.event_type}:${resourceId ?? ""}`,
          type: "subscription.canceled",
          subjectRef: resourceId ?? "",
          subscriptionRef: resourceId,
          occurredAt,
          payload: parsed,
        };
      case "PAYMENT.SALE.REFUNDED": {
        return {
          externalEventId: parsed.id ?? `PAYMENT.SALE.REFUNDED:${resourceId ?? ""}`,
          type: "payment.refunded",
          subjectRef: agreementId ?? resourceId ?? "",
          subscriptionRef: agreementId ?? resourceId,
          transactionRef: resourceId,
          occurredAt,
          amountMinor: amount?.total !== undefined ? majorToMinor(amount.total, amount?.currency ?? "USD") : undefined,
          currency,
          payload: parsed,
        };
      }
      case "PAYMENT.SALE.REVERSED":
        return {
          externalEventId: parsed.id ?? `PAYMENT.SALE.REVERSED:${resourceId ?? ""}`,
          type: "dispute.opened",
          subjectRef: agreementId ?? resourceId ?? "",
          subscriptionRef: agreementId ?? resourceId,
          transactionRef: resourceId,
          occurredAt,
          payload: parsed,
        };
      default:
        throw new WebhookVerificationError(`unsupported paypal event ${parsed.event_type}`);
    }
  }

  /** Reconciliation fallback: GET the subscription and check status. */
  async verifyCheckout(input: { providerRef: string }): Promise<{
    paid: boolean;
    amountMinor?: bigint;
    currency?: string;
    occurredAt?: string;
    transactionRef?: string;
  }> {
    const token = await this.accessToken();
    const res = await httpJson<{
      id: string;
      status?: string;
      start_time?: string;
      billing_info?: { last_payment?: { amount?: { value?: string; currency_code?: string; currency?: string } } };
    }>({
      url: `${this.baseUrl}/v1/billing/subscriptions/${encodeURIComponent(input.providerRef)}`,
      headers: { authorization: `Bearer ${token}` },
      fetchImpl: this.fetchImpl,
    });
    const amount = res.data.billing_info?.last_payment?.amount;
    const currency = normalizeCurrency(amount?.currency_code ?? amount?.currency);
    return {
      paid: res.data.status === "ACTIVE" && !!amount?.value && !!currency,
      amountMinor: amount?.value && currency ? majorToMinor(amount.value, currency) : undefined,
      currency,
      occurredAt: res.data.start_time,
      transactionRef: res.data.id,
    };
  }
}
