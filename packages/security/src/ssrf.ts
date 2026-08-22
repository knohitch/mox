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

export interface UrlGuardResult {
  ok: boolean;
  reason?: string;
  /** Normalized URL when ok; undefined otherwise. */
  url?: string;
  hostname: string;
}

const BLOCKED_SUFFIXES = [".internal", ".local", ".localhost", ".home.arpa"];

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
  if (mapped === "::1" || mapped === "::" || mapped.startsWith("fe80:") || mapped.startsWith("fc") || mapped.startsWith("fd")) {
    return true;
  }
  const v4 = ipv4ToInt(mapped);
  if (v4 !== null) {
    const privateRanges = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "127.0.0.0/8", "100.64.0.0/10", "0.0.0.0/8"];
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

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
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

  return { ok: true, url: parsed.toString(), hostname };
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
