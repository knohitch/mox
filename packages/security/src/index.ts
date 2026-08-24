/**
 * Mox security primitives for the computer layer (Prompt 04).
 *
 * Derived from OpenBot's egress identity model (per-agent upstream proxy,
 * attributable traffic) and hardened for multi-tenant Mox:
 * - egress policy decides whether an outbound destination may be reached;
 * - screencast/log metadata is scrubbed of secret-shaped material;
 * - control-plane access invariants (internal ports are never public).
 */

import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

// ---- Egress policy ----

export type EgressAction = "allow" | "deny";

export interface EgressRule {
  /** Hostname or host suffix starting with a dot (`.example.com`). */
  host: string;
  action: EgressAction;
  note?: string;
}

export interface EgressDecision {
  action: EgressAction;
  matchedRule?: string;
  reason: string;
}

/**
 * Egress gate for browser/shell network actions. Fail closed: no rules
 * configured means deny everything except loopback-internal infrastructure
 * the gateway itself needs — which callers never pass in as a target.
 */
export class EgressPolicy {
  private readonly allow: EgressRule[];
  private readonly deny: EgressRule[];
  private readonly defaultAction: EgressAction;

  constructor(
    options: { allow?: EgressRule[]; deny?: EgressRule[]; defaultAction?: EgressAction } = {},
  ) {
    this.allow = options.allow ?? [];
    this.deny = options.deny ?? [];
    // Secure default: with no explicit choice, unknown destinations deny.
    this.defaultAction = options.defaultAction ?? "deny";
  }

  /**
   * Decide for one destination. Deny beats allow. Host matching is exact or
   * suffix (`*.example.com` style via leading dot). A malformed URL denies.
   */
  decide(url: string): EgressDecision {
    let host: string;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return { action: "deny", reason: `protocol not permitted: ${parsed.protocol}` };
      }
      host = parsed.hostname.toLowerCase();
    } catch {
      return { action: "deny", reason: "malformed destination URL" };
    }
    for (const rule of this.deny) {
      if (hostMatches(rule.host, host)) {
        return { action: "deny", matchedRule: rule.host, reason: rule.note ?? `denied by egress rule ${rule.host}` };
      }
    }
    for (const rule of this.allow) {
      if (hostMatches(rule.host, host)) {
        return { action: "allow", matchedRule: rule.host, reason: rule.note ?? `allowed by egress rule ${rule.host}` };
      }
    }
    return {
      action: this.defaultAction,
      reason:
        this.defaultAction === "deny"
          ? `no egress rule matched ${host}; default deny`
          : `no egress rule matched ${host}; default allow`,
    };
  }

  /** Per-agent egress proxy binding (OpenBot-derived attribution model). */
  proxyFor(agentId: string, bindings: Record<string, string>): string | undefined {
    return bindings[agentId] ?? bindings["*"];
  }
}

function hostMatches(ruleHost: string, host: string): boolean {
  const r = ruleHost.toLowerCase();
  if (r.startsWith(".")) return host === r.slice(1) || host.endsWith(r);
  return host === r;
}

// ---- Screencast / log hygiene ----

const SECRET_KEY_PATTERN =
  /(token|secret|password|passwd|api[-_]?key|authorization|credential|private[-_]?key|session)/i;

const SECRET_VALUE_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\b(sk|xoxb|xoxp|ghp|gho|ghs|github_pat|AKIA|ASIA)[A-Za-z0-9_-]{8,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g,
  /\b(postgres(?:ql)?:\/\/|mysql:\/\/|mongodb(?:\+srv)?:\/\/|redis:\/\/)[^\s"'<>]+/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bhttps:\/\/[^\s"'<>?]+\/[^\s"'<>]*\?(?:[^\s"'<>]*?(?:X-Amz-Signature|X-Amz-Credential|Signature|sig|token|access_token|api_key)=)[^\s"'<>]+/gi,
];

export interface SanitizedArtifactRef {
  kind: "artifact_ref";
  reason: "large_or_binary";
  originalBytes: number;
  sha256: string;
}

/** Redact secret-shaped keys from any object tree (screencast metadata, logs). */
export function redactMetadata(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth-limit]";
  if (typeof value === "string") return scrubLogLine(value);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactMetadata(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY_PATTERN.test(key) ? "[redacted]" : redactMetadata(item, depth + 1);
  }
  return out;
}

/**
 * Scrub a free-form log line: values that look like bearer tokens / API keys
 * are replaced. Used on stderr tails and screencast annotations so secrets
 * never appear in diagnostics.
 */
export function scrubLogLine(line: string): string {
  let out = line;
  for (const pattern of SECRET_VALUE_PATTERNS) out = out.replace(pattern, "[redacted]");
  return redactCardCandidates(out);
}

function redactCardCandidates(value: string): string {
  return value.replace(/\b(?:\d[ -]?){13,19}\b/g, (candidate) => {
    const digits = candidate.replace(/\D/g, "");
    return digits.length >= 13 && digits.length <= 19 && luhnValid(digits) ? "[redacted-card]" : candidate;
  });
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  let doubleDigit = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = digits.charCodeAt(i) - 48;
    if (n < 0 || n > 9) return false;
    if (doubleDigit) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}

export interface SanitizeOptions {
  maxStringBytes?: number;
  maxJsonBytes?: number;
}

const DEFAULT_SANITIZE_OPTIONS: Required<SanitizeOptions> = {
  maxStringBytes: 16 * 1024,
  maxJsonBytes: 64 * 1024,
};

export function sanitizeForPersistence<T>(value: T, options: SanitizeOptions = {}): T {
  const limits = { ...DEFAULT_SANITIZE_OPTIONS, ...options };
  return sanitizeValue(value, limits, 0) as T;
}

function sanitizeValue(value: unknown, limits: Required<SanitizeOptions>, depth: number): unknown {
  if (depth > 8) return "[depth-limit]";
  if (typeof value === "string") {
    const scrubbed = scrubLogLine(value);
    const bytes = Buffer.byteLength(scrubbed, "utf8");
    if (bytes > limits.maxStringBytes || looksBinary(scrubbed)) return artifactSummary(scrubbed);
    return scrubbed;
  }
  if (value === null || typeof value !== "object") return value;
  if (ArrayBuffer.isView(value)) return artifactSummary(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  if (value instanceof ArrayBuffer) return artifactSummary(Buffer.from(value));
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, limits, depth + 1));
  const input = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(input)) {
    out[key] = SECRET_KEY_PATTERN.test(key) ? "[redacted]" : sanitizeValue(item, limits, depth + 1);
  }
  const bytes = Buffer.byteLength(JSON.stringify(out), "utf8");
  if (depth > 0 && bytes > limits.maxJsonBytes) return artifactSummary(JSON.stringify(out));
  return out;
}

function looksBinary(value: string): boolean {
  if (value.length === 0) return false;
  let suspicious = 0;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0 || (code < 9 && code !== 10 && code !== 13)) suspicious += 1;
  }
  return suspicious > 0;
}

function artifactSummary(value: string | Buffer): SanitizedArtifactRef {
  const buf = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  const sha256 = createHash("sha256").update(buf).digest("hex");
  return { kind: "artifact_ref", reason: "large_or_binary", originalBytes: buf.byteLength, sha256 };
}

// ---- Access invariants ----

/**
 * Control ports of a computer container (CDP/Playwright websocket, VNC-like
 * surfaces). These must never be published publicly; only the Computer
 * Gateway and supervisor reach them.
 */
export const COMPUTER_INTERNAL_PORTS = Object.freeze([9222, 5900, 6080]);

export interface PortBindingCheck {
  ok: boolean;
  reason: string;
}

/**
 * Validate proposed port bindings for a computer container. Any internal
 * control port bound to a non-loopback interface is rejected outright.
 */
export function checkPortBindings(bindings: Array<{ hostIp: string; hostPort: number }>): PortBindingCheck {
  for (const b of bindings) {
    if (!COMPUTER_INTERNAL_PORTS.includes(b.hostPort)) continue;
    const loopback = b.hostIp === "127.0.0.1" || b.hostIp === "::1";
    if (!loopback) {
      return {
        ok: false,
        reason: `control port ${b.hostPort} bound to non-loopback ${b.hostIp} — internal ports must not be public`,
      };
    }
  }
  return { ok: true, reason: "all bindings safe" };
}

/**
 * The agent's path to a computer is ONLY through the Computer Gateway.
 * Direct requests to a browser service endpoint are rejected: the caller
 * must present a gateway-minted session token bound to org+agent+session.
 */
export interface GatewayTokenClaims {
  orgId: string;
  agentId: string;
  userId?: string;
  serverId?: string;
  sessionId: string;
  scopes?: string[];
  allowedActions?: string[];
  jti: string;
  expiresAt: string;
}

export function mintGatewayToken(
  claims: Omit<GatewayTokenClaims, "expiresAt" | "jti"> & { ttlSeconds: number; jti?: string },
  now: Date = new Date(),
  secret = gatewayTokenSecret(),
): { token: string; claims: GatewayTokenClaims } {
  const full: GatewayTokenClaims = {
    ...claims,
    jti: claims.jti ?? randomUUID(),
    expiresAt: new Date(now.getTime() + claims.ttlSeconds * 1000).toISOString(),
  };
  const payload = Buffer.from(JSON.stringify(full), "utf8").toString("base64url");
  const signature = signGatewayPayload(payload, secret);
  const token = `${payload}.${signature}`;
  return { token, claims: full };
}

export type DirectAccessRejection =
  | { ok: true; claims: GatewayTokenClaims }
  | { ok: false; reason: string };

export function verifyGatewayToken(
  token: string,
  now: Date = new Date(),
  options: {
    secret?: string;
    seenJti?: Set<string>;
    consumeReplay?: boolean;
    expectedOrgId?: string;
    expectedServerId?: string;
    expectedSessionId?: string;
  } = {},
): DirectAccessRejection {
  let claims: GatewayTokenClaims;
  try {
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra !== undefined) return { ok: false, reason: "gateway token must be signed" };
    const expected = signGatewayPayload(payload, options.secret ?? gatewayTokenSecret());
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return { ok: false, reason: "gateway token signature mismatch" };
    }
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as GatewayTokenClaims;
  } catch {
    return { ok: false, reason: "unparseable gateway token" };
  }
  if (!claims.orgId || !claims.agentId || !claims.sessionId || !claims.jti) {
    return { ok: false, reason: "gateway token missing scope claims" };
  }
  const exp = Date.parse(claims.expiresAt);
  if (!Number.isFinite(exp) || exp <= now.getTime()) {
    return { ok: false, reason: "gateway token expired" };
  }
  if (options.expectedOrgId && claims.orgId !== options.expectedOrgId) {
    return { ok: false, reason: "gateway token org mismatch" };
  }
  if (options.expectedServerId && claims.serverId !== options.expectedServerId) {
    return { ok: false, reason: "gateway token server mismatch" };
  }
  if (options.expectedSessionId && claims.sessionId !== options.expectedSessionId) {
    return { ok: false, reason: "gateway token session mismatch" };
  }
  if (options.consumeReplay && options.seenJti) {
    if (options.seenJti.has(claims.jti)) return { ok: false, reason: "gateway token replayed" };
    options.seenJti.add(claims.jti);
  }
  return { ok: true, claims };
}

function gatewayTokenSecret(): string {
  return process.env.MOX_GATEWAY_TOKEN_SECRET ?? "mox-local-gateway-token-secret-for-tests";
}

function signGatewayPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export * from "./ssrf.js";
