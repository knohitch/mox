# UI Parity 04 — Customer Extended Capabilities & Workspace Operations

Date: 2026-08-28

Phase 4 of the UI parity sweep. The customer workspace surface now drives real server-backed extended capabilities and operational controls without UI pretense or fake features: usage quotas and consumption telemetry, notification routing preferences and inbox notifications, backup archives and non-destructive restore verification, workspace team collaboration and seat limits, scheduled cron automations, subagent task delegation, registered tool skills, RAG knowledge sources, memory configuration, voice synthesis, and honest blocked states for non-productized runtime targets.

---

## A. Usage & Quota Telemetry

- **Telemetry Projections**: `UsageView` in `apps/web/src/views/MiscViews.tsx` surfaces the real server-projected metrics (`/api/usage/details` and `/api/billing/entitlements`).
- **Quota Status Projection**: Built on canonical status projection logic (`projectUsageStatus` in `services/control-plane/src/projections.ts`):
  - `within_included`: Usage within normal allocated limits (`tone="good"`).
  - `soft_limit_warning`: Usage approaching limits (`tone="warn"`).
  - `hard_limit_blocked`: Quota exhausted and further consumption blocked (`tone="bad"`).
  - `overage`: Consumption exceeds base plan quota with metered billing (`tone="warn"`).
  - `unlimited`: No quota ceiling applied on tier (`tone="accent"`).
- **Core Resource Quotas**: Monitored metrics include agents count, active runs, storage allowance (`caps.storage_gb`), voice synthesis minutes (`caps.voice_minutes`), and token consumption.

---

## B. Notification Center & Channel Routing

- **Canonical Event Routing**: Dedicated notification preferences endpoint (`/api/notifications/preferences`) managing delivery routes across in-app notification center, email digests, and browser push notifications.
- **Mandatory Alerts Guard**: Security incidents and billing/subscription updates are classified as mandatory (`mandatory: true`) and cannot be muted or opted out of, ensuring account security and compliance.
- **Inbox & Direct Link**: The `NotificationBell` header widget connects directly to the full notification preferences panel via `/settings#notifications`.

---

## C. Backup Management & Point-in-Time Restore Verification

- **Backup Catalog & Masking**: Backup archives surface server snapshots and cloud storage copies (`/api/backups`). Storage locations are masked via `maskBackupLocation` to prevent exposing internal infrastructure bucket names or raw cloud provider identifiers.
- **Plan Entitlement Gating**: When backup retention is not included in the active subscription tier (`overview.availability === false`), manual backup creation is disabled with an explanatory entitlement notice.
- **Non-Destructive Restore Test**: Customers can verify backup integrity using the non-destructive restore test endpoint (`POST /api/backups/:id/restore-test`), ensuring disaster-recovery readiness without overwriting live workspace data.

---

## D. Workspace Collaboration & Team Management

- **Isolated Workspace Invitations**: Created a dedicated `workspace_invitations` database table and migration (`0019_workspace_invitations.sql`), completely separating customer workspace team invitations from internal platform staff invitations.
- **Seat Allocation & Quota Enforcement**: Member invitations and seat assignments are strictly bounded by the `team_members` entitlement.
- **Owner-Safety Invariants**: Enforced by `canMutateMember` in `services/control-plane/src/projections.ts`:
  - Only workspace owners can modify owner memberships.
  - The sole remaining workspace owner cannot be demoted or removed.
- **Hashed Invitation Tokens**: Workspace invite links use cryptographic tokens stored as SHA-256 hashes (`tokenHash`), expiring after 7 days or upon explicit revocation.

---

## E. Multi-Agent Delegation, Schedules, Skills & Grounding

- **Schedules & Heartbeats**:
  - Crontab execution schedules with timezone configuration and execution prompt.
  - Interactive `enabled` status toggle per schedule.
  - Quota limit enforcement against `schedule_workflow_limit` entitlement (`validateScheduleLimit`), visually preventing creation beyond tier limits.
- **Subagent Delegation**:
  - Hierarchical and collaborative task delegation (`auto` or `ask` modes).
  - Cycle and self-reference protection: validated via `validateSubagents` (agents cannot delegate to themselves by agent ID or slug).
  - Same-organization boundary check: subagents must belong to the caller's organization.
- **Curated Skills Catalog**:
  - Replaced arbitrary free-form input with a curated catalog of registered skills (`data_analysis`, `web_search`, `code_interpreter`, `sql_query`, `doc_summarizer`).
  - No internal donor or nonexistent skill IDs exposed.
- **Knowledge Sources & Grounding (RAG)**:
  - Bound knowledge sources configured with explicit access permissions (`read`, `search`, `attach`).
  - Permission validation enforced server-side via `validateKnowledgeAccess`.
  - Organization boundary check: referenced knowledge sources must exist in the caller's organization.
- **Memory & Cross-Session Recall (Honest Disclaimer)**:
  - Allows configuring memory scope (`org`, `agent`, `thread`, `room`) and retention period in days.
  - Settings are validated and stored in `AgentDefinition.memory`.
  - **Honest Runtime State**: Includes an explicit disclaimer notice stating that memory configurations are stored in the canonical definition, but persistent cross-session memory recall is not yet consumed by the active runtime engine.
- **Workflow Automations (Honest Unavailable State)**:
  - The UI renders `FeatureUnavailable` explaining that directed multi-step workflow graphs require an external engine gateway (`code: not_configured`), rather than pretending an execution engine exists.

---

## F. Voice Synthesis

- **ElevenLabs Catalog**: Exposes supported voice models (`voice_rachel`, `voice_drew`, `voice_clyde`) with personality descriptions.
- **Entitlement Gating**: Preview audio synthesis checks `caps.voice_minutes > 0`. If unentitled, the UI displays a clear "Not Entitled" badge and disables synthesis buttons.

---

## G. Device & Execution Targets

- **Local Physical Device Blocking**:
  - Marked honestly as `<Badge tone="bad">NOT_PRODUCTIZED_BLOCKED</Badge>`.
  - Clear message that no local device relay daemon is composed on the deployment, restricting deployments to Cloud Sandbox, Mox Cloud, or Customer VPS.
  - No fake device mocks or simulated USB/local connections.

---

## H. Knowledge Sources & Storage in Settings

- Added **Knowledge Sources & Storage** panel to `SettingsView` (`/settings#knowledge`).
- Displays storage quota allowance (`caps.storage_gb`).
- Supports adding document catalogs, web crawls, API schemas, and structured database knowledge sources.
- Supports deleting existing knowledge sources.

---

## I. Navigation Integrity

- Frozen `CUSTOMER_NAV` remains strictly preserved and intact (`apps/web/tests/nav.test.ts` passes).
- Supported anchor links in `/settings`:
  - `#team`: Team Members & Collaboration
  - `#notifications`: Notification Preferences
  - `#knowledge`: Knowledge Sources & Storage
  - `#developer`: Personal API tokens

---

## J. Test Verification Matrix

All test suites passing across all packages:

1. **`@mox/web` Typecheck**:
   - `tsc -b --force` exited with `0`.
2. **`@mox/web` Unit Tests**:
   - `vitest run` passed **75 / 75 tests** across 11 test files.
   - `tests/extended-capabilities.test.ts`: **12 / 12 passed**.
3. **`@mox/control-plane` Typecheck**:
   - `tsc -b && tsc -p tsconfig.test.json` exited with `0`.
4. **`@mox/control-plane` Unit Tests**:
   - `vitest run` passed **61 / 61 tests** (92 database-dependent tests safely skipped).
   - `tests/phase-04-extended.test.ts`: **22 / 22 passed**.
5. **`@mox/cli` Unit Tests**:
   - `vitest run` passed **11 / 11 tests**.
