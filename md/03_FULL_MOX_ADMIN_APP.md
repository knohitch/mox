# Prompt 03 — Full Mox Admin application and platform configuration

**Reasoning: Extra High**

Run after Prompt 02.

## Goal

Build the complete protected browser-based Mox Admin application over the authoritative services.

No separate duplicate business logic backend.

## Security

- authenticated staff only
- no public admin signup
- server-side RBAC/capabilities
- privileged session controls
- audit all sensitive changes
- PAT `admin` scope never creates admin role
- customer BYOK secret values are not exposed to normal admins

## Admin sections

### Dashboard
- customers
- active subscriptions
- payment failures
- active servers
- server provisioning failures
- runtime/agent health
- provider incidents
- notifications
- abuse
- cost/margin summary

### Customers / organizations
- users
- memberships
- plans/subscriptions
- servers
- agents
- support notes
- controlled suspend/reactivate

### Plans / entitlements / pricing
- Plus
- Pro
- Max
- Enterprise
- plan versions
- entitlement values
- regional price books
- USD/GBP/NGN/GHS + extensible currencies
- fixed and FX-derived regional pricing
- addons

### Payment providers
Configure:
- Paystack
- Flutterwave
- Stripe
- PayPal

Fields/capabilities:
- enable/disable
- test/live
- safe public ids
- vault secret refs
- webhook setup/status
- supported currencies
- supported regions
- reconciliation status
- health
- maintenance mode

Never render full secrets after save.

### Compute
- Contabo
- Hetzner
- provider accounts
- commercial approval state
- compute classes
- SKU mapping
- regions
- health
- capacity
- orders
- lifecycle/resize/cancel

### Models / Intelligence
System-managed provider configuration for:
- OpenAI
- Anthropic
- Gemini
- xAI/Grok
- DeepSeek API/provider
- Qwen
- GLM
- Kimi
- MiMo
- NVIDIA
- OpenRouter
- OpenAI-compatible

Admin may configure:
- default model
- fallback model
- feature-specific model
- internal intelligence layer
- availability
- quotas/cost metadata
- system/provider credentials

Credential rules:
- Mox Vault only
- write-only secret inputs
- fingerprint/configured state only
- rotate/revoke
- audit
- no secret in URL/log/analytics

Customer BYOK remains isolated.

### Agents / runtime
- inventory
- deployment state
- runtime version
- server placement
- failures
- restart/redeploy where authorized

### Notifications
- compose
- target
- schedule
- cancel
- stats

### Operations
- jobs/queues
- incidents
- backups
- abuse
- audit
- cost/margin
- feature flags
- provider health

## Branding

Everything is Mox.

No donor-project names.

Generic AI configuration uses "Models" / "Intelligence", not generic "GPT".

Actual provider/model names may appear in provider/model sections.

## Acceptance criteria

- real protected admin app exists
- admin calls authoritative APIs/services
- payment providers configurable
- compute providers configurable
- plans/prices/entitlements configurable
- Mox-owned model/API credentials configurable
- notification composer exists
- secrets protected
- privileged actions RBAC-protected and audited
