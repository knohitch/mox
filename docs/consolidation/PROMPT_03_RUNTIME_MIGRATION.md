# Prompt 03 — DeepSeek Harness becomes the single native Mox runtime

Status: **Implemented (Mox-side composition).** Migration note per
`MASTER_EXECUTION_GUIDE.md` working discipline item 6.

- Old HEAD SHA: `96c6d9c0421c0b32e310923fb8bd803e8fc37977`
- Branch: `master`
- Date: 2026-08-21

## What landed

### New packages

| Path | Role |
|---|---|
| `packages/runtime-client/` | The Mox runtime wire protocol (JSON-RPC 2.0, newline-delimited stdio transport) + typed `RuntimeClient`. The Control Plane's only view of any agent runtime. Zero DSH imports. |
| `runtime/agent-runtime/` | Mox composition around a DSH-derived kernel: launch/resume/cancel, canonical event streaming, persistence/config/credential seams, fail-closed policy gate, approval seam, bounded crash/restart supervision, tenant-isolated run registry. |

### Protocol surface (`@mox/runtime-client`)

Methods: `runtime/health`, `runtime.capabilities`, `run.start`, `run.resume`,
`run.cancel`, `run.list`, `approval.respond`, `runtime.shutdown`.
Notifications: `runtime.event` carrying a validated canonical `AgentEvent`.
Every request/response schema is zod-validated at the boundary; an invalid
`AgentDefinition` cannot cross the wire.

### Persistence boundary

DSH local session/credential/settings storage is not authoritative in hosted
mode. The host persists through `SessionEventStore` (bridge implementation:
in-memory; Postgres event ownership finalizes in Prompt 06), resolves
credentials through `RuntimeCredentialProvider` grants, and assembles config
through `RuntimeConfigProvider`. Secrets travel only inside scoped grants and
are redacted (`redactForStorage`) before durable storage.

### Policy boundary

Tool execution authority is Mox policy, never local DSH configuration.
`PermissionsPolicyEngine` derives decisions from the definition
(deny-list > allow-list; write-or-worse requires human approval; unknown
danger fails closed). `failClosed()` converts engine errors into denials.
Approvals remain interaction seams: `approval.opened` / `approval.resolved`
events plus the `approval.respond` method.

### Single runtime authority

OpenBot `agent-bot` and OpenMaus harness are marked compatibility/reference
(see markers in their trees and `SOURCE_CLASSIFICATION.md`). They are not
deleted (Architecture Rule 7) and are no longer parallel authorities: new
Mox-created agents route to `AgentRuntime`. A legacy-agent adapter can be
added when OpenBot/OpenMaus surfaces are ported (Prompt 05+); until then no
Mox code invokes their native loops.

## Tests added

- `packages/runtime-client/tests/protocol.test.ts` — wire contract validation (9).
- `packages/runtime-client/tests/client.test.ts` — correlation, streaming,
  timeout, crash semantics (6).
- `runtime/agent-runtime/tests/agent-runtime.test.ts` — launch validation,
  config/credential merge, tenant isolation, cancel/restart budget/shutdown,
  model-stub → tool-gate → canonical events, approval flows (14).
- `runtime/agent-runtime/tests/leak.test.ts` — credential-leak redaction (4).

## Acceptance criteria status

- New Mox agents execute through the DSH-derived runtime shape — yes, via
  `AgentRuntime` + reference engine; the out-of-process DSH kernel plugs into
  the same `AgentEngine`/protocol seams.
- Runtime controllable out-of-process — yes (`StdioRuntimeTransport`,
  JSON-RPC framing); exercised by protocol tests with a loopback transport.
- Agent events normalized to Mox contracts — yes (zod-validated `AgentEvent`
  on the wire; `dshEventToEnvelope` for DSH-shaped streams).
- DSH local settings/credentials non-authoritative in hosted mode — yes
  (persistence/config/credential seams; enforced by composition, tested).
- OpenBot/OpenMaus loops compatibility-only — yes (markers + routing rule).

## Known gaps (tracked, not silent)

1. The actual DSH kernel process is not yet launched by Mox: the reference
   engine runs in-process. Wiring `launchStdioRuntime` to a built DSH SDK
   server binary is deferred until the DSH tree has a stable build on this
   host (its full typecheck exceeds the 10-minute window; see BASELINE §2).
2. `SessionEventStore` is an in-memory bridge; Postgres ownership lands in
   Prompt 06 as planned.
3. `run.list` recovery of pre-crash runs from the kernel side is stubbed in
   the fake client; real recovery needs the DSH session checkpoint work.
