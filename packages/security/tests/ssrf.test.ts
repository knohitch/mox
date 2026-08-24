import { describe, expect, it } from "vitest";
import {
  assertSafeOutboundUrl,
  isPrivateIp,
  readBoundedBody,
  DEFAULT_FETCH_LIMITS,
  ResponseTooLargeError,
  safeOutboundFetch,
  UnsafeOutboundUrlError,
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
    expect(assertSafeOutboundUrl("https://localhost./admin").reason).toBe("blocked_hostname");
    expect(assertSafeOutboundUrl("https://10.1.2.3/internal").reason).toBe("private_address");
    expect(assertSafeOutboundUrl("https://172.16.0.1/internal").reason).toBe("private_address");
    expect(assertSafeOutboundUrl("https://192.168.1.10/router").reason).toBe("private_address");
    expect(assertSafeOutboundUrl("https://[fe80::1]/x").reason).toBe("private_address");
    expect(assertSafeOutboundUrl("https://169.254.169.254/latest/meta-data/").reason).toBe("private_address");
    expect(assertSafeOutboundUrl("https://[::1]/x").reason).toBe("private_address");
    expect(assertSafeOutboundUrl("https://[::ffff:10.0.0.5]/x").reason).toBe("private_address");
    expect(assertSafeOutboundUrl("https://[64:ff9b::a00:5]/x").reason).toBe("private_address");
    expect(assertSafeOutboundUrl("https://203.0.113.10/x").reason).toBe("private_address");
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
    expect(assertSafeOutboundUrl("https://0x7f000001/").ok).toBe(false);
  });

  it("rejects disallowed ports before outbound fetch", async () => {
    expect(assertSafeOutboundUrl("https://example.com:8443/").reason).toBe("port_not_allowed");
    await expect(
      safeOutboundFetch("https://example.com:8443/", {}, { resolve: async () => [{ address: "93.184.216.34" }] }),
    ).rejects.toMatchObject({ reason: "port_not_allowed" });
  });

  it("validates resolved DNS records and redirect hops", async () => {
    await expect(
      safeOutboundFetch("https://metadata.example/", {}, {
        resolve: async () => [{ address: "169.254.169.254" }],
        fetchImpl: async () => new Response("never"),
      }),
    ).rejects.toBeInstanceOf(UnsafeOutboundUrlError);

    await expect(
      safeOutboundFetch("https://public.example/", {}, {
        redirect: "follow",
        resolve: async () => [{ address: "93.184.216.34" }],
        fetchImpl: async () => new Response("", { status: 302, headers: { location: "https://127.0.0.1/admin" } }),
      }),
    ).rejects.toMatchObject({ reason: "private_address" });
  });

  it("allows public HTTPS through the safe outbound primitive", async () => {
    const result = await safeOutboundFetch("https://api.example.com/data", {}, {
      resolve: async () => [{ address: "93.184.216.34" }],
      fetchImpl: async () => new Response("ok", { status: 200 }),
    });
    expect(result.response.status).toBe(200);
    expect(new TextDecoder().decode(result.body)).toBe("ok");
  });

  it("enforces timeout and response-size limits in safe outbound fetch", async () => {
    await expect(
      safeOutboundFetch("https://api.example.com/large", {}, {
        resolve: async () => [{ address: "93.184.216.34" }],
        limits: { maxResponseBytes: 4, timeoutMs: 1000 },
        fetchImpl: async () => new Response("too-large"),
      }),
    ).rejects.toBeInstanceOf(ResponseTooLargeError);

    await expect(
      safeOutboundFetch("https://api.example.com/slow", {}, {
        resolve: async () => [{ address: "93.184.216.34" }],
        limits: { maxResponseBytes: 100, timeoutMs: 1 },
        fetchImpl: async (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      }),
    ).rejects.toThrow(/aborted/);
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
