import { CredentialId, ProviderId, type CredentialReference } from "@mox/contracts";
import type { AdapterBinding, CredentialScopeLevel } from "./gateway.js";
import {
  AnthropicAdapter,
  GeminiAdapter,
  OpenAiCompatibleAdapter,
} from "./providers.js";

/**
 * Default provider catalog (Prompt 07): every listed API provider has a real
 * adapter binding. OpenAI-compatible vendors share one adapter with
 * provider-specific baseUrls; Anthropic and Gemini keep native adapters.
 *
 * `credentialRefs` point at vault locators per scope; the gateway resolves
 * them through @mox/credentials at dispatch time.
 */

function ref(scope: CredentialScopeLevel, vendor: string): CredentialReference {
  return {
    credentialId: CredentialId.parse(`cred_${vendor}_${scope}`),
    kind: "api-key",
    label: `${vendor} API key (${scope} scope)`,
    vaultRef: `model/${vendor}/${scope}`,
  };
}

export function openAiCompatibleBinding(
  providerId: string,
  baseUrl: string,
  transport?: import("./providers.js").HttpTransport,
): AdapterBinding {
  return {
    create: (apiKeyProvider) =>
      new OpenAiCompatibleAdapter(
        {
          providerId,
          baseUrl,
          apiKeyProvider,
        },
        transport,
      ),
    // BYOK scopes: agent → user → org; system-managed last resort.
    credentialRefs: {
      agent: ref("agent", providerId),
      user: ref("user", providerId),
      org: ref("org", providerId),
      system: ref("system", providerId),
    },
  };
}

export function anthropicBinding(): AdapterBinding {
  return {
    create: (apiKeyProvider) => new AnthropicAdapter({ apiKeyProvider }),
    credentialRefs: {
      agent: ref("agent", "anthropic"),
      user: ref("user", "anthropic"),
      org: ref("org", "anthropic"),
      system: ref("system", "anthropic"),
    },
  };
}

export function geminiBinding(): AdapterBinding {
  return {
    create: (apiKeyProvider) => new GeminiAdapter({ apiKeyProvider }),
    credentialRefs: {
      agent: ref("agent", "google"),
      user: ref("user", "google"),
      org: ref("org", "google"),
      system: ref("system", "google"),
    },
  };
}

export interface CatalogDefaults {
  /** Override individual OpenAI-compatible baseUrls when needed. */
  baseUrls?: Partial<Record<string, string>>;
  /** Inject an HTTP transport (tests / proxies). Applies to compatible family. */
  transport?: import("./providers.js").HttpTransport;
}

/** providerId → binding for every supported API provider. */
export function defaultProviderCatalog(defaults: CatalogDefaults = {}): Map<string, AdapterBinding> {
  const b = defaults.baseUrls ?? {};
  const catalog = new Map<string, AdapterBinding>();

  // Native-shape adapters:
  catalog.set("p_anthropic", anthropicBinding());
  catalog.set("p_google", geminiBinding());

  // OpenAI-compatible family (one adapter, per-vendor endpoints). Every URL can
  // be overridden so regional/workspace-specific endpoints remain supported.
  const compatible: Array<[string, string]> = [
    ["p_openai", "https://api.openai.com/v1"],
    ["p_openrouter", "https://openrouter.ai/api/v1"],
    ["p_deepseek", "https://api.deepseek.com/v1"],
    ["p_qwen", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"],
    ["p_glm", "https://api.z.ai/api/paas/v4"],
    ["p_kimi", "https://api.moonshot.ai/v1"],
    ["p_mimo", "https://api.xiaomimimo.com/v1"],
    ["p_minimax", "https://api.minimax.io/v1"],
    ["p_meta", "https://api.meta.ai/v1"],
    ["p_nvidia", "https://integrate.api.nvidia.com/v1"],
    ["p_xai", "https://api.x.ai/v1"],
    ["p_generic", "https://generic.example.invalid/v1"], // explicit placeholder until configured
  ];
  for (const [providerId, url] of compatible) {
    catalog.set(providerId, openAiCompatibleBinding(ProviderId.parse(providerId), b[providerId] ?? url, defaults.transport));
  }
  return catalog;
}
