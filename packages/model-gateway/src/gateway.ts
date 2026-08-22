import type {
  CredentialReference,
  ModelSelection,
  UsageEvent,
} from "@mox/contracts";
import { ProviderUnavailableError } from "@mox/provider-sdk";
import { redact } from "@mox/credentials";
import { ModelRegistry } from "./registry.js";
import type { CompletionRequest, CompletionResult } from "./providers.js";

/**
 * The Mox Model Gateway (Prompt 07) — the ONLY path from agent runtimes to
 * models:
 *
 *   Agent Runtime → Model Gateway → entitlement/policy → credential resolution
 *     → usage meter → provider adapter → model
 *
 * Guarantees:
 * - credential scopes resolve EXPLICITLY (agent < user < org < system); when
 *   `forbidBroaderFallback` is set the call FAILS rather than silently using
 *   a broader secret;
 * - every invocation emits usage metadata, success or failure;
 * - secrets never appear in errors or meter records (redacted at the edge);
 * - provider failure is contained — unrelated providers are untouched.
 */

export type CredentialScopeLevel = "agent" | "user" | "org" | "system";
export const SCOPE_ORDER: ReadonlyArray<CredentialScopeLevel> = ["agent", "user", "org", "system"];

export interface ScopePolicy {
  /** Scopes the caller MAY use, most-specific first. */
  allowedScopes: readonly CredentialScopeLevel[];
  /** Fail instead of falling back to broader scopes. */
  forbidBroaderFallback?: boolean;
}

export interface CredentialResolver {
  /** Resolve a scoped secret reference; null when absent. */
  resolve(scope: CredentialScopeLevel, ref: CredentialReference): Promise<string | null>;
}

export interface EntitlementPolicySeam {
  check(input: { orgId: string; providerId: string; modelId: string }): Promise<{ allowed: boolean; reason?: string }>;
}

export interface UsageMeterSink {
  record(usage: UsageEvent): Promise<void>;
}

export class InMemoryUsageMeter implements UsageMeterSink {
  readonly events: UsageEvent[] = [];
  async record(usage: UsageEvent): Promise<void> {
    this.events.push(usage);
  }
}

/**
 * Adapter factory bound to one provider. `apiKeyProvider` injects the
 * RESOLVED scoped secret at dispatch time — adapters never store keys.
 */
export interface AdapterBinding {
  create(apiKeyProvider: () => Promise<string | null>): {
    complete(req: CompletionRequest): Promise<CompletionResult>;
  };
  /** Where the API key may live, per scope level. */
  credentialRefs: Partial<Record<CredentialScopeLevel, CredentialReference>>;
}

export interface ModelGatewayOptions {
  registry: ModelRegistry;
  adapters: Map<string, AdapterBinding>;
  entitlements: EntitlementPolicySeam;
  credentials: CredentialResolver;
  meter: UsageMeterSink;
  region?: string;
}

export interface GatewayDispatchInput {
  orgId: string;
  userId?: string;
  agentId?: string;
  selection: ModelSelection;
  request: Omit<CompletionRequest, "modelId" | "requestId">;
  requestId?: string;
  scopePolicy?: ScopePolicy;
}

export interface GatewayDispatchResult {
  text: string;
  usage: CompletionResult["usage"];
  modelId: string;
  providerId: string;
  providerRequestId?: string;
  /** True when the served model is deprecated (still works, flagged). */
  deprecated?: boolean;
}

export class ModelGateway {
  constructor(private readonly opts: ModelGatewayOptions) {}

  async dispatch(input: GatewayDispatchInput): Promise<GatewayDispatchResult> {
    const startedAt = Date.now();
    const { providerId, modelId } = input.selection;
    const requestId = input.requestId ?? crypto.randomUUID();

    // 1. Registry: alias resolution + availability/region checks.
    const entry = this.opts.registry.resolveSelection(providerId, modelId);
    if (!entry) return await this.fail(input, requestId, startedAt, `model not found: ${providerId}/${modelId}`);
    const deprecated = this.opts.registry.isDeprecated(entry);
    const dispatchable = this.opts.registry.checkDispatchable(entry, { region: this.opts.region });
    if (!dispatchable.ok) {
      return await this.fail(input, requestId, startedAt, dispatchable.reason ?? "model not dispatchable");
    }

    // 2. Entitlement/policy.
    const entitle = await this.opts.entitlements.check({ orgId: input.orgId, providerId, modelId });
    if (!entitle.allowed) return await this.fail(input, requestId, startedAt, entitle.reason ?? "not entitled for this model");

    // 3. Credential resolution — explicit, deterministic, no silent widening.
    const binding = this.opts.adapters.get(providerId);
    if (!binding) return await this.fail(input, requestId, startedAt, `no adapter bound for provider ${providerId}`);

    let resolvedKey: { scope: CredentialScopeLevel; apiKey: string } | undefined;
    for (const scope of SCOPE_ORDER) {
      const ref = binding.credentialRefs[scope];
      const allowed = input.scopePolicy?.allowedScopes.includes(scope) ?? true;
      if (!ref || !allowed) continue;
      const apiKey = await this.opts.credentials.resolve(scope, ref);
      if (apiKey !== null) {
        resolvedKey = { scope, apiKey };
        break;
      }
    }
    if (!resolvedKey) {
      return await this.fail(
        input,
        requestId,
        startedAt,
        input.scopePolicy?.forbidBroaderFallback
          ? `no agent-scope credential and broader fallback is forbidden (${input.scopePolicy.allowedScopes.join(", ")})`
          : `no usable credentials within allowed scopes (${(input.scopePolicy?.allowedScopes ?? SCOPE_ORDER).join(", ")})`,
      );
    }

    // 4. Dispatch through the provider adapter with usage metering.
    const adapter = binding.create(async () => resolvedKey.apiKey);
    try {
      const result = await adapter.complete({ ...input.request, modelId, requestId });
      await this.meterUsage(input, requestId, startedAt, {
        success: true,
        tokens: result.usage,
        deprecated,
        resolvedScope: resolvedKey.scope,
      });
      return {
        text: result.text,
        usage: result.usage,
        modelId,
        providerId,
        providerRequestId: result.providerRequestId,
        ...(deprecated ? { deprecated: true } : {}),
      };
    } catch (error) {
      // Contain provider failures; strip any secret-shaped material first.
      const message = safeMessage(error);
      await this.meterUsage(input, requestId, startedAt, {
        success: false,
        error: message,
        deprecated,
        resolvedScope: resolvedKey.scope,
      });
      if (error instanceof ProviderUnavailableError) throw error;
      throw new ProviderUnavailableError(input.selection.providerId, {
        state: "unavailable",
        reason: message,
        checkedAt: new Date().toISOString(),
      });
    }
  }

  private async fail(
    input: GatewayDispatchInput,
    requestId: string,
    startedAt: number,
    reason: string,
  ): Promise<never> {
    await this.meterUsage(input, requestId, startedAt, { success: false, error: reason });
    throw new Error(reason);
  }

  private async meterUsage(
    input: GatewayDispatchInput,
    requestId: string,
    startedAt: number,
    facts: {
      success: boolean;
      tokens?: CompletionResult["usage"];
      error?: string;
      deprecated?: boolean;
      resolvedScope?: CredentialScopeLevel;
    },
  ): Promise<void> {
    await this.opts.meter.record({
      usageId: `u_${requestId}` as UsageEvent["usageId"],
      orgId: input.orgId as never,
      agentId: input.agentId,
      metric: facts.success ? "tokens-in" : "requests",
      quantity: facts.success ? (facts.tokens?.inputTokens ?? 0) : 1,
      at: new Date().toISOString(),
      extension: redact({
        kind: "model.invocation",
        requestId,
        providerId: input.selection.providerId,
        modelId: input.selection.modelId,
        userId: input.userId,
        latencyMs: Date.now() - startedAt,
        outputTokens: facts.tokens?.outputTokens,
        cacheReadTokens: facts.tokens?.cacheReadTokens,
        resolvedCredentialScope: facts.resolvedScope,
        deprecatedModel: facts.deprecated === true ? true : undefined,
        success: facts.success,
        error: facts.error,
      }) as never,
    });
  }
}

function safeMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  // Defense-in-depth: strip anything that looks like a bearer key.
  const scrubbed = redact({ message: raw }) as { message?: unknown };
  return String(scrubbed.message ?? raw);
}
