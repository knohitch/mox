# Prompt 05 — Mox-only public branding and CI guard

**Reasoning: Extra High**

Run after major product work is complete.

## Goal

Guarantee that customer-facing surfaces expose Mox only while preserving private/legal third-party attribution.

## Scan

Search:
- apps/web
- apps/admin
- apps/cli
- public API errors
- runtime status/errors shown to users
- email templates
- notification templates
- computer/browser labels
- deployment UI
- customer-facing docs
- generated templates/examples

Forbidden public donor names:
- OpenBot
- OpenMausBot
- DeepSeek Harness
- DSH when it means donor runtime
- donor `*Bot` product identity

Use:
- Mox
- Mox Runtime
- Mox Computer
- Mox Browser
- Mox Agent
- Mox Models
- Mox Intelligence
- Mox Node

## Provider/model exceptions

Allowed where technically meaningful:
- OpenAI
- actual GPT model identifiers
- Claude/Anthropic
- Gemini
- Grok/xAI
- DeepSeek model/API provider
- Qwen
- GLM
- Kimi
- MiMo
- NVIDIA
- OpenRouter
- payment providers
- compute providers

"DeepSeek" as model provider is allowed.
"DeepSeek Harness" is not public product wording.

## GPT rule

Allowed:
- real model id/name
- OpenAI provider setup
- provider-specific help

Forbidden:
- generic “GPT agent”
- generic “GPT powered”
- generic “GPT settings”
- generic GPT wording in Home/Agents/Servers/Notifications

Use AI/model/intelligence/Mox wording.

## Legal attribution

Keep required:
- MIT licenses
- Apache NOTICE
- provenance

Restrict to:
- third_party/licenses
- third_party/notices
- third_party/provenance
- internal legal/provenance docs

## CI scanner

Add `public-branding-scan` to mandatory quality checks.

It must:
- scan public paths
- fail on forbidden donor names
- catch generic forbidden GPT usage where safely detectable
- allow actual provider/model names
- exclude third-party/legal/provenance data

## Acceptance criteria

- no donor branding in public surfaces
- Mox is the public product/runtime identity
- generic GPT wording removed
- actual providers/models remain correctly named
- attribution preserved
- CI blocks regressions
