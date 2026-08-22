import { describe, expect, it } from "vitest";
import {
  assertSafeOutboundUrl,
  isPrivateIp,
  readBoundedBody,
  DEFAULT_FETCH_LIMITS,
  ResponseTooLargeError,
} from "../src/index.js";

describe("ssrf guard", () => {
  it("allows normal public https URLs", () => {
    const result = assertSafeOutboundUrl("https://api.example.com/v1/data?x=1");
    expect(result.ok).toBe(true);
    expect(result.hostname).toBe("api.example.com");
  });

  it("blocks non-http schemes and credentials in URLs", () => {
    expect(assertSafeOutboundUrl("file:///etc/passwd").reason).toBe("scheme_not_allowed");
    expect(assertSafeOutboundUrl("gopher://host").reason).toBe("scheme_not_allowed");
    expect(assertSafeOutboundUrl("https://user:pass@example.com/").reason).toBe("credentials_in_url");
  });

  it("requires https by default", () => {
    expect(assertSafeOutboundUrl("http://api.example.com/").reason).toBe("https_required");
    expect(assertSafeOutboundUrl("http://api.example.com/", { allowHttp: true }).ok).toBe(true);
  });

  it("blocks loopback/private/link-local literal addresses", () => {
    expect(assertSafeOutboundUrl("https://127.0.0.1/admin").reason).toBe("private_address");
    expect(assertSafeOutboundUrl("https://10.1.2.3/internal").reason).toBe("private_address");
    expect(assertSafeOutboundUrl("https://192.168.1.10/router").reason).toBe("private_address");
    expect(assertSafeOutboundUrl("https://169.254.169.254/latest/meta-data/").reason).toBe("private_address");
    expect(assertSafeOutboundUrl("https://[::1]/x").reason).toBe("private_address");
    expect(assertSafeOutboundUrl("https://[::ffff:10.0.0.5]/x").reason).toBe("private_address");
    expect(isPrivateIp("172.20.3.4")).toBe(true);
    expect(isPrivateIp("8.8.8.8")).toBe(false);
  });

  it("blocks internal hostnames and cloud metadata names", () => {
    expect(assertSafeOutboundUrl("https://control-plane.mox.internal/secrets").reason).toBe("blocked_hostname");
    expect(assertSafeOutboundUrl("https://metadata.google.internal/computeMetadata/").reason).toBe("blocked_hostname");
    expect(assertSafeOutboundUrl("https://myserver.local/x").reason).toBe("blocked_hostname");
  });

  it("rejects decimal-encoded IPv4 tricks", () => {
    // The WHATWG URL parser normalizes 2130706433 to 127.0.0.1, so the
    // literal-IP check catches it; either way it must not pass.
    const result = assertSafeOutboundUrl("https://2130706433/");
    expect(result.ok).toBe(false);
    expect(["private_address", "encoded_address"]).toContain(result.reason);
  });

  it("supports hostname allowlists for locked-down integrations", () => {
    const options = { allowedHosts: ["hooks.slack.com"] };
    expect(assertSafeOutboundUrl("https://hooks.slack.com/services/T/B/xyz", options).ok).toBe(true);
    expect(assertSafeOutboundUrl("https://evil.example.com/grab", options).reason).toBe("host_not_allowlisted");
    // Subdomain of an allowlisted host passes.
    expect(assertSafeOutboundUrl("https://api.hooks.slack.com/x", options).ok).toBe(true);
  });

  it("bounds response memory during reads", async () => {
    const bigBody = new Uint8Array(DEFAULT_FETCH_LIMITS.maxResponseBytes + 1);
    const response = new Response(bigBody);
    await expect(readBoundedBody(response)).rejects.toBeInstanceOf(ResponseTooLargeError);

    const small = new Response(new TextEncoder().encode("hello"));
    const body = await readBoundedBody(small, { maxResponseBytes: 100, timeoutMs: 1000 });
    expect(new TextDecoder().decode(body)).toBe("hello");
  });
});
