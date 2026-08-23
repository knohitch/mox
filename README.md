# Mox

**Mox** is a hosted AI-agent cloud + VPS reseller/control plane + multi-model
agent runtime: one TypeScript monorepo where customers buy dedicated VPS
nodes, run AI agents on them through a single canonical `AgentDefinition`,
and operate everything — billing, compute, channels, integrations,
notifications, usage, costs and security — from Mox-owned services.

## Repository layout

```
apps/       web (React+Vite), cli (mox CLI)
services/   billing · compute-orchestrator · agent-control · channel-gateway
            integration-gateway · notification-service · usage-meter
            cost-engine · platform-ops · admin · audit-service
runtime/    agent-runtime (Mox Runtime) · computer-runtime · mox-node
packages/   contracts · database · money · entitlements · feature-flags
            provider-health · compute-providers · backups · voice-device
            credentials · policy · security · observability · events …
docs/       architecture · operations · security · verification · consolidation
third_party/ licenses · notices · provenance (private legal attribution)
md/         the original build-pack prompts (00–15)
```

## Getting started

```bash
pnpm install
pnpm test        # full unit/integration suite (368+ tests)
pnpm typecheck
pnpm lint
pnpm build
pnpm public-branding-scan          # public product-name guard
node scripts/authority-scan.mjs    # vendored-tree import guard
```

Database migrations live in `packages/database/migrations`
(`pnpm --filter @mox/database run db:migrate`).

## Documentation

| Topic | Document |
|---|---|
| System architecture | [docs/architecture/SYSTEM_OVERVIEW.md](docs/architecture/SYSTEM_OVERVIEW.md) |
| Verification matrix | [docs/verification/FULL_SYSTEM_MATRIX.md](docs/verification/FULL_SYSTEM_MATRIX.md) |
| Security | [docs/security/THREAT_MODEL.md](docs/security/THREAT_MODEL.md) · [SECURITY_BOUNDARIES.md](docs/security/SECURITY_BOUNDARIES.md) |
| Operations | [docs/operations/RUNBOOK.md](docs/operations/RUNBOOK.md) · [DISASTER_RECOVERY.md](docs/operations/DISASTER_RECOVERY.md) |
| Provider onboarding | [docs/operations/PROVIDER_ONBOARDING.md](docs/operations/PROVIDER_ONBOARDING.md) |
| Releases | [docs/operations/RELEASE_CHECKLIST.md](docs/operations/RELEASE_CHECKLIST.md) |
| Legal attribution | [third_party/provenance/PROVENANCE_ADAPTATIONS.md](third_party/provenance/PROVENANCE_ADAPTATIONS.md) |

## Design rules (binding)

1. One authority per concern.
2. Provider code stays behind provider interfaces; missing capabilities
   report honestly (`UNAVAILABLE/REQUIRES_APPROVAL`) — never fake success.
3. Customer VPS nodes are untrusted; the Control Plane owns identity,
   billing, entitlements and desired state.
4. External side effects are idempotent and auditable.
5. Simple and Developer agent builders compile to the same `AgentDefinition`.

## Provenance

Mox preserves required third-party license, notice and adapted-component
records under `third_party/`. Those records are legal/provenance material
only; customer-facing surfaces use the Mox product and runtime identity.
