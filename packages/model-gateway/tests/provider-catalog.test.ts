import { describe, expect, it } from "vitest";
import { defaultProviderCatalog } from "../src/catalog.js";
import type { HttpTransport } from "../src/providers.js";

const expectedCompatibleProviders: Record<string, string> = {
  p_openai: "https://api.openai.com/v1/chat/completions",
  p_openrouter: "https://openrouter.ai/api/v1/chat/completions",
  p_deepseek: "https://api.deepseek.com/v1/chat/completions",
  p_qwen: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions",
  p_glm: "https://api.z.ai/api/paas/v4/chat/completions",
  p_kimi: "https://api.moonshot.ai/v1/chat/completions",
  p_mimo: "https://api.xiaomimimo.com/v1/chat/completions",
  p_minimax: "https://api.minimax.io/v1/chat/completions",
  p_meta: "https://api.meta.ai/v1/chat/completions",
  p_nvidia: "https://integrate.api.nvidia.com/v1/chat/completions",
  p_xai: "https://api.x.ai/v1/chat/completions",
};

describe("defaultProviderCatalog", () => {
  it("registers all first-class OpenAI-compatible providers", () => {
    const catalog = defaultProviderCatalog();
    for (const providerId of Object.keys(expectedCompatibleProviders)) {
      expect(catalog.has(providerId), `${providerId} should be registered`).toBe(true);
    }
    expect(catalog.has("p_anthropic")).toBe(true);
    expect(catalog.has("p_google")).toBe(true);
    expect(catalog.has("p_generic")).toBe(true);
  });

  it("routes each first-class compatible provider to its canonical endpoint", async () => {
    const calls: string[] = [];
    const transport: HttpTransport = async (url) => {
      calls.push(url);
      return {
        status: 200,
        json: {
          id: "req-test",
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        },
      };
    };
    const catalog = defaultProviderCatalog({ transport });

    for (const [providerId, expectedUrl] of Object.entries(expectedCompatibleProviders)) {
      calls.length = 0;
      const binding = catalog.get(providerId);
      expect(binding, `${providerId} binding should exist`).toBeDefined();
      await binding!.create(async () => "test-key").complete({
        modelId: "test-model",
        messages: [{ role: "user", content: "ping" }],
      });
      expect(calls).toEqual([expectedUrl]);
    }
  });

  it("allows deployment-specific base URL overrides", async () => {
    const calls: string[] = [];
    const transport: HttpTransport = async (url) => {
      calls.push(url);
      return { status: 200, json: { choices: [{ message: { content: "ok" } }] } };
    };
    const catalog = defaultProviderCatalog({
      transport,
      baseUrls: { p_qwen: "https://workspace.example/compatible-mode/v1" },
    });

    await catalog.get("p_qwen")!.create(async () => "test-key").complete({
      modelId: "qwen-plus",
      messages: [{ role: "user", content: "ping" }],
    });

    expect(calls).toEqual(["https://workspace.example/compatible-mode/v1/chat/completions"]);
  });
});
