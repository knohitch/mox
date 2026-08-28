# 03 — CUSTOMER COMMERCIAL, CONNECTIONS AND DEVELOPER PARITY

## Objective

Surface the customer capabilities that already exist in billing, credentials, model connections, integrations, channels, personal tokens and CLI—but do so through safe customer-specific APIs.

---

# A. CUSTOMER BILLING SELF-SERVICE

Existing customer billing authority historically includes:
- provider catalog
- checkout
- cancel
- reconcile
- subscription
- invoices
- entitlements

Build a complete Billing experience.

Required:

## Current subscription
Show:
- plan/product display name
- lifecycle state
- current period end
- cancellation status
- commercial-access status
- suspension/grace information where customer-safe

## Plans / pricing
Create a **customer-safe catalog projection**.

Do not reuse raw Admin plan APIs.

It may include:
- plan display name
- feature/entitlement summary
- current customer price
- currency
- billing interval
- plan version identifier needed for checkout
- availability

Must not expose:
- wholesale cost
- margin
- internal FX implementation metadata
- internal provider IDs unnecessary to checkout

## Checkout
Use the existing Mox-owned checkout authority:
- price server-side;
- region server-side;
- no client amount authority.

## Cancel
Expose cancellation with clear lifecycle consequences.

## Reconcile
Use reconciliation only as a safe recovery action/status path, not as routine fake success.

---

# B. CUSTOMER BYOK / MODEL CONNECTIONS

Mox database/credential design already distinguishes:
- customer credential refs/secrets
- Mox system credential refs/secrets
- model providers/connections
- auth methods such as API key, OAuth, device login

Build secure customer provider connection management.

Required UX:
- Add provider connection
- auth method selection supported by provider
- save secret to customer credential vault
- never return full secret after save
- masked/configured metadata
- connection status
- test connection
- rotate/update
- disconnect/delete
- provider models
- choose model for agent

Server/API requirements:
- customer org scoped;
- no system credential table access;
- no plaintext secret persistence outside the credential authority;
- test endpoint must perform a real safe provider probe or honestly report unsupported setup;
- provider unavailable/config missing must not report success.

Do not implement a generic secret textbox that bypasses `@mox/credentials`.

---

# C. INTEGRATIONS / APPS

The integration gateway already contains provider-neutral concepts for:
- MCP
- Composio
- OAuth/API
- Make
- n8n
- generic webhook/token

Do not expose a simplistic toggle if a real provider requires credentials/runtime binding.

Build provider-aware connection UX.

At minimum:
- integration/provider catalog
- connection state
- connect/setup
- disconnect
- configuration appropriate to provider kind
- safe credential references
- tool catalogue exposed by the connection
- explicit grant/revoke of tools to an agent and/or user
- visible approval/danger metadata where useful

Execution must remain capability-honest.

If a provider implementation says execution requires a bound runtime session, either:
- wire the real session; or
- show the exact blocker.

Never mark it fully connected merely because a row exists.

---

# D. CHANNELS

Mox channel architecture already supports several provider kinds.

Build customer channel management around actual channel connection schema/adapter behavior.

Required:
- channel provider catalog
- connect/configure
- credential setup using customer vault
- bind to one or more permitted agent flows according to the canonical model
- status
- disconnect
- test/health when technically valid
- webhook/setup instructions when needed
- provider-specific prerequisites

Cover supported kinds found in code, such as:
- Web
- WhatsApp
- Telegram
- Slack
- Discord
- Microsoft Teams
- generic webhook

Do not expose webhook signing secrets after save.

---

# E. PERSONAL API TOKENS

The server and `HttpMoxApi` already have personal-token methods.

Promote them into the typed `MoxApi` customer contract if still omitted.

Add a Settings -> Developer/API Tokens experience:

- list token metadata
- create
- name
- scope selection
- expiry display
- one-time plaintext reveal
- clear warning that it cannot be viewed again
- last used
- revoke

Do not store the plaintext token in browser persistent storage.

---

# F. CLI CONTRACT

Audit `apps/cli`.

Historically CLI commands called `/v1/...` while current Control Plane used `/api/...`.

Do not leave a dead developer tool.

Choose one deliberate architecture:
1. implement a supported versioned `/v1` public API adapter; or
2. align CLI to the supported public/customer API.

Whichever you choose:
- preserve server-side scope/entitlement/role checks;
- do not route CLI through Admin APIs;
- agent CRUD/deploy/log/terminal commands must be capability-honest;
- commands unavailable in production must clearly say why.

Add web Settings documentation/snippet for obtaining an API token and using the CLI if CLI is production-supported.

---

# G. MODELS PAGE

The customer Models page should become a real control surface:
- providers
- connection state
- available models
- BYOK status
- real test status
- configuration entry point
- unavailable reason
- agent usage context if useful

Remove active controls that are guaranteed 501.

---

# H. TESTS

Add coverage for:
- customer-safe plan catalog;
- checkout authority;
- cancel/reconcile role checks;
- customer secret isolation;
- BYOK create/test/rotate/delete;
- no system-secret leakage;
- integration provider onboarding;
- tool grants/revoke;
- channel binding tenant isolation;
- personal token one-time secret semantics;
- CLI/API contract;
- no Admin capability crossover.

---

# REPORT

Create:

`docs/verification/UI_PARITY_03_COMMERCIAL_CONNECTIONS_DEV.md`

Local commit after green verification:

`feat(ui-parity): surface billing connections and developer workflows`
