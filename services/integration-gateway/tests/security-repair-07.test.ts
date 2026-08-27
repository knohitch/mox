import { EventEmitter } from "node:events";
import https from "node:https";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { WebhookAutomationProvider, type IntegrationConnection } from "../src/providers.js";

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
      res.statusCode = 200;
      res.headers = {};
      res.rawHeaders = [];
      callback?.(res);
      res.end("ok");
    });
    return req;
  }) as never);
  return { spy, captured };
}

const connection: IntegrationConnection = {
  connectionId: "i1",
  orgId: "o1",
  providerKind: "webhook-token",
  displayName: "Webhook",
  webhookUrl: "https://8.8.8.8/hooks/final?token=abc&mode=full",
  config: {},
  status: "connected",
};

describe("Security Repair 07 — integration SSRF caller", () => {
  it("R09-8/A2: default WebhookAutomationProvider preserves non-root request target on the pinned node:https path", async () => {
    const { spy: httpsSpy, captured } = interceptHttps();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("global fetch must not run"));
    try {
      const provider = new WebhookAutomationProvider("webhook-token");
      const result = await provider.invoke(connection, "trigger", { payload: { ok: true } });
      expect(result.ok).toBe(true);
      expect(httpsSpy).toHaveBeenCalledTimes(1);
      expect(captured[0]!.path).toBe("/hooks/final?token=abc&mode=full");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      httpsSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  it("A7: explicit fixture fetch injection remains an explicit test seam", async () => {
    const { spy: httpsSpy } = interceptHttps();
    const fixture = vi.fn(async () => new Response("ok", { status: 200 }));
    try {
      const provider = new WebhookAutomationProvider("webhook-token", { fetchImpl: fixture });
      const result = await provider.invoke(connection, "trigger", { payload: {} });
      expect(result.ok).toBe(true);
      expect(fixture).toHaveBeenCalledTimes(1);
      expect(httpsSpy).not.toHaveBeenCalled();
    } finally {
      httpsSpy.mockRestore();
    }
  });
});
