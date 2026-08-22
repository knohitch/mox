# Prompt 09 — Compute Orchestrator, Contabo, Hetzner interface and Mox Node

**Recommended Codex reasoning: Ultra**

Continue from Prompt 08.

## Goal

Build Mox's dedicated-VPS provisioning/reseller layer. Every paid workspace receives a dedicated VPS according to entitlement. Customers receive root/SSH access. Agents run on the customer's VPS, while Mox Control Plane remains authoritative.

## Provider abstraction

Implement `ComputeProvider` with capabilities including:

- list products;
- list regions;
- provision;
- get instance;
- start;
- stop;
- reboot;
- resize/upgrade;
- reinstall;
- cancel;
- snapshots;
- reverse DNS/PTR where supported;
- provider health;
- operation status.

Use capability flags when a provider lacks an operation.

## Compute classes

Plans reference:
- `COMPUTE_SMALL`
- `COMPUTE_MEDIUM`
- `COMPUTE_LARGE`
- custom enterprise classes

A compute class maps to provider SKUs via admin configuration.
Never hard-code Plus→specific Contabo SKU.

Recommended initial minimum targets:
- Small: >=2 vCPU / 4 GB RAM
- Medium: >=4 vCPU / 8 GB RAM
- Large: >=6–8 vCPU / 16 GB RAM

Treat these as configurable class requirements, not universal provider promises.

## Contabo

Implement the first real provider adapter:
- authenticated API client;
- product/region mapping;
- provisioning;
- cloud-init/user-data;
- instance lifecycle;
- upgrade discovery/request where API supports;
- cancellation;
- reverse DNS if supported;
- provider request ids;
- retries/backoff;
- idempotent operation mapping;
- rate-limit/error normalization.

Do not expose wholesale provider costs to customers.

## Hetzner

Implement provider adapter/interface to the extent technically possible, but gate production enablement with:
- `commercial_status = VERIFY/APPROVED`
or equivalent admin setting.

No automatic production selection until approved.

## Desired-state orchestrator

`services/compute-orchestrator` owns:
- server order;
- desired state;
- provider operation;
- reconciliation;
- provider resource id;
- operation id/idempotency;
- retries;
- terminal failure;
- cancellation/retention.

HTTP requests return provisioning state; they do not wait for provider completion.

Use durable jobs.

## Mox Node

Create `runtime/mox-node`.

Mox Node runs on customer VPS and:
- installs via cloud-init for Mox-provisioned servers;
- enrolls securely with Control Plane;
- maintains outbound authenticated connection when practical;
- reports heartbeat/metrics;
- manages Docker agent/computer workloads;
- streams logs/status;
- verifies signed commands;
- reports version/capabilities;
- executes deployment/restart/update/backup operations.

The customer has root and may disable/modify Mox Node. Therefore:
- Mox Node is untrusted for billing/entitlements/ownership;
- Control Plane can still manage provider-side VPS lifecycle independently.

## SSH/root

Provisioning must securely establish:
- initial SSH key or root credential delivery;
- customer SSH key management;
- optional password reset/rotation through supported flows;
- no root credentials in normal logs.

Support "bring your own server" enrollment contract if feasible:
- install command/token;
- SSH bootstrap option;
- no entitlement bypass.

## Provider accounts

Design for multiple provider accounts:
- region/account capacity;
- account health;
- blast radius;
- credential rotation.

## Tests

Use provider fakes for destructive paths plus real adapter unit tests:
- double-click provisioning does not buy two VPSs;
- worker retry;
- provider timeout;
- provider returns success after local timeout;
- node enrollment;
- node lost heartbeat;
- customer modifies node;
- resize;
- cancellation/retention;
- root credential redaction.

## Acceptance criteria

- Dedicated VPS provisioning is a Mox-owned desired-state workflow.
- Contabo adapter is real/configurable.
- Hetzner is pluggable and commercially gated.
- Mox Node can manage workloads but cannot grant itself entitlements.
- customers can obtain root/SSH safely.
