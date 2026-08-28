# UI Parity 02 — Customer Core: Authoring, Versioning, Infrastructure & Honest Unavailable States

Date: 2026-08-28

Phase 2 of the UI parity sweep. The customer surface now drives the real
server-backed authoring/versioning/deployment model instead of a synthetic
address space. Key correctness fix from the earlier increment stood: the UI
addresses agents by the **server row id** (`AgentSummary.agentId`), never the
engine-facing `definition.agentId` — threads created with the engine id would
500 against the UUID-typed `threads.agentId` column.

## D. Real thread lifecycle (chat correctness fix — retained)

- `MoxApi.createThread`/`listThreads`/`archiveThread` backed by real routes;
  `AgentDetail` owns a real thread list and an honest empty state.
- `HttpMoxApi.send` surfaces honest turn results (no invented `turn.failed`),
  and the new `archiveThread` filters archived threads from the roster list.

## B. New Agent authoring (Simple + Developer)

- `AgentsView` gains a **+ New Agent** modal (`NewAgentModal`); gated by the
  `max_agents` entitlement.
  - **Simple** mode: name/role/instructions/model/tools/browser/permission
    preset/target. Input compiles into the canonical `AgentDefinition` via
    `createAgentDraft` (`SimpleAgentInput` mirrors the server `SimpleModeInput`
    shape: `provider/model`, `permissionPreset`, `target`, optional
    voice/channels/schedule/knowledge).
  - **Developer** mode (entitlement-gated by `hasDeveloperMode`): raw JSON
    `AgentDefinition` editor, validated server-side.
- Draft agents appear in the roster with a `draft` badge and a counters row
  "(N) drafts unpublished"; drafts are addressable by the same row id.
- `DemoMoxApi` (dev-only in-memory stand-in) compiles both modes to
  `AgentDefinition.parse`-valid definitions locally; `store.tsx` adds
  `refreshAgents()` so the roster resyncs after authoring.

## C. Versions / publish / rollback

- `AgentDetail` → Settings gains a **Versions** panel:
  - Revision table from `listAgentVersions` (rev, changelog, by, at, live badge).
  - **Publish** (with optional changelog) → `publishAgent`.
  - **Rollback** per prior revision (confirm) → `rollbackAgent`; reverts the
    working copy honestly and resyncs.
  - `currentVersion` is shown honestly (`vN live` / `unpublished draft`).
- `diffAgentVersions` surfaced in the demo/test path.

## J. Settings tab

- `SettingsTab` expands by `authoring.mode`:
  - Simple-mode agents: inline-edit role / instructions / permission preset /
    browser toggle → `updateAgentDraft`, saved as an unpublished working copy.
  - Developer-mode agents: inline editing disabled with an honest note; model
    stays switchable.
  - Model selector now emits `provider/model` and calls `updateModel` against
    the row id (previously sent bare model ids → hosted would reject).

## H. Server lifecycle actions

- `ServersView` adds per-server actions via `serverAction(orderId, …)`
  (Restart / Stop / Start / Resize-with-compute-class-code / Cancel), using
  `ServerSummary.orderId`; states reconcile from the orchestrator (no fake
  success states).

## I. Deployments

- `DeploymentsView` gains **+ Deploy** (`DeployModal`: agent + published
  revision + target via `deployAgent`), per-row **Redeploy** and **Rollback**
  (`listAgentVersions` revision picker → `deploymentRollback`), publishing
  only pins published revisions.

## F. Agent workspace tabs honesty

- Computer / Files / Terminal / Logs tabs render an explicit **Not configured**
  state when their routes report 501 (`FeatureUnavailable`), instead of an
  empty-looking surface. Terminal keeps the fail-closed posture: a
  not-configured reply disables the command form. Tab switches never trigger a
  guaranteed-501 endpoint.

## K. Web tests

- `apps/web/tests/authoring-versioning.test.ts` (48 web tests total, 9 files):
  draft lifecycle (create → publish → update → diff → rollback), duplicate-slug
  rejection, Simple-mode round-trip (`simpleInputFromDefinition`), thread
  archive, server lifecycle transitions/resize class requirement, and
  deployment published-revision gating — all pure-logic, no backend.
- `apps/web/src/domain/authoring.ts` holds the shared round-trip logic
  (`simpleInputFromDefinition`, `permissionPresetFromDefinition`,
  `slugFromName`).

## Addressing (row id vs engine id)

Hosted `/api/agents` returns the row id in its response envelope; the
`definition.agentId` stays engine-facing (`agent_<uuid>`). `AgentSummary`
carries a documented `agentId` (row id) and every mutating route call uses it.
Demo mode keeps `agentId === definition.agentId` (no separate DB row) and is
clearly labeled dev-only.

## Verification (green)

- `apps/web`: `pnpm typecheck` clean.
- `apps/web`: `pnpm test` → 48 passed / 9 files.
- `services/control-plane`: `pnpm typecheck` clean (tsc + test tsconfig).
- `services/control-plane`: `pnpm test` → 39 passed (DB-gated tests skip
  without `MOX_TEST_DATABASE_URL`).
- `git diff --check` clean (LF/CRLF warnings only).

## Remaining Phase 2 scope (not done — documented)

- E. Turn-execution honesty requires composing the dormant
  `services/agent-control` engine into the control plane; the routes report
  not-configured honestly and the UI surfaces it (§F) rather than faking.
- Subsequent phases 03–07.