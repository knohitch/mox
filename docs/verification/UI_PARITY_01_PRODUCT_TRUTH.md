# UI Parity 01 — Product Surface Inventory & Truth

Date: 2026-08-27

Phase 1 of the UI parity sweep: establish canonical product truth on the customer surface so the UI reflects real, durable state instead of placeholders. Covers canonical entitlement parity, server truth, deployment truth, room membership persistence, model availability truth, a reusable feature-availability model, and focused tests.

## B. Canonical entitlement parity

Before:
- The web consumed two sources of truth: a legacy boolean `Entitlements` interface and the canonical per-key entitlement authority (`packages/entitlements`). Capabilities derived from workspace-level booleans (terminal/computer) that did not match the per-key product model, and numeric limits were not uniformly reachable.

After:
- `apps/web/src/api/entitlement.ts` adds `CANONICAL_ENTITLEMENT_KEYS`, a single `Entitlements = { commerciallyEntitled, values }` shape, and selectors: `hasBrowser` (browser_sessions), `hasTerminal` (cli_sessions), `hasAgentRooms` (agent_rooms), `hasModelConnections` (model_connections), `hasVoice` (voice_minutes), plus `hasIntegrations`, `hasChannels`, `hasDeveloperMode`, `hasBackups`, `hasTeamMembers`, `hasStorage`, `hasMoxAiCredits`, and `limitOf`.
- `apps/web/src/api/types.ts` removes the legacy `Entitlements`; `http-api.ts` `getEntitlements` now returns `{ commerciallyEntitled, values }`; `store.tsx` exposes capability hooks; `demo-api.ts` returns the canonical shape; `MiscViews.tsx`/`AgentsView.tsx` use the new hooks.
- Numeric values stay numeric (no boolean collapse); commercial-access denial is distinct from a value (gates off while `commerciallyEntitled: false`).

Tests: `apps/web/tests/entitlement.test.ts` (10 tests) — key set, numeric preservation, denial-distinctness, per-capability derivation.

## C. Server product-truth projection

Before:
- `/api/servers` collapsed every non-running state to `provisioning`, and hardcoded `agentsRunning`, `cpuPct`, `memPct` to `0` (fabricated telemetry).

After:
- `services/control-plane/src/api.ts` now projects the ACTUAL orchestrator `order.state` (running/error/stopped/resizing/requested/…), plus `orderId`, real `computeClass`, `provider`, `lastError`, `createdAt`, `updatedAt`.
- Telemetry with no authority is explicitly `null` (agentsRunning/cpuPct/memPct), never `0`.
- Projection extracted to a pure, testable helper `projectServerSummary` in `services/control-plane/src/projections.ts`.
- Web `ServerSummary` updated (full `OrderState` union, nullable telemetry, new fields); `ServersView` renders telemetry as "unavailable" and adds Class/Last-error columns.

Tests: `services/control-plane/tests/projections.test.ts` — state preservation, provider-instance id fallback, telemetry `null` (no fabricated zeros).

## D. Deployment product-truth projection

Before:
- `/api/deployments` rendered every target as `sandbox` and every state as `desired` (fake "success-looking" placeholder).

After:
- Target derived from the real durable `deployment_kind` (`sandbox`, `customer_vps`, shared/dedicated host → `mox-cloud`), with the linked order id as the customer-VPS identity.
- State derived from real reconciled authorities: linked orchestrator `order.state` + node heartbeat. A running order whose node stopped heartbeating is `degraded`, not healthy; no compute authority → honest durable `desired` marker.
- Version identity is a durable `{agentId}@{desiredRevision}`, never a client-only invented number.
- Pure helpers `projectDeploymentState`/`projectDeploymentTarget`/`deploymentVersionId` in `projections.ts`.

Tests: `services/control-plane/tests/projections.test.ts` — state derivation, degraded-on-stale-heartbeat, desired fallback, real target kind (no sandbox), durable version identity.

## E. Room membership persistence

Before:
- `GET /api/rooms` returned `memberAgentIds: []` always; `POST /api/rooms` echoed submitted ids without persisting them (create "looked" successful but data was lost).

After:
- `POST /api/rooms` validates every member agent belongs to the SAME org, persists members transactionally via `room_members` (org-scoped, within a DB transaction), and returns durable truth.
- `GET /api/rooms` reads the persisted `room_members` rows and returns the actual members.
- Cross-org membership is rejected with HTTP 400 (and a `reason` listing rejected agent ids).

Tests: DB-gated integration in `services/control-plane/tests/auth-integration.test.ts` (skips without `MOX_TEST_DATABASE_URL`): persist-real-members + reload, and cross-org rejection.

## F. Model availability truth

Before:
- `/api/models` reported `available: true` for every model regardless of provider connection/credential health.

After:
- Availability derives from the provider's `modelConnections.connectionStatus` + presence of `credentialRefId`: `configured`+creds → available; `error` → error; missing creds / unconfigured / disabled → `not_configured`.
- Pure helper `projectModelAvailability` in `projections.ts`.

Tests: `services/control-plane/tests/projections.test.ts` — not-available until configured + creds, error/unconfigured/disabled handling.

## G. Feature availability contract

- `apps/web/src/domain/availability.ts` adds a small reusable discriminated-union availability model for UI use: `available`, `not_configured`, `not_entitled`, `role_denied`, `provider_unavailable`, with `isAvailable` guard and `availabilityLabel`. Purpose: prevent active-looking buttons that are guaranteed to fail. `coming_later` is intentionally excluded (no product approval) to avoid a fake success path.

Tests: `apps/web/tests/availability.test.ts` — only `available` is actionable; honest labels; reason passthrough.

## Verification

- `services/control-plane`: `pnpm typecheck` clean; `pnpm test` → 39 passed, 80 skipped (skipped = PostgreSQL-gated, incl. the new room persistence tests). New pure projection tests run in CI without a database.
- `apps/web`: `pnpm typecheck` clean; `pnpm test` → 38 passed across 8 files (entitlement, availability, etc.).

## Remaining / honest gaps

- Deployment **runtime** state has no separate runtime tracking authority; `state` is derived from the orchestrator order + heartbeat, which is the honest durable signal available. Intentionally NOT a competing deployment state machine.
- Room member update-after-create is not exposed (no PATCH endpoint exists); create-time persistence + read is implemented per the phase ("if existing domain design permits").
- Model connection probes remain `501 not_configured` until a provider SDK/vault probe is wired; the availability projection reports this honestly rather than faking connectivity.
