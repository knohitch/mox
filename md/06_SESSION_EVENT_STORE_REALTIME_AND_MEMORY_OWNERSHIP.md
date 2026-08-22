# Prompt 06 — Session/event store, realtime and memory ownership

**Recommended Codex reasoning: Ultra**

Continue from Prompt 05.

## Goal

Make Mox authoritative for threads, messages, runtime events and durable conversation history. Remove mandatory dependence on local DSH session files or CopilotKit Intelligence as the sole source of truth.

## Required durable model

Implement/finish PostgreSQL persistence for:

- threads;
- thread participants;
- messages;
- agent runs;
- session events;
- tool calls;
- approvals;
- attachments metadata;
- computer-session references;
- runtime checkpoints/recovery metadata;
- agent-room shared threads;
- event correlation/causation.

Use append-oriented event storage where it improves recovery/audit. Maintain projections/views for fast UI queries.

## Event semantics

Canonical event types should cover at least:
- run started/completed/failed/cancelled;
- model request/response metadata;
- assistant content delta/final;
- tool requested/started/completed/failed;
- approval requested/resolved;
- computer action;
- file/artifact produced;
- subagent started/completed;
- workflow/job events;
- deployment events;
- user message;
- system notification relevant to thread.

Do not store hidden chain-of-thought.

## Realtime

Create a Mox Realtime abstraction.

Transport may initially use:
- Supabase Realtime/Broadcast;
- or Mox WebSocket/SSE service.

UI must not depend directly on Supabase-specific event shapes.

Support:
- thread streaming;
- agent presence/status;
- server provisioning progress;
- deployment progress;
- approvals;
- notifications.

## CopilotKit

If CopilotKit remains useful for AG-UI/client compatibility, keep it behind an adapter.
It must not be the only authoritative persistence layer.

## DSH persistence

Implement DSH session adapter so:
- session history can be reconstructed from Mox storage;
- runtime restart can resume;
- no tenant can load another tenant's session;
- event idempotency prevents duplicates after reconnect/retry.

## Memory

Separate:
- conversational history;
- long-term memory/knowledge references;
- vector/semantic indexes.

Do not indiscriminately dump every message into long-term memory.

## Tests

- event append/replay;
- duplicate event idempotency;
- reconnect/resume;
- runtime crash + recovery;
- room thread;
- cross-tenant isolation;
- realtime fanout;
- CopilotKit adapter does not become authoritative;
- no chain-of-thought persistence.

## Acceptance criteria

- Mox Postgres is the source of truth for conversations/events.
- UI realtime is transport-agnostic.
- DSH can resume from Mox-owned history.
- CopilotKit is optional/adapter-based rather than mandatory authority.
