# MOX — PHASE 03
# REAL DURABLE AGENT ROOMS SHARED CONVERSATIONS

> ✅ **STATUS: DONE** — implemented and verified. See
> `docs/verification/PRODUCT_COMPLETION_03_AGENT_ROOMS_SHARED_CHAT.md`.

Use **Gemini 3.1 Pro High**.

Work in `E:\MyCodes\Mox` on clean `master`. Preserve onboarding, DEV direct access, auth/security, entitlements and working Agent chat. Do not push.

## GAP

Room creation exists, but shared room chat has historically been honestly unavailable. Build real durable room conversations; do not replace the unavailable message with fake UI.

## PRODUCT GOAL

A Room:
- contains multiple Mox Agents;
- allows human workspace participants;
- has durable messages;
- labels Agent provenance;
- allows explicit one-Agent or multi-Agent targeting;
- survives refresh/restart;
- enforces org membership server-side.

## ARCHITECTURE

Re-scan `agentRooms`, `roomMembers`, thread/messages, runtime send/run, approvals/events, usage and audit.

Extend canonical concepts. Do not invent client-only `room:<id>` thread ids.

If schema changes are needed, inspect migration head and use next sequential migration.

Durable messages need room/thread id, sender kind, sender user/agent id, content, createdAt, authoritative ordering, run/turn link and failure state where applicable.

## ROUTING

No random Agent selection.

Composer supports explicit target:
- one member Agent; and/or
- all room Agents;
- optional robust `@AgentName`.

If all are targeted, define deterministic bounded coordination. Respect concurrent-Agent limits, usage metering, approvals, timeouts and cancellation. Prevent recursive Agent-to-Agent loops.

## UI

`/rooms` should have room list, create/manage room, member Agents, durable message history, target selector, composer, run state, approvals/errors, Agent identity per response, and loading/empty/error/gated states.

## TESTS

Cover persistence/reload, single/all Agent targeting, nonmember Agent rejection, cross-org denial, plan room/member limits, concurrency, usage attribution, no recursion loop, UI states, and DEV fixture conversation.

Run runtime/control-plane/web/full gates plus PostgreSQL.

Report:
`docs/verification/PRODUCT_COMPLETION_03_AGENT_ROOMS_SHARED_CHAT.md`

Local commit:
`feat(rooms): add durable multi-agent conversations`

Do not push.
