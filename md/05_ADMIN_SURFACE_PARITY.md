# 05 — ADMIN SURFACE PARITY

## Objective

Make the Mox Admin surface expose every Mox-owned platform-management capability that an authorized Admin is supposed to see/manage.

Do not leak these capabilities into Customer or Support.

Start from the authoritative inventory created in Phase 01.

---

# A. ADMIN NAVIGATION AUDIT

Current historical Admin sections include areas such as:
- dashboard
- customers
- plans
- payments
- compute
- intelligence
- runtime
- notifications
- operations
- staff

Re-scan the current code.

Compare:
- Admin service capabilities
- Control Plane Admin routes
- database Admin-domain state
- Admin API client
- Admin navigation
- rendered controls

Every `ADMIN_VISIBLE` or `ADMIN_CAPABILITY_GATED` item needs a discoverable UI.

Visibility must be based on server-verified Admin capability, not customer org role.

---

# B. CUSTOMERS

Ensure Admin can appropriately see/manage:
- customer/workspace
- members
- subscription
- servers
- agents
- support notes
- suspension/reactivation
- customer state/reasons
- safe recent activity

Do not expose secrets in customer details.

If underlying Admin routes support actions that UI only displays, add controls.

---

# C. PLANS / ENTITLEMENTS / PRICING / ADD-ONS

Admin plan API historically returns:
- products
- plan versions
- entitlement definitions
- entitlement values
- currencies
- pricing regions
- price books
- price versions
- add-ons

Ensure Admin UI can actually manage what server authority supports.

At minimum inspect whether UI currently lacks:
- product/plan version management
- entitlement values
- regional pricing
- price versions/effective dates
- add-on definitions

If mutations do not exist but the underlying domain expects Admin editability, add safe Admin APIs and auditing.

Never move business entitlement logic into UI.

---

# D. BILLING PROVIDERS

Surface all Admin-safe provider configuration supported by current API:
- environment/test-live
- enabled state
- secret reference presence
- webhook configuration metadata
- health
- recent payment/webhook diagnostics where appropriate

Never return secret values.

---

# E. COMPUTE

Existing Admin compute authority covers provider accounts, compute classes, orders, operations and Mox Node health.

Ensure UI supports authorized actions:
- provider account configuration
- enable/disable
- commercial approval status
- credential ref presence
- compute class configuration
- server order lifecycle action
- node health
- operation errors

Do not show raw secret values.

---

# F. MODELS / INTELLIGENCE

Ensure Admin can manage all Mox-system intelligence metadata intended by current system-model schema/services:
- system providers
- system models
- connection status
- credential reference presence
- base URL
- availability
- default/fallback models
- internal feature-model routing metadata
- quotas/cost metadata only to authorized Admin roles

Do not mix customer BYOK state with system credential state.

---

# G. RUNTIME / OPERATIONS

Current Admin Operations historically displays:
- notification jobs
- server operations
- incidents
- backups
- abuse
- audit
- feature flags
- cost ledger

Audit underlying services for actions currently hidden.

Particular known candidates:

## Feature flags
FeatureFlagService supports:
- set
- remove
- scoped flag
- rollout percent
- audit
- scopes:
  - global
  - region
  - plan
  - organization
  - user
  - provider

Build Admin feature-flag management with capability checks and audit.

## Backups
BackupService supports:
- run backup
- restore test
- retention sweep
- cancellation export

Expose only appropriate Admin operations, with tenant targeting/audit.

## Incidents/provider health
If Mox-owned provider-health/incident services expose mutation/management functions, surface them.

## Abuse
If abuse-case lifecycle actions exist, surface them to the correct Admin role; otherwise remain read-only.

---

# H. ENTERPRISE CONTRACTS

Mox-owned Enterprise contract service includes metadata/capabilities such as:
- contract reference
- custom price/currency
- entitlement values
- included nodes
- custom compute class codes
- private model slugs
- dedicated database
- dedicated runtime
- custom retention
- custom domains
- audit export
- SSO readiness/metadata
- private networking hooks
- SLA terms
- white-label metadata
- activation/deactivation
- audit history

Create a dedicated Admin capability-gated Enterprise Contracts surface if it is still absent.

Do not branch runtime behavior on plan name. Continue using the shared entitlement engine.

---

# I. STAFF & ACCESS

Ensure Admin Staff UI reflects all platform-staff lifecycle authority:
- list
- invite
- invite state
- revoke invite
- roles
- surfaces
- enable/disable/revoke membership
- capability-aware visibility

Do not let Support users gain Admin staff-management authority.

---

# J. NOTIFICATIONS

Admin notification domain already supports:
- preview
- send
- schedule
- cancel jobs
- audience segmentation

Ensure UI exposes every supported action:
- preview before send
- direct send
- schedule
- cancel scheduled job
- inspect job
- status/error/fanout
- audiences supported by API

No fake delivery success.

---

# K. ADMIN TESTS

Add tests for:
- nav visibility per capability;
- forbidden Admin action;
- staff/admin isolation;
- secret masking;
- feature flag set/remove/audit;
- enterprise contract lifecycle;
- backup operation audit;
- notification preview/send/schedule/cancel;
- plans/entitlements mutation if implemented;
- cross-org target auditing.

---

# REPORT

Create:

`docs/verification/UI_PARITY_05_ADMIN.md`

Local commit after green verification:

`feat(ui-parity): complete admin capability surfaces`
