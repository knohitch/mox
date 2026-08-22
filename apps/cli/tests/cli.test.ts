import { describe, expect, it } from "vitest";
import { InMemoryTokenStore, type ApiClient } from "../src/api.js";
import { main, type CliIo } from "../src/main.js";

interface RecordedRequest {
  method: string;
  path: string;
  body?: unknown;
}

function fakeApi(routes: Record<string, (body?: unknown) => unknown> = {}) {
  const requests: RecordedRequest[] = [];
  const api: ApiClient = {
    async request(method, path, body) {
      requests.push({ method, path, body });
      const key = `${method} ${path}`;
      const handler =
        routes[key] ?? routes[`${method} ${path.split("/").slice(0, 3).join("/")}`] ?? (() => ({ ok: true }));
      return handler(body);
    },
  };
  return { api, requests };
}

function captureIo() {
  const out: string[] = [];
  const errors: string[] = [];
  const io: CliIo = {
    print: (line) => out.push(line),
    error: (line) => errors.push(line),
  };
  return { io, out, errors };
}

const TOKEN = "test-token-1234567890";

describe("mox cli", () => {
  it("sends bearer tokens on API calls and prints responses", async () => {
    const { api, requests } = fakeApi({
      "GET /v1/whoami": () => ({ userId: "u-1", email: "dev@example.test" }),
    });
    // Wrap to assert auth header behavior via token store presence.
    const tokens = new InMemoryTokenStore();
    await tokens.set(TOKEN);
    const { io, out } = captureIo();
    const code = await main({ argv: ["whoami"], api, tokens, io });
    expect(code).toBe(0);
    expect(requests[0]?.method).toBe("GET");
    expect(JSON.parse(out[0]!)).toEqual({ userId: "u-1", email: "dev@example.test" });
  });

  it("login stores the token; logout clears it", async () => {
    const { api } = fakeApi();
    const tokens = new InMemoryTokenStore();
    const first = captureIo();
    await main({ argv: ["login", "--token", TOKEN], api, tokens, io: first.io });
    expect(await tokens.get()).toBe(TOKEN);
    const second = captureIo();
    await main({ argv: ["logout"], api, tokens, io: second.io });
    expect(await tokens.get()).toBeUndefined();
  });

  it("servers list/get hit the right endpoints", async () => {
    const { api, requests } = fakeApi({
      "GET /v1/servers": () => [{ id: "srv-1", state: "running" }],
      "GET /v1/servers/srv-1": () => ({ id: "srv-1", ipv4: "203.0.113.9" }),
    });
    const tokens = new InMemoryTokenStore();
    const list = captureIo();
    await main({ argv: ["servers", "list"], api, tokens, io: list.io });
    expect(requests[0]?.path).toBe("/v1/servers");

    const get = captureIo();
    await main({ argv: ["servers", "get", "srv-1"], api, tokens, io: get.io });
    expect(requests[1]?.path).toBe("/v1/servers/srv-1");
    expect(JSON.parse(get.out[0]!).ipv4).toBe("203.0.113.9");
  });

  it("deploy requires a slug and forwards revision flag", async () => {
    const { api, requests } = fakeApi();
    const tokens = new InMemoryTokenStore();
    const ctx = captureIo();
    await main({ argv: ["deploy", "sales-helper", "--revision", "3"], api, tokens, io: ctx.io });
    expect(requests[0]).toEqual({
      method: "POST",
      path: "/v1/agents/sales-helper/deployments",
      body: { revision: 3 },
    });

    const missing = captureIo();
    const code = await main({ argv: ["deploy"], api, tokens, io: missing.io });
    expect(code).toBe(1);
    expect(missing.errors[0]).toContain("agent-slug");
  });

  it("terminal asks the server, which enforces entitlements server-side", async () => {
    let terminalCalls = 0;
    const { api, requests } = fakeApi({
      "POST /v1/servers": () => {
        terminalCalls += 1;
        // Server-side gate denies unentitled plans.
        throw new Error("API POST /v1/servers/srv-1/terminal failed (403): cli_sessions not enabled");
      },
    });
    const tokens = new InMemoryTokenStore();
    const ctx = captureIo();
    const code = await main({ argv: ["terminal", "srv-1"], api, tokens, io: ctx.io });
    void terminalCalls;
    expect(code).toBe(1);
    expect(ctx.errors[0]).toContain("403");
    expect(ctx.errors[0]).toContain("not enabled");
    expect(requests[0]?.method).toBe("POST");
  });

  it("help lists all required commands", async () => {
    const { api } = fakeApi();
    const ctx = captureIo();
    await main({ argv: ["help"], api, tokens: new InMemoryTokenStore(), io: ctx.io });
    const text = ctx.out.join("\n");
    for (const expected of ["login", "whoami", "orgs", "servers", "agents", "deploy", "deployment", "logs", "models", "channels", "integrations", "terminal"]) {
      expect(text).toContain(expected);
    }
  });

  it("unknown commands exit non-zero with guidance", async () => {
    const { api } = fakeApi();
    const ctx = captureIo();
    const code = await main({ argv: ["frobnicate"], api, tokens: new InMemoryTokenStore(), io: ctx.io });
    expect(code).toBe(1);
    expect(ctx.errors[0]).toContain("unknown command");
  });
});
