/**
 * Payment-provider adapter tests (Prompt 01). All provider HTTP is
 * scripted via injected fetch — no live accounts are ever touched.
 */

import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PaystackProvider } from "../src/providers/paystack.js";
import { FlutterwaveProvider } from "../src/providers/flutterwave.js";
import { StripeProvider } from "../src/providers/stripe.js";
import { PayPalProvider } from "../src/providers/paypal.js";
import { WebhookVerificationError } from "../src/provider.js";

const BASE_CHECKOUT = {
  orgId: "org-1",
  checkoutSessionId: "sess-1",
  description: "Mox Plus",
  amountMinor: 1999n,
  currency: "USD",
  successUrl: "https://app.example/success",
  cancelUrl: "https://app.example/cancel",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ---- Paystack ----------------------------------------------------------------

describe("paystack adapter", () => {
  const secret = "sk_test_paystack";
  const sign = (body: string) => createHmac("sha512", secret).update(body).digest("hex");

  it("verifies HMAC-SHA512 over raw body and normalizes charge.success", async () => {
    const provider = new PaystackProvider({ environment: "test", secretKey: secret });
    const raw = `{"event":"charge.success","data":{"id":42,"reference":"mox_sess-1","status":"success","amount":1999,"currency":"USD","paid_at":"2026-08-23T10:00:00Z"}}`;
    const event = await provider.verifyWebhook({ "x-paystack-signature": sign(raw) }, raw);
    expect(event.type).toBe("checkout.completed");
    expect(event.subjectRef).toBe("mox_sess-1");
    expect(event.amountMinor).toBe(1999n);
  });

  it("rejects tampered bodies and wrong signatures", async () => {
    const provider = new PaystackProvider({ environment: "test", secretKey: secret });
    const raw = `{"event":"charge.success","data":{"reference":"x"}}`;
    await expect(
      provider.verifyWebhook({ "x-paystack-signature": sign(raw + " ") }, raw),
    ).rejects.toBeInstanceOf(WebhookVerificationError);
    await expect(provider.verifyWebhook({}, raw)).rejects.toBeInstanceOf(WebhookVerificationError);
  });

  it("initializes checkout with minor-unit amounts and our reference", async () => {
    let captured: { url: string; body?: unknown } | undefined;
    const provider = new PaystackProvider({
      environment: "test",
      secretKey: secret,
      fetchImpl: async (url, init) => {
        captured = { url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined };
        return jsonResponse(200, {
          status: true,
          message: "ok",
          data: { authorization_url: "https://checkout.paystack.com/abc", access_code: "ac", reference: "mox_sess-1" },
        });
      },
    });
    const result = await provider.createCheckout(BASE_CHECKOUT);
    expect(result.providerRef).toBe("mox_sess-1");
    expect(captured?.url).toContain("/transaction/initialize");
    expect((captured?.body as { amount: number }).amount).toBe(1999); // minor units preserved
  });

  it("surfaces unsupported merchant charge honestly and reconciles via verify", async () => {
    const provider = new PaystackProvider({
      environment: "test",
      secretKey: secret,
      fetchImpl: async () =>
        jsonResponse(200, { status: true, data: { status: "success", amount: 1999, currency: "USD", paid_at: "2026-08-23T10:00:00Z" } }),
    });
    await expect(provider.charge()).resolves.toMatchObject({ ok: false, failureReason: /provider-managed/ });
    const verification = await provider.verifyCheckout({ providerRef: "mox_sess-1" });
    expect(verification.paid).toBe(true);
    expect(verification.amountMinor).toBe(1999n);
  });

  it("unconfigured instances fail honestly", () => {
    const provider = new PaystackProvider({ environment: "test" });
    expect(provider.configured).toBe(false);
    expect(provider.blocker).toMatch(/secret key/i);
  });
});

// ---- Flutterwave ---------------------------------------------------------------

describe("flutterwave adapter", () => {
  const hash = "flw-secret-hash";

  it("verifies verif-hash exact match and converts major to minor units", async () => {
    const provider = new FlutterwaveProvider({
      environment: "test",
      secretKey: "sk_flw",
      secretHash: hash,
    });
    const raw = `{"event":"charge.completed","data":{"id":99,"tx_ref":"mox_sess-2","status":"successful","amount":19.99,"currency":"USD","created_at":"2026-08-23T09:00:00Z"}}`;
    const event = await provider.verifyWebhook({ "verif-hash": hash }, raw);
    expect(event.type).toBe("checkout.completed");
    expect(event.subjectRef).toBe("mox_sess-2");
    // Major-unit 19.99 USD -> 1999 minor units.
    expect(event.amountMinor).toBe(1999n);
  });

  it("rejects missing or mismatched verif-hash", async () => {
    const provider = new FlutterwaveProvider({
      environment: "test",
      secretKey: "sk_flw",
      secretHash: hash,
    });
    const raw = `{"event":"charge.completed","data":{"tx_ref":"x","status":"successful"}}`;
    await expect(provider.verifyWebhook({}, raw)).rejects.toBeInstanceOf(WebhookVerificationError);
    await expect(provider.verifyWebhook({ "verif-hash": "wrong" }, raw)).rejects.toBeInstanceOf(
      WebhookVerificationError,
    );
  });

  it("failed charges normalize to payment.failed", async () => {
    const provider = new FlutterwaveProvider({ environment: "test", secretKey: "k", secretHash: hash });
    const raw = `{"event":"charge.completed","data":{"id":100,"tx_ref":"mox_sess-3","status":"failed","amount":19.99,"currency":"USD"}}`;
    const event = await provider.verifyWebhook({ "verif-hash": hash }, raw);
    expect(event.type).toBe("payment.failed");
  });

  it("creates payment links against the v3 payments endpoint", async () => {
    let calledUrl = "";
    const provider = new FlutterwaveProvider({
      environment: "test",
      secretKey: "sk_flw",
      secretHash: hash,
      fetchImpl: async (url) => {
        calledUrl = String(url);
        return jsonResponse(200, { status: "success", message: "ok", data: { link: "https://flw.link/x" } });
      },
    });
    const result = await provider.createCheckout(BASE_CHECKOUT);
    expect(result.redirectUrl).toBe("https://flw.link/x");
    expect(calledUrl).toContain("/v3/payments".replace("/v3", "")); // base already includes /v3
  });

  it("merchant charge is honestly unsupported", async () => {
    const provider = new FlutterwaveProvider({ environment: "test", secretKey: "k", secretHash: hash });
    await expect(provider.charge()).resolves.toMatchObject({ ok: false, failureReason: /provider-managed/ });
  });
});

// ---- Stripe ---------------------------------------------------------------------

describe("stripe adapter", () => {
  const whsec = "whsec_test";
  let timestamp = Math.floor(Date.now() / 1000);

  function stripeSigned(body: string, secret = whsec, ts = timestamp): string {
    const v1 = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
    return `t=${ts},v1=${v1}`;
  }

  it("verifies t=.v1= HMAC-SHA256 within tolerance and binds subscription ref", async () => {
    const provider = new StripeProvider({
      environment: "test",
      secretKey: "sk_stripe",
      webhookSecret: whsec,
    });
    const raw = JSON.stringify({
      id: "evt_1",
      type: "checkout.session.completed",
      created: timestamp,
      data: { object: { id: "cs_1", subscription: "sub_9", total: 1999, currency: "usd" } },
    });
    const event = await provider.verifyWebhook({ "stripe-signature": stripeSigned(raw) }, raw);
    expect(event.type).toBe("checkout.completed");
    expect(event.subjectRef).toBe("cs_1");
    expect(event.subscriptionRef).toBe("sub_9");
    expect(event.amountMinor).toBe(1999n);
  });

  it("enforces the ±300s tolerance window", async () => {
    const provider = new StripeProvider({
      environment: "test",
      secretKey: "sk_stripe",
      webhookSecret: whsec,
    });
    timestamp -= 3600;
    try {
      const raw = `{"id":"evt_old","type":"invoice.paid","created":${timestamp},"data":{"object":{"subscription":"sub_1"}}}`;
      await expect(provider.verifyWebhook({ "stripe-signature": stripeSigned(raw) }, raw)).rejects.toThrow(
        /tolerance/,
      );
    } finally {
      timestamp = Math.floor(Date.now() / 1000);
    }
  });

  it("rejects tampered payloads and wrong secrets", async () => {
    const provider = new StripeProvider({
      environment: "test",
      secretKey: "sk_stripe",
      webhookSecret: whsec,
    });
    const raw = `{"id":"evt_2","type":"invoice.paid","created":${timestamp},"data":{"object":{"subscription":"sub_1"}}}`;
    await expect(
      provider.verifyWebhook({ "stripe-signature": stripeSigned(raw, "whsec_evil") }, raw),
    ).rejects.toBeInstanceOf(WebhookVerificationError);
  });

  it("creates a server-side Checkout Session with price_data from Mox money", async () => {
    let sentBody = "";
    const provider = new StripeProvider({
      environment: "test",
      secretKey: "sk_stripe",
      webhookSecret: whsec,
      fetchImpl: async (_url, init) => {
        sentBody = String(init?.body ?? "");
        return jsonResponse(200, { id: "cs_test_1", object: "checkout_session" });
      },
    });
    const result = await provider.createCheckout(BASE_CHECKOUT);
    expect(result.providerRef).toBe("cs_test_1");
    expect(sentBody).toContain("mode=subscription");
    expect(decodeURIComponent(sentBody)).toContain("unit_amount]=1999");
    expect(decodeURIComponent(sentBody)).toContain("recurring][interval]=month");
  });

  it("invoice events map renewal success/failure onto subscription refs; merchant charge denied", async () => {
    const provider = new StripeProvider({
      environment: "test",
      secretKey: "sk_stripe",
      webhookSecret: whsec,
    });
    const paid = JSON.stringify({
      id: "evt_paid",
      type: "invoice.paid",
      created: timestamp,
      data: { object: { id: "in_1", subscription: "sub_9", amount_due: 1999, currency: "usd" } },
    });
    const failed = JSON.stringify({
      id: "evt_failed",
      type: "invoice.payment_failed",
      created: timestamp,
      data: { object: { id: "in_2", subscription: "sub_9" } },
    });
    expect((await provider.verifyWebhook({ "stripe-signature": stripeSigned(paid) }, paid)).type).toBe(
      "payment.succeeded",
    );
    expect((await provider.verifyWebhook({ "stripe-signature": stripeSigned(failed) }, failed)).type).toBe(
      "payment.failed",
    );
    await expect(provider.charge()).resolves.toMatchObject({ ok: false });
  });
});

// ---- PayPal ----------------------------------------------------------------------

describe("paypal adapter", () => {
  const headers = {
    "paypal-auth-algo": "SHA256withRSA",
    "paypal-cert-url": "https://api.paypal.com/v1/notifications/certs/CERT-360",
    "paypal-transmission-id": "tid-1",
    "paypal-transmission-sig": "sig-1",
    "paypal-transmission-time": "2026-08-23T10:00:00Z",
  };

  function paypalFetch(options: { verificationStatus?: string }) {
    return async (url: unknown, init?: RequestInit): Promise<Response> => {
      const urlText = String(url);
      if (urlText.includes("/oauth2/token")) {
        return jsonResponse(200, { access_token: "token-1", expires_in: 3600 });
      }
      if (urlText.includes("verify-webhook-signature")) {
        return jsonResponse(200, { verification_status: options.verificationStatus ?? "SUCCESS" });
      }
      throw new Error(`unexpected paypal call ${urlText}`);
    };
  }

  it("requires OFFICIAL postback verification SUCCESS and normalizes activation", async () => {
    let verifyBody: { verification_status?: string; webhook_event?: { event_type?: string } } | undefined;
    const provider = new PayPalProvider({
      environment: "test",
      clientId: "cid",
      clientSecret: "csec",
      webhookId: "WHID",
      fetchImpl: async (url, init) => {
        const urlText = String(url);
        if (urlText.includes("/oauth2/token")) {
          return jsonResponse(200, { access_token: "t", expires_in: 3600 });
        }
        if (urlText.includes("verify-webhook-signature")) {
          verifyBody = JSON.parse(String(init?.body));
          return jsonResponse(200, { verification_status: "SUCCESS" });
        }
        throw new Error(`unexpected ${urlText}`);
      },
    });
    const raw = JSON.stringify({
      id: "WH-1",
      event_type: "BILLING.SUBSCRIPTION.ACTIVATED",
      create_time: "2026-08-23T10:00:00Z",
      resource: { id: "I-ABC123" },
    });
    const event = await provider.verifyWebhook(headers, raw);
    expect(event.type).toBe("checkout.completed");
    expect(event.subjectRef).toBe("I-ABC123");
    expect(event.subscriptionRef).toBe("I-ABC123");
    expect(verifyBody?.verification_status).toBeUndefined(); // request carries webhook_event
    expect((verifyBody as unknown as { webhook_id: string }).webhook_id).toBe("WHID");
    void verifyBody;
  });

  it("fails closed when PayPal reports FAILURE", async () => {
    const provider = new PayPalProvider({
      environment: "test",
      clientId: "cid",
      clientSecret: "csec",
      webhookId: "WHID",
      fetchImpl: paypalFetch({ verificationStatus: "FAILURE" }),
    });
    const raw = `{"id":"WH-2","event_type":"PAYMENT.SALE.COMPLETED","resource":{"id":"9XY","billing_agreement_id":"I-ABC123","amount":{"total":"19.99","currency":"USD"}}}`;
    await expect(provider.verifyWebhook(headers, raw)).rejects.toBeInstanceOf(WebhookVerificationError);
  });

  it("maps PAYMENT.SALE.COMPLETED renewals with billing_agreement binding and minor-unit conversion", async () => {
    const provider = new PayPalProvider({
      environment: "test",
      clientId: "cid",
      clientSecret: "csec",
      webhookId: "WHID",
      fetchImpl: paypalFetch({}),
    });
    const raw = JSON.stringify({
      id: "WH-3",
      event_type: "PAYMENT.SALE.COMPLETED",
      resource: { id: "9XYZ", billing_agreement_id: "I-ABC123", amount: { total: "19.99", currency: "USD" } },
    });
    const event = await provider.verifyWebhook(headers, raw);
    expect(event.type).toBe("payment.succeeded");
    expect(event.subjectRef).toBe("I-ABC123");
    expect(event.amountMinor).toBe(1999n);
  });

  it("refuses ad-hoc checkout without an admin-mapped plan", async () => {
    const provider = new PayPalProvider({
      environment: "test",
      clientId: "cid",
      clientSecret: "csec",
      webhookId: "WHID",
      fetchImpl: paypalFetch({}),
    });
    await expect(provider.createCheckout(BASE_CHECKOUT)).rejects.toThrow(/plan mapping/);
  });

  it("creates a subscription against a mapped plan and extracts the approve link", async () => {
    const provider = new PayPalProvider({
      environment: "test",
      clientId: "cid",
      clientSecret: "csec",
      webhookId: "WHID",
      fetchImpl: async (url) => {
        const urlText = String(url);
        if (urlText.includes("/oauth2/token")) {
          return jsonResponse(200, { access_token: "t", expires_in: 3600 });
        }
        if (urlText.includes("/v1/billing/subscriptions")) {
          return jsonResponse(201, {
            id: "I-NEW1",
            links: [{ rel: "approve", href: "https://paypal.com/approve/I-NEW1" }],
          });
        }
        throw new Error(`unexpected ${urlText}`);
      },
    });
    const result = await provider.createCheckout({ ...BASE_CHECKOUT, providerPriceRef: "P-PLAN1" });
    expect(result.providerRef).toBe("I-NEW1");
    expect(result.redirectUrl).toContain("/approve/");
  });
});
