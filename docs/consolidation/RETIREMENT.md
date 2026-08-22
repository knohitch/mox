# Upstream Retirement Record (Prompt 15)

Status: **Complete.** The three imported trees no longer define production
architecture. This document records the disposition of each donor tree and
the evidence that Mox production code stands alone.

## Disposition

| Vendored tree | Role during consolidation | Final disposition |
|---|---|---|
| `OpenBot-main/` | Control-plane / computer / security donor | Retired as production path. Concepts adapted into `services/*`, `packages/security`, `packages/database`, `apps/web`. Tree kept as a gitignored reference snapshot only. |
| `OpenMausBot-main/` | GrokBot UX / provider / voice / device donor | Retired as production path. Structural mirrors + voice/device abstractions re-hosted (`packages/adapters`, `packages/voice-device`). |
| `deepseek-harness-master/` | Runtime kernel donor | Retired as production path. Kernel consolidated into `runtime/agent-runtime`; DSH model seam retained as the model-provider seam. |

## Why the trees are archived rather than deleted

Architecture Rule 7 (preserve until Prompt 15) plus license hygiene: the
trees remain on disk as clearly non-production vendor reference snapshots —
excluded from git (`.gitignore`), from builds (`tsconfig`/workspaces never
reference them), from tests (vitest excludes) and from any deployment entry
point. Their licenses/notices are preserved in `third_party/licenses/` +
`third_party/notices/NOTICES.md`; adapted components are inventoried in
`third_party/provenance/PROVENANCE_ADAPTATIONS.md`.

## Duplicate-authority elimination

Final authorities (one per concern):

| Concern | Single authority |
|---|---|
| Agent loop | `runtime/agent-runtime` |
| Credentials | `packages/credentials` vault (+ refs only in DB) |
| Sessions/threads | runtime persistence schema (org-scoped) |
| Model registry/routing | `packages/model-gateway` |
| Approvals/policy | `packages/policy` + computer gateway |
| Computer/browser | `runtime/computer-runtime` |
| Billing | `services/billing` |
| Entitlements | `packages/entitlements` |
| Deployment desired state | `services/compute-orchestrator` + `services/agent-control` |
| Channel identity | `services/channel-gateway` mapping tables |

## Evidence

- `node scripts/authority-scan.mjs` exits 0: zero imports/requires from the
  vendored trees anywhere under `apps/services/runtime/packages/infra`.
  The only textual mentions in Mox code are documentation comments inside
  `packages/adapters/src/*` explicitly stating "no import from <tree>".
- Vitest excludes vendored trees; tsconfig workspaces never include them.
- Full gates green at retirement: typecheck ✓ · lint ✓ · 53 test files /
  368+ tests ✓.
