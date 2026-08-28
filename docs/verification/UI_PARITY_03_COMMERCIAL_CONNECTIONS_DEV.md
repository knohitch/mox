# UI Parity 03 — Customer Commercial Connections & Developer Surfaces

Date: 2026-08-28

Phase 3 of the UI parity sweep. The customer self-service surface now drives
real server-backed commercial and developer HTTP surfaces instead of UI
pretense: BYOK model credentials, integration connections + agent tool grants,
channels, billing self-service (plans/subscription/entitlements/checkout/
cancel/reconcile), and personal API tokens. Secrets are never routed through
the UI — they are written to the control plane's encrypted credential vault and
the browser only ever sees field **metadata** (`configFields`, `secretKeys`).

## A. Billing self-service

- `BillingView` rewritten: KPI row (`commercialStatus` from
  `apps/web/src/domain/billing.ts`), subscription panel (plan, current period,
  cancel-at-end, entitled state), plans table using `bestPlanPrice` over all
  regions, checkout modal (provider + region → `startCheckout`, then
  `reconcileCheckout` for missed callbacks), and **Cancel subscription**.
- `MoxStore` gains `refreshEntitlements()`; `failingApi` stubs every billing
  seam so hosted failures render honest unavailable states, never fake rows.
- Web surfaces the server-projected catalog (`/api/plans`, `/api/billing/
  providers`, `/api/billing/subscription`, `/api/billing/entitlements`) — no
  amounts are computed client-side except display formatting
  (`moneyMinorToDisplay`).
- Hosted checkout requires an admin-registered billing provider; absent that,
  the API refuses honestly and the UI shows it.

## B. BYOK model connections

- `ModelsView` rewritten onto the real surface: model list with availability
  derived from connection + credential authority, and a **BYOK control plane**
  of connect / rotate / disconnect / test per provider.
- Connect accepts the API key (never stored in the UI), an optional `baseUrl`
  for BYO-URL providers, and optional custom models; rotate issues a new secret;
  disconnect drops the credential reference server-side.
- Test probes are **honest 501** (`code: not_configured`) until a runtime
  gateway exists — the UI renders that (`FeatureUnavailable`) instead of a
  fake ping result. The old `cli-engines` route stays as a backward-compatible
  honest 501; the panel was removed from the UI.
- `domain/connections.ts` maps provider/connection state → badges.

## C. Integrations + tool grants

- `IntegrationsView` rewritten: per-integration connect modal whose fields come
  from the server catalog (`configFields`, secret fields rendered as password
  inputs), connected/disconnected state, `dangerous` and runtime-session
  badges.
- **Tool grants** panel: grant / revoke per agent (`toolPattern`), refused
  honestly (409 `not_connected`) until the integration is connected; identical
  re-grants are idempotent.
- Disconnect clears the vault credential; a fresh grant is refused until
  reconnect. Secret values never appear in the catalog projection
  (`publicIntegrationConfig` allowlist).

## D. Channels

- `ChannelsView` rewritten: connect modal binds an agent and asks exactly the
  secret keys the server declares (`secretKeys` — **field names**, never
  values), reconnect (re-auth), disconnect, test probe, and a setup-help panel
  (`setupInstructions` / `prerequisites`).
- Web-kind channels need no credential; credentialed channels (telegram,
  slack, discord, …) reject empty secrets with a 400.
- The control plane now exposes `secretKeys` on channel rows (added to the
  channels projection + web `ChannelCatalogRow` + demo seed).
- Test probes answer honestly (hosted 501 until a delivery gateway; the demo
  answers `ok` only for the web path).

## E. Developer surface

- `SettingsView` **Developer** panel: create / list / revoke personal API
  tokens — session-only routes, full plaintext shown **once** at creation,
  revoked/rotation states honest.
- CLI usage snippet derives its endpoint from the resolved web config
  (`resolveWebConfig` → `cliBaseUrl`), so the example always points at the
  correct environment.

## Backend (control-plane)

- New/changed routes: `/api/plans`, `/api/billing/subscription`,
  `/api/billing/entitlements`, `/api/billing/providers`, `/api/billing/checkout`,
  `/api/billing/cancel`, `/api/billing/reconcile`, `/api/model-connections`
  (GET/connect/rotate/DELETE/test), `/api/integrations`
  (+`:id/connect|disconnect|grants`), `/api/channels`
  (+`:id/connect`, `connections/:id/reconnect|disconnect|test`), plus the
  existing `/api/auth/tokens` session-only token routes.
- Credential vault: optional `customerCredentialsKey` (env `MOX_CUSTOMER_
  CREDENTIALS_KEY` || `MOX_CREDENTIALS_KEY`) wires a real encrypted
  `PgCustomerCredentialStore` behind `CustomerCredentialService`; absent, every
  secret-bearing operation throws an honest 501 (`code: not_configured`).
- Secrets addressed by scope externalIds: `model:<slug>`,
  `integration:<slug>` (JSON blob), `channel:<slug>:<agentId>`.
- Channel rows + lists project `secretKeys` (keys only) so the customer knows
  what to paste without ever reading stored values.

## CLI §F realignment

- `apps/cli/src/commands.ts` rewritten against the real surface: `whoami` →
  `/api/me`; agents list/get/create/update vs `/api/agents` + `/api/agents/
  drafts`; `deploy` → `POST /api/deployments {agentId, revision}`; deployment
  list → `/api/deployments`; `models connections`, `channels list`,
  `integrations list` → their catalog routes; `terminal`/`logs` →
  per-agent routes that honestly 501.
- Commands with no server route (`orgs list`, `servers get`, `deployment
  status`) report an honest "unsupported" message instead of fabricating
  output.
- CLI test suite rewritten (11 tests) against the new routes + fixture file.

## UI glue

- `primitives.tsx` `DataTable.head.key` relaxed from `keyof T` to `string` so
  customer tables can render computed columns ("actions", "price", "state")
  without lying about row shape; the no-render fallback casts at the call site.
- `apps/web/src/domain/{billing,connections}.ts` hold the shared state/price
  logic; `store.tsx` `failingApi` covers the full new `MoxApi` seam and
  `testChannel` resolves to an honest `{ok:false, reason}` in the failing path.

## Verification (green)

- `apps/web`: `pnpm typecheck` clean.
- `apps/web`: `pnpm test` → 63 passed / 10 files (48 prior + 15 new in
  `tests/commerce-connections.test.ts` covering models/integrations/channels/
  billing/tokens/domain helpers).
- `apps/cli`: `pnpm typecheck` clean; `pnpm test` → 11 passed.
- `services/control-plane`: `pnpm typecheck` clean (tsc + test tsconfig).
- `services/control-plane`: `pnpm test` → 39 passed; DB-gated suites (incl. the
  new `tests/phase-03-commerce.test.ts` — 6 tests: secret-free catalogs, BYOK
  round-trip, channel credential rules, integration grants, session-only
  tokens, plans/subscription/cancel) skip without `MOX_TEST_DATABASE_URL`
  (`scripts/run-postgres-verification.cmd` provisions a disposable cluster).
- `git diff --check` clean (LF/CRLF warnings only).

## Remaining Phase 3 scope (not done — documented)

- Hosted checkout needs an admin-registered billing provider + webhook
  reconciler; checkout/reconcile routes are in place and honesty-tested, the
  demo answers with a mock session.
- Test/probe endpoints (model/test, channels/:id/test, logs/terminal/computer)
  honestly 501 until a runtime gateway is composed; the UI surfaces
  `FeatureUnavailable` instead of faking success.
- `cli-engines` retained as a backward-compatible honest 501.
- Subsequent phases 04–07.