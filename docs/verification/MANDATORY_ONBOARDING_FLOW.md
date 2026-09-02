# Mandatory Customer Onboarding Flow — Verification Report

Date: 2026-09-02
Branch: `master` (local only — nothing pushed)

## 1. Starting SHA

`7a8910cf3891cbf9bbf19a9173cd38fc1d765e77` — `feat(ui): command palette, toasts, skeleton states; white light theme with elevated cards` (Prompt 01, clean working tree at start).

## 2. Migration file

`packages/database/migrations/0020_org_onboarding_state.sql` — the next migration number after re-scanning the repo (0019 was the last; 0011+ are hand-written SQL without drizzle meta snapshots, so a new SQL file is the established convention; `packages/database/scripts/migrate.mjs` applies it by filename order with checksum bookkeeping in `mox_migrations`).

Contents: guarded `org_onboarding_status` enum (`not_started` / `in_progress` / `completed`), the `org_onboarding` table (PK `org_id` FK→`organizations` cascade; CHECK-constrained choice columns; FKs to `agents`, `server_orders`, `users` with `ON DELETE SET NULL`), and the idempotent backfill of every pre-existing organization as `completed`.

## 3. Exact files changed

New:

| File | Purpose |
| --- | --- |
| `packages/database/migrations/0020_org_onboarding_state.sql` | Durable org-scoped onboarding state + backfill |
| `packages/database/src/schema/onboarding.ts` | Drizzle schema (`orgOnboarding`) |
| `packages/database/src/pg-onboarding-store.ts` | `PgOnboardingStore` — durable authority (get / getOrDefault / ensureNotStarted / applyPatch / complete) |
| `services/control-plane/src/onboarding.ts` | Step/decision semantics: validation, per-step field scoping, completion gating, customer-safe projection |
| `services/control-plane/tests/onboarding.test.ts` | 10 PG-gated integration tests |
| `apps/web/src/domain/onboarding.ts` | Pure routing matrix, post-auth destinations, truthful review derivation |
| `apps/web/src/views/OnboardingView.tsx` | Standalone 6-step flow (no sidebar) |
| `apps/web/src/views/WorkspaceSetupCard.tsx` | Post-onboarding dashboard checklist (real resource state) |
| `apps/web/tests/onboarding-routing.test.ts` | Routing matrix + studio URL state tests |
| `apps/web/tests/onboarding-review.test.ts` | Deferred/completed/unavailable review semantics |
| `apps/web/tests/onboarding-view.test.ts` | SSR tests: no sidebar, shared primitives, a11y progress |
| `docs/verification/MANDATORY_ONBOARDING_FLOW.md` | This report |
| `docs/verification/assets/onboarding-*.png` | Visual evidence (light theme) |

Modified:

- `packages/database/src/schema/index.ts`, `packages/database/src/index.ts` — exports.
- `services/control-plane/src/auth.ts` — customer signup inserts `org_onboarding` `not_started` row inside the signup transaction.
- `services/control-plane/src/api.ts` — `GET /api/onboarding`, `PATCH /api/onboarding`, `POST /api/onboarding/complete` (+ audit event on completion).
- `services/control-plane/src/composition.ts` — `onboarding: PgOnboardingStore` in `ControlPlaneServices`.
- `apps/web/src/api/types.ts` — `OnboardingState`, `OnboardingPatchInput`, `ServerOrderView`, `MoxApi.getOnboarding/updateOnboarding/completeOnboarding/orderServer`.
- `apps/web/src/api/http-api.ts` — HTTP client methods (server order response projected to a customer-safe `ServerOrderView`).
- `apps/web/src/api/store.tsx` — durable onboarding state in bootstrap/authenticateAndLoad/signOut; `signIn`/`signUp` return the fresh state; `refreshOnboarding`.
- `apps/web/src/api/demo-api.ts` — dev-only demo implementations (explicitly classified dev-only).
- `apps/web/src/App.tsx` — routing matrix (root, `/onboarding`, product-route guard), post-login/signup destinations; `/onboarding` renders BEFORE the `CustomerShell` wrap (no sidebar).
- `apps/web/src/views/AuthPages.tsx` — `MoxLogo` exported for the onboarding brand header.
- `apps/web/src/views/MiscViews.tsx` — mounts `WorkspaceSetupCard` on the dashboard.
- `apps/web/src/styles.css` — onboarding + setup-card styles built exclusively from existing tokens/utilities.
- `apps/web/src/uiStudio/mockStore.ts`, `previewNavigation.ts`, `views/UiStudioView.tsx` — dev-only onboarding preview.
- `scripts/run-postgres-verification.ps1` — added `tests/onboarding.test.ts` to the PG-gated suite list.

## 4. Onboarding data model

Table `org_onboarding` — one row per organization (PK `org_id`):

- `status` (`org_onboarding_status` enum): `not_started` | `in_progress` | `completed`
- `current_step` int 1..6 (resume pointer), `completed_steps` jsonb (sorted step numbers)
- Step decisions: `persona` text, `goals` jsonb (allow-listed ids), `display_name`/`workspace_name` (confirmed profile fields), `model_setup_choice` (`mox_managed|own_provider|deferred`), `model_provider_id` (slug, never a key), `agent_setup_choice` (`created|deferred`), `agent_id` uuid FK, `infrastructure_setup_choice` (`provisioned|deferred`), `server_order_id` uuid FK, `connections_setup_choice` (`configured|deferred`)
- Timestamps/actor: `started_at`, `updated_at`, `completed_at`, `updated_by_user_id`

Backfill: every organization existing before the migration is inserted `completed` with steps 1–6 recorded.

## 5. API endpoints

All customer-session authenticated via `requireAuth` (scope `settings` for API tokens; cookie sessions satisfy all scopes); every query org-scoped to the session's verified `activeOrgId` — no cross-org access.

| Endpoint | Behavior |
| --- | --- |
| `GET /api/onboarding` | Durable state for the active org; a missing row reads as `not_started` (reads never create rows). |
| `PATCH /api/onboarding` | Owner/admin only. Validates the body into a step-scoped write: fields must belong to the step, enums/uuids/lengths validated, goals allow-listed; a step counts as recorded only when its required decision fields were sent. Rejects completed orgs (409 `onboarding_completed`). Cross-checks `agentId`/`serverOrderId` really exist in the org (400 otherwise). Cannot set `status` — arbitrary PATCH can never complete onboarding. Step 1 additionally updates the REAL `users.display_name` / `organizations.display_name` authorities. |
| `POST /api/onboarding/complete` | Owner/admin only. 409 `onboarding_incomplete` until every required decision step is recorded; otherwise idempotent completion + durable `audit_events` row (`onboarding.completed`, org-scoped). |

## 6. Routing matrix

Implemented in `apps/web/src/domain/onboarding.ts` (`resolveCustomerOnboardingRouting`, unit-tested) and wired in `apps/web/src/App.tsx`:

| Visit | Unauthenticated | Authenticated, active-org onboarding incomplete | Complete |
| --- | --- | --- | --- |
| `/` | `/login` | `/onboarding` | `/dashboard` |
| `/signup` | signup form | — (public) | signup form |
| `/login` | login form | — (public) | login form |
| Successful signup | → `/onboarding` always | | |
| Successful login | → `/onboarding` when incomplete; else safe `returnTo` or `/dashboard` (`postAuthDestination`; `returnTo=/onboarding` never returns a completed user to the wizard) | | |
| `/onboarding` | `/login?returnTo=%2Fonboarding` | onboarding flow (standalone) | `/dashboard` |
| `/dashboard /agents /rooms /servers /deployments /models /integrations /channels /usage /billing /backups /settings` | `/login` | `/onboarding` (guard) | allowed |
| `/admin`, `/support` | separate staff surfaces — untouched by customer onboarding | | |

No redirect loops: `/dashboard → /onboarding` renders the flow; `/onboarding` + completed → `/dashboard` renders the shell (asserted by tests in both directions). When the durable state cannot be loaded (availability incident) the guard fails OPEN so users are never trapped; `/onboarding` itself always re-reads the authority and shows an honest retry state.

## 7. Onboarding steps

1. **Welcome / Workspace** — display name + workspace name (prefilled from `/api/me`, never re-asked), persona radio cards (founder/developer/agency/operations/other). Continue persists via PATCH and really updates user/org display names.
2. **Goals** — multi-select of 8 allow-listed goals; personalization only, never entitlements.
3. **AI / model setup** — "Use Mox-managed models" enabled only when the `mox` provider actually exists in this deployment's catalog; "Connect my own provider" uses the real BYOK flow (`POST /api/model-connections/:slug/connect` → customer credential vault; the key is never displayed again and never stored in onboarding state); "Configure later" records `deferred` and never shows "Connected".
4. **First agent** — real agent authoring (`POST /api/agents/drafts`, Simple Mode: name, role, instructions, model from `/api/models` availability, permission preset, sandbox target) or honest defer.
5. **Infrastructure** — real commercial state (`GET /api/billing/entitlements`: included server count + compute class; `GET /api/servers` states). "Provision my server" calls the real order authority (`POST /api/servers/orders` with an org-scoped idempotency key) — nothing is auto-provisioned; defer is always available when not entitled/unavailable. No wholesale prices, provider credentials or internal SKUs are displayed.
6. **Connections / Ready** — real configured counts for channels/integrations/API tokens (channels note they bind to an agent); one-click real API token creation (shown once); readiness review derived from REAL resource state; `Finish onboarding` calls `POST /api/onboarding/complete` → `/dashboard`.

## 8. Screenshots / visual notes

Light theme, captured from the dev-only UI Studio at 1440×950 and 390px. The flow is fully chrome-free — no header, no footer band, no sidebar: one centered card holding the progress indicator, the step content and an inline Back/decision action row (the toolbar visible above the card in the studio captures is the dev-only UI Studio chrome, not the product):

- `docs/verification/assets/onboarding-step1-light.png` — step 1: progress bar + step chips, prefilled form, persona cards, inline Continue.
- `docs/verification/assets/onboarding-step6-review.png` — step 6: real connection counts + readiness review (Completed items green: Connected/Created/Running/3 Configured) with the inline action row.
- `docs/verification/assets/onboarding-provider-unavailable.png` — "Use Mox-managed models" honestly disabled with the deployment reason; Continue blocked until a valid choice.
- `docs/verification/assets/onboarding-mobile-390.png` — ~390px: stacked layout, wrapped step chips, no horizontal overflow.

## 9. UI Studio onboarding preview (development only)

Run `pnpm ui:studio`, open `http://localhost:5174/__ui?surface=customer&page=/onboarding&theme=light`. Use the **Onboarding** selector (or the `onboarding=` URL param): `step1 … step6`, `error` (state-load failure with retry), `provider-unavailable` (managed models disabled, no BYOK connected, server entitlement 0), `mobile` (390px frame). The preview renders through `MoxPreviewProvider` with deterministic fixtures (`uiStudio/mockStore.ts`), is gated by `isUiStudioAllowed()` (DEV + `VITE_MOX_UI_STUDIO=1` + localhost) and renders a fake 404 in production builds. It is visual-only: it never touches real onboarding authority, and `/onboarding` is registered ONLY in the studio page list — never in `CUSTOMER_NAV` (the sidebar).

## 10. Confirmation: onboarding has no sidebar, header or footer

`CustomerSurface` returns `<OnboardingView />` before the `CustomerShell` wrap (the same pattern as the public auth pages), so no customer sidebar/topbar can appear. The flow itself renders a single centered card with NO header (no brand bar, user email or sign-out control) and NO footer band — Back/Continue are an inline action row inside the card, and the accessible progress indicator lives at the top of the card. SSR tests assert the rendered flow contains no `sidebar`/`nav-scroll`/`topbar-customer`/`onboarding-top`/`onboarding-footer`/`Sign out` markup, no `/onboarding` entry exists in `CUSTOMER_NAV`, and step 1 renders no Back control. Screenshots confirm visually.

## 11. Confirmation: dashboard CSS/design system reused

No new palette, radii, fonts or shadows were introduced. The onboarding shell and setup card are built from the existing tokens (`--bg*`, `--text*`, `--accent`, `--good/--warn/--bad` + tints, `--r-*`, `--space-*`, `--type-*`, `--shadow-*`, `--line*`) and shared primitives (`Button`, `Badge`, `LoadingState`, `ErrorState`, `MoxLogo`, global input styling, `.mastra-error-box`). New classes (`onboarding-*`, `setup-*`) only compose these tokens, so light and dark themes both follow the system automatically.

## 12. Deferred vs completed semantics

- A deferred external setup is a REAL recorded decision (choice column set, step marked complete) that never marks the feature configured: the review derives from live resource state (`/api/models` availability, agent count, `server_orders` states, connected integrations/channels/tokens).
- Distinct visual states: `Complete` (green), `Pending` (neutral), `Deferred` (neutral — never a green check), `Needs attention` (warn — choice recorded but resource absent), `Unavailable` (red with reason: not entitled, provider/catalog absent, state-load failure). Unit-tested: `deferred` badge tone is never `good`; provisioning shows `Provisioning`, not `Running`.
- Server enforcement: `modelProviderId` only accepted with `own_provider`; `agentId`/`serverOrderId` must be real org-owned rows; `status` is not PATCHable.

## 13. Existing-user migration behavior

Migration 0020 backfills all pre-existing organizations as `completed` (idempotent `ON CONFLICT DO NOTHING`), so no existing account can be locked out; the PG test replays the exact backfill statement against a legacy org inserted directly via SQL. Organizations created after the migration through customer signup insert a `not_started` row inside the signup transaction. The platform-setup bootstrap org (created post-migration by `completePlatformSetup`) is intentionally left without a row — it reads as `not_started`, i.e. it goes through onboarding like any new customer workspace.

## 14. Tests and totals

- `services/control-plane/tests/onboarding.test.ts` — **10 PG-gated tests**: signup→not_started (row created by signup, GET read-only), step-1 real rename of user+org, invalid persona/goal/cross-step field rejection, PATCH cannot set `status`, completion gating (409 with missing steps), real-agent reference required (invented id → 400) and created-vs-deferred distinction, invented server order → 400 + deferred path, full 6-step flow → idempotent completion + durable audit row + post-completion PATCH 409, per-org isolation + resume after logout/login, role enforcement (member PATCH → 403) + unauthenticated 401 + migration backfill replay.
- `apps/web/tests/onboarding-routing.test.ts` — **14 tests**: full routing matrix (every product route × every status), root behavior, `/onboarding` self-render, completed→dashboard, fail-open on unknown state, no redirect loops, post-auth destinations (signup/login × returnTo), studio URL round-trip + unknown-state rejection + `/onboarding` absent from `CUSTOMER_NAV`.
- `apps/web/tests/onboarding-review.test.ts` — **6 tests**: workspace/goals derivation; model connected-vs-deferred-vs-attention-vs-pending (deferred badge never green); agent created/deferred; infrastructure running/provisioning/error/deferred/unavailable/provisioned-but-missing; connections real counts.
- `apps/web/tests/onboarding-view.test.ts` — **7 SSR tests**: no sidebar/app chrome; shared primitives present; accessible progressbar (`aria-valuenow`, `aria-valuemax`, `aria-current`); form labels + semantic radios; review rows on step 6; honest load-failure state; disabled Mox-managed option when unavailable.
- Updated: `apps/web/tests/preview-navigation.test.ts` (studio page list = sidebar destinations + onboarding).

Totals after the change: **725 passed / 103 skipped** (skips are PG-gated suites) plus the PG-gated run below. Playwright/browser E2E does not exist in this repo (no config/deps), so routing/resume behavior is covered by the HTTP+PostgreSQL integration tests and SSR view tests; manual browser verification was performed via the UI Studio (screenshots above).

## 15. PostgreSQL results

`powershell -ExecutionPolicy Bypass -File scripts/run-postgres-verification.ps1`:

- Provisioned a disposable cluster, created `mox_verify`, applied **all migrations including `apply 0020_org_onboarding_state.sql`**.
- PG-gated suites (now including `tests/onboarding.test.ts`): **6 files passed, 107 tests passed** (`tests/onboarding.test.ts` alone: 10 passed).
- Pre-0006→current upgrade drill: PASS.
- Final line: `PASS: real PostgreSQL verification completed.`

## 16. Remaining Critical/High/Medium findings

- **None Critical/High.**
- Medium: `POST /api/model-connections/:slug/test` and `GET /api/cli-engines` are honest 501s on this deployment (pre-existing); the onboarding UI never claims a tested connection.
- Medium (informational): `pnpm dependency-security` reports **1 pre-existing moderate** advisory (`--audit-level high` gate passes; no dependencies were added by this change).
- Low: the org/workspace display-name rename performed by onboarding step 1 is direct-but-validated within the PATCH handler; a general org-settings endpoint can supersede it later.

## 17. External / live-provider items requiring manual validation

- Actual provider connectivity (OpenAI/Anthropic/… API keys) — the credential vault stores keys, but live model calls are runtime-side.
- Real VPS provisioning through a live compute provider (Hetzner/Contabo) — tests use the orchestrator authority with the Fake provider.
- Channel OAuth/token validity for Telegram/Slack/Discord/WhatsApp/Teams.
- Email delivery of platform notifications (onboarding completion writes an audit row; no email is required).
- Billing/checkout provisioning flow that grants `included_server_count` (step 5 reflects entitlement truth but does not itself sell anything).

## 18. Confirmation: no push occurred

All work is committed **locally only** (`feat(onboarding): add mandatory standalone customer onboarding`). No `git push` was executed; `master` remains ahead of no remote by push.
