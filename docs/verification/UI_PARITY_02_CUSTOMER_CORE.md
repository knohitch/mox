# UI Parity 02 — Customer Core: Real Thread Lifecycle & Honest Room State

Date: 2026-08-28

Phase 2 (partial) of the UI parity sweep. This increment fixes the correctness-critical defects on the customer surface: the chat/agent UI was using **synthetic thread IDs** (`t_<agentId>`, `room:<id>`) against the UUID-typed `threads` DB column, guaranteeing HTTP 500 on any thread load/send. This phase makes the UI use **real hosted thread lifecycle** and stops fabricating an unavailable room-thread authority.

## D. Real thread lifecycle (chat correctness fix)

Before:
- `AgentDetail` (AgentsView) computed `threadId = \`t_${agentId}\`` and passed it to `loadThread`/`send`/`messages`. The backend `threads.id` column is a real UUID, so every such call hit a guaranteed 500. There was no way to create or select a thread.
- `HttpMoxApi.send` swallowed the backend response and **always** emitted a synthetic `turn.failed` on success — faking failure regardless of the real result.

After:
- `MoxApi` gains `createThread({ agentId, title? }): Promise<{ threadId }>` in `apps/web/src/api/types.ts`.
- `HttpMoxApi.createThread` → `POST /api/threads` (returns a real UUID thread). `HttpMoxApi.send` now surfaces the backend's honest result: a 2xx means the turn was accepted (no invented `turn.failed`); only a throw emits `turn.failed` with the real error.
- `demo-api.ts` (dev-only in-memory impl) gains a matching `createThread` that mints a real UUID thread and mirrors new-method parity.
- `store.tsx` `failingApi` mirrors `createThread`.
- `AgentDetail` now owns a real thread list: loads threads via `mox.api.listThreads(agentId)`, auto-selects the first, exposes a thread selector list, a enabled **+ New Chat** action (creates a real thread via `createThread`), an honest "No conversation yet" empty state, and passes the real `threadId` to `ChatTab`/`WorkTab`.

## E. Turn execution honesty

`HttpMoxApi.send` no longer fabricates success/failure. When no turn-execution engine is composed, the backend returns an honest not-configured error which is now surfaced verbatim via `turn.failed` (previously replaced by a hardcoded message). The missing production component (a runtime/turn-execution engine) is documented as remaining scope.

## G. Agent rooms (create + honest room thread)

Before:
- `RoomsView` had **no** create affordance and rendered the room's shared thread with the fabricated id `room:${roomId}`, then called `mox.send(.., 'room:...')` — guaranteed 500.
- There is no canonical room-scoped thread authority (threads are per-agent), so a shared multi-agent thread is not representable.

After:
- `RoomsView` adds a real **+ Create Room** flow (title + member-agent checkboxes) backed by `mox.api.createRoom({ title, memberAgentIds })`, which persists transactionally (Phase 1 §E).
- The shared-room chat panel no longer fabricates `room:<id>`; it renders an honest "Shared room chat is not yet available on this deployment" state rather than calling a guaranteed-failing endpoint.

## Verification (green)

- `apps/web`: `pnpm typecheck` clean.
- `apps/web`: `pnpm test` → 38 passed / 8 files.

## Remaining Phase 2 scope (not done — documented)

- B. Agent creation/authoring (Simple + Developer modes).
- C. Draft / version / publish / diff / rollback / deploy — requires composing the dormant `services/agent-control` engine into the control plane (not runtime-testable here; high risk).
- F. Workspace tabs honesty pass.
- H. Server lifecycle mutation routes.
- I. Deployment mutation routes.
- Subsequent phases 03–07.
