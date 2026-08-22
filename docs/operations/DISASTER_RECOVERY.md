# Mox Disaster Recovery Runbook (Prompt 14)

Status: exercised in test form by `services/billing/tests/chaos.test.ts`,
`services/compute-orchestrator/tests/chaos.test.ts`, and
`packages/backups/tests/backups.test.ts`. Staging drills should follow this
document quarterly.

## RTO / RPO targets

| System | RPO | RPO | Notes |
|---|---|---|---|
| PostgreSQL (control plane) | 15 min | 1 h | WAL archiving + nightly base backup |
| Object storage (backups) | — | — | Mox-owned bucket, versioned, outside customer VPSes |
| Redis (queues/cache) | loss accepted | 0 | Queues are rebuildable; durable state lives in Postgres |
| Customer VPS data | per contract | n/a | Customers own their servers; snapshots per plan entitlement |

## Recovery procedures

### 1. PostgreSQL restore
1. Stop writers (or fail over to replica).
2. Restore latest base backup; replay WAL to the last consistent point.
3. Run `pnpm --filter @mox/database run db:migrate` to confirm schema head
   matches migration journal.
4. Smoke-verify: `GET /v1/whoami` with a service token; one billing lookup;
   one compute order read.

**Tested assumption:** migrations apply from a clean database in order
(`0000` → head). Verified in CI via drizzle-kit generation + journal checks.

### 2. Object storage restore
Backups are content-addressed by `backupId` under `backups/<orgId>/`.
Restore = rehydrate bucket from secondary region replication, then run the
restore-test flow (`BackupService.runRestoreTest`) over recent artifacts.

**Invariant:** no customer VPS holds the only copy of any backup.

### 3. Server metadata recovery
Server orders/desired state live in Postgres (`server_orders`). After a DB
restore, reconciliation (`ComputeOrchestrator.reconcile`) converges records
with provider reality: missing instances surface as errors; running
instances keep serving. Provider-side lifecycle is authoritative for
existence; Mox is authoritative for ownership.

### 4. Secret/key recovery assumptions
- Vault keys are held in KMS/HSM-backed storage OUTSIDE database backups.
- Losing vault keys means losing secrets (API keys must be re-entered);
  it does NOT corrupt subscription/entitlement state.
- Node enroll tokens are one-time and can be re-issued per server.

### 5. Queue loss assumptions
Redis queues may be flushed without corruption:
- Compute operations: `server_operations` rows are the source of truth;
  workers re-scan `dueOperations` after restart.
- Billing renewals: driven by period timestamps, not queue contents.
- Notifications: at-most-once dispatch is acceptable; in-app notifications
  persist in Postgres.

Chaos coverage: duplicate workers/ticks produce ≤1 side effect
(`chaos.test.ts`).

### 6. Rebuild customer node from desired state
If a customer's Mox Node is lost/reinstalled:
1. Re-issue enrollment token for the server order.
2. Re-run cloud-init bootstrap (same user-data builder).
3. Node enrolls with the SAME org/order binding; heartbeats resume.
Control-plane enforcement never depended on the node.

### 7. Restore agent/session history
Agent definitions/versions/deployments are rows in Postgres. Restoring the
DB restores authoring history; deployments reconcile by re-running
`AgentControlService.reconcile()` which pushes pinned versions to nodes.

## Chaos drill matrix (staging)

| Scenario | Expected outcome | Test |
|---|---|---|
| Webhook delivered 5× concurrently | 1 subscription, 1 transition | `billing/chaos` |
| Renewal sweep raced by 2 workers | 1 invoice paid | `billing/chaos` |
| Provider timeout after successful order | exactly 1 VPS exists | `compute/chaos` |
| Total provider outage | order → error, nothing bought | `compute/chaos` |
| Duplicate reconcile workers | ≤1 provision call | `compute/chaos` |
| Cancel during outage | retention once, idempotent | `compute/chaos` |
| Node offline during enforcement | provider-side suspend works | `platform-ops` |
| Webhook replay post-application | no-op duplicate | `security-hardening` |

## Escalation

1. Declare incident (`PlatformOpsService.openIncident`) with kind + scope.
2. Page on-call via notification service critical route defaults
   (in-app + email + push).
3. Post updates through incident lifecycle; resolve only after verification
   gates pass (typecheck/test/build + smoke).
