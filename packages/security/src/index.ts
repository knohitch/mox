/**
 * Mox security primitives for the computer layer (Prompt 04).
 *
 * Derived from OpenBot's egress identity model (per-agent upstream proxy,
 * attributable traffic) and hardened for multi-tenant Mox:
 * - egress policy decides whether an outbound destination may be reached;
 * - screencast/log metadata is scrubbed of secret-shaped material;
 * - control-plane access invariants (internal ports are never public).
 */

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

/** Redact secret-shaped keys from any object tree (screencast metadata, logs). */
export function redactMetadata(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth-limit]";
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
  return line
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, "Bearer [redacted]")
    .replace(/\b(sk|xoxb|xoxp|ghp|gho|AKIA)[A-Za-z0-9_\-]{8,}\b/g, "[redacted]")
    
.replace(/\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{5,}\b/g, "[redacted-jwt]")
    // Card numbers: grouped 13–19 digits with separators (PAN hygiene in logs).
    .replace(/\b\d{4}[- ]\d{4,6}[- ]?\d{4,10}([- ]?\d{1,6})?\b/g, "[redacted-card]")
    .replace(/\b\d{13,19}\b/g, "[redacted-card]");
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
  sessionId: string;
  expiresAt: string;
}

export function mintGatewayToken(
  claims: Omit<GatewayTokenClaims, "expiresAt"> & { ttlSeconds: number },
  now: Date = new Date(),
): { token: string; claims: GatewayTokenClaims } {
  const full: GatewayTokenClaims = {
    ...claims,
    expiresAt: new Date(now.getTime() + claims.ttlSeconds * 1000).toISOString(),
  };
  // Opaque token for this prompt; real signing lands with the auth package.
  const token = Buffer.from(JSON.stringify(full), "utf8").toString("base64url");
  return { token, claims: full };
}

export type DirectAccessRejection =
  | { ok: true; claims: GatewayTokenClaims }
  | { ok: false; reason: string };

export function verifyGatewayToken(token: string, now: Date = new Date()): DirectAccessRejection {
  let claims: GatewayTokenClaims;
  try {
    claims = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as GatewayTokenClaims;
  } catch {
    return { ok: false, reason: "unparseable gateway token" };
  }
  if (!claims.orgId || !claims.agentId || !claims.sessionId) {
    return { ok: false, reason: "gateway token missing scope claims" };
  }
  const exp = Date.parse(claims.expiresAt);
  if (!Number.isFinite(exp) || exp <= now.getTime()) {
    return { ok: false, reason: "gateway token expired" };
  }
  return { ok: true, claims };
}

export * from "./ssrf.js";
