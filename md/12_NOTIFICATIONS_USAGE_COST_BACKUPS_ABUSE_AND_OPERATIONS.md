# Prompt 12 — Notifications, usage, cost, backups, abuse and operations

**Recommended Codex reasoning: Extra High**

Continue from Prompt 11.

## Goal

Build the operational systems required to run Mox as a serious commercial agent/VPS platform.

## Notification Service

Consume canonical platform events such as:
- server ordered/provisioned/failed;
- agent deployed/crashed;
- approval requested;
- subscription renewed/past due/suspended;
- backup completed/failed;
- abuse case opened;
- provider incident;
- team invite.

Routes:
- in-app;
- email;
- web push-ready;
- SMS-ready;
- WhatsApp-ready;
- webhook.

Use templates and user/org notification preferences.
Do not let every service send email independently.

## In-app notifications

Persist notifications and expose realtime unread updates.
Support:
- read/unread;
- severity/type;
- resource link;
- deduplication;
- expiration/archive.

## Usage Meter

Implement canonical usage ingestion/aggregation for:
- AI input/output/cache tokens;
- agent runs;
- browser minutes/concurrency;
- CLI sessions;
- storage;
- workflow/job runs;
- channel messages;
- voice minutes;
- API requests;
- compute nodes;
- backup storage.

Each event includes tenant/user/agent/server/provider dimensions as relevant.

Entitlement Service must support:
- included quantity;
- hard limit;
- soft limit;
- overage-ready pricing reference.

## Cost Engine

Separate internal costs from customer pricing.

Track:
- provider VPS cost;
- setup fees;
- storage;
- backups;
- IPv4 where applicable;
- AI cost;
- messaging cost;
- voice cost;
- payment fees where available;
- other infrastructure.

Calculate:
- MRR;
- estimated/actual COGS;
- gross profit;
- gross margin percentage;
by customer/plan/region/provider/time period.

Customer must never see wholesale provider cost unless intentionally exposed by admin.

## Backups

Create:
- `BackupProvider`;
- provider snapshot adapter;
- S3-compatible backup storage adapter.

Backups must live outside the customer VPS.

Support:
- scheduled backups;
- retention;
- restore test flow;
- cancellation retention export;
- status/audit.

## Abuse

Build abuse case management:
- provider account;
- server;
- customer;
- complaint source;
- evidence;
- deadline;
- actions;
- suspend server;
- customer response;
- resolve/reinstate;
- repeat-abuse flags;
- audit.

Mox must be able to emergency-suspend a server through provider API even if Mox Node is offline.

## Incidents

Add incident records/status for:
- provider outage;
- model outage;
- channel outage;
- Mox service incident.

## Acceptance criteria

- Notification routing is centralized.
- usage/cost are separate systems.
- admin can see margin by plan/customer/provider.
- backups survive VPS destruction.
- abuse workflow can identify and suspend offending VPS.
- operations are audited and idempotent.
