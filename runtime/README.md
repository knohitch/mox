# runtime/

Mox-owned agent runtime. This is the production home of the Mox Runtime
composition behind `AgentDefinition`/`AgentRuntime` contracts:

- `agent-runtime/` — `@mox/agent-runtime`: launch/resume/cancel, canonical
  event streaming, persistence/config/credential seams, fail-closed policy
  gate, approvals, bounded crash/restart supervision.
- Control Plane code depends only on `@mox/runtime-client` (the wire
  protocol), never on runtime internals.

Reference/test engines are explicit development tools only. Their local
session, credential and settings storage is not authoritative in hosted Mox.
