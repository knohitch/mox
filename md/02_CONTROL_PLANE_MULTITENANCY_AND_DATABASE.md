# Prompt 02 — Control plane, multi-tenancy and canonical database

**Recommended Codex reasoning: Ultra**

Continue from Prompt 01.

## Goal

Turn the OpenBot-derived server foundation into the authoritative Mox Control Plane and PostgreSQL domain, while preserving working OpenBot behavior behind compatibility adapters.

## Source to study deeply

- `OpenBot-main/server/src/auth/`
- `OpenBot-main/server/src/agents/`
- `OpenBot-main/server/src/channels/`
- `OpenBot-main/server/src/credentials.ts`
- `OpenBot-main/server/src/audit.ts`
- `OpenBot-main/server/src/db/`
- `OpenBot-main/server/src/plugins/`
- `OpenBot-main/server/src/knowledge/`
- `OpenBot-main/server/src/components/`
- current migrations/tests

## Required Mox database domains

Use PostgreSQL + Drizzle as authoritative durable state. Create a Mox-owned schema/package under `packages/database`.

At minimum cover:

### Identity
- users
- organizations/workspaces
- memberships
- roles/permissions
- auth sessions / external identities as required

### Agents
- agents
- agent versions
- deployments
- agent rooms
- room members
- skills
- agent-skill bindings
- knowledge sources

### Runtime/session metadata
- threads
- session event metadata
- runtime runs
- tool-call metadata
- approval requests
- jobs

### Models
- providers
- models
- model connections
- credential references
- model usage references

### Computer
- computers
- sessions
- policies
- actions

### Integrations/channels
- integration providers/connections
- tools
- grants
- channel providers/connections
- external conversations
- messages

### Operations
- notifications
- usage events
- cost events
- backups
- abuse cases
- incidents
- audit events
- feature flags

Billing/compute-specific tables may be introduced as shells here and fully implemented in later prompts.

## Multi-tenancy

Every tenant-owned durable object must have explicit organization/workspace scope.

Requirements:
- no accidental cross-tenant lookup paths;
- repository/service methods require tenant context;
- unique constraints include tenant scope where appropriate;
- authorization checks are server-side;
- admin/system scope is explicit, not implied by missing tenant id.

Add tests that attempt cross-tenant access.

## Credentials

Adapt OpenBot credential handling into a Mox-owned `packages/credentials` interface:
- system scope;
- organization scope;
- user scope;
- agent scope;
- encrypted at rest;
- no plaintext secret values in API responses/logs;
- metadata and secret material separated where practical.

Do not yet implement every external provider.

## Audit

Port/extend OpenBot audit into `services/audit-service` or equivalent Mox-owned boundary.
Audit events must support:
- actor;
- tenant;
- action;
- resource;
- decision/result;
- correlation/operation id;
- provider request id where relevant;
- before/after metadata without leaking secrets.

## Compatibility

Preserve existing OpenBot API behavior through adapters/routes where practical while new Mox services become authoritative.

## Redis rule

If Redis is introduced here:
- queues/cache/locks/rate limits only;
- no business-record source of truth.

## Supabase rule

If Supabase is used, it must be the managed Postgres/realtime layer or a transport service. Do not create a second competing Mox database.

## Acceptance criteria

- Canonical Mox database package exists.
- Organizations/workspaces and memberships are first-class.
- Cross-tenant tests pass.
- OpenBot-derived credentials/audit have Mox ownership.
- Migrations are deterministic.
- Existing OpenBot behavior is preserved or explicitly mapped.
- No billing/entitlement decision is trusted from customer nodes.
