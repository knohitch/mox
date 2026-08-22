# Prompt 04 — Computer, policy, browser and runtime supervision

Status: **implemented in-repo** (reference drivers; real Chromium/Docker attach to the same seams inside Mox Node later).

## What landed

### Authoritative computer layer
- `runtime/computer-runtime` is the ONLY path from agent code to computers:
  - `provider.ts` — `ComputerProvider` contract advertising capabilities (browser, shell, filesystem, screencast, desktop-cua, mobile-device, human-takeover, profiles-cookies, aria-snapshots) + region/runtime constraints; `effectClassOf()` maps canonical `ComputerAction`s to policy effect classes.
  - `playwright-provider.ts` — default provider (id `mox-playwright`). Honest reference driver: per-session virtual page state, refuses shell unless entitled elsewhere, pauses agent writes during human takeover, scrubs screencast metadata via `@mox/security`.
  - `gateway.ts` — the canonical Prompt 04 flow, enforced in order:
    token verify → session-bound check → ownership (org+agent) → egress decision (navigate) → entitlement (computer/shell) → `PolicyEngine.decide` on server-resolved context → optional `ApprovalRequest` (+ scoped TTL grant + re-decide) → audit BEFORE provider → `ComputerProvider.execute`.
    Rejection codes: `unauthorized | not-entitled | denied | approval-denied | limit-exceeded | unknown-session`.
  - `supervisor.ts` — OpenBot-Supervisor-derived, Mox-owned: deterministic collision-safe container names (`mox-<org>-<agent>-<session>`, docker-name-safe sanitization), capacity cap, loopback-only internal control ports, health sweep with bounded restarts, crash reporting with scrubbed reasons, per-org listing isolation. `ContainerDriver` interface keeps Docker out until Mox Node.
  - `entitlements.ts` — fail-closed `StaticEntitlementChecker`; commercial engine arrives with Prompt 08.
  - `computer-tool.ts` — the single `computer` tool DSH/runtime registers; mints session-BOUND gateway tokens (`tokenFor(sessionId)`), opens sessions lazily, forwards actions only.

### Policy unification
- `packages/policy` `PolicyEngine` remains the ONE authority: deny > allow > grants > ask > default; broken expressions deny (fail closed); scoped expiring grants for approvals; full decision audit sink. DSH presets / OpenMaus auto-approve stay non-authoritative.
- Approval semantics unified on canonical `PolicyDecision`/`ApprovalRequest`. Explicit human refusal produces a distinct `approval-denied` gateway code (vs rule-based `denied`).
- The runtime seam deliberately does NOT double-ask: hosts seed `"computer"` into the run's `approvedTools` so the gateway flow is the only approval path.

### Security invariants (tested)
- Gateway tokens are required and session-bound — no session hopping, no direct browser-service access.
- Internal control ports (9222/5900/6080) must bind loopback only.
- Egress policy decides navigate targets server-side before policy/provider run.
- Screencast metadata + crash reasons are scrubbed (`redactMetadata`, `scrubLogLine`).
- Sessions are strictly per (org, agent); cross-agent/cross-tenant use audited then refused.
- Provider crashes release the provider session and drop ownership so restart re-opens cleanly.

## Provenance
- Policy precedence + audit-before-forward semantics adapted from `OpenBot-main/server/src/computer/{gateway,policy}.ts` (MIT).
- Supervisor naming/isolation concepts adapted from `OpenBot-main/supervisor/src/*` (MIT); Docker specifics deferred behind `ContainerDriver`.
- Takeover control-flow concept informed by `OpenMausBot-main/server/computer-control.ts` (Apache-2.0) — proposal-only patterns NOT made authoritative.

## Tests added (97 new across 5 files)
- `packages/policy/tests/engine.test.ts` — allow/deny/ask precedence, fail-closed broken rules, scoped/expiring/revocable grants, deny-beats-grant, audit trail.
- `packages/security/tests/security.test.ts` — egress exact/suffix/deny-beats-allow/default-deny/malformed/non-http, proxy binding, secret redaction, port invariants, token mint/verify/expiry.
- `runtime/computer-runtime/tests/gateway.test.ts` — happy path, direct-access rejection (incl. session-hopping), not-entitled, shell entitlement split, deny rules, approval approve/refuse/TTL-expiry, cross-agent + cross-tenant isolation, max-sessions limit, id collisions, crash→reopen, takeover pause/resume, screencast hygiene, egress enforcement.
- `runtime/computer-runtime/tests/supervisor.test.ts` — deterministic names/sanitization, capacity, port invariant, restart budget→crash, scrubbed crash reasons, org-scoped listing, lifecycle.
- `runtime/agent-runtime/tests/computer-tool.test.ts` — end-to-end DSH reference engine → computer tool → gateway → provider; denial surfaces as failed tool result; no second approval flow at runtime seam.

Infra note: root `vitest.config.ts` now aliases `@mox/*` to package SOURCES so tests never run against stale `dist/`.

## Acceptance criteria status
- DSH uses Mox Computer Gateway for computer/browser side effects ✅ (e2e test)
- One authoritative policy engine ✅
- Default browser runs through isolated Playwright computer runtime ✅ (reference driver behind real interface)
- Human takeover + screencast survive ✅
- Supervisor logic Mox-owned, embeddable into Mox Node later ✅

## Known gaps (documented blockers, per master guide)
- Real Chromium child process + Docker driver attach inside Mox Node (Prompt 09) behind existing interfaces.
- Entitlement source-of-truth waits for Prompt 08 (`StaticEntitlementChecker` is fail-closed meanwhile).
- Stale stray file `packages/database/src/schema/agents` (not exported) left untouched — cleanup belongs to a DB-touching prompt.
