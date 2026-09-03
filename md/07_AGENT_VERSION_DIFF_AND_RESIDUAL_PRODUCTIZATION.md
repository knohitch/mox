# MOX — PHASE 07
# PRODUCTIZE AGENT VERSION DIFF + CLOSE RESIDUAL HIDDEN/BLOCKED FEATURES

> ✅ **STATUS: DONE** — implemented and verified. See
> `docs/verification/PRODUCT_COMPLETION_07_RESIDUAL_MATRIX.md`.

Use **Gemini 3.1 Pro High**.

Work in `E:\MyCodes\Mox` on clean `master`. Preserve onboarding, DEV direct access, themes and all prior phases. Do not push.

## A. AGENT VERSION DIFF UI

The API already has/had `diffAgentVersions(agentId, from, to)` while the product UI historically lacked a real caller.

Expose it inside Agent authoring/version history.

Requirements:
- list immutable revisions;
- select `from` and `to`;
- Compare;
- render structured changes, not a raw JSON dump;
- identify current/published/deployed revision;
- preserve rollback;
- diff is read-only;
- never expose secrets.

Where supported, group changes around canonical AgentDefinition sections: identity, model, instructions, tools, integrations, channels, memory/knowledge, runtime, schedules/workflows, subagents, safety/settings.

## B. RESIDUAL PRODUCTIZATION AUDIT

Read current `docs/verification/UI_COMPLETION_FINAL_MATRIX.md`, all current API contracts and Phase 01–06 reports.

Rebuild the matrix from actual source.

Every previously `NOT_PRODUCTIZED_BLOCKED` feature must now be:
1. productized and visible;
2. intentionally retired because the concept is obsolete; or
3. code-complete but externally unavailable because a deployment component/credential is absent.

There must be no functioning legitimate Customer/Admin/Support capability hidden from its intended surface.

### Search for

- API methods with zero production UI/CLI callers;
- `501` / `not_configured`;
- TODO/FIXME/HACK;
- no-op buttons;
- invalid `disabled` controls;
- `return []` masking unavailable state;
- `onClick={() => void 0}`;
- `href="#"`;
- hidden tabs/dead routes;
- backend mutations with no intended product surface;
- UI actions with no backend authority;
- customer features visible only in Studio;
- staff features missing from staff navigation.

Classify every match. Do not surface backend-only webhooks/node enrollment as customer UI.

### Expected closure from earlier phases

Verify:
- thread archive already productized;
- server provisioning Phase 02;
- Room shared chat Phase 03;
- computer/files/terminal/logs Phase 04;
- model probes/CLI state Phase 05;
- support escalation Phase 06;
- Agent version diff this phase.

If a bounded defect remains, repair it. If a major external/deployment dependency remains, classify it explicitly rather than fake it.

DEV Customer/Admin/Support direct fixture shortcuts must reflect the newly productized surfaces.

## TESTS / VERIFICATION

Add tests for diff UI and residual classification. Run full repo gates and PostgreSQL if authority changes.

Report:
`docs/verification/PRODUCT_COMPLETION_07_RESIDUAL_MATRIX.md`

The matrix must include capability, intended surface, route/UI, API/service authority, gate, external dependency, final classification. Zero unclassified rows.

Local commit:
`feat(ui): productize version diff and close residual surfaces`

Do not push.
