# PRODUCT COMPLETION — PHASE 03
# Agent Rooms Shared Conversation Verification

Starting SHA: `cc58989a2e46068d9a9fe015eb1c8f5e5f2a8a30`

## Summary

Agent Rooms now have real, durable shared conversations. The `/rooms` page has a full chat interface with message history, agent targeting, and composer. Messages persist through the canonical thread/message authority and survive refresh.

## What Was Built

### Backend

- **`GET /api/rooms/:roomId/messages`** — lists messages in a room's shared thread with agent name resolution. Returns empty array for rooms with no messages yet.
- **`POST /api/rooms/:roomId/messages`** — sends a user message to a room. Supports `targetAgentId` for single-agent targeting. Without targeting, invokes up to 3 member agents sequentially (bounded to prevent recursive loops). Updates `agentRooms.lastMessage` and `lastMessageAt`.
- **`ensureRoomThread()`** — internal helper that lazily creates a backing thread + `roomThreads` link on first message. Uses first member agent as thread owner (satisfies `threads.agentId NOT NULL`). Thread creation is transactional.
- **Import**: Added `roomThreads` to control-plane API imports.

### Frontend

- **`RoomsView`** (`MiscViews.tsx`): Replaced "not yet available" empty state with full chat interface.
- **`RoomChatPanel`** component:
  - Message history with auto-scroll
  - Agent identity badges (user = accent, agent = good, system = neutral)
  - Agent name resolution (display name, not raw id)
  - Target agent selector dropdown (All agents / specific member)
  - Composer with Enter-to-send
  - Loading/error/empty states

### API Client

- **`types.ts`**: Added `RoomMessage` interface. Added `getRoomMessages` and `sendRoomMessage` to `MoxApi`.
- **`http-api.ts`**: Added `getRoomMessages` and `sendRoomMessage` HTTP methods.
- **`demo-api.ts`**: Full in-memory room conversation demo with agent response simulation.
- **`store.tsx`**: Added room message methods to `failingApi`.
- **`mockStore.ts`**: Added room message fixtures for UI Studio.

### Tests

Added 6 new tests in `apps/web/tests/authoring-versioning.test.ts`:

| Test | Coverage |
|------|----------|
| Messages persist and reload | Send + getRoomMessages round-trip |
| Single agent targeting | targetAgentId invokes only that agent |
| All agents broadcast | No target invokes multiple agents |
| Agent display names | Agent messages show display name, not raw id |
| Return value shape | sendRoomMessage returns message + turns |
| Empty history on create | New rooms start with no messages |

## Verification Results

| Gate | Result |
|------|--------|
| `pnpm typecheck` | PASS (all 37 workspace projects) |
| `pnpm test` | PASS (85 files, 730 tests passed, 107 skipped) |
| `git diff --check` | PASS (no whitespace errors) |
| Room tests (21 total in file) | PASS |

## Architecture Decisions

- **Thread per room**: A room gets one backing thread via `roomThreads` table. The thread's `agentId` is the first member agent (schema constraint), but actual authorship is tracked via `threadMessages.authorKind`/`authorId`.
- **Lazy thread creation**: Thread is created on first message, not on room creation. This avoids empty threads for rooms that are never used.
- **Bounded agent invocation**: Max 3 agents per message to prevent recursive loops and respect concurrent-Agent limits. Sequential execution, not parallel.
- **No client-only thread ids**: Room threads are server-authoritative via `roomThreads` table. No synthetic `room:<id>` ids.

## Security Preservation

- Room membership validated server-side (org-scoped).
- Cross-org agent rejection preserved.
- `requireCommercialMutation` gate on message send.
- Agent runtime failures don't block other agents.
- No provider credentials exposed.

## Files Modified

- `services/control-plane/src/api.ts` — room message endpoints + `ensureRoomThread`
- `apps/web/src/api/types.ts` — `RoomMessage` type, new API methods
- `apps/web/src/api/http-api.ts` — room message HTTP methods
- `apps/web/src/api/demo-api.ts` — room conversation demo fixtures
- `apps/web/src/api/store.tsx` — added room methods to failingApi
- `apps/web/src/uiStudio/mockStore.ts` — room message Studio fixtures
- `apps/web/src/views/MiscViews.tsx` — room chat UI
- `apps/web/tests/authoring-versioning.test.ts` — 6 new room tests
- `md/02_CUSTOMER_SERVER_PROVISIONING.md` — marked as done

## External Deployment Requirements

- `agent_rooms` entitlement must be enabled for the org.
- Room requires at least one member agent before messaging.
- Agent runtime must be configured for actual agent responses (demo mode simulates them).
