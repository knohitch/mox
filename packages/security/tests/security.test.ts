import { describe, expect, it } from "vitest";
import {
  checkPortBindings,
  COMPUTER_INTERNAL_PORTS,
  EgressPolicy,
  mintGatewayToken,
  redactMetadata,
  scrubLogLine,
  verifyGatewayToken,
} from "../src/index.js";

describe("EgressPolicy", () => {
  it("allows exact hosts and suffix hosts", () => {
    const egress = new EgressPolicy({ allow: [{ host: ".example.com", action: "allow" }, { host: "openai.com", action: "allow" }] });
    expect(egress.decide("https://example.com/a").action).toBe("allow");
    expect(egress.decide("https://api.example.com/b").action).toBe("allow");
    expect(egress.decide("https://notexample.com/").action).toBe("deny");
    expect(egress.decide("https://openai.com/v1").action).toBe("allow");
  });

  it("default-deny when no rule matches (fail closed)", () => {
    const egress = new EgressPolicy({ allow: [{ host: ".example.com", action: "allow" }] });
    const d = egress.decide("https://unknown.test/");
    expect(d.action).toBe("deny");
    expect(d.reason).toContain("default deny");
  });

  it("deny beats allow", () => {
    const egress = new EgressPolicy({
      allow: [{ host: ".example.com", action: "allow" }],
      deny: [{ host: "admin.example.com", action: "deny" }],
    });
    const d = egress.decide("https://admin.example.com/console");
    expect(d.action).toBe("deny");
    expect(d.matchedRule).toBe("admin.example.com");
  });

  it("denies malformed URLs and non-http(s) protocols", () => {
    const egress = new EgressPolicy({ defaultAction: "allow" });
    expect(egress.decide("not a url").action).toBe("deny");
    expect(egress.decide("file:///etc/passwd").reason).toContain("protocol not permitted");
    // Even default-allow never admits malformed/non-web targets.
    expect(egress.decide("ftp://files.example.com/").action).toBe("deny");
  });

  it("binds per-agent upstream proxies with * fallback (OpenBot-derived)", () => {
    const egress = new EgressPolicy();
    const bindings = { "*": "proxy-default:8080", "agent-a": "proxy-a:8080" };
    expect(egress.proxyFor("agent-a", bindings)).toBe("proxy-a:8080");
    expect(egress.proxyFor("agent-b", bindings)).toBe("proxy-default:8080");
    expect(egress.proxyFor("agent-b", {})).toBeUndefined();
  });
});

describe("secret hygiene", () => {
  it("redactMetadata scrubs secret-shaped keys at any depth", () => {
    const out = redactMetadata({
      pageUrl: "https://x.test/",
      api_key: "sk-123",
      nested: { Authorization: "Bearer abc", ok: 1 },
      list: [{ password: "hunter2", keep: true }],
    }) as Record<string, unknown>;
    expect(out.api_key).toBe("[redacted]");
    const nested = out.nested as Record<string, unknown>;
    expect(nested.Authorization).toBe("[redacted]");
    expect(nested.ok).toBe(1);
    const listItem = (out.list as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    expect(listItem.password).toBe("[redacted]");
    expect(listItem.keep).toBe(true);
  });

  it("scrubLogLine removes bearer tokens, API keys and JWTs from diagnostics", () => {
    const line =
      "failed upstream: Authorization=Bearer abc.def.ghi token=sk-proj0123456789 jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fwpM";
    const scrubbed = scrubLogLine(line);
    expect(scrubbed).toContain("[redacted]");
    expect(scrubbed).not.toContain("sk-proj0123456789");
    expect(scrubbed).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(scrubbed).not.toContain("Bearer abc.def.ghi");
  });

  it("leaves normal text untouched", () => {
    expect(scrubLogLine("page loaded in 120ms")).toBe("page loaded in 120ms");
  });
});

describe("control-port invariants", () => {
  it("rejects internal control ports bound to non-loopback interfaces", () => {
    for (const port of COMPUTER_INTERNAL_PORTS) {
      const check = checkPortBindings([{ hostIp: "0.0.0.0", hostPort: port }]);
      expect(check.ok).toBe(false);
      expect(check.reason).toContain(String(port));
      expect(check.reason).toContain("must not be public");
    }
  });

  it("accepts loopback-only control ports and unrelated ports anywhere", () => {
    expect(
      checkPortBindings([
        { hostIp: "127.0.0.1", hostPort: 9222 },
        { hostIp: "::1", hostPort: 5900 },
        { hostIp: "0.0.0.0", hostPort: 8080 },
      ]).ok,
    ).toBe(true);
  });
});

describe("gateway tokens (direct-access rejection)", () => {
  const claims = { orgId: "org-1", agentId: "agent-1", sessionId: "sess-1", ttlSeconds: 60 };

  it("round-trips a valid token", () => {
    const { token } = mintGatewayToken(claims);
    const verified = verifyGatewayToken(token);
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.claims.orgId).toBe("org-1");
      expect(verified.claims.agentId).toBe("agent-1");
    }
  });

  it("rejects expired tokens", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const { token } = mintGatewayToken(claims, now);
    const later = new Date(now.getTime() + 61_000);
    const verified = verifyGatewayToken(token, later);
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.reason).toContain("expired");
  });

  it("rejects garbage and claim-less tokens", () => {
    expect(verifyGatewayToken("not-a-token").ok).toBe(false);
    const partial = Buffer.from(JSON.stringify({ orgId: "org-1" }), "utf8").toString("base64url");
    expect(verifyGatewayToken(partial).ok).toBe(false);
  });

  it("rejects unsigned JSON, tampering, and replay when a cache is supplied", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const { token } = mintGatewayToken({ ...claims, jti: "jti-1" }, now, "secret-a");
    expect(verifyGatewayToken(token, now, { secret: "secret-a" }).ok).toBe(true);
    expect(verifyGatewayToken(token.replace(/.$/, "x"), now, { secret: "secret-a" }).ok).toBe(false);
    expect(verifyGatewayToken(token, now, { secret: "wrong-secret" }).ok).toBe(false);
    const unsigned = Buffer.from(JSON.stringify({ orgId: "org-1", agentId: "a", sessionId: "s", expiresAt: "2099-01-01T00:00:00Z" }), "utf8").toString("base64url");
    expect(verifyGatewayToken(unsigned, now).ok).toBe(false);
    const seen = new Set<string>();
    expect(verifyGatewayToken(token, now, { secret: "secret-a", seenJti: seen, consumeReplay: true }).ok).toBe(true);
    const replay = verifyGatewayToken(token, now, { secret: "secret-a", seenJti: seen, consumeReplay: true });
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.reason).toContain("replayed");
  });

  it("rejects wrong org, server, and session scopes", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const { token } = mintGatewayToken({ ...claims, serverId: "srv-1" }, now, "secret-a");
    expect(verifyGatewayToken(token, now, { secret: "secret-a", expectedOrgId: "org-2" }).ok).toBe(false);
    expect(verifyGatewayToken(token, now, { secret: "secret-a", expectedServerId: "srv-2" }).ok).toBe(false);
    expect(verifyGatewayToken(token, now, { secret: "secret-a", expectedSessionId: "sess-2" }).ok).toBe(false);
    expect(verifyGatewayToken(token, now, {
      secret: "secret-a",
      expectedOrgId: "org-1",
      expectedServerId: "srv-1",
      expectedSessionId: "sess-1",
    }).ok).toBe(true);
  });
});
