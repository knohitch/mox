import { EventEmitter } from "node:events";
import https from "node:https";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { HttpOutboundTransport } from "../src/gateway.js";

function interceptHttps() {
  const captured: https.RequestOptions[] = [];
  const spy = vi.spyOn(https, "request").mockImplementation(((options: unknown, callback?: (res: unknown) => void) => {
    captured.push(options as https.RequestOptions);
    const req = new EventEmitter() as EventEmitter & {
      setTimeout(ms: number, cb: () => void): unknown;
      write(chunk: unknown): boolean;
      end(): void;
      destroy(error?: Error): unknown;
    };
    req.setTimeout = () => req;
    req.write = () => true;
    req.destroy = (error?: Error) => { if (error) queueMicrotask(() => req.emit("error", error)); return req; };
    req.end = () => queueMicrotask(() => {
      const res = new PassThrough() as PassThrough & { statusCode: number; headers: Record<string, string>; rawHeaders: string[] };
      res.statusCode = 204;
      res.headers = {};
      res.rawHeaders = [];
      callback?.(res);
      res.end();
    });
    return req;
  }) as never);
  return { spy, captured };
}

const connection = {
  connectionId: "c1",
  orgId: "o1",
  agentId: "a1",
  providerKind: "webhook",
  secretRef: "vault://c1",
  status: "active" as const,
  outboundUrl: "https://8.8.8.8/hook/task?token=abc&mode=full",
  createdAt: new Date().toISOString(),
};

describe("Security Repair 07 — channel SSRF caller", () => {
  it("R09-7/A1: default HttpOutboundTransport preserves non-root request target on the pinned node:https path", async () => {
    const { spy: httpsSpy, captured } = interceptHttps();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("global fetch must not run"));
    try {
      const result = await new HttpOutboundTransport().send(connection, { hello: "world" });
      expect(result.delivered).toBe(true);
      expect(httpsSpy).toHaveBeenCalledTimes(1);
      expect(captured[0]!.path).toBe("/hook/task?token=abc&mode=full");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      httpsSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  it("A7: explicit fixture fetch injection remains possible but is never the default", async () => {
    const { spy: httpsSpy } = interceptHttps();
    const fixture = vi.fn(async () => new Response(null, { status: 204 }));
    try {
      const result = await new HttpOutboundTransport(fixture).send(connection, {});
      expect(result.delivered).toBe(true);
      expect(fixture).toHaveBeenCalledTimes(1);
      expect(httpsSpy).not.toHaveBeenCalled();
    } finally {
      httpsSpy.mockRestore();
    }
  });
});
