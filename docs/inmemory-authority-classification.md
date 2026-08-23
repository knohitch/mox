# InMemory store authority classification (Prompt 00 §B)

Repository-wide audit of every authoritative-looking `new InMemory*`
occurrence. Production composition (`services/control-plane/src/composition.ts`)
wires ONLY `Pg*` stores; none of the defaults below are reachable from it.

Classification legend:

- **TEST** — appears only under `tests/`; a test fixture, never production.
- **EPHEMERAL** — non-authoritative in-process cache/reference seam with a
  durable counterpart; safe as a default only because the composition root
  never relies on it.
- **REPLACED** — was a production bug; now has a durable implementation and
  is wired by the control plane.

| Location | Store | Class | Notes |
| --- | --- | --- | --- |
| packages/database/tests/* | SessionEventStore, ThreadStore, MessageStore, MemoryStore | TEST | Reference semantics suite for the PG translations. |
| runtime/agent-runtime/tests/* | InMemorySessionEventStore | TEST | Runtime kernel unit tests. |
| runtime/computer-runtime/tests/* | InMemoryContainerDriver | TEST | Container driver fake. |
| runtime/mox-node/tests/* | InMemoryNodeState | EPHEMERAL | Node-local identity cache; durable identity lives on the control plane (`mox_nodes.agent_token_hash`). |
| apps/cli/tests/* + src/main.ts | InMemoryTokenStore | EPHEMERAL | CLI credential cache; vault-backed store is the durable path. |
| services/billing/tests/* | InMemoryBillingStore | TEST (+ conformance harness) | Also used by the restart/idempotency suite to model the durable tier when PostgreSQL is absent. |
| services/billing/src/service.ts | default `InMemoryBillingStore` param | REPLACED | Production composes `PgBillingStore`; default exists for library ergonomics and fails loudly via config checks before serving traffic. |
| services/compute-orchestrator/tests/* | InMemoryOrchestratorStore | TEST | Same dual role as billing in the restart suite. |
| services/compute-orchestrator/src/service.ts | default `InMemoryOrchestratorStore` param | REPLACED | Production composes `PgOrchestratorStore`. |
| services/notification-service/tests/* | InMemoryNotificationStore | TEST | Restart suite models durability. |
| services/platform-ops/src/service.ts | InMemoryAbuseStore / InMemoryIncidentStore | EPHEMERAL | Ops telemetry seams; Prompt 02 finishes user/admin semantics over `platform_ops` tables. |
| services/admin/src/{service,enterprise}.ts | InMemoryAdminStore / InMemoryEnterpriseStore | EPHEMERAL | Admin read-model seams; entitlement truth moved to `PgEntitlementStore`. |
| services/agent-control/src/service.ts | default `InMemoryAgentControlStore` | REPLACED | `PgAgentControlStore` added (agents + immutable versions + deployment projections); wired by the control plane. |
| services/cost-engine/src/service.ts | default `InMemoryCostStore` | EPHEMERAL | Wholesale analytics over `cost_ledger_entries` land with the cost prompt. |
| services/integration-gateway/src/gateway.ts | default `InMemoryIntegrationStore` | EPHEMERAL | Connection truth lives in `integration_connections`; gateway state is routing cache. |
| services/channel-gateway/src/gateway.ts | default `InMemoryChannelStore` | EPHEMERAL | Connection truth lives in `channel_connections`; delivery state is ephemeral by design. |
| services/usage-meter/src/service.ts | default `InMemoryUsageStore` | EPHEMERAL | Aggregates from `usage_events`/`model_usage_refs`; raw events are durable. |
| packages/model-gateway/tests/* | InMemoryUsageMeter | TEST | |
| packages/realtime/tests/* | InMemoryRealtimeBus | EPHEMERAL | Bus fan-out is transport-level; event authority is `session_events` (PostgreSQL). |
| packages/feature-flags/src/index.ts | default `InMemoryFeatureFlagStore` | EPHEMERAL | Flag truth lives in `feature_flags` table via admin tooling. |
| packages/provider-health/src/index.ts | default `InMemoryProviderHealthStore` | EPHEMERAL | Health scoring window is advisory; commercial gates never depend on it. |
| packages/backups/src/service.ts | default `InMemoryBackupStore` | EPHEMERAL | Backup records are durable rows; this seam tracks in-flight jobs. |
| packages/entitlements/tests/* | InMemoryEntitlementStore | TEST | Durable authority is `PgEntitlementStore` (Prompt 00 §D4). |

Rules enforced going forward:

1. The production composition root must not construct any `InMemory*`
   authoritative store — enforced by review plus
   `pnpm run scan:authority`.
2. New service stores ship with BOTH an `InMemory*` reference
   implementation (tests) and a `Pg*` translation before they may serve an
   authenticated surface.
3. Defaults are allowed only as constructor ergonomics; every production
   entrypoint passes its dependency explicitly.
