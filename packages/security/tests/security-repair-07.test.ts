import { EventEmitter } from "node:events";
import https from "node:https";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  buildPinnedRequestOptions,
  resolveValidatedAddresses,
  safeOutboundFetch,
  validateGatewaySigningSecret,
  verifyGatewayToken,
  mintGatewayToken,
  LEGACY_PUBLIC_GATEWAY_SECRET,
} from "../src/index.js";

function interceptHttps(responses: Array<{ status: number; headers?: Record<string, string>; body?: string }>) {
  const captured: https.RequestOptions[] = [];
  let call = 0;
  const spy = vi.spyOn(https, "request").mockImplementation(((options: unknown, callback?: (res: unknown) => void) => {
    captured.push(options as https.RequestOptions);
    const response = responses[call++] ?? { status: 200, body: "ok" };
    const req = new EventEmitter() as EventEmitter & {
      setTimeout(ms: number, cb: () => void): unknown;
      write(chunk: unknown): boolean;
      end(): void;
      destroy(error?: Error): unknown;
    };
    req.setTimeout = () => req;
    req.write = () => true;
    req.destroy = (error?: Error) => {
      if (error) queueMicrotask(() => req.emit("error", error));
      return req;
    };
    req.end = () => {
      queueMicrotask(() => {
        const res = new PassThrough() as PassThrough & {
          statusCode: number;
          headers: Record<string, string>;
          rawHeaders: string[];
        };
        res.statusCode = response.status;
        res.headers = response.headers ?? {};
        res.rawHeaders = Object.entries(response.headers ?? {}).flatMap(([key, value]) => [key, value]);
        callback?.(res);
        res.end(response.body ?? "");
      });
    };
    return req;
  }) as never);
  return { spy, captured };
}

async function lookupOnce(options: https.RequestOptions): Promise<string> {
  const lookup = options.lookup;
  if (!lookup) throw new Error("pinned lookup missing");
  return new Promise<string>((resolve, reject) => {
    (lookup as unknown as (
      hostname: string,
      options: { all?: boolean },
      callback: (error: Error | null, address: string, family: number) => void,
    ) => void)(String(options.hostname), {}, (error, address) => error ? reject(error) : resolve(address));
  });
}

describe("Security Repair 07 — SSRF resolve/validate/pin", () => {
  it("R09-9/A3: rebinding resolver is consulted once and request lookup can use only the validated public address", async () => {
    let resolutions = 0;
    const resolver = async () => {
      resolutions += 1;
      return resolutions === 1 ? [{ address: "8.8.8.8", family: 4 }] : [{ address: "127.0.0.1", family: 4 }];
    };
    const { spy, captured } = interceptHttps([{ status: 200, body: "ok" }]);
    try {
      const result = await safeOutboundFetch("https://public.example/data", {}, { resolve: resolver });
      expect(result.response.status).toBe(200);
      expect(resolutions).toBe(1);
      expect(captured).toHaveLength(1);
      expect(await lookupOnce(captured[0]!)).toBe("8.8.8.8");
    } finally {
      spy.mockRestore();
    }
  });

  it("A4: mixed DNS answers fail closed if any answer is private/mapped-private", async () => {
    for (const blocked of ["127.0.0.1", "10.0.0.8", "172.16.1.2", "192.168.1.2", "169.254.169.254", "fd00::1", "::ffff:10.0.0.8"]) {
      await expect(
        resolveValidatedAddresses("mixed.example", async () => [
          { address: "8.8.8.8", family: 4 },
          { address: blocked, family: blocked.includes(":") ? 6 : 4 },
        ]),
      ).rejects.toMatchObject({ reason: "dns_private_address" });
    }
  });

  it("R09-10/A5: pinned TLS options preserve original hostname for SNI/certificate verification and never disable verification", async () => {
    const pinned = await resolveValidatedAddresses("api.example.com", async () => [{ address: "8.8.4.4", family: 4 }]);
    const options = buildPinnedRequestOptions(new URL("https://api.example.com/path"), pinned, new Headers(), {});
    expect(options.hostname).toBe("api.example.com");
    expect(options.servername).toBe("api.example.com");
    expect(options.rejectUnauthorized).not.toBe(false);
    expect(await lookupOnce(options)).toBe("8.8.4.4");
  });

  it("R09-1: pinned request preserves a non-root pathname", async () => {
    const pinned = await resolveValidatedAddresses("api.example.com", async () => [{ address: "8.8.4.4", family: 4 }]);
    const options = buildPinnedRequestOptions(new URL("https://api.example.com/hook/task"), pinned, new Headers(), {});
    expect(options.path).toBe("/hook/task");
  });

  it("R09-2: pinned request preserves pathname and query", async () => {
    const pinned = await resolveValidatedAddresses("api.example.com", async () => [{ address: "8.8.4.4", family: 4 }]);
    const options = buildPinnedRequestOptions(
      new URL("https://api.example.com/hook/task?token=abc&mode=full"),
      pinned,
      new Headers(),
      {},
    );
    expect(options.path).toBe("/hook/task?token=abc&mode=full");
  });

  it("R09-3: pinned request preserves the root target", async () => {
    const pinned = await resolveValidatedAddresses("api.example.com", async () => [{ address: "8.8.4.4", family: 4 }]);
    const options = buildPinnedRequestOptions(new URL("https://api.example.com/"), pinned, new Headers(), {});
    expect(options.path).toBe("/");
  });

  it("R09-4: pinned request preserves encoded path/query resource identity", async () => {
    const pinned = await resolveValidatedAddresses("api.example.com", async () => [{ address: "8.8.4.4", family: 4 }]);
    const options = buildPinnedRequestOptions(
      new URL("https://api.example.com/hook/%2Ftenant/%E2%9C%93?q=a%2Fb&space=hello%20world"),
      pinned,
      new Headers(),
      {},
    );
    expect(options.path).toBe("/hook/%2Ftenant/%E2%9C%93?q=a%2Fb&space=hello%20world");
  });

  it("R09-5: URL fragments are never transmitted in the HTTP request target", async () => {
    const pinned = await resolveValidatedAddresses("api.example.com", async () => [{ address: "8.8.4.4", family: 4 }]);
    const options = buildPinnedRequestOptions(
      new URL("https://api.example.com/hook/task?token=abc#client-only"),
      pinned,
      new Headers(),
      {},
    );
    expect(options.path).toBe("/hook/task?token=abc");
    expect(String(options.path)).not.toContain("#client-only");
  });

  it("R09-6/A6: every redirect hop gets its own request target plus fresh resolve→validate→pin and cross-host credential stripping", async () => {
    const resolved: string[] = [];
    const resolver = async (hostname: string) => {
      resolved.push(hostname);
      return hostname === "first.example"
        ? [{ address: "8.8.8.8", family: 4 }]
        : [{ address: "9.9.9.9", family: 4 }];
    };
    const { spy, captured } = interceptHttps([
      { status: 302, headers: { location: "https://second.example/hooks/final?b=2#redirect-fragment" } },
      { status: 200, body: "ok" },
    ]);
    try {
      await safeOutboundFetch(
        "https://first.example/start?a=1",
        { headers: { authorization: "Bearer secret", cookie: "sid=secret", "proxy-authorization": "Basic secret" } },
        { redirect: "follow", maxRedirects: 2, resolve: resolver },
      );
      expect(resolved).toEqual(["first.example", "second.example"]);
      expect(captured).toHaveLength(2);
      expect(await lookupOnce(captured[0]!)).toBe("8.8.8.8");
      expect(await lookupOnce(captured[1]!)).toBe("9.9.9.9");
      expect(captured[0]!.servername).toBe("first.example");
      expect(captured[1]!.servername).toBe("second.example");
      expect(captured[0]!.path).toBe("/start?a=1");
      expect(captured[1]!.path).toBe("/hooks/final?b=2");
      const secondHeaders = captured[1]!.headers as Record<string, string>;
      expect(Object.keys(secondHeaders).map((k) => k.toLowerCase())).not.toContain("authorization");
      expect(Object.keys(secondHeaders).map((k) => k.toLowerCase())).not.toContain("cookie");
      expect(Object.keys(secondHeaders).map((k) => k.toLowerCase())).not.toContain("proxy-authorization");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("Security Repair 07 — canonical gateway signing secret", () => {
  const strong = "Mox-Gateway-Strong-Secret-2026#Ab9xY";
  const claims = { orgId: "org-1", agentId: "agent-1", sessionId: "sess-1", ttlSeconds: 60 };

  it("D: one validator rejects legacy/short/low-diversity values and accepts the strong fixture", () => {
    expect(() => validateGatewaySigningSecret("")).toThrow(/required/);
    expect(() => validateGatewaySigningSecret(LEGACY_PUBLIC_GATEWAY_SECRET)).toThrow(/public hardcoded/);
    expect(() => validateGatewaySigningSecret("Short-1")).toThrow(/at least 32/);
    expect(() => validateGatewaySigningSecret("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toThrow(/at least 3/);
    expect(validateGatewaySigningSecret(strong)).toBe(strong);
  });

  it("D: mint and verify helpers apply the same injected-secret policy", () => {
    expect(() => mintGatewayToken(claims, new Date(), "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toThrow(/at least 3/);
    const token = mintGatewayToken(claims, new Date(), strong).token;
    expect(verifyGatewayToken(token, new Date(), { secret: strong }).ok).toBe(true);
    expect(verifyGatewayToken(token, new Date(), { secret: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })).toMatchObject({ ok: false });
  });
});
