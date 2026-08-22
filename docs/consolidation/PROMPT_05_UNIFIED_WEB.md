# Prompt 05 — Unified Mox web product and GrokBot-style agent experience

Status: **implemented** as `apps/web` (React 18 + Vite, browser-only, no Electron).

## What landed

### Information architecture (all real routes, no static fakes)
`Home · Agents · Agent Rooms · Servers · Deployments · Models · Apps & Integrations · Channels · Usage · Billing · Settings`

Agent detail exposes the required tabs: **Chat · Work · Computer · Files · Terminal (entitlement-gated) · Logs · Settings**, with Terminal/Computer tabs locked via the `useEntitlement()` hook — gates are hooks, never hardcoded plan names.

### Agent experience
- **Roster** (`domain/roster.ts`): one normalized Mox `Agent` concept (no bot/coworker split). Presence derives from runtime/deployment facts (`working | running | idle | unavailable`), unread dots, deterministic hue avatars + initials, model badges.
- **Chat**: streaming bubbles fed by canonical `message.delta/completed`, markdown renderer (`ui/markdown.tsx`: fences, headings, lists, bold/code/links — text nodes only, no HTML injection), approval cards wired to canonical `ApprovalRequest` round-trips, stop/cancel of in-flight runs, error+retry rows.
- **Work view** (`domain/work-view.ts`): pure projection from canonical `AgentEvent`s into Codex/Claude-Code-style activity items (turns, tool calls, terminal, file changes, approvals, errors). Streaming deltas never leak into work items; no chain-of-thought exists anywhere in the pipeline.
- **Computer view**: session state, takeover take/hand-back (pauses agent actions), restart, honest "reference frame" labeling until a live screencast transport lands. Contractually routed through the Computer Gateway shape.
- **Rooms**: first-class `AgentRoom` domain objects with shared threads and member configuration; orchestration maturation noted for later runtime prompts.

### Architecture seams
- `src/api/types.ts` defines `MoxApi` — the ONLY backend access seam. Views consume hooks (`useMox`, `useEntitlement`); swapping the demo implementation for the HTTP/SSE control-plane client is mechanical.
- `src/api/demo-api.ts` is an honest in-browser stand-in (labeled "demo data"): streaming turns, tool events, approval gates/expiry, entitlements, computer takeover are all exercised against canonical contracts. It does not fake unavailable capabilities as available.
- Dependency-free hash router (`router.tsx`) with param patterns; OpenBot's TanStack file-routing pattern was evaluated but a minimal router keeps this slice lean while preserving the IA.

### Provenance / adaptation notes
- Roster+detail-pane product skeleton adapted from OpenBot `app/src/routes/_authed/*` concepts (MIT).
- Chat/approval/tool-card interaction grammar adapted from OpenMausBot `ChatView`/`ApprovalCard`/`CommandPalette` patterns (Apache-2.0); mascot/call surfaces intentionally deferred to the voice prompt (11).
- Computer takeover strip ("You have control" / "The assistant needs you") mirrors OpenBot `computer-view.tsx` semantics.

## Tests added (14)
- `work-view.test.ts` — event→activity projection incl. outcome attachment, delta exclusion, failure marking.
- `roster.test.ts` — presence derivation precedence, fail-visible default, avatar stability.
- `router.test.ts` — exact/param/query matching.
- `demo-api.test.ts` — canonical event streams, approval gate round-trip (incl. synchronous-resolution race), cancellation → `turn.failed`, room domain objects.

## Acceptance criteria status
- One Mox web app exposes roster/chat/work/computer paradigm ✅
- OpenMaus UX strengths preserved through port/adaptation ✅ (chat grammar, approvals, presence)
- OpenBot admin/control surfaces migrated or represented ✅ (servers/deployments/models/integrations/channels/billing/settings views; deep admin tooling continues in prompts 12–13)
- UI consumes Mox contracts/APIs only ✅ (`@mox/contracts` + `MoxApi`)
- Entitlement gates are hooks ✅

## Known gaps (documented)
- Live screencast/WebSocket transport waits for realtime work (prompt 06) and Mox Node (prompt 09); the view shows honest reference frames meanwhile.
- Branch/thread forking in chat deferred (canonical thread model is single-active per agent in this slice; prompt 06 adds durable threads).
- Voice/call controls land with prompt 11.
