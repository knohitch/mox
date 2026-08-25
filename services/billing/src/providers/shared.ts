/**
 * Shared HTTP helpers for payment-provider adapters (Prompt 01).
 *
 * Rules:
 * - secrets travel ONLY in Authorization headers/headers to provider hosts;
 * - responses map to ProviderError with retryable hints;
 * - no secret or full payload is ever logged.
 */

import { timingSafeEqual } from "node:crypto";
import { ProviderError } from "@mox/compute-providers";

export interface HttpJsonOptions {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** Raw body sender for form-encoded APIs (Stripe). */
  rawBody?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export async function httpJson<T>(options: HttpJsonOptions): Promise<{ status: number; data: T }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  try {
    const res = await (options.fetchImpl ?? fetch)(options.url, {
      method: options.method ?? (options.body !== undefined || options.rawBody !== undefined ? "POST" : "GET"),
      headers: {
        ...(options.rawBody !== undefined
          ? { "content-type": "application/x-www-form-urlencoded" }
          : options.body !== undefined
            ? { "content-type": "application/json" }
            : {}),
        ...options.headers,
      },
      body: options.rawBody ?? (options.body !== undefined ? JSON.stringify(options.body) : undefined),
      signal: controller.signal,
    });
    const text = await res.text();
    let data: unknown = undefined;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!res.ok) {
      const message = typeof data === "object" && data && "message" in (data as Record<string, unknown>)
        ? String((data as Record<string, unknown>).message)
        : `provider HTTP ${res.status}`;
      // 4xx (except 408/429) are non-retryable; everything else may be retried.
      const retryable = res.status >= 500 || res.status === 408 || res.status === 429;
      throw new ProviderError(message, { httpStatus: res.status, retryable });
    }
    return { status: res.status, data: data as T };
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(
      `provider request failed: ${error instanceof Error ? error.message : String(error)}`,
      { retryable: true },
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Constant-time hex/base64 string comparison for signatures. */
export function safeEquals(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function requireConfigured(value: string | undefined, what: string): string {
  if (!value || value.trim() === "") {
    throw new ProviderError(`billing provider is missing ${what}`, { retryable: false });
  }
  return value;
}

/** Converts major-unit decimals (Flutterwave/PayPal display) to integer minor units. */
export function majorToMinor(major: number | string, currency: string): bigint {
  const exponent = currency === "JPY" ? 0 : currency === "BHD" || currency === "KWD" ? 3 : 2;
  const value = typeof major === "string" ? Number.parseFloat(major) : major;
  if (!Number.isFinite(value)) throw new ProviderError("invalid provider amount", { retryable: false });
  return BigInt(Math.round(value * 10 ** exponent));
}

/**
 * Canonical currency representation (Security Repair 05A §C): providers
 * send lowercase (e.g. Stripe `usd`); Mox stores ISO-4217 uppercase.
 * Semantic equality is exact AFTER normalization.
 */
export function normalizeCurrency(currency: string | null | undefined): string | undefined {
  if (currency === undefined || currency === null) return undefined;
  const trimmed = currency.trim().toUpperCase();
  return trimmed.length > 0 ? trimmed : undefined;
}
