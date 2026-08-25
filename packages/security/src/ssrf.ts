/**
 * SSRF guard (Prompt 14): validates outbound HTTP(S) URLs issued by agents,
 * integrations and webhooks before any fetch is attempted.
 *
 * Blocks: non-HTTP(S) schemes, credentials in URLs, localhost/loopback,
 * link-local (169.254.x including cloud metadata), private ranges
 * (RFC1918, ULA fc00::/7), *.internal/.local/.localhost hostnames, IPv6
 * loopback and IPv4-mapped IPv6. Callers should ALSO resolve DNS at fetch
 * time and re-check the resolved IP (rebinding defense); this module
 * provides `isPrivateIp` for that second check.
 */

import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { LookupFunction } from "node:net";

export interface UrlGuardResult {
  ok: boolean;
  reason?: string;
  /** Normalized URL when ok; undefined otherwise. */
  url?: string;
  hostname: string;
}

const BLOCKED_SUFFIXES = [".internal", ".local", ".localhost", ".home.arpa", ".invalid"];

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
]);

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255 || !/^\d+$/.test(part)) return null;
    value = value * 256 + n;
  }
  return value;
}

function ipv4InCidr(ip: string, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split("/");
  if (base === undefined || bitsRaw === undefined) return false;
  const baseInt = ipv4ToInt(base);
  const ipInt = ipv4ToInt(ip);
  if (baseInt === null || ipInt === null) return false;
  const bits = Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (-1 << (32 - bits)) >>> 0;
  return ((ipInt & mask) >>> 0) === ((baseInt & mask) >>> 0);
}

/** True when the literal IP is private/link-local/loopback/metadata. */
export function isPrivateIp(ip: string): boolean {
  // IPv4-mapped IPv6 (::ffff:10.0.0.1 or normalized hex ::ffff:a00:5)
  const mapped = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (mapped.startsWith("::ffff:")) {
    const tail = mapped.slice(7);
    if (tail.includes(".")) {
      return isPrivateIp(tail);
    }
    // Hex form: two 16-bit groups encode the IPv4 address.
    const hexMatch = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
    if (hexMatch?.[1] && hexMatch[2]) {
      const hi = parseInt(hexMatch[1], 16);
      const lo = parseInt(hexMatch[2], 16);
      return isPrivateIp(`${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`);
    }
    return true; // unparseable mapped address: fail closed
  }
  if (
    mapped === "::1" ||
    mapped === "::" ||
    mapped.startsWith("fe80:") ||
    mapped.startsWith("fc") ||
    mapped.startsWith("fd") ||
    mapped.startsWith("ff")
  ) {
    return true;
  }
  if (mapped.startsWith("64:ff9b::")) {
    const maybeV4 = mapped.slice("64:ff9b::".length);
    if (maybeV4.includes(".")) return isPrivateIp(maybeV4);
    const hexMatch = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(maybeV4);
    if (hexMatch?.[1] && hexMatch[2]) {
      const hi = parseInt(hexMatch[1], 16);
      const lo = parseInt(hexMatch[2], 16);
      return isPrivateIp(`${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`);
    }
    return true;
  }
  const v4 = ipv4ToInt(mapped);
  if (v4 !== null) {
    const privateRanges = [
      "10.0.0.0/8",
      "172.16.0.0/12",
      "192.168.0.0/16",
      "169.254.0.0/16",
      "127.0.0.0/8",
      "100.64.0.0/10",
      "0.0.0.0/8",
      "192.0.0.0/24",
      "192.0.2.0/24",
      "198.18.0.0/15",
      "198.51.100.0/24",
      "203.0.113.0/24",
      "224.0.0.0/4",
      "240.0.0.0/4",
    ];
    return privateRanges.some((range) => ipv4InCidr(mapped, range));
  }
  return false;
}

/**
 * Validate a user-/agent-supplied URL for server-side fetching.
 * Returns ok:false with a reason instead of throwing, so callers can
 * reject without try/catch noise.
 */
export function assertSafeOutboundUrl(
  rawUrl: string,
  options: { allowedHosts?: string[]; allowHttp?: boolean } = {},
): UrlGuardResult {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "unparseable_url", hostname: "" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "scheme_not_allowed", hostname: parsed.hostname };
  }
  if (parsed.protocol === "http:" && options.allowHttp !== true) {
    return { ok: false, reason: "https_required", hostname: parsed.hostname };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: "credentials_in_url", hostname: parsed.hostname };
  }
  if (parsed.port && ![80, 443].includes(Number(parsed.port))) {
    return { ok: false, reason: "port_not_allowed", hostname: parsed.hostname };
  }

  const hostname = canonicalHostname(parsed.hostname);
  if (BLOCKED_HOSTNAMES.has(hostname) || BLOCKED_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    return { ok: false, reason: "blocked_hostname", hostname };
  }
  // Literal IPs are checked directly.
  if (/^[\d.]+$/.test(hostname) || hostname.includes(":")) {
    if (isPrivateIp(hostname)) {
      return { ok: false, reason: "private_address", hostname };
    }
  }
  // Decimal/octal-encoded IPv4 tricks (e.g. 2130706433 == 127.0.0.1).
  if (/^\d{8,}$/.test(hostname)) {
    return { ok: false, reason: "encoded_address", hostname };
  }

  if (options.allowedHosts && options.allowedHosts.length > 0) {
    const allowed = options.allowedHosts.some(
      (host) => hostname === host.toLowerCase() || hostname.endsWith(`.${host.toLowerCase()}`),
    );
    if (!allowed) return { ok: false, reason: "host_not_allowlisted", hostname };
  }

  parsed.hostname = hostname.includes(":") ? `[${hostname}]` : hostname;
  return { ok: true, url: parsed.toString(), hostname };
}

export function canonicalHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/g, "");
}

/** Response-size + timeout policy for outbound fetches. */
export interface FetchLimits {
  maxResponseBytes: number;
  timeoutMs: number;
}

export const DEFAULT_FETCH_LIMITS: FetchLimits = {
  maxResponseBytes: 5 * 1024 * 1024,
  timeoutMs: 15_000,
};

export interface SafeOutboundOptions {
  allowedHosts?: string[];
  allowHttp?: boolean;
  allowedPorts?: number[];
  limits?: FetchLimits;
  redirect?: "manual" | "follow";
  maxRedirects?: number;
  /**
   * TEST-ONLY injected transport (fixtures, mocks). When provided it
   * REPLACES the pinned connection and is the caller's responsibility —
   * it does not benefit from resolved-IP pinning. Production code must
   * never pass fetchImpl: the default path pins every connection to the
   * validated addresses (Security Repair 05B §D).
   */
  fetchImpl?: typeof fetch;
  resolve?: (hostname: string) => Promise<Array<{ address: string; family?: number }>>;
}

export class UnsafeOutboundUrlError extends Error {
  constructor(public readonly reason: string) {
    super(`unsafe outbound URL: ${reason}`);
    this.name = "UnsafeOutboundUrlError";
  }
}

/**
 * Security Repair 05B §D: DNS-rebinding TOCTOU elimination. DNS is resolved
 * ONCE per request attempt, every returned IP is validated, and the actual
 * connection is pinned to those validated addresses via a custom `lookup`
 * (node:http/https) — validation and connection provably use the SAME IPs.
 * The original hostname is preserved for TLS SNI and certificate validation
 * (`servername`), and TLS verification is NEVER disabled.
 */
export async function resolveValidatedAddresses(
  hostname: string,
  resolver: SafeOutboundOptions["resolve"],
): Promise<Array<{ address: string; family: number }>> {
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new UnsafeOutboundUrlError("private_address");
    return [{ address: hostname, family: hostname.includes(":") ? 6 : 4 }];
  }
  const addresses = resolver ? await resolver(hostname) : await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0) throw new UnsafeOutboundUrlError("dns_no_records");
  const validated: Array<{ address: string; family: number }> = [];
  for (const entry of addresses) {
    if (!net.isIP(entry.address) || isPrivateIp(entry.address)) {
      throw new UnsafeOutboundUrlError("dns_private_address");
    }
    validated.push({ address: entry.address, family: entry.family ?? (entry.address.includes(":") ? 6 : 4) });
  }
  return validated;
}

/** A lookup that serves ONLY the pinned, already-validated addresses. */
export function pinnedLookup(pinned: Array<{ address: string; family: number }>): LookupFunction {
  let cursor = 0;
  const next = (): { address: string; family: number } => {
    if (pinned.length === 0) throw new UnsafeOutboundUrlError("pinned_addresses_exhausted");
    const entry = pinned[cursor % pinned.length]!;
    cursor += 1;
    return entry;
  };
  return ((hostname: string, options, callback) => {
    try {
      const entry = next();
      if (typeof options === "function") {
        (options as (err: Error | null, address: string, family: number) => void)(null, entry.address, entry.family);
        return;
      }
      if (options?.all) {
        callback(null, pinned.map((p) => ({ address: p.address, family: p.family })));
        return;
      }
      callback(null, entry.address, entry.family);
    } catch (error) {
      callback(error as Error, "", 0);
    }
  }) as LookupFunction;
}

export interface SafeOutboundFetchResult {
  response: Response;
  body: Uint8Array;
  url: string;
}

export async function safeOutboundFetch(
  rawUrl: string,
  init: RequestInit = {},
  options: SafeOutboundOptions = {},
): Promise<SafeOutboundFetchResult> {
  const limits = options.limits ?? DEFAULT_FETCH_LIMITS;
  let current = rawUrl;
  const redirects = options.redirect === "follow" ? options.maxRedirects ?? 3 : 0;
  let previousHost: string | undefined;
  for (let hop = 0; hop <= redirects; hop += 1) {
    const checked = assertSafeOutboundUrl(current, {
      allowedHosts: options.allowedHosts,
      allowHttp: options.allowHttp,
    });
    if (!checked.ok || !checked.url) throw new UnsafeOutboundUrlError(checked.reason ?? "url_denied");
    const parsed = new URL(checked.url);
    const port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
    const allowedPorts = options.allowedPorts ?? [443];
    if (!allowedPorts.includes(port)) throw new UnsafeOutboundUrlError("port_not_allowed");

    // Resolve once → validate every IP → pin the connection to those IPs.
    const pinned = await resolveValidatedAddresses(checked.hostname, options.resolve);

    const headers = new Headers(init.headers);
    if (previousHost && previousHost !== checked.hostname) {
      headers.delete("authorization");
      headers.delete("cookie");
      headers.delete("proxy-authorization");
    }

    let response: Response;
    if (options.fetchImpl) {
      // Explicit test/injected transport: validated above, connection
      // semantics belong to the caller (documented test seam only).
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), limits.timeoutMs);
      try {
        response = await options.fetchImpl(checked.url, {
          ...init,
          headers,
          redirect: "manual",
          signal: init.signal ?? controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
    } else {
      response = await performPinnedRequest(parsed, pinned, headers, init, limits);
    }
    if (response.status >= 300 && response.status < 400 && response.headers.get("location") && hop < redirects) {
      previousHost = checked.hostname;
      current = new URL(response.headers.get("location")!, checked.url).toString();
      continue;
    }
    const body = await readBoundedBody(response, limits);
    return { response, body, url: checked.url };
  }
  throw new UnsafeOutboundUrlError("redirect_not_allowed");
}

/**
 * One pinned request attempt over node:http/https. The custom lookup serves
 * ONLY the validated addresses; `servername` keeps the ORIGINAL hostname for
 * TLS SNI + certificate validation (verification stays enabled).
 */
function performPinnedRequest(
  parsed: URL,
  pinned: Array<{ address: string; family: number }>,
  headers: Headers,
  init: RequestInit,
  limits: FetchLimits,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const lib = parsed.protocol === "https:" ? https : http;
    const hostname = parsed.hostname;
    const port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
    const requestOptions: https.RequestOptions = {
      protocol: parsed.protocol,
      hostname,
      port,
      method: (init.method ?? "GET").toUpperCase(),
      headers: Object.fromEntries(headers.entries()),
      lookup: pinnedLookup(pinned),
      // Original hostname for SNI/cert verification; NEVER disable TLS.
      servername: hostname,
      family: pinned[0]?.family,
    };
    const req = lib.request(requestOptions, (res) => {
      const status = res.statusCode ?? 0;
      const responseHeaders = new Headers();
      for (let i = 0; i < res.rawHeaders.length; i += 2) {
        const key = res.rawHeaders[i]!;
        const value = res.rawHeaders[i + 1] ?? "";
        try {
          responseHeaders.append(key, value);
        } catch {
          // Unsettable headers (e.g. cookie) are skipped — they must never
          // be re-emitted anyway.
        }
      }
      // Stream the body with the size cap applied incrementally.
      const chunks: Buffer[] = [];
      let total = 0;
      let overflow = false;
      res.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > limits.maxResponseBytes) {
          overflow = true;
          res.destroy();
          reject(new ResponseTooLargeError());
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        if (overflow) return;
        const body = Buffer.concat(chunks);
        resolve(new Response(body, { status, headers: responseHeaders }));
      });
      res.on("error", (error) => reject(error));
    });
    req.setTimeout(limits.timeoutMs, () => req.destroy(new Error("outbound request timed out")));
    req.on("error", (error) => reject(error));
    if (init.body != null) {
      req.write(init.body);
    }
    req.end();
  });
}

export class ResponseTooLargeError extends Error {
  constructor() {
    super("response exceeded maximum size");
    this.name = "ResponseTooLargeError";
  }
}

export function abortSignalFor(limits: FetchLimits = DEFAULT_FETCH_LIMITS): AbortSignal {
  return AbortSignal.timeout(limits.timeoutMs);
}

/**
 * Read a response body enforcing the byte cap incrementally.
 * Pairs the SSRF guard with bounded memory usage.
 */
export async function readBoundedBody(response: Response, limits: FetchLimits = DEFAULT_FETCH_LIMITS): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > limits.maxResponseBytes) {
      void reader.cancel().catch(() => undefined);
      throw new ResponseTooLargeError();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
