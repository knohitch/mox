# AGENTS_CONVERSATION_FLOW_FINAL

Prompt 02 — second-pass trap catcher and UX refinement for the Agents conversation lifecycle.

## Starting state

- Starting SHA: `b4f851e3298f103ec0727e0e21fe67a2e5d8d3d9` (local `master`, one commit ahead of `origin/master` at `f85a8092…`; nothing was pushed or reset).
- Prompt 01 local commit found at start: `b4f851e fix(agents): wire hub composer to real thread and message flow`.
- Working tree: only the known pre-existing untracked scratch file `fix_icons.py` (left untouched, not committed).

## Files changed this pass

| File | Change |
| --- | --- |
| `services/control-plane/src/api.ts` | `GET /api/agents/:agentId/threads` now also returns the authoritative `status` ("active"/"archived") so clients keep archived threads out of Recent. Additive; store remains the single authority. |
| `apps/web/src/api/types.ts`, `apps/web/src/api/http-api.ts` | `listThreads` result type gains optional `status?: string` (additive, backward compatible). |
| `apps/web/src/views/AgentsView.tsx` | Archive action; message-loading and thread-load-error states; workspace loading/zero-agent/error gating; Recent loading/empty/no-match states; scroll reset on thread switch; dead controls removed; model badge made honestly non-interactive. |
| `apps/web/src/domain/thread-actions.ts` | **New.** `archiveCurrentConversation` — canonical archive flow with safe fallback and error surfacing. |
| `apps/web/src/uiStudio/mockStore.ts` | Studio previews: running state (streaming bubble + active run), open approval card, second fixture thread, `createThread`/`send` failures in the `error` state. |
| `apps/web/src/styles.css` | Error banner, footer-button reset, non-pointer model badge, lone-toolbar-action alignment. |
| `apps/web/tests/agents-first-message.test.tsx` | +11 tests (ordering, archive, loading/error states, dead-control assertions). |
| `apps/web/tests/agents-layout.test.tsx` | Mock store completed with `ready`/`error`/`needsAuth` (realism, not weakened). |

## A. Six user-flow traces (code-path + test evidence)

| # | Flow | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Hub composer: type → choose agent → Send → durable thread → exact message → active conversation → Recent updated | **PASS** | `startFromHub` → `startConversation`; tests assert `createThread` exactly once with derived title, `send(a1,"th_9","Hello world")` with exact text, canonical order `create → ready → load → send → sync`, and selection transition via `onThreadReady`. |
| 2 | Choose Agent first: card → empty state → first message → Send → real thread | **PASS** | Card with no draft opens the agent's start state (`setSelectedId`, no thread); `EmptyThreadPanel` send uses the same `startFirstMessage`; no thread is created on selection. |
| 3 | Suggested prompt: select agent → click suggestion → draft populated → edit → Send | **PASS** | Suggestions set the composer draft and focus it (`setDraft(s); inputRef.current?.focus()`); tests assert suggestions render as real labeled buttons and the composer stays editable; Send still required. |
| 4 | Existing Recent thread: click → messages loaded → send follow-up | **PASS** | `openRecentThread` awaits `mox.loadThread` with loading + error states; ChatTab renders loaded messages (test renders a fixture conversation) and the untouched canonical composer sends follow-ups. |
| 5 | New Conversation: rail/header plus → fresh no-thread composer → first message → exactly one durable thread | **PASS** | Rail plus and header "New chat" clear `selectedThreadId` only; first send goes through `startConversation` (thread created exactly once — asserted). |
| 6 | Partial failure: createThread ok → send fails → same thread stays selected → retry creates no duplicate | **PASS** | `startConversation` calls `onThreadReady` immediately after creation and never re-creates on send failure; test asserts exactly one `createThread`, thread still selected, `onError` reported, Recent still synced. |

## B. Dead interactions found / fixed

| Item | Finding | Action |
| --- | --- | --- |
| `onClick={() => void 0}` | None remaining (removed in Prompt 01). | Verified by test (`void 0` absent). |
| `href="#"` | Footer "Create Agent" used `<a href="#">` + `preventDefault`. | Replaced with a real `<button type="button" aria-label="Create Agent">`; test asserts no `href="#"` remains. |
| "Add context" plus in the active composer | Clickable-looking icon button with no handler — a no-op. | **Removed** (see C). |
| Model badge chevron | Chevron implied a dropdown that did nothing. | Chevron removed; badge is explicitly non-interactive with a "change it in Settings" tooltip (see D). |
| Hub composer disabled | Fixed in Prompt 01; disabled now only while sending or when zero agents. | Tests assert editability in populated state and disabled only in the zero-agent state. |
| Suggested prompts / thread rows | Fixed in Prompt 01 (`void 0` gone; rows call `loadThread`). | Re-verified. |

## C. Add context audit

The active composer's plus button ("Add context") had no handler. Authority check: the canonical send route
`POST /api/threads/:threadId/messages` accepts `{ text }` only; there is no per-message attachment contract for
files, knowledge sources, integrations, or room context (knowledge sources exist only as agent-level bindings
in Settings; rooms have no message-context seam). **No real authority exists → the control was removed.**
No fake attachment UI remains.

## D. Model control audit

The header model badge rendered a chevron (dropdown affordance) but was static. Real model-selection authority
(`updateModel` + model list) already exists and is exposed in the agent Settings tab. Decision: **render the header
badge as an honest non-interactive badge** (chevron removed, pointer cursor removed, tooltip
"Model … — change it in Settings") rather than duplicating Settings' select in the cramped header. Test asserts the
badge contains no chevron SVG and carries the explanatory tooltip.

## E. Thread archive

- New archive icon button in the chat header (visible only when a thread is open), `aria-label`/`title` "Archive conversation".
- Flow: `api.archiveThread(threadId)` → selection falls back to the agent's start state → `syncAllThreads()` refreshes Recent.
- Recent exclusion is now **server-truthful**: the list route exposes the authoritative `status`, and Recent filters `archived`
  (threads without a status field — older deployments/dev API — are treated as active). The dev-only demo API already filtered archived.
- Errors keep the conversation open and render an inline `role="alert"` banner ("Archive failed: … — the conversation stays open.").
- No restore/unarchive was invented — none exists in the API.
- Store-level tests: archive called once with ordered `archive → fallback → sync`; failure keeps selection and reports the error.

## F. Recent quality

- Titles come from `createThread` (derived from the first user message), so "General Discussion"/"New chat" monotony is gone; fallback title only when derivation is impossible.
- Selected row styling (`active` class) exists for both Recent and agent rows.
- New intentional states: "Loading conversations…" (`role="status"`), "No conversations yet.", "No matches." — never a blank section.
- Stale list after send/archive: `syncAllThreads()` re-pulls authoritative data after first message and archive.
- Missing thread load fixed (Prompt 01) and now with explicit loading/error handling (see I).

## G. Keyboard

- Hub textarea: Enter sends, Shift+Enter inserts newline; send-without-agent preserves the draft, focuses the picker, shows guidance (asserted by tests: picker + alert hint + draft preserved by design of `startFromHub`).
- Active chat: Enter sends, Shift+Enter newline (unchanged canonical behavior).
- Duplicate send: Hub guarded by `hubStarting` + disabled button; active chat guarded by `runId` (stop replaces submit).
- Rail: Recent rows, agent rows, Hub cards all `role="button"` + `tabIndex={0}` + Enter/Space handlers; footer Create Agent is a real button.

## H. Scroll

- Opening a thread: messages effect scrolls to bottom once messages exist — latest message visible; for fresh threads this shows the whole (short) conversation including the first user message.
- Auto-follow only when the user is not scrolled up (`isScrolledUp` threshold 50px); scrolling upward is respected.
- Composer is a flex sibling below the scroll area (`.chat` layout) — it cannot cover the final message.
- **Fixed:** switching threads inherits the previous thread's `isScrolledUp`/offset — a `threadId`-keyed effect now resets the flag and snaps to the newest message, so a nonsensical offset can't persist across threads.

## I. Loading / empty / error states

| State | Treatment |
| --- | --- |
| Loading workspace (`!ready && !error`) | "Loading workspace…" hub panel — replaces the previous lie that showed the zero-agent CTA while loading. |
| Loading Recent | "Loading conversations…" row. |
| Zero agents | Disabled composer + "Create your first Agent to start a conversation." + Create Agent. |
| Backend error + zero agents | Disabled composer + "Workspace unavailable: …" (`role="alert"`), no creation CTA. |
| No Recent | "No conversations yet." muted row. |
| Selected agent / no thread | EmptyThreadPanel with functional composer + suggestions. |
| Loading messages | "Loading conversation…" panel (`role="status"`). |
| Failed thread load | Alert panel with the error and a Retry button (re-runs `loadThread`). |
| Failed thread creation | Inline hub/empty-panel hint (`role="alert"`), draft preserved. |
| Failed send | Canonical message-bubble error + Retry (unchanged), hub hint for hub-originated sends. |
| Active run | Stop button replaces Send (canonical, unchanged); Studio previews the running bubble. |

## J. UI Studio coverage (`/__ui?surface=customer&page=/agents&state=…`)

- Hub default — `populated` (interactive composer, real fixture agents).
- Hub with draft + chosen agent — interactive (type + pick).
- Zero agents — `empty`.
- Selected agent / no thread — click a card (interactive).
- Active conversation — click "Q3 Pipeline Review" fixture thread (completed exchange).
- Running — "General Discussion" fixture thread (streaming bubble + `activeRun` → stop button).
- Approval — fixture open approval card (matches production's global approval banner behavior).
- Thread creation failure / send failure — `error` state: `createThread`/`send` reject with explicit "Simulated …" messages, surfaced through the real error paths.
- Loading — `loading` (renders the new truthful loading hub). Gated — `gated`.
All fixtures are mock-only; no privileged APIs, no PostgreSQL access.

## K. Capability regression

Create Agent (Simple + Developer), versions/diff/publish/rollback, Work, Computer, Files, Terminal, Logs,
approvals, model selection (Settings), Rooms link, and archive all remain wired through the same canonical
components; this pass only removed the dead "Add context" control and the fake dropdown chevron. Fail-closed
features (terminal/computer/logs "Not configured" surfaces) untouched. Evidence: full suites green —
`admin-parity`, `product-surfaces`, `extended-capabilities`, `authoring-versioning`, `ui-studio`, `roster`, `work-view` all pass.

## L. Security / data integrity

- Agent and thread IDs are server-minted and consumed verbatim (`createThread` response is the only thread-id source; control-plane validates the agent belongs to the caller's org).
- No client-fabricated thread IDs (tests assert the authoritative id from `createThread` is used everywhere).
- No hidden/default agent: the picker starts unselected and requires an explicit choice.
- Cross-org safety unchanged: threads/archive routes are tenant-scoped server-side (`orgId` re-checked); no client-side org logic added.
- No secrets introduced; `secret-scan` clean. Studio fixtures remain behind the dev-only studio gate (`isUiStudioAllowed`).

## M. Tests

New/refined assertions in `apps/web/tests/agents-first-message.test.tsx` (27 tests total in the file):

- Exact canonical call ordering `create → ready → load → send → sync`.
- `createThread` exactly once (happy path and send-failure path); exact user text sent; exact agent/thread used.
- No thread on empty message; creation failure preserves state; send failure keeps the thread (no duplicate on retry).
- Archive: once, ordered fallback + Recent sync; failure keeps selection + error.
- Loading workspace, truthful backend-error hub, message loading, failed-load retry.
- Dead controls: no `href="#"`, no "Add context", non-interactive model badge, archive button only with an open thread.
- Existing conversation renders messages; suggestions are real buttons.

Totals: `pnpm --filter @mox/web test` → **151 passed** (was 140; +11). Repo `pnpm test` → **699 passed / 93 skipped** (the skips are the PG-gated suites, run separately below).

## Full verification

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | ok |
| `pnpm --filter @mox/web test` | 151 passed |
| `pnpm --filter @mox/web run typecheck` | clean |
| `pnpm lint` | 0 errors (51 pre-existing-style warnings) |
| `pnpm typecheck` | clean (all packages) |
| `pnpm test` | 699 passed, 93 skipped |
| `pnpm build` | success |
| `pnpm public-branding-scan` | clean |
| `pnpm secret-scan` | clean |
| `pnpm scan:authority` | clean |
| `pnpm dependency-security` | exit 0 (1 pre-existing moderate advisory; high-level threshold) |
| `git diff --check` | clean (CRLF notices only) |
| `powershell -ExecutionPolicy Bypass -File scripts/run-postgres-verification.ps1` | **97/97 passed** (API authority changed → run required). First run had 1 failure in `security-repair-05b.test.ts` ("quota=1 … exactly one order", a compute-orchestrator PG concurrency race that never touches the changed route); it passed on re-run with the changes applied and on a clean tree — timing flake, not a regression (tracked below). |

## Remaining issues

- **Critical / High:** none.
- **Medium:** `security-repair-05b.test.ts` test B is timing-sensitive under concurrent PG orchestration (failed once across three runs, never related to this change). Worth deflaking upstream (e.g., deterministic quota seeding) — out of scope here.
- **Low:** Hub "Recent" aria/labelling of dynamic rows is covered but not click-exercisable in the node-environment test harness (repo has no jsdom; interactions are covered at the logic level).

## Final decision

**CLOSED — AGENTS CONVERSATION FLOW READY**

No disqualifier applies: the Hub composer is functional, suggested prompts work, Recent clicks load messages,
first messages cannot create duplicate threads, no visible no-op control remains, and auth/security surfaces are unchanged.
