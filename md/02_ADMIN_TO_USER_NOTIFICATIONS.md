# Prompt 02 — Admin-to-user notifications, durable inbox and realtime delivery

**Reasoning: Extra High**

Run after Prompt 01 payments completes.

## Goal

Finish notifications end-to-end so Mox admins can create/send/schedule/broadcast notifications and users have a secure durable notification inbox.

## Security first

All user notification operations must enforce:
- authenticated `userId`
- authenticated `orgId`
- ownership/audience
- server-side authorization

Required user operations:
- list notifications
- get notification
- mark read
- mark unread
- mark all read
- archive
- unread count

A user must never:
- read another user's private notification
- mark another user's notification read
- enumerate notifications across tenants
- see another user's unread count

Add IDOR and cross-tenant tests.

## Durable persistence

Use PostgreSQL only for production notification authority.

Schema/store must support:
- notification id
- org id
- user id where targeted
- audience type
- title
- body
- severity
- category
- action/resource reference
- readAt
- archivedAt
- createdBy
- scheduledAt
- expiresAt
- dedupe key
- delivery state
- created/updated timestamps

## Admin send/broadcast

Add admin APIs/service methods for:
- draft
- preview
- send now
- schedule
- cancel scheduled
- single user
- selected users
- org/workspace
- plan segment
- region segment
- all eligible users

All require:
- real Mox admin/staff capability
- not merely PAT `admin` scope
- audit event

Large broadcasts must use durable jobs and idempotent fan-out.

## User web UI

Add:
- header bell
- unread count
- realtime updates
- inbox page/panel

Filters:
- All
- Unread
- System
- Billing
- Servers
- Agents
- Security

Actions:
- read/unread
- mark all read
- archive
- action/resource navigation
- pagination/infinite loading

## Realtime

Persist first, then publish through Mox realtime abstraction.

Only intended users receive the event.

## Automatic platform events

Wire at least:
- subscription activated
- payment failed
- past due/grace/suspended
- server provisioning started/ready/failed
- node offline
- agent deployment success/failure
- approval required
- backup completed/failed
- security/abuse events where appropriate

## Delivery transports

Keep centralized router support:
- in-app
- email
- web push-ready
- SMS-ready
- WhatsApp-ready
- webhook

External delivery failure must never delete the durable in-app notification.

## User preferences

Allow users to configure non-critical notification categories/channels.

Security, billing-critical and legal/abuse notices may remain mandatory where appropriate.

## Tests

- admin unauthorized send denied
- admin authorized send
- one-user target
- org target
- plan target
- region target
- broadcast
- scheduled send
- fan-out retry idempotency
- cross-user read denied
- cross-org read denied
- per-user unread count
- realtime user isolation
- restart persistence
- read/archive persistence
- payment event produces notification
- server event produces notification

## Acceptance criteria

- admin can create/send/schedule notifications
- user bell/inbox works
- durable read/unread/archive works
- IDOR closed
- unread count is per user
- broadcasts are queued/idempotent
- payment/server/agent events feed the same notification service
