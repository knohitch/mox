# Prompt 06 — Session/event store, realtime and memory ownership

Status: **implemented** (in-memory reference stores fully tested; PostgreSQL translations + generated migration for the hosted control plane).

## What landed

### Durable model — Mox Postgres is the source of truth
New schema (`packages/database/src/schema/`), migration `0001_youthful_iceman.sql`:
- `session_events` — append-oriented canonical event stream. `event_id` PRIMARY KEY = idempotency key (retries/reconnects can never duplicate); `seq` bigserial gives replay order; carries orgId, subjectKind(thread|room)+subjectId, agentId/runId/turnId, correlationId + causationId (full causal chains), type + payload.
- `thread_messages` (+ author kind), `thread_participants` (unique per thread+principal), `room_threads` (rooms share the same machinery), `attachments_meta`, `runtime_checkpoints` (resume tokens/snapshots per run).
- `long_term_memories` — scope/kind/salience/content + unique dedupe index; vector indexes referenced by pointer (`vector_ref`) so pgvector can attach without reshaping storage.

### Event semantics
`@mox/contracts/session-events.ts` defines the durable `SessionEvent` union covering: run started/completed/failed/cancelled; model requested/responded METADATA only; assistant delta/final; user message; system notification; tool requested/started/completed/failed; approval requested/resolved; computer action; artifact produced; subagent started/completed; workflow/job events; deployment updated. There is no field anywhere that could carry hidden chain-of-thought.

### Stores (two implementations, one interface)
- `InMemory*SessionEventStore / ThreadStore / MessageStore / MemoryStore` — reference semantics: idempotent append, ordered replay, correlation replay, tenant checks. Reads of foreign tenants return not-found/empty (no existence leak); writes throw `TenantScopeError`.
- `Pg*` drizzle translations over the same interfaces for hosted deployment (`ON CONFLICT DO NOTHING` idempotency).

### Realtime abstraction
`packages/realtime`: typed topics (`thread:{org}:{id}`, `presence:{org}`, `server:{org}:{id}`, `deployment:{org}:{id}`, `approvals:{org}`, `notifications:{org}:{userId}`) carrying canonical `@mox/events` envelopes. `RealtimeTransport` is the seam — an in-process bus ships now; WS/SSE or Supabase Broadcast adapters plug in unchanged. Tenant isolation enforced at DELIVERY time; a crashing subscriber never breaks fanout. The web app consumes only this shape (via its API seam) — zero Supabase-specific dependencies.

### DSH persistence adapter
`packages/adapters/dsh-session.ts`: `rebuildHistory()` folds stored events into kernel-ready message lists; `dedupeById()` makes replays idempotent; opaque resume tokens bind run ↔ last persisted seq. Cross-tenant loading is impossible by construction — adapters consume pre-scoped store results.

### CopilotKit demoted to adapter
`packages/adapters/copilotkit.ts` projects canonical events into AG-UI message shapes for client compatibility. It persists nothing and depends on nothing proprietary — authority stays with the Mox event store.

### Memory ownership
`MemoryService` gates ALL long-term writes: minimum salience, bounded per-subject capacity with lowest-salience eviction, dedupe, explicit attribution. `proposeMemories()` is the only sanctioned path from conversation → memory proposals; messages are NEVER auto-persisted (tested).

## Tests added (21)
- persistence: idempotent appends, ordered/correlation replay, cross-tenant refusal on writes + silence on reads, thread-org binding, memory salience gate/dedupe/eviction/forget-isolation, no-auto-persist proof.
- realtime: fanout incl. crashing subscriber, delivery-time tenant isolation, envelope scope/correlation/causation fidelity, empty-topic no-op.
- adapters: history rebuild + dedupe from both event unions, resume-token round-trip/garbage rejection, CopilotKit projections.

## Acceptance criteria status
- Mox Postgres is source of truth ✅ (schema + stores; in-repo tests use reference impls)
- UI realtime is transport-agnostic ✅
- DSH can resume from Mox-owned history ✅ (adapter + checkpoint schema)
- CopilotKit optional/adapter-based ✅

## Known gaps
- Live PostgreSQL instance wiring arrives with infra prompts; Pg stores are typechecked but not integration-tested against a running server here.
- pgvector index creation lands with the knowledge prompt (pointer column already reserved).
