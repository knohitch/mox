# Prompt 07 — Model Gateway, credential vault and provider system

**Recommended Codex reasoning: Ultra**

Continue from Prompt 06.

## Goal

Build the complete Mox model layer so agents use one gateway regardless of provider, user BYOK scope or approved CLI/subscription engine.

## Architecture

```text
Agent Runtime
→ Mox Model Gateway
→ entitlement/policy
→ credential resolution
→ usage meter
→ provider adapter
→ model
```

DSH LLM seam is the runtime-facing model abstraction.

## Credential scopes

Support:
- Mox/system managed;
- organization;
- user;
- agent.

Resolution must be explicit and deterministic. Never silently fall back to a broader secret scope if policy forbids it.

## API provider adapters

Implement production-quality adapters/configuration for:

- OpenAI
- Anthropic
- Google Gemini
- xAI/Grok
- DeepSeek
- Qwen/Alibaba Model Studio
- GLM/Z.ai API/MaaS
- Kimi
- Xiaomi MiMo
- NVIDIA model APIs/NIM endpoints
- OpenRouter
- generic OpenAI-compatible provider

Where official SDKs differ from OpenAI-compatible behavior, do not force every provider through a lossy adapter.

## Model registry

Store/configure:
- provider;
- model id;
- display name;
- capabilities;
- modalities;
- tool use;
- reasoning support/levels;
- context limits when known/configured;
- availability;
- deprecated status;
- cost metadata hooks;
- region restrictions where relevant.

Provider health/unavailability must degrade gracefully.

## CLI/subscription engines

Create a separate connector category for official coding/subscription CLIs:
- Codex;
- Claude Code;
- Gemini CLI;
- Grok CLI;
- additional engines only when terms/technical flows permit.

Requirements:
- never scrape browser cookies as a generic login system;
- support official device/login flows only;
- hosted Mox use must be feature-flagged by provider/commercial approval;
- distinguish `OFFICIAL`, `API_ONLY`, `EXPERIMENTAL`, `UNSUPPORTED`;
- a user must always be able to use the provider's API route independently.

## Mox AI

Add the provider abstraction for future Mox-included models:
- `mox-fast`
- `mox-agent`
- `mox-code`
- `mox-reasoning`
as aliases/configurable offerings.

Do not fake hosted inference if no backend is configured. Return unavailable/not-configured.

## Vault

Secrets:
- encrypted at rest;
- key rotation design;
- redact logs;
- never returned after creation except controlled reveal where absolutely necessary;
- per-scope access checks;
- audit create/update/delete/use events.

## Metering hooks

Every model invocation emits usage metadata:
- input tokens;
- output tokens;
- cache tokens if provider supports;
- model/provider;
- request id;
- tenant/user/agent;
- success/failure;
- latency;
- provider-reported cost if available.

## UI/API

Models page must support:
- connect provider;
- test connection;
- list models;
- choose defaults;
- per-agent model selection;
- BYOK vs Mox-managed label;
- official CLI connection state;
- capability/availability.

## Acceptance criteria

- Native runtime uses Mox Model Gateway.
- Provider adapters are pluggable.
- BYOK scopes work and are encrypted/audited.
- API providers listed above have real adapters/config or explicit unavailable blockers.
- subscription/CLI routes are clearly separated from API routes.
- provider failure does not crash unrelated providers.
