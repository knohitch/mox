# Repair Prompt 03 — Full Mox admin application and system provider configuration

**Reasoning: Extra High**

Run after Prompts 00–02.

## Goal
Build the real browser-based Mox admin application over authoritative services so normal business changes do not require source-code edits.

Do not build a second business-logic backend for admin. Admin UI calls secure admin APIs that delegate to existing authoritative Mox services.

## Admin security
- authenticated staff only
- no public admin signup
- capability-based RBAC
- privileged/MFA-ready sessions
- server-side authorization
- audit sensitive actions

## Required admin sections

### Dashboard
- customers/subscriptions
- active servers
- agent/runtime health
- billing failures
- provider incidents
- abuse cases
- margin/cost summary

### Customers / organizations
- users/memberships
- subscription/plan
- servers
- agents
- support notes
- authorized suspend/reactivate actions

### Plans / pricing
- Plus / Pro / Max / Enterprise
- plan versions
- entitlements
- regional price books
- USD/GBP/NGN/GHS plus extensible currencies
- fixed and FX-derived prices
- add-ons

### Payment providers
- Paystack
- Flutterwave
- Stripe
- PayPal
- enabled
- test/live
- safe public identifiers
- vault secret refs
- webhook health/status
- supported currencies/regions
- reconciliation status

### Compute
- Contabo
- Hetzner
- provider accounts
- commercial approval
- compute classes
- SKU mappings
- regions
- health/capacity
- server orders/lifecycle

### Models / Intelligence
Admins must be able to configure Mox-owned provider credentials separately from customer BYOK.

Support system configuration for:
- OpenAI
- Anthropic
- Gemini
- xAI/Grok
- DeepSeek provider/API
- Qwen
- GLM
- Kimi
- MiMo
- NVIDIA
- OpenRouter
- generic OpenAI-compatible

Allow:
- system/default provider
- fallback provider/model
- feature-specific model assignment
- internal extra-intelligence layer
- maintenance/availability
- quotas/cost metadata

Secrets:
- Mox Vault only
- never return plaintext after save
- test connection
- rotate/revoke
- audit changes/use

Customer BYOK must remain isolated from system credentials. Prefer metadata-only admin access to customer credentials.

### Agents / runtimes
- agent inventory
- deployments
- runtime versions
- server placement
- failures

### Notifications
- compose/send/schedule/broadcast
- delivery/read statistics

### Operations
- jobs/queues
- incidents
- backups
- abuse
- audit
- costs/margins
- feature flags

## Branding
Admin product is Mox.
No donor-project names.
Do not call generic intelligence “GPT”.
Actual provider/model names may appear in explicit provider/model configuration.

## Secret-handling UI
- write-only secret fields
- show configured/fingerprint/last-four only when safe
- never put secrets in URL/query string
- no browser logs/analytics containing secrets

## Acceptance criteria
- protected visual admin app exists;
- it calls authoritative services;
- plans/prices/entitlements are configurable;
- four payment providers are configurable;
- compute providers/classes are configurable;
- Mox-owned model/API credentials and internal intelligence routing are configurable;
- customer BYOK and system credentials are isolated;
- notification composer exists;
- privileged actions are RBAC-protected and audited.
