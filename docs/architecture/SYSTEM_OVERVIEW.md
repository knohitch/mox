# Mox System Overview

Mox is a hosted AI-agent cloud + VPS reseller/control plane + multi-model
agent runtime, implemented as one coherent system with dedicated
legal/provenance records under `third_party/`.

## Architecture at a glance

| Layer | Components |
|---|---|
| Apps | `apps/web` (React+Vite), `apps/cli` (mox CLI) |
| Services | control-plane concerns split by ownership: `billing`, `compute-orchestrator`, `agent-control`, `channel-gateway`, `integration-gateway`, `notification-service`, `usage-meter`, `cost-engine`, `platform-ops`, `admin`, `audit-service` |
| Runtime | `runtime/agent-runtime` (Mox Runtime), `runtime/computer-runtime`, `runtime/mox-node` (customer VPS agent) |
| Packages | contracts, database, money, entitlements, feature-flags, provider-health, compute-providers, backups, voice-device, credentials, policy, security, observability, events, realtime, adapters |

## Core rules (binding)

1. One authority per concern — no parallel stores for sessions, billing,
   entitlements, deployments or policy.
2. Provider code stays behind provider interfaces.
3. Customer VPS nodes are untrusted; the Control Plane is authoritative.
4. External side effects are idempotent and auditable.
5. Simple and Developer modes compile to one `AgentDefinition`.
6. Web-first product; no desktop requirement.

## Data flow examples

- **Subscribe**: web checkout → billing session → verified gateway webhook →
  subscription ACTIVE → entitlement values resolved via
  `packages/entitlements` precedence (contract > override > plan).
- **Provision**: order (idempotencyKey) → durable op queue → health-ranked
  provider selection (approved only) → cloud-init bootstraps Mox Node →
  node enrolls/heartbeats → workloads deployed via signed commands.
- **Agent message**: channel webhook → adapter normalize → thread mapping →
  agent runtime turn → tool calls gated by grants/policy → adapter reply.

## Where to look

- Verification: `docs/verification/FULL_SYSTEM_MATRIX.md`
- Security: `docs/security/THREAT_MODEL.md`, `SECURITY_BOUNDARIES.md`
- Operations: `docs/operations/RUNBOOK.md`, `DISASTER_RECOVERY.md`,
  `PROVIDER_ONBOARDING.md`, `RELEASE_CHECKLIST.md`
- Provenance: `third_party/provenance/PROVENANCE_ADAPTATIONS.md`
