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
  const STRONG_TEST_SECRET = "test-gateway-secret-Ab3#x9KpQw7Tz2Lm5Vr8Ys1Nc";

  it("round-trips a valid token with an explicitly injected secret", () => {
    const { token } = mintGatewayToken(claims, new Date(), STRONG_TEST_SECRET);
    const verified = verifyGatewayToken(token, new Date(), { secret: STRONG_TEST_SECRET });
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.claims.orgId).toBe("org-1");
      expect(verified.claims.agentId).toBe("agent-1");
    }
  });

  it("fails closed without a configured secret (finding C)", () => {
    const previous = process.env.MOX_GATEWAY_TOKEN_SECRET;
    delete process.env.MOX_GATEWAY_TOKEN_SECRET;
    try {
      expect(() => mintGatewayToken(claims)).toThrow(/not configured/);
      const forged = `${Buffer.from(JSON.stringify({ exp: Date.now() })).toString("base64url")}.${"a".repeat(64)}`;
      expect(verifyGatewayToken(forged).ok).toBe(false);
    } finally {
      if (previous) process.env.MOX_GATEWAY_TOKEN_SECRET = previous;
      else delete process.env.MOX_GATEWAY_TOKEN_SECRET;
    }
  });

  it("refuses the legacy public test secret and weak secrets", () => {
    expect(() => mintGatewayToken(claims, new Date(), "mox-local-gateway-token-secret-for-tests")).toThrow(/public hardcoded/);
    expect(() => mintGatewayToken(claims, new Date(), "short")).toThrow(/32 characters/);
    expect(() => mintGatewayToken(claims, new Date(), "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toThrow(/at least 3/);
  });

  it("rejects expired tokens", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const { token } = mintGatewayToken(claims, now, STRONG_TEST_SECRET);
    const later = new Date(now.getTime() + 61_000);
    const verified = verifyGatewayToken(token, later, { secret: STRONG_TEST_SECRET });
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.reason).toContain("expired");
  });

  it("rejects garbage and claim-less tokens", () => {
    expect(verifyGatewayToken("not-a-token", new Date(), { secret: STRONG_TEST_SECRET }).ok).toBe(false);
    const partial = Buffer.from(JSON.stringify({ orgId: "org-1" }), "utf8").toString("base64url");
    expect(verifyGatewayToken(partial, new Date(), { secret: STRONG_TEST_SECRET }).ok).toBe(false);
  });

  it("rejects unsigned JSON, tampering, and replay when a cache is supplied", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const { token } = mintGatewayToken({ ...claims, jti: "jti-1" }, now, STRONG_TEST_SECRET);
    expect(verifyGatewayToken(token, now, { secret: STRONG_TEST_SECRET }).ok).toBe(true);
    expect(verifyGatewayToken(token.replace(/.$/, "x"), now, { secret: STRONG_TEST_SECRET }).ok).toBe(false);
    expect(verifyGatewayToken(token, now, { secret: "wrong-secret" }).ok).toBe(false);
    const unsigned = Buffer.from(JSON.stringify({ orgId: "org-1", agentId: "a", sessionId: "s", expiresAt: "2099-01-01T00:00:00Z" }), "utf8").toString("base64url");
    expect(verifyGatewayToken(unsigned, now, { secret: STRONG_TEST_SECRET }).ok).toBe(false);
    const seen = new Set<string>();
    expect(verifyGatewayToken(token, now, { secret: STRONG_TEST_SECRET, seenJti: seen, consumeReplay: true }).ok).toBe(true);
    const replay = verifyGatewayToken(token, now, { secret: STRONG_TEST_SECRET, seenJti: seen, consumeReplay: true });
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.reason).toContain("replayed");
  });

  it("rejects wrong org, server, and session scopes", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const { token } = mintGatewayToken({ ...claims, serverId: "srv-1" }, now, STRONG_TEST_SECRET);
    expect(verifyGatewayToken(token, now, { secret: STRONG_TEST_SECRET, expectedOrgId: "org-2" }).ok).toBe(false);
    expect(verifyGatewayToken(token, now, { secret: STRONG_TEST_SECRET, expectedServerId: "srv-2" }).ok).toBe(false);
    expect(verifyGatewayToken(token, now, { secret: STRONG_TEST_SECRET, expectedSessionId: "sess-2" }).ok).toBe(false);
    expect(verifyGatewayToken(token, now, {
      secret: STRONG_TEST_SECRET,
      expectedOrgId: "org-1",
      expectedServerId: "srv-1",
      expectedSessionId: "sess-1",
    }).ok).toBe(true);
  });
});

describe("sanitization (Security Repair 05B §E)", () => {
  it("scrubs passwords, token assignments, provider keys, DB URLs, JWTs, PEMs and cookies", () => {
    // Long base64-like secret constructed at runtime (mixed case + digits +
    // separators) so the fixture never depends on paste fidelity.
    const secretB64 = "Se" + "e".repeat(60) + "+cRcRcRcRcRcRcRcRcRcR" + "9A/b".repeat(4);
    expect(secretB64.length).toBeGreaterThanOrEqual(40);
    // PEM fixture assembled at runtime so the secret-scanner never trips on
    // a literal private-key header in a test file.
    const pemFixture = ["-----BEGIN ", "RSA PRIVATE KEY", "-----\n", "MIIEowIBAAKCAQEA...\n", "-----END ", "RSA PRIVATE KEY", "-----"].join("");
    const line = [
      "failed login password=hunter2 for user bob",
      "token: ghx_1234567890abcdefghijklmnopqrstuvwxyzABC",
      "npm_0123456789abcdef0123456789abcdef0123 registered",
      "glpat-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234 leaked",
      "AIzaSyB9x2Q8vW3mN4pL7kR6tY1uO5cH0dF8gJ2aK9 leaked",
      "db=postgresql://user:pw@db.internal/app",
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abc123def456 sent",
      "cookie: mox_session=secret123; other=1",
      "sk_live_abcdefghijklmnop1234",
      "whsec_ABCDEFGHIJKLMNOPQRSTUVWX",
      pemFixture,
      `base64 ${secretB64}`,
    ].join("\n");
    const out = scrubLogLine(line);
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("ghx_1234567890abcdefghijklmnopqrstuvwxyzABC");
    expect(out).not.toContain("npm_0123456789abcdef0123456789abcdef0123");
    expect(out).not.toContain("glpat-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234");
    expect(out).not.toContain("AIzaSyB9x2Q8vW3mN4pL7kR6tY1uO5cH0dF8gJ2aK9");
    expect(out).not.toContain("postgresql://");
    expect(out).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(out).not.toContain("mox_session=secret123");
    expect(out).not.toContain("sk_live_abcdefghijklmnop1234");
    expect(out).not.toContain("whsec_ABCDEFGHIJKLMNOPQRSTUVWX");
    expect(out).not.toContain("PRIVATE KEY");
    expect(out).not.toContain("e".repeat(60));
    expect(out).toContain("[redacted]");
  });

  it("does not corrupt benign ids, UUIDs and slugs", () => {
    const benign = "org=11111111-1111-4111-8111-00000000abcd node=node-11111111-1111-4111-8111-00000000abcd host=ws-7 worker=compute-1234ab";
    const out = scrubLogLine(benign);
    expect(out).toContain("11111111-1111-4111-8111-00000000abcd");
    expect(out).toContain("compute-1234ab");
    expect(out).not.toContain("[redacted]");
  });
});
