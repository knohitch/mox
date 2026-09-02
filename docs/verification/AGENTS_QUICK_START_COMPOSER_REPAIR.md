# AGENTS_QUICK_START_COMPOSER_REPAIR

Prompt 01 — Fix the Agents Hub composer, first-message flow, agent selection, and thread creation.

## Starting state

- Starting SHA: `f85a8092a3af97acd08ae10368cabc383234e660` (master, identical to `origin/master`).
- Working tree: tracked files clean at start. One pre-existing **untracked** scratch file
  `fix_icons.py` (dated 2025-08-30, a one-off icon-replacement script) was present at repo root.
  It was **not** authored by this change, was **not** modified or deleted, and is **not** part of the commit.
- Branch: `master`. No push was performed.

## Files changed

| File | Change |
| --- | --- |
| `apps/web/src/domain/first-message.ts` | **New.** Shared first-message flow: `startConversation`, `deriveSafeTitle`, `FALLBACK_THREAD_TITLE`, `EMPTY_THREAD_SUGGESTIONS`. |
| `apps/web/src/views/AgentsView.tsx` | Hub composer wired to real thread/message APIs; agent card behavior; empty-thread composer; Recent loading; rail controls; a11y. |
| `apps/web/src/uiStudio/mockStore.ts` | Studio mock store now serves fixture messages so "existing conversation" previews with content; `createThread` echoes the requested title. Preview only — no real APIs, no PostgreSQL. |
| `apps/web/src/styles.css` | Styles for `.aw-agent-picker`, `.aw-composer-hint`, invalid/busy states, agent-card selected state, focus-visible rings. |
| `apps/web/tests/agents-first-message.test.tsx` | **New.** 16 focused tests (logic + server-rendered UI states). |

No backend, API-contract, or database code changed, so `run-postgres-verification.ps1` was not required.

## Old broken behavior

- Hub "Ask anything…" `<textarea className="aw-composer" ... disabled>` and
  `<button className="aw-composer-submit" disabled>` — typing and sending were impossible; the bar was visual scaffolding only.
- Hub agent cards did only `setSelectedId(a.agentId)` — no real thread, no first message.
- Empty-thread suggested-prompt buttons were literal no-ops: `onClick={() => void 0}`.
- Recent thread rows set `selectedId`/`selectedThreadId` but never called `mox.loadThread`, so the chat pane rendered blank.
- The rail header plus opened the New Agent modal (overloaded control), and the chat header "Task" button
  eagerly created a durable thread titled "New chat" with no message — littering the thread store with empty threads.

## New Hub composer flow

`Agents Hub → type request → explicitly choose agent → createThread() → mox.send() → active conversation view → thread appears under RECENT`.

- The textarea is editable, multiline, draft held in component state (`hubDraft`); Enter sends, Shift+Enter inserts a newline.
- A native `<select>` agent picker (keyboard accessible, `aria-label="Choose agent"`) lists the real workspace agents.
- Send is disabled only when the draft is empty or the workspace has zero agents (or while the first-message flow is running).
- The whole flow goes through the canonical seam only: `mox.api.createThread`, `mox.loadThread`, `mox.send`, plus `syncAllThreads()` for the Recent rail. No raw URLs, no parallel chat path, no second thread store.

## Agent-selection behavior

- Send without an agent: the draft is preserved, a `role="alert"` hint "Choose an agent to continue." is shown,
  the picker is focused, and the picker is outlined invalid. After selecting an agent the user can send immediately.
  No silent default, no draft clearing, no raw error.
- Hub agent card with a draft typed: selects that agent as the composer's target, preserves the draft, never auto-sends
  (card gets `aria-pressed` + selected styling).
- Hub agent card with no draft: opens the agent's empty conversation/start state — no durable thread is created on selection.
- Rail agent rows behave as before (open agent start state) and now support Enter/Space.

## Thread lifecycle (no empty-thread litter)

`Select agent → empty-state composer → user types first message → createThread() → send() → active conversation`.

Durable threads are created **only** when the first message is actually sent. The chat-header button now
opens the empty conversation composer (label "New chat", `aria-label`/`title` "New conversation") instead of eagerly creating an empty thread.

## First-message flow (one shared implementation)

`startConversation(deps, { agentId, initialMessage })` in `apps/web/src/domain/first-message.ts`:

1. `createThread({ agentId, title: deriveSafeTitle(initialMessage) })` — server-minted thread id is authoritative.
2. `onThreadReady(agentId, threadId)` — selects the agent + thread so the UI transitions into the active conversation immediately (no flash back to the Hub).
3. `loadThread(agentId, threadId)` — initializes the thread in the store.
4. `send(agentId, threadId, text)` — canonical store pipeline (optimistic user bubble, streaming placeholder, `message.delta`, `message.completed`, `turn.failed`, approval refresh, cancel — all untouched).
5. `syncThreads()` — refreshes Recent.

The same flow powers: Hub composer first message, agent empty-thread composer (suggested prompts included),
and new-conversation first messages. Chat-composer behavior inside an existing thread was not rewritten.

## Thread title

`deriveSafeTitle` is deterministic and local: trims, collapses whitespace, clamps to 48 characters on a word boundary
with an ellipsis, and falls back to `"New conversation"`. No external AI call. The derived title is passed into `createThread`.

## Recent refresh

After the first message settles, `syncAllThreads()` re-pulls every agent's threads through `mox.api.listThreads`;
the new thread (with its derived title) appears under RECENT and is selected — no page refresh, authoritative data only.
Recent rows now also call `mox.loadThread` when opened, so clicking an existing thread loads its real messages (no blank chat),
and support Enter/Space activation with per-row `aria-label`s.

## Suggested prompts

All no-op buttons removed. In the agent empty-thread panel (and the in-thread empty state), suggestions now:
populate the composer draft, focus the composer, stay editable, and require Send to submit. No auto-send, no AI generation;
the list is a deterministic constant (`EMPTY_THREAD_SUGGESTIONS`) shared by both surfaces and addressed to the selected agent.

## Partial-failure behavior

- `createThread` failure: error surfaced inline (`role="alert"`), draft and selected agent preserved, user stays on the Hub; retry re-runs the flow (no thread was created).
- `send` failure after successful creation: the created thread stays selected; the canonical store surfaces the failure on the message bubble with Retry, so retries happen **inside** the thread and never mint a duplicate thread.
- `syncThreads()` still runs in the partial-failure path so the durable thread appears under Recent.
- Duplicate submissions are prevented: Send is disabled and the handler is guarded while the flow is running; a subtle busy state (`aria-busy`, "Starting conversation…" status) is shown.

## No-agent behavior

With zero agents the composer renders disabled (the only state in which it is disabled) alongside
"Create your first Agent to start a conversation." with an explicit **Create Agent** button. The rail header plus means
"New conversation" (focuses the Hub composer on the Hub; opens the selected agent's empty-state composer when an agent is active) —
agent creation remains the separate explicit footer action. Tooltips and `aria-label`s distinguish the two.

## UI Studio

`createMockMoxStore` now previews an existing conversation: `getMessages` serves a fixture exchange for the
preview thread and the store's `loadThread`/`messages` cache makes clicking a Recent row render it. Studio states
(`/__ui?surface=customer&page=/agents&state=…`) safely cover: Hub with no agent selected (populated default),
no agents (`state=empty`), selected agent + draft and selected-agent/no-thread (interactive in preview),
existing conversation (fixture messages), and error (`state=error`). Transient first-message loading / send-error
visual states are exercised by tests rather than dedicated Studio fixtures. Studio fixtures call no privileged APIs and mutate no PostgreSQL.

## Accessibility

Textarea `aria-label="Ask anything"`; picker is a native `<select>` with `aria-label="Choose agent"`, focusable and
outlined invalid on the no-agent hint; hint/status text uses `role="alert"`/`role="status"`; Send has `aria-label="Send message"`;
suggestion buttons are real `<button>`s with labels; Recent/agent rows and Hub cards support Enter/Space with
`aria-label`s; busy states are announced via `aria-busy`; decorative SVGs are `aria-hidden`.

## Tests

`apps/web/tests/agents-first-message.test.tsx` — 16 tests:
- `deriveSafeTitle`: trim, whitespace collapse, word-boundary clamp, fallback, determinism (5).
- `startConversation`: createThread exactly once with derived title, authoritative threadId used everywhere, store init + exact send args, no thread on empty message, creation failure preserves state, send failure keeps the thread for in-thread retry with Recent refresh (4).
- Hub (server-rendered): editable composer + real agent picker without a default selection, Send disabled on empty draft, cards are real buttons, New conversation vs Create Agent differentiation (4).
- Zero agents: disabled composer + explicit Create Agent only (1).
- Empty-thread composer: working suggestions (no `void 0`) plus functional composer; existing conversation renders messages without a blank chat (2).

Totals across the workspace after the change:
- `pnpm --filter @mox/web test`: **17 test files, 140 tests passed** (16 new).
- `pnpm test` (repo root): **82 files passed / 5 skipped, 699 tests passed / 93 skipped**.

## Verification results

| Command | Result |
| --- | --- |
| `pnpm --filter @mox/web test` | 140 passed |
| `pnpm --filter @mox/web run typecheck` | clean |
| `pnpm lint` | 0 errors (51 pre-existing-style warnings across 301 files) |
| `pnpm typecheck` | clean |
| `pnpm test` | 699 passed, 93 skipped |
| `pnpm build` | success |
| `pnpm public-branding-scan` | clean |
| `pnpm secret-scan` | clean |
| `pnpm scan:authority` | clean |
| `git diff --check` | clean (CRLF conversion warnings only) |

Backend/API/database code was not changed, so `scripts/run-postgres-verification.ps1` was not run.

## Confirmations

- **No default Agent was invented.** The composer requires an explicit user choice from the real workspace roster;
  there is no first-agent, "General Assistant", hidden, or random default anywhere in the flow. No user-configured
  default-agent authority exists in the repository, so none was integrated.
- **No fake thread IDs.** Thread ids come exclusively from `mox.api.createThread` responses (server-minted);
  `deriveSafeTitle` derives only display titles, never identifiers.
- **No fixture data in production.** Fixture conversation data lives only in the dev-only UI Studio mock store
  (gated by `isUiStudioAllowed`); production composes `HttpMoxApi` as before. Auth/entitlement guards are unchanged.
- **No push occurred.** Work is committed locally on `master` only.
