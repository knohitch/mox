# Repair Prompt 02 — Admin notifications, durable user inbox and authorization

**Reasoning: Extra High**

Run after Repair Prompt 00. If billing-driven notifications are wired, run after Prompt 01.

## Goal
Finish Mox notifications end-to-end so admins can create/send announcements and users can receive, read and manage them securely.

## Fix authorization first
Change all user-facing notification operations to enforce:
- `orgId`
- authenticated `userId`
- notification ownership/audience
- explicit admin/system scope only when authorized

At minimum support:
- `listNotifications(orgId, userId, filters)`
- `getNotification(orgId, userId, notificationId)`
- `markRead(orgId, userId, notificationId)`
- `markUnread(...)`
- `markAllRead(orgId, userId)`
- `archive(...)`
- `unreadCount(orgId, userId)`

A user must never read/mark another user's private notification or see another user's unread count. Add cross-user and cross-tenant IDOR tests.

## Durable schema/store
Use PostgreSQL production persistence. Add indexed fields where needed for:
- title
- body/content
- severity
- category
- audience type
- target user/org/segment
- action/resource reference
- readAt
- archivedAt
- createdBy
- scheduledAt
- expiresAt
- dedupe key
- delivery status

Do not hide authorization-critical/searchable fields only inside opaque JSON.

## Admin-created notifications
Extend AdminService/admin API with RBAC-protected actions:
- draft
- preview
- send now
- schedule
- cancel scheduled
- target one user
- selected users
- organization/workspace
- plan/tier segment
- region segment
- broadcast all eligible users
- delivery/read statistics

Every send/broadcast is audited.

Large fan-out must use durable idempotent jobs, not a synchronous HTTP loop.

## User web UX
Add to `apps/web`:

### Header bell
- unread count for authenticated user only
- realtime update
- panel/inbox entry

### Notification inbox
- All
- Unread
- System
- Billing
- Servers
- Agents
- Security
- mark read/unread
- mark all read
- archive
- action/resource links
- pagination/infinite loading

Generic UI must not use “GPT”.

## Realtime
Persist first, then publish through the Mox realtime abstraction. Only eligible users receive the event. UI must not depend directly on a vendor-specific realtime payload shape.

## Automatic platform notifications
Wire canonical events including:
- subscription activated
- payment failed/past due
- server provisioning started/ready/failed
- node offline
- agent deployment success/failure
- approval required
- backup completed/failed
- security/abuse action where appropriate

## Delivery channels
Keep centralized router support for:
- in-app
- email
- web-push-ready
- SMS-ready
- WhatsApp-ready
- webhook

Optional external delivery failure must not remove the durable in-app notification.

## Preferences
Users can control non-critical categories/delivery methods. Critical security/billing/legal notices may be non-disableable where appropriate.

## Tests
- unauthorized admin send denied
- authorized send
- one-user target
- org target
- plan/region target
- all-user broadcast
- scheduled send
- duplicate job retry
- cross-user read denied
- cross-org read denied
- user-specific unread count
- realtime user isolation
- restart persistence
- read/archive persistence

## Acceptance criteria
- admins can send/schedule/target notifications from Mox;
- users have a real bell/inbox;
- read/unread/archive works durably;
- unread count is per user;
- notification IDOR is closed;
- broadcasts are durable/idempotent;
- platform events feed the same system.
