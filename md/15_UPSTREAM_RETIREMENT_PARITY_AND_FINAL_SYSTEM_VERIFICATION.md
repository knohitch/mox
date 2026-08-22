# Prompt 15 — Upstream retirement, parity and final system verification

**Recommended Codex reasoning: Ultra**

Continue only after Prompts 00–14 have met their acceptance criteria.

## Goal

Complete consolidation: Mox production code must no longer be three independent imported applications. Retire obsolete duplicate authorities only after parity is demonstrated.

## Required inventory

Re-run the classification of:
- `OpenBot-main/`
- `OpenMausBot-main/`
- `deepseek-harness-master/`

For every major subsystem, identify:
- Mox replacement path;
- tests proving parity;
- remaining direct imports/references;
- licensing/provenance requirements.

## Duplicate-authority scan

There must not be multiple production authorities for:
- agent loop;
- credentials;
- sessions;
- model registry/routing;
- approvals/policy;
- computer/browser;
- billing;
- entitlements;
- deployment desired state;
- channel identity.

Search the repository and eliminate obsolete production paths.

## Retire

When replacement is proven:
- remove OpenBot example/native runtime authorities that Mox Runtime replaced;
- remove OpenMaus harness/server authorities that duplicate Mox Runtime/Control Plane;
- remove DSH product UI/host/client paths that are not part of Mox runtime;
- remove obsolete local secret/session/settings authorities;
- remove duplicate legacy routes after compatibility window if no longer required.

Do not delete source code that is still required for licensed adapted code provenance unless its license/NOTICE is preserved under `third_party`.

## Third-party preservation

Create/finalize:
- `third_party/licenses/`
- `third_party/notices/`
- `third_party/provenance/`

Document code/components adapted from:
- OpenBot;
- OpenMausBot;
- DeepSeek Harness.

Preserve Apache NOTICE obligations.

## Final repository shape

Production entry points should now be Mox-owned under:
- `apps/`
- `services/`
- `runtime/`
- `packages/`

No production deployment should launch `OpenBot-main`, `OpenMausBot-main` or `deepseek-harness-master` as independent products.

If keeping a source snapshot is useful for provenance, move/archive it in a clearly non-production third-party/vendor reference area only after verifying licenses and build references.

## Full-system verification matrix

Create `docs/verification/FULL_SYSTEM_MATRIX.md`.

Verify end-to-end:

### Account/commercial
- signup;
- verified payment activation;
- Plus/Pro/Max/Enterprise entitlement;
- regional price;
- recurring renewal;
- failed renewal/grace/suspend;
- add-on;
- cancel/retention/delete.

### Compute
- provision dedicated VPS;
- root/SSH delivery;
- Mox Node enroll;
- deploy workload;
- resize;
- provider failure;
- cancellation;
- BYOVPS if implemented.

### Agents
- Simple builder;
- Developer builder;
- version/deploy/rollback;
- agent roster;
- chat;
- room;
- subagent/workflow/schedule;
- computer/browser;
- terminal.

### Models
- BYOK;
- system credential;
- multiple providers;
- provider unavailable;
- usage meter;
- official CLI connector state.

### Channels/integrations
- web;
- WhatsApp;
- Telegram;
- Slack;
- Discord;
- Teams;
- MCP;
- Composio;
- Make;
- n8n.

### Operations
- notification;
- audit;
- usage;
- cost/margin;
- backup/restore;
- abuse suspend;
- incident;
- provider health;
- feature flags.

### Security
- cross-tenant denial;
- policy denial;
- node impersonation denial;
- secret redaction;
- SSRF defense;
- webhook replay defense.

## Final quality gates

Run:
- full unit/integration suites;
- typecheck;
- lint;
- builds;
- database migrations from clean database;
- upgrade migrations from pre-consolidation supported baseline if applicable;
- container builds;
- smoke tests using provider fakes;
- staging-safe real provider smoke tests only when explicitly configured.

## Final documentation

Create:
- `README.md` for Mox;
- `docs/architecture/SYSTEM_OVERVIEW.md`;
- `docs/operations/RUNBOOK.md`;
- `docs/operations/PROVIDER_ONBOARDING.md`;
- `docs/operations/RELEASE_CHECKLIST.md`;
- `docs/security/SECURITY_BOUNDARIES.md`;
- `docs/verification/FULL_SYSTEM_MATRIX.md`.

## Final acceptance criteria

Mox is one coherent full system.

The old imported projects no longer define production architecture.

Every required feature has:
- a Mox-owned domain;
- a Mox-owned authoritative service;
- tested boundaries;
- documented operational ownership.

No “MVP-only”, “placeholder complete”, or “TODO means shipped” status is acceptable.
If any full-system item remains blocked by third-party commercial approval/credentials, the feature must exist behind a correct provider interface and report `UNAVAILABLE/REQUIRES_APPROVAL`, with the blocker documented explicitly.
