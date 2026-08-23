# Repair Prompt 05 — Mox-only public branding, donor-name containment and CI guard

**Reasoning: Extra High**

Run after major functional repairs.

## Goal
Guarantee that customers see **Mox** as the product identity while preserving legally required third-party attribution privately.

## Scan public surfaces
Search:
- `apps/web`
- admin app
- `apps/cli`
- public API error strings
- runtime status/errors sent to UI
- email templates
- notification templates
- computer/browser labels
- deployment status
- public product docs/README if customer-facing
- generated templates/examples presented to users

Forbidden public donor branding:
- OpenBot
- OpenMausBot
- DeepSeek Harness
- DSH when referring to donor internals
- donor `*Bot` product identities

Replace contextually with:
- Mox
- Mox Runtime
- Mox Computer
- Mox Browser
- Mox Agent
- Mox Models / Mox Intelligence
- Mox Node

Do not blindly replace actual provider/model names.

## Provider/model exceptions
Allowed where technically necessary:
- OpenAI and actual GPT model identifiers
- Anthropic / Claude
- Gemini
- xAI/Grok
- DeepSeek model/API provider
- Qwen
- GLM
- Kimi
- MiMo
- NVIDIA
- OpenRouter
- payment providers
- compute providers

“DeepSeek” as an actual model/API provider is allowed.
“DeepSeek Harness” as internal donor/runtime identity is forbidden publicly.

## GPT wording rule
Search customer-facing strings for `GPT`.

Allowed:
- actual model id/name such as `gpt-*`
- OpenAI model/API setup
- provider-specific help

Forbidden:
- generic “GPT agent”
- generic “GPT-powered”
- “GPT settings” meaning all models
- Home/Agents/Servers/Notifications using GPT as synonym for AI

Use AI/model/intelligence/Mox Agent/Mox Runtime instead.

## Legal attribution
Do not remove required:
- licenses
- Apache NOTICE
- provenance

Restrict details to:
- `third_party/licenses`
- `third_party/notices`
- `third_party/provenance`
- private legal/provenance docs

If root/public README lists donor projects and is intended as product documentation, replace with a neutral third-party-notices pointer while preserving details in `third_party`.

## CI branding guard
Create a script/test such as `scripts/public-branding-scan.mjs`.

It must:
- scan customer/public production paths
- fail on forbidden donor strings
- catch generic forbidden GPT usage where safely detectable
- allow legitimate provider/model identifiers
- exclude legal/provenance/migration history as appropriate

Add to mandatory CI/quality scripts.

## Acceptance criteria
- donor project identities do not appear in customer-facing UI/API/CLI/templates;
- Mox is the public product/runtime identity;
- generic GPT wording is gone;
- legitimate provider/model names remain;
- legal attribution remains intact;
- CI blocks future branding regressions.
