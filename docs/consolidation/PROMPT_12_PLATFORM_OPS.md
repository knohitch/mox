# Prompt 12 — Notifications, usage, cost, backups, abuse and operations

## What was built

- `services/notification-service`
  - Centralized routing: every service emits canonical `PlatformEvent`s; the
    notification service fans out over in_app / email / web_push / sms /
    whatsapp / webhook routes with severity defaults (info→in_app;
    critical→in_app+email+push) and per-event-type preference overrides +
    mutes. No service sends email independently.
  - Templates with `{{var}}` rendering per event type + locale.
  - In-app notifications persist with read/unread, severity/type, resource
    link, dedupe key collapse, expiration/archive; realtime unread-count
    subscriber callback for websockets.
  - Honest dispatch log: only messages actually sent are recorded.
- `services/usage-meter`
  - Canonical kinds for AI input/output/cache tokens, agent runs, browser
    minutes/concurrency, CLI sessions, storage, workflow/job runs, channel
    messages, voice minutes, API requests, compute node hours, backup
    storage — each carrying tenant/user/agent/server/provider dimensions.
  - Idempotent ingestion by caller event id; hourly bucket aggregation;
    period roll-ups scoped per tenant.
  - Entitlement limits: included quantity (-1 = unlimited), soft limit
    (warns + overage pricing reference), hard limit (blocks ingestion).
- `services/cost-engine`
  - Internal wholesale ledger (vps_cost, setup_fee, storage, backups, ipv4,
    ai_cost, messaging, voice, payment_fees, infra_other) strictly separated
    from customer revenue entries.
  - MRR from recurring revenue only; margin reports by org/plan/region/
    provider/time with explicit caller-supplied FX rates (never guessed).
    Integer minor-unit math throughout via @mox/money.
- `packages/backups`
  - `BackupProvider` seams: provider snapshot adapter (Contabo backup API)
    plus S3-compatible object storage adapter; bytes always land outside the
    customer VPS.
  - Scheduled-backup runner idempotent per idempotency key; restore-test
    flow verifies artifacts without touching live servers; retention sweep;
    cancellation retention export package survives workspace destruction.
- `services/platform-ops`
  - Abuse case management: complaint source, evidence chain, deadlines,
    customer responses, resolve/reinstate/dismiss actions, repeat-offender
    flagging at a configurable threshold.
  - Emergency suspension executes through the PROVIDER API — effective even
    when Mox Node is offline, disabled or modified by the customer.
  - Incident records for provider/model/channel/Mox-service outages with
    investigating→identified→monitoring→resolved lifecycle and update log.
- DB schema `schema/platform-ops.ts` (+ migration 0005): notification
  templates/preferences/dispatches, usage limits, cost ledger entries,
  incidents.

## Tests

25 new tests covering: route defaults/overrides/mutes, template rendering,
dedupe, unread realtime updates + read/archive/expiry, centralized dispatch
log, ingestion idempotency, all canonical usage kinds, hard-limit blocking,
soft-limit warnings with overage price refs, tenant isolation, MRR
computation, provider margin reporting incl. FX conversion, plan/org
groupings, cost-entry dedupe, missing-FX honesty, snapshot+S3 backups with
re-trigger safety, failure honesty, restore tests, retention sweep,
cancellation export surviving the VPS, emergency suspension while node is
offline, repeat offender flags, full abuse workflow, incident lifecycles for
all four outage kinds.
