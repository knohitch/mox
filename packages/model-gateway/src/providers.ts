import { ProviderUnavailableError } from "@mox/provider-sdk";

/**
 * Model provider adapters (Prompt 07). Providers whose APIs differ
 * structurally (Anthropic messages, Gemini generateContent) get their own
 * adapter instead of being forced through a lossy OpenAI translation.
 * Every adapter takes an injectable transport so tests assert REQUEST SHAPE
 * without network access; production wires fetch.
 *
 * Rule: an adapter WITHOUT credentials reports `not-configured` honestly. It
 * never fakes a successful completion.
 */

export interface CompletionRequest {
  modelId: string;
  /** Chat transcript, oldest first. */
  messages: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }>;
  temperature?: number;
  maxOutputTokens?: number;
  /** Request-level identifier for tracing/metering correlation. */
  requestId?: string;
}

export interface CompletionUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
}

export interface CompletionResult {
  text: string;
  usage: CompletionUsage;
  providerRequestId?: string;
  raw?: unknown;
}

export type HttpTransport = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body: string;
}) => Promise<{ status: number; json: unknown }>;

export const defaultHttpTransport: HttpTransport = async (url, init) => {
  const res = await fetch(url, { ...init });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};

function providerDown(providerId: string, reason: string): ProviderUnavailableError {
  return new ProviderUnavailableError(providerId, {
    state: "unavailable",
    reason,
    checkedAt: new Date().toISOString(),
  });
}

export function notConfigured(providerId: string): ProviderUnavailableError {
  return providerDown(providerId, "not configured (missing credentials)");
}

// ---- OpenAI-compatible family ----

/**
 * One adapter covers every OpenAI-compatible endpoint via baseUrl:
 * OpenAI, OpenRouter, DeepSeek, Qwen/Alibaba Model Studio, GLM/Z.ai,
 * Kimi (Moonshot), Xiaomi MiMo, NVIDIA NIM. Vendor quirks stay in config.
 */
export interface OpenAiCompatibleConfig {
  providerId: string;
  baseUrl: string;
  /** API key injected at request time from the vault — never stored here. */
  apiKeyProvider: () => Promise<string | null>;
}

export class OpenAiCompatibleAdapter {
  readonly kind = "api" as const;

  constructor(
    private readonly cfg: OpenAiCompatibleConfig,
    private readonly transport: HttpTransport = defaultHttpTransport,
  ) {}

  get providerId(): string {
    return this.cfg.providerId;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const apiKey = await this.cfg.apiKeyProvider();
    if (!apiKey) throw notConfigured(this.cfg.providerId);

    const res = await this.transport(`${this.cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: req.modelId,
        messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
        temperature: req.temperature,
        max_tokens: req.maxOutputTokens,
        user: req.requestId,
      }),
    });
    if (res.status === 401 || res.status === 403) {
      throw providerDown(this.cfg.providerId, `rejected credentials (HTTP ${res.status})`);
    }
    if (res.status >= 400) {
      throw providerDown(this.cfg.providerId, `upstream error ${res.status}`);
    }
    const body = res.json as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      id?: string;
    };
    const text = body.choices?.[0]?.message?.content ?? "";
    return {
      text,
      usage: {
        inputTokens: body.usage?.prompt_tokens,
        outputTokens: body.usage?.completion_tokens,
      },
      providerRequestId: body.id,
      raw: body,
    };
  }
}

// ---- Anthropic (native Messages API shape) ----

export class AnthropicAdapter {
  readonly kind = "api" as const;
  readonly providerId = "p_anthropic";

  constructor(
    private readonly opts: { apiKeyProvider: () => Promise<string | null>; version?: string },
    private readonly transport: HttpTransport = defaultHttpTransport,
  ) {}

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const apiKey = await this.opts.apiKeyProvider();
    if (!apiKey) throw notConfigured(this.providerId);

    const system = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    // Anthropic rejects empty content blocks; guard the single-message case.
    const nonSystem = req.messages.filter((m) => m.role !== "system");
    const messages = nonSystem.length > 0 ? nonSystem.map((m) => ({ role: m.role === "tool" ? "user" : m.role, content: m.content })) : [{ role: "user" as const, content: "(ping)" }];

    const res = await this.transport("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": this.opts.version ?? "2023-06-01",
      },
      body: JSON.stringify({
        model: req.modelId,
        max_tokens: req.maxOutputTokens ?? 1024,
        system: system || undefined,
        messages,
      }),
    });
    if (res.status >= 400) {
      throw providerDown(this.providerId, `upstream error ${res.status}`);
    }
    const body = res.json as {
      content?: Array<{ text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
      id?: string;
    };
    return {
      text: (body.content ?? []).map((c) => c.text ?? "").join(""),
      usage: { inputTokens: body.usage?.input_tokens, outputTokens: body.usage?.output_tokens },
      providerRequestId: body.id,
      raw: body,
    };
  }
}

// ---- Google Gemini (generateContent shape) ----

export class GeminiAdapter {
  readonly kind = "api" as const;
  readonly providerId = "p_google";

  constructor(
    private readonly opts: { apiKeyProvider: () => Promise<string | null> },
    private readonly transport: HttpTransport = defaultHttpTransport,
  ) {}

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const apiKey = await this.opts.apiKeyProvider();
    if (!apiKey) throw notConfigured(this.providerId);

    const contents = req.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));

    const res = await this.transport(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(req.modelId)}:generateContent`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({ contents }),
      },
    );
    if (res.status >= 400) {
      throw providerDown(this.providerId, `upstream error ${res.status}`);
    }
    const body = res.json as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    return {
      text: (body.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join(""),
      usage: {
        inputTokens: body.usageMetadata?.promptTokenCount,
        outputTokens: body.usageMetadata?.candidatesTokenCount,
      },
      raw: body,
    };
  }
}
