# runtime/

Mox-owned agent runtime. Since Prompt 03
(docs/consolidation/PROMPT_03_RUNTIME_MIGRATION.md) this is the home of the
DSH-derived kernel composition behind `AgentDefinition`/`AgentRuntime`
contracts:

- `agent-runtime/` — `@mox/agent-runtime`: launch/resume/cancel, canonical
  event streaming, persistence/config/credential seams, fail-closed policy
  gate, approvals, bounded crash/restart supervision.
- Control Plane code depends only on `@mox/runtime-client` (the wire
  protocol), never on DSH internals.

The imported `deepseek-harness-master/` tree remains the reference kernel
implementation until its retirement prompt (Architecture Rule 7); its local
session/credential/settings storage is not authoritative in hosted Mox.
