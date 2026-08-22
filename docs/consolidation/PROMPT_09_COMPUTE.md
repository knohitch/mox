# Prompt 09 — Compute Orchestrator, Contabo, Hetzner and Mox Node

## What was built

- `packages/compute-providers`
  - `ComputeProvider` interface with capability flags (13 operations); Mox
    business logic never assumes an operation exists.
  - **Contabo adapter**: real API client against api.contabo.com — OAuth2
    client-credentials with cached tokens, `X-Request-Id` idempotency headers,
    429/5xx retry with Retry-After backoff, ~1 rps throttle option, base64
    cloud-init user-data, instance lifecycle (start/stop/reboot/resize/
    reinstall/cancel), reverse DNS, health. Injectable fetch for tests.
  - **Hetzner adapter**: complete against api.hetzner.cloud/v1 but
    commercially gated (`commercial_status = verify|approved`); production
    routing requires admin approval.
  - `FakeComputeProvider` for destructive-path tests; unconfigured providers
    report honest blockers (no invented credentials).
- `services/compute-orchestrator`
  - Server orders as desired state; `(org, idempotencyKey)` dedupe makes
    double-click ordering buy exactly one VPS.
  - Durable operation records with attempt counters and exponential backoff;
    reconcile loop processes due ops; non-retryable failures abandon to
    terminal `error` state.
  - Admin-configured compute classes (COMPUTE_SMALL/MEDIUM/LARGE + custom)
    map to provider SKUs; never hard-coded per plan.
  - Multi-provider accounts with blast-radius separation, health scoring and
    commercial gates.
  - Cancellation runs through the provider API so destruction works even when
    Mox Node is offline; retention window then destroys remaining refs.
  - Node enrollment (one-time token → rotating agent token), heartbeats,
    lost-node sweep. All node data is advisory/untrusted.
  - Cloud-init builder installs Docker + Mox Node; no root credentials in
    user-data, orders or logs.
- `runtime/mox-node`: outbound-only agent — enrollment exchange, heartbeat
  reporter, HMAC-signed command channel with replay protection (staleness +
  single-use nonces), Docker workload manager (apply/replace/stop/logs) via an
  injectable executor seam, backup/update command execution.
- DB schema `packages/database/src/schema/compute.ts` (+ migration 0003):
  compute_classes, provider_accounts, ssh_keys, server_orders, server_operations,
  mox_nodes, node_commands.

## Tests

21 new tests: double-click dedupe, worker retry w/ backoff, late provider
success convergence, terminal failure abandonment, resize, provider-side
cancel→retention→destroy, enrollment token mismatch rejection, heartbeat loss
and recovery, commercial gate refusal then approved selection, root credential
redaction, provider health reporting, Contabo auth/header/retry/provision
mapping, Hetzner gating/state mapping, signed-command verification (tamper/
stale/replay), Docker workload application and error honesty, node agent loop.
