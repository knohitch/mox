# UI Parity 05 — Complete Admin Capability Surfaces

Date: 2026-08-28

Phase 5 of the UI parity sweep. The Mox platform-admin console now provides parity across all underlying administrative capabilities without leaking administrative powers to Customer or Support surfaces. Authorized platform administrators can view and manage Customers, Plans & Entitlements, Payments & Billing Providers, Compute & Server Orders, Models & Intelligence, Operations (Feature Flags, Backups, Incidents, Abuse), Enterprise Contracts, Staff & Access, and Notifications.

---

## A. Admin Navigation Audit & Capability Gating

- **Staff Navigation Surface**:
  - The Admin surface now offers 11 capability-gated tabs (`dashboard`, `customers`, `plans`, `payments`, `compute`, `intelligence`, `runtime`, `notifications`, `operations`, `contracts`, `staff`).
  - Gating is strictly capability-based (`visibleAdminTabs` in `apps/web/src/concepts/staffNav.ts`):
    - `dashboard`, `customers`, `operations`: gated on `admin.read`.
    - `plans`, `payments`, `contracts`: gated on `admin.billing.write`.
    - `compute`: gated on `admin.compute.write`.
    - `intelligence`: gated on `admin.intelligence.write`.
    - `runtime`: gated on `admin.operations.write`.
    - `notifications`: gated on `admin.notifications.write`.
    - `staff`: strictly gated on `admin.staff.write` (accessible only to `superadmin`).
- **Support Surface Isolation**:
  - Support roles (`support_manager`, `support_agent`) possess no `admin.*` capabilities and see no Admin tabs (`visibleAdminTabs` returns `[]`).
  - Platform administrators lacking `admin.staff.write` (e.g. `platform_admin`, `billing_admin`, `ops_admin`) cannot view or access the Staff & Access panel.

---

## B. Customers Panel

- **Organization & Member Visibility**:
  - Displays organizations, user lists with roles and disabled status, active subscriptions with renewal statuses, servers, agents, and support notes.
- **Controlled Suspension & Safe Reactivation**:
  - Interactive suspension reasons: `admin_controlled`, `billing_nonpayment`, `abuse_investigation`, `security_containment`.
  - Financial reconciliation guard: When reactivating subscriptions that were suspended for billing/refund/dispute reasons, the administrator can explicitly assert `financialReconciled` (fulfilling Security Repair 05A §I).
  - Cross-organization audit trail: actions record `targetOrgId` and redact sensitive payloads. Secrets are never exposed.

---

## C. Plans, Entitlements, Pricing & Add-ons

- **Plan Entitlement Values Management**:
  - Interactive table displaying plan entitlement values across plan versions.
  - Backend route `PUT /api/admin/plans/entitlements/:planVersionId/:key` allowing administrators to tune integer, boolean, and text entitlements with audit logging.
- **Add-on Definitions**:
  - Add-on creation and update form: code, display name, consumable flag, and unit.
  - Backend route `POST /api/admin/plans/addons` upserting directly into `addonDefinitions` table with audit logging.
- **Currencies & Regional Pricing**:
  - Currencies upsert form (`PUT /api/admin/plans/currencies/:code`).
  - Regional price books upsert form (`PUT /api/admin/plans/price-books`) supporting fixed and FX-derived pricing.
  - Display of price versions with effective dates and pricing regions.

---

## D. Payments & Billing Providers

- **Provider Configuration**:
  - Manages Paystack, Flutterwave, Stripe, and PayPal configurations.
  - Test vs. live environment toggles, maintenance mode, and priority ordering.
- **Secret Reference Safety**:
  - API secrets and webhook secrets are referenced strictly by Vault/env identifier (`hasSecretRef`, `hasWebhookSecretRef`). Raw secret values are never accepted from or returned to the client.
  - Surfaces real-time webhook status (`configured`, `healthy`) and payment reconciliation health.

---

## E. Compute & Server Order Lifecycles

- **Provider Accounts & Compute Classes**:
  - Configuration of provider accounts (Contabo, Hetzner) with commercial approval state, health scores, and credential reference presence.
  - Compute class definitions (`minVcpu`, `minRamGb`, SKU maps).
- **Interactive Server Order Lifecycle**:
  - Replaced read-only display with interactive action controls per server order:
    - **Restart**: Triggers server restart operation.
    - **Redeploy**: Queues server redeployment.
    - **Cancel**: Cancels server order with audit logging reflecting the affected organization (`targetOrgId`).
  - Powered by backend route `POST /api/admin/compute/orders/:orderId/:action`.

---

## F. Models & Intelligence

- **System Model Providers**:
  - Provider management for OpenAI, Anthropic, Gemini, DeepSeek, Qwen, GLM, Kimi, MiniMax, and local Ollama nodes.
  - Settings: base URL, credential reference presence, availability (`available`, `degraded`, `disabled`), default and fallback model configurations.
- **Customer BYOK Separation**:
  - Platform system models and credentials remain strictly segregated from customer BYOK credentials.
  - Quotas, routing, and cost metadata are restricted to authorized administrators.

---

## G. Operations (Feature Flags, Backups, Incidents, Abuse)

- **Feature Flags Management**:
  - Dedicated interactive surface in the Operations panel.
  - Create and update scoped feature flags across scopes (`global`, `region`, `plan`, `organization`, `user`, `provider`) with rollout percentages.
  - Backend routes `POST /api/admin/operations/feature-flags` and `DELETE /api/admin/operations/feature-flags/:key` with audit logging.
- **Backups Operations**:
  - Tenant-targeted backup execution: `POST /api/admin/operations/backups/run`.
  - Non-destructive disaster recovery restore verification: `POST /api/admin/operations/backups/:backupId/restore-test`.
- **Incidents & Abuse Monitoring**:
  - Read & status visibility for active system incidents, job queues, and open abuse cases.
  - Platform and cross-org audit trail inspection.

---

## H. Enterprise Contracts Surface

- **Dedicated Enterprise Contracts Panel**:
  - Positioned as a dedicated first-class tab in the Admin navigation (`Contracts`), capability-gated on `admin.billing.write` (held by `superadmin` and `billing_admin`).
- **Contract Authoring & Capabilities**:
  - Contract reference, organization ID, effective from and until dates, and active toggle.
  - Custom entitlement values JSON (e.g. `agents_limit`, `custom_integrations`, `compute_nodes`).
  - Enterprise metadata: included nodes, dedicated database, dedicated runtime, custom domains, audit export, SSO SAML readiness, and white-label branding.
- **Entitlement Engine Synchronization**:
  - Persisted in PostgreSQL `custom_contracts` table.
  - Automatically synced into `services.entitlements.applyContract()`, overriding standard plan layers without branching on plan names.
- **Lifecycle & Audit**:
  - Deactivation action (`POST /api/admin/enterprise-contracts/:contractRef/deactivate`).
  - Every contract creation, update, and deactivation is recorded in `audit_events` with `targetOrgId`.

---

## I. Staff & Access

- **Platform Staff Administration**:
  - Strictly capability-gated to `admin.staff.write` (superadmin authority only).
  - Staff invitation lifecycle: invite creation with role (`platform_admin`, `support_manager`, `support_agent`) and surface (`admin`, `support`, `both`), invite revocation, and membership enable/disable/revoke.
  - Support agents and non-superadmin platform staff can never view or manage staff members.

---

## J. Notifications Management

- **Preview Workflow**:
  - "Preview before send" interactive button calling `POST /api/admin/notifications/preview` to render notification templates and variable substitutions before distribution.
- **Notification Jobs Lifecycle**:
  - Immediate send (`POST /api/admin/notifications/send`) and scheduled dispatch (`POST /api/admin/notifications/schedule`).
  - Interactive job cancellation for pending scheduled jobs (`POST /api/admin/notifications/jobs/:jobId/cancel`).
  - Job inspection drawer showing fanout delivery progress, recipient counts, and delivery error diagnostics.
- **Audience Segmentation**:
  - Supported audiences: All users (`all`), specific organization (`org`), subscription tier (`plan`), or geographical region (`region`).

---

## K. Automated Test Verification

1. **`apps/web` Test Suite**:
   - `tests/staff-nav.test.ts`: Asserts tab visibility across `superadmin`, `billing_admin`, `platform_admin`, and `support_agent`.
   - `tests/admin-parity.test.ts`: Asserts `contracts` capability gating, superadmin staff access exclusivity, and client method definitions for contracts, feature flags, backups, plan entitlements, and notification jobs.
   - **Result**: 12 test files passed, 79 tests passed.
2. **`services/control-plane` Test Suite**:
   - `tests/phase-05-admin.test.ts`: Tests platform role capability mapping, staff surface isolation, custom enterprise contract resolution and deactivation fallback, and feature flag hierarchical precedence and audit.
   - **Result**: 7 test files passed, 67 tests passed (92 skipped for live postgres).
3. **`apps/cli` Test Suite**:
   - **Result**: 1 test file passed, 11 tests passed.
