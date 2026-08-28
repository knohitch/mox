# 01 — PRODUCT SURFACE INVENTORY AND PRODUCT-TRUTH REPAIR

## Objective

Create the authoritative inventory of Mox-owned capabilities and fix the cross-cutting truth/projection defects that can make existing features disappear or lie to the UI.

This phase is foundational. Do not start adding lots of UI before completing it.

---

# A. BUILD THE AUTHORITATIVE FEATURE INVENTORY

Scan at minimum:

- `apps/web/src`
- `apps/cli/src`
- `services/*/src`
- `packages/*/src`
- `packages/database/src/schema`
- `runtime/*/src`
- current Control Plane routes

For each meaningful product capability record:

- capability key/name
- owning package/service
- durable state/store
- HTTP endpoint(s), if any
- web API client method(s), if any
- current UI route/component, if any
- intended surface
- authorization requirement
- entitlement requirement
- implementation status
- blocker, if any

Create:

`docs/verification/UI_PARITY_FEATURE_INVENTORY.md`

Use a table. Do not omit backend-only capabilities.

---

# B. FIX CANONICAL ENTITLEMENT PARITY

Known defect to verify:

Canonical keys are defined by `packages/entitlements/src/index.ts`, including:

- included_compute_class
- included_server_count
- max_agents
- active_concurrent_agents
- agent_rooms
- agents_per_room
- browser_sessions
- cli_sessions
- developer_mode
- model_connections
- mox_ai_credits
- channel_connections
- integrations
- storage_gb
- backup_retention_days
- team_members
- voice_minutes
- schedule_workflow_limit

The current web layer historically collapsed these into ad-hoc booleans such as:

- computer
- terminal
- voice
- rooms
- customModels

Do not preserve that mismatch.

Implement one canonical frontend entitlement/value representation.

Requirements:

- web code consumes canonical entitlement keys;
- numeric values remain numeric;
- text values remain text;
- booleans remain booleans;
- commercial access denial remains distinct from an entitlement value;
- create small selectors/helpers for UX concepts if needed, e.g.:
  - browser capability derives from `browser_sessions`
  - terminal capability derives from `cli_sessions`
  - rooms derives from `agent_rooms`
  - model connection capability derives from `model_connections`
  - voice capability must account for `voice_minutes`, not invent `voice`
- UI can display quotas/limits where useful;
- no duplicate second entitlement authority.

Update all existing entitlement usage in the web app.

---

# C. FIX SERVER PRODUCT-TRUTH PROJECTION

Verify current customer server projection.

Known issues to eliminate if still present:

- all non-running states projected as `provisioning`;
- `agentsRunning` hardcoded to zero;
- `cpuPct` hardcoded to zero;
- `memPct` hardcoded to zero.

Requirements:

- preserve actual lifecycle state;
- telemetry that does not exist must be `null`, omitted, or explicitly unavailable;
- do not fabricate zero;
- compute class/region/display identity must come from authoritative data;
- customer response must still hide provider-secret/wholesale-only details;
- expose only safe provider-independent compute identity unless product policy intentionally exposes provider.

Update UI to render `unavailable` cleanly.

---

# D. FIX DEPLOYMENT PRODUCT-TRUTH PROJECTION

Known historical placeholder projection:

- every target represented as sandbox;
- every state represented as desired.

Replace placeholders with real durable/reconciled deployment information.

If the current schema lacks enough state:
- use the existing agent-control/runtime authority if available;
- add the minimum durable field/migration only when necessary;
- do not create a competing deployment state machine.

---

# E. FIX AGENT ROOM MEMBERSHIP PERSISTENCE

Known defect to verify:

- `room_members` exists;
- room create accepts `memberAgentIds`;
- list historically returned an empty array;
- create historically returned submitted IDs without persisting them.

Requirements:

- validate every member agent belongs to the same org;
- persist members transactionally;
- read actual members;
- no cross-org membership;
- support create and later member update if existing domain design permits;
- return durable truth after reload.

---

# F. MODEL AVAILABILITY TRUTH

Inspect current model-list projection.

Do not report every model `available: true` if provider/connection/health state says otherwise.

Create an honest safe availability projection using existing provider/connection/health authorities.

Do not expose:
- system credentials;
- provider secrets;
- internal routing/margin metadata.

---

# G. FEATURE AVAILABILITY CONTRACT

Create a small reusable product availability model for UI use, for example:

- `available`
- `not_configured`
- `not_entitled`
- `role_denied`
- `provider_unavailable`
- `coming_later` only when explicitly product-approved, never as a fake success path

Do not over-engineer it. Its purpose is to prevent active-looking buttons that are guaranteed to fail.

---

# H. TESTS

Add focused coverage for:

- canonical entitlement mapping;
- numeric entitlement preservation;
- server state projection;
- unavailable telemetry;
- real deployment projection;
- room member persistence;
- cross-org room-member rejection;
- model availability projection.

Run affected tests and typechecks.

---

# REPORT

Create:

`docs/verification/UI_PARITY_01_PRODUCT_TRUTH.md`

Include before/after defects and exact tests.

Local commit message after green verification:

`fix(ui-parity): establish canonical product truth`
