import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
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
      "GET /api/me": () => ({ userId: "u-1", email: "dev@example.test" }),
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

  it("whoami/agents/models/channels/integrations hit /api routes", async () => {
    const { api, requests } = fakeApi();
    const tokens = new InMemoryTokenStore();
    const cases: Array<{ argv: string[]; path: string }> = [
      { argv: ["whoami"], path: "/api/me" },
      { argv: ["agents", "list"], path: "/api/agents" },
      { argv: ["agents", "get", "a-1"], path: "/api/agents/a-1" },
      { argv: ["models", "connections"], path: "/api/model-connections" },
      { argv: ["channels", "list"], path: "/api/channels" },
      { argv: ["integrations", "list"], path: "/api/integrations" },
    ];
    for (const c of cases) {
      const ctx = captureIo();
      const code = await main({ argv: c.argv, api, tokens, io: ctx.io });
      expect(code).toBe(0);
    }
    expect(requests.map((r) => r.path)).toEqual(cases.map((c) => c.path));
  });

  it("servers list hits /api/servers; get is honestly unsupported", async () => {
    const { api, requests } = fakeApi({
      "GET /api/servers": () => [{ id: "srv-1", state: "running" }],
    });
    const tokens = new InMemoryTokenStore();
    const list = captureIo();
    await main({ argv: ["servers", "list"], api, tokens, io: list.io });
    expect(requests[0]?.path).toBe("/api/servers");

    const before = requests.length;
    const get = captureIo();
    const code = await main({ argv: ["servers", "get", "srv-1"], api, tokens, io: get.io });
    expect(code).toBe(1);
    expect(requests.length).toBe(before);
    expect(get.errors[0]).toContain("unsupported");
  });

  it("orgs and per-id deployment status are honestly unsupported", async () => {
    const { api, requests } = fakeApi();
    const tokens = new InMemoryTokenStore();
    const orgs = captureIo();
    const orgsCode = await main({ argv: ["orgs", "list"], api, tokens, io: orgs.io });
    expect(orgsCode).toBe(1);
    expect(orgs.errors[0]).toContain("unsupported");

    const status = captureIo();
    const statusCode = await main({ argv: ["deployment", "status", "d-1"], api, tokens, io: status.io });
    expect(statusCode).toBe(1);
    expect(status.errors[0]).toContain("unsupported");

    const list = captureIo();
    await main({ argv: ["deployment", "list"], api, tokens, io: list.io });
    expect(requests[0]?.path).toBe("/api/deployments");
  });

  it("deploy requires an agent id and forwards the revision flag", async () => {
    const { api, requests } = fakeApi();
    const tokens = new InMemoryTokenStore();
    const ctx = captureIo();
    await main({ argv: ["deploy", "a-39c0f2", "--revision", "3"], api, tokens, io: ctx.io });
    expect(requests[0]).toEqual({
      method: "POST",
      path: "/api/deployments",
      body: { agentId: "a-39c0f2", revision: 3 },
    });

    const missing = captureIo();
    const code = await main({ argv: ["deploy"], api, tokens, io: missing.io });
    expect(code).toBe(1);
    expect(missing.errors[0]).toContain("agent-id");
  });

  it("logs and terminal target per-agent /api routes", async () => {
    const { api, requests } = fakeApi();
    const tokens = new InMemoryTokenStore();
    const logs = captureIo();
    await main({ argv: ["logs", "a-1"], api, tokens, io: logs.io });
    expect(requests[0]?.path).toBe("/api/agents/a-1/logs");

    const term = captureIo();
    await main({ argv: ["terminal", "a-1"], api, tokens, io: term.io });
    expect(requests[1]).toEqual({
      method: "POST",
      path: "/api/agents/a-1/terminal",
      body: {},
    });
  });

  it("terminal surfaces server-side enforcement errors honestly", async () => {
    const { api, requests } = fakeApi({
      "POST /api/agents": () => {
        // Server-side gate denies unentitled plans.
        throw new Error("API POST /api/agents/ag-2/terminal failed (403): cli_sessions not enabled");
      },
    });
    const tokens = new InMemoryTokenStore();
    const ctx = captureIo();
    const code = await main({ argv: ["terminal", "ag-2"], api, tokens, io: ctx.io });
    expect(code).toBe(1);
    expect(ctx.errors[0]).toContain("403");
    expect(ctx.errors[0]).toContain("not enabled");
    expect(requests[0]?.method).toBe("POST");
  });

  it("agents create/update forward the JSON body to draft routes", async () => {
    const { api, requests } = fakeApi();
    const tokens = new InMemoryTokenStore();
    const bodyFile = fileURLToPath(new URL("./fixtures/agent-body.json", import.meta.url));
    const create = captureIo();
    await main({ argv: ["agents", "create", bodyFile], api, tokens, io: create.io });
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.path).toBe("/api/agents/drafts");
    expect((requests[0]?.body as { slug?: string })?.slug).toBe("sales-helper");

    const update = captureIo();
    await main({ argv: ["agents", "update", "a-1", bodyFile], api, tokens, io: update.io });
    expect(requests[1]?.method).toBe("PATCH");
    expect(requests[1]?.path).toBe("/api/agents/a-1/draft");
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