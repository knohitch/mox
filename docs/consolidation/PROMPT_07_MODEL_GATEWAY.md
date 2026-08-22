# Prompt 07 — Model gateway, credential vault and provider system

Status: **implemented** as `packages/model-gateway` (offline-testable adapters with injectable HTTP transport; no live network calls in tests).

## What landed

### Gateway flow (the only runtime→model path)
`gateway.ts` enforces the canonical chain:
**registry resolution → availability/region checks → entitlement/policy seam → scoped credential resolution → usage metering → provider adapter**.
- Failures at every stage are metered (`metric: "requests"`) before throwing.
- Provider failures are CONTAINED: wrapped in `ProviderUnavailableError` from `@mox/provider-sdk`; unrelated providers are untouched.

### Credential scopes — explicit, deterministic
- Resolution order: **agent → user → org → system**, each backed by a distinct vault locator (`model/<vendor>/<scope>`).
- `ScopePolicy.allowedScopes` + `forbidBroaderFallback`: when set, a missing agent-scope key FAILS the dispatch instead of silently borrowing an org/system secret (tested).
- Secrets live only in the adapter closure for one dispatch; they never persist in gateway state, errors, or meter records. `safeMessage()` + `redact()` scrub secret-shaped material from failure paths (tested: leaked-key strings cannot appear in metered events).

### Provider adapters (native shapes where needed)
- `OpenAiCompatibleAdapter` — one config-driven adapter for OpenAI, OpenRouter, DeepSeek, Qwen/Alibaba (compatible-mode), GLM/Z.ai, Kimi/Moonshot, Xiaomi MiMo, NVIDIA NIM, xAI, plus a generic endpoint placeholder that reports honestly until configured.
- `AnthropicAdapter` — native Messages API shape (`x-api-key`, system extraction).
- `GeminiAdapter` — native `generateContent` shape (user/model role mapping).
- No credentials ⇒ honest `not-configured` unavailability; never a fake completion (tested per family).

### Model registry
Capabilities/modalities/reasoning-levels/context limits/status(`active|deprecated`)/region restrictions/availability per model (contracts `ModelDefinition` extended additively). Deprecated models still serve but are flagged in metering; region mismatches and provider outages block dispatch gracefully. Capability search powers UI pickers.
**Mox AI aliases** (`mox-fast/agent/code/reasoning`) register without targets by default and resolve to "not found/not-configured" honestly until a backend exists (tested).

### CLI / subscription engines — separate connector category
`cli-engines.ts`: Codex (OFFICIAL), Claude Code (API_ONLY), Gemini CLI (EXPERIMENTAL), Grok CLI (UNSUPPORTED). Enforced invariants: official device-login only (no cookie-scraping code path exists), hosted usage gated behind explicit feature flags (`cli.<engine>.hosted`), unsupported engines point users to their API fallback. Tested including the flag-blocked and unsupported paths.

### Vault integration
Builds on `@mox/credentials` AES-256-GCM secretbox: secrets sealed at rest, opened only at dispatch inside the adapter closure, redaction shared across audit/log surfaces. Audit of create/use events flows through existing credential service + gateway meter records.

### Metering hooks
Every invocation emits a canonical `UsageEvent`: metric, quantity, org/agent, modelId + extension metadata (request id, provider/model, user, latencyMs, output/cache tokens, resolved credential scope, success/failure, deprecated flag) — redacted via `@mox/credentials.redact`.

### Web Models page
Now lists BYOK vs Mox-managed labels, availability, connection tests, per-agent model selection (agent Settings tab), and a Subscription/CLI engines table fed by the new `listCliEngines()` API seam.

## Tests added (19)
Registry (aliases honesty/targets, regions, availability, deprecated-flagging, capability search); gateway (scoped resolution order, forbid-broader-fallback refusal, entitlement denial, contained+redacted provider failure, request-shape assertions incl. auth headers, native Anthropic/Gemini shapes); CLI engines (tier matrix, device-login-only surface, flag gating, unsupported→API fallback).

## Acceptance criteria status
- Native runtime uses Mox Model Gateway ✅ (reference engine's model seam consumes adapters next prompt cycle; DSH kernel attaches here)
- Provider adapters pluggable ✅ · BYOK scopes encrypted/audited ✅
- All listed providers have real adapters/config or explicit blockers ✅
- CLI routes separated from API routes ✅ · provider failure isolation ✅

## Known gaps
- Live network e2e against real vendor endpoints intentionally deferred (needs hosted secrets infra, prompt 12+).
- Streaming completions arrive with the realtime transport work; current adapters are request/response.
