import { describe, expect, it } from "vitest";
import { CredentialId, ModelDefinition, ModelId, ProviderId, type CredentialReference } from "@mox/contracts";
import { ProviderUnavailableError } from "@mox/provider-sdk";
import {
  AnthropicAdapter,
  defaultProviderCatalog,
  GeminiAdapter,
  InMemoryUsageMeter,
  ModelGateway,
  OpenAiCompatibleAdapter,
  type CredentialResolver,
  type CredentialScopeLevel,
  type EntitlementPolicySeam,
  type HttpTransport,
} from "../src/index.js";
import { ModelRegistry } from "../src/index.js";

const ORG = "org-1";

function ref(scope: string): CredentialReference {
  return {
    credentialId: CredentialId.parse(`cred_${scope}`),
    kind: "api-key",
    label: scope,
    vaultRef: `model/p_openai/${scope}`,
  };
}

function resolver(keys: Partial<Record<CredentialScopeLevel, string | null>>): CredentialResolver {
  return {
    async resolve(scope) {
      return keys[scope] ?? null;
    },
  };
}

const allowAll: EntitlementPolicySeam = { check: async () => ({ allowed: true }) };

function openAiTransport(response: unknown, status = 200, calls: Array<{ url: string; headers: Record<string, string>; body: string }> = []): HttpTransport {
  return async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body });
    return { status, json: response };
  };
}

const openAiResponse = {
  id: "req_1",
  choices: [{ message: { content: "hello!" } }],
  usage: { prompt_tokens: 12, completion_tokens: 7 },
};

function gatewayWith(
  overrides: {
    keys?: Partial<Record<CredentialScopeLevel, string | null>>;
    transport?: HttpTransport;
    entitlements?: EntitlementPolicySeam;
    registry?: ModelRegistry;
  } = {},
) {
  const catalog = defaultProviderCatalog({ transport: overrides.transport });
  const meter = new InMemoryUsageMeter();
  const gw = new ModelGateway({
    registry:
      overrides.registry ??
      (() => {
        const r = new ModelRegistry();
        r.register(
          ModelDefinition.parse({
            providerId: ProviderId.parse("p_openai"),
            modelId: ModelId.parse("gpt-4.1"),
            displayName: "GPT-4.1",
            contextWindowTokens: 128_000,
            capabilities: ["chat", "tools"],
          }),
        );
        return r;
      })(),
    adapters: catalog,
    entitlements: overrides.entitlements ?? allowAll,
    credentials: resolver(overrides.keys ?? { org: "sk-test-org" }),
    meter,
  });
  return { gw, meter };
}

describe("ModelGateway dispatch", () => {
  it("routes through the provider adapter with scoped credentials and meters usage", async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const { gw, meter } = gatewayWith({ keys: { org: "sk-live-secret-123" }, transport: openAiTransport(openAiResponse, 200, calls) });

    const res = await gw.dispatch({
      orgId: ORG,
      agentId: "a1",
      selection: { providerId: ProviderId.parse("p_openai"), modelId: ModelId.parse("gpt-4.1") },
      request: { messages: [{ role: "user", content: "hi" }] },
    });

    expect(res.text).toBe("hello!");
    expect(res.providerRequestId).toBe("req_1");
    expect(calls[0]?.url).toContain("/chat/completions");
    expect(calls[0]?.headers.authorization).toBe("Bearer sk-live-secret-123");

    expect(meter.events).toHaveLength(1);
    const meta = meter.events[0]?.extension as Record<string, unknown>;
    expect(meta.success).toBe(true);
    expect(meta.latencyMs).toBeTypeOf("number");
    expect(meta.providerId).toBe("p_openai");
  });

  it("resolves agent-scope before org and never falls back when forbidden", async () => {
    const { gw, meter } = gatewayWith({ keys: { agent: null, user: null, org: "sk-org" }, transport: openAiTransport(openAiResponse) });
    await expect(
      gw.dispatch({
        orgId: ORG,
        selection: { providerId: ProviderId.parse("p_openai"), modelId: ModelId.parse("gpt-4.1") },
        request: { messages: [] },
        scopePolicy: { allowedScopes: ["agent"], forbidBroaderFallback: true },
      }),
    ).rejects.toThrow(/broader fallback is forbidden/);
    expect(meter.events[0]?.metric).toBe("requests");
  });

  it("entitlement denial blocks dispatch and is metered as a failure", async () => {
    const { gw, meter } = gatewayWith({
      entitlements: { check: async () => ({ allowed: false, reason: "model not in plan" }) },
    });
    await expect(
      gw.dispatch({
        orgId: ORG,
        selection: { providerId: ProviderId.parse("p_openai"), modelId: ModelId.parse("gpt-4.1") },
        request: { messages: [] },
      }),
    ).rejects.toThrow("model not in plan");
    expect(((meter.events[0]?.extension ?? {}) as Record<string, unknown>).success).toBe(false);
  });

  it("provider failure is contained, redacted, and metered — not a crash", async () => {
    const failing: HttpTransport = async () => ({
      status: 500,
      json: { error: { message: "upstream exploded key=sk-leaky-key-9876" } },
    });
    const { gw, meter } = gatewayWith({ transport: failing });
    await expect(
      gw.dispatch({
        orgId: ORG,
        selection: { providerId: ProviderId.parse("p_openai"), modelId: ModelId.parse("gpt-4.1") },
        request: { messages: [{ role: "user", content: "x" }] },
      }),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
    const errText = JSON.stringify(meter.events[0]);
    expect(errText).not.toContain("sk-leaky-key-9876");
    expect(meter.events[0]?.extension).toBeDefined();
  });

  it("unknown models and unconfigured mox aliases fail honestly", async () => {
    const { gw } = gatewayWith({});
    await expect(
      gw.dispatch({
        orgId: ORG,
        selection: { providerId: ProviderId.parse("p_mox"), modelId: ModelId.parse("mox-agent") },
        request: { messages: [] },
      }),
    ).rejects.toThrow(/model not found/);
  });

  it("adapters refuse to call providers without credentials", async () => {
    const adapter = new OpenAiCompatibleAdapter({
      providerId: "p_openai",
      baseUrl: "https://api.openai.com/v1",
      apiKeyProvider: async () => null,
    });
    await expect(adapter.complete({ modelId: "gpt-4.1", messages: [] })).rejects.toThrow(/not configured/);
    await expect(new AnthropicAdapter({ apiKeyProvider: async () => null }).complete({ modelId: "claude-x", messages: [] })).rejects.toThrow(/not configured/);
    await expect(new GeminiAdapter({ apiKeyProvider: async () => null }).complete({ modelId: "gemini-x", messages: [] })).rejects.toThrow(/not configured/);
  });
});

describe("native-shape adapters build correct requests", () => {
  it("anthropic uses x-api-key + system extraction + messages API path", async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const t: HttpTransport = async (url, init) => {
      calls.push({ url, headers: init.headers, body: init.body });
      return { status: 200, json: { content: [{ text: "hey" }], usage: { input_tokens: 3, output_tokens: 2 }, id: "msg_1" } };
    };
    const adapter = new AnthropicAdapter({ apiKeyProvider: async () => "sk-ant-key" }, t);
    const res = await adapter.complete({
      modelId: "claude-sonnet-4",
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hi" },
      ],
    });
    expect(res.text).toBe("hey");
    expect(calls[0]?.url).toContain("/v1/messages");
    expect(calls[0]?.headers["x-api-key"]).toBe("sk-ant-key");
    const body = JSON.parse(calls[0]?.body ?? "{}") as { system?: string; messages?: unknown[] };
    expect(body.system).toBe("be brief");
    expect(body.messages).toHaveLength(1);
  });

  it("gemini uses generateContent with model-role mapping", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const t: HttpTransport = async (url, init) => {
      calls.push({ url, body: init.body });
      return { status: 200, json: { candidates: [{ content: { parts: [{ text: "ok" }] } }], usageMetadata: { promptTokenCount: 5 } } };
    };
    const adapter = new GeminiAdapter({ apiKeyProvider: async () => "g-key" }, t);
    const res = await adapter.complete({
      modelId: "gemini-2.5-flash",
      messages: [
        { role: "assistant", content: "earlier" },
        { role: "user", content: "next" },
      ],
    });
    expect(res.text).toBe("ok");
    expect(calls[0]?.url).toContain(":generateContent");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toMatchObject({
      contents: [
        { role: "model", parts: [{ text: "earlier" }] },
        { role: "user", parts: [{ text: "next" }] },
      ],
    });
  });
});
