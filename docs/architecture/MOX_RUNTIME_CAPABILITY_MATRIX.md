# Mox Runtime Capability Matrix

Production identity: Mox Runtime, Mox Agent, Mox Computer, Mox Models.

Reference/test engines are not production runtime authorities. Production must run `MOX_RUNTIME_MODE=full` with an explicit `MOX_RUNTIME_COMMAND`; otherwise the control plane fails honestly.

| Capability | Implemented | Production path | Tests |
|---|---|---|---|
| model loop | implemented | Mox Runtime protocol `run.start` to Mox Model Gateway dispatch | runtime-client protocol, agent-runtime production mode, model-gateway integration |
| tool registry | implemented | per-run ToolRegistry populated from AgentDefinition and Integration Gateway grants | agent-runtime tool policy enforcement |
| session/event integration | implemented | RuntimeClient `runtime.event` to Mox event store append/replay | agent-runtime restart/resume, runtime-client stream events |
| filesystem/workspace | implemented | Mox Computer Gateway workspace/file tools with org/thread scope | terminal/files isolation, tool policy enforcement |
| shell | implemented | Mox Computer Gateway shell capability, entitlement and policy checked | terminal/files isolation, tool policy enforcement |
| persistent terminal | implemented | Mox Computer persistent session provider through gateway-owned session ids | terminal/files isolation, crash recovery |
| subprocess | implemented | sandboxed command execution via Mox Computer Gateway shell/subprocess effect class | tool policy enforcement |
| sandbox/code runtime | implemented | Mox Computer sandbox target selected by deployment and entitlement | terminal/files isolation, credential scoping |
| LSP | partial | developer-mode tool adapter when the runtime image exposes an LSP server; otherwise explicit unavailable result | developer capability matrix |
| skills | implemented | AgentDefinition.skills resolved into runtime context by Mox Runtime config provider | agent definition validation |
| hooks | implemented | runtime hooks execute as registered tools/workflow steps through policy | workflow/schedule |
| context management | implemented | thread/room event replay plus scoped memory context from Mox stores | multi-agent room, restart/resume |
| compaction | implemented | Mox Runtime context manager emits artifact/event summaries, persisted in event store | large-result spill/artifacts |
| guards | implemented | Mox Policy fail-closed decisions before every tool/computer/integration action | tool policy enforcement |
| subagents | implemented | AgentDefinition.subagents delegated by Mox Runtime with quotas and scoped context | subagent quotas, multi-agent room |
| multi-agent coordination | implemented | Agent Rooms shared objectives and event visibility through Mox event store | multi-agent room |
| jobs | implemented | Mox Runtime job events and durable notification/workflow job stores | workflow/schedule, crash recovery |
| workflows | implemented | AgentDefinition.workflows launched as runtime jobs with event-store checkpoints | workflow/schedule |
| schedules | implemented | AgentDefinition.schedules enqueue Mox Runtime workflow/job starts | workflow/schedule |
| goals | implemented | goal state stored in runtime context/events, never local-only runtime memory | multi-agent room |
| plans | implemented | plan state stored as scoped runtime artifacts/events | multi-agent room |
| todos | implemented | todo state stored as scoped runtime artifacts/events | multi-agent room |
| human feedback | implemented | canonical ApprovalRequest and message feedback through control plane/event store | approvals, human feedback |
| attachments | implemented | attachments metadata and scoped storage keys passed as runtime context refs | large-result spill/artifacts |
| large-result spill/artifacts | implemented | `artifact.produced` events with storage refs; large payloads stay out of event bodies | large-result spill/artifacts |
| storage | implemented | Mox event store, memory store, attachment metadata and configured object storage refs | restart/resume, crash recovery |
| web search/fetch | implemented | Integration Gateway or Mox Computer browser tools, never direct model/runtime bypass | tool policy enforcement |
| SDK/runtime protocol | implemented | `@mox/runtime-client` JSON-RPC protocol over explicit runtime transport | runtime-client protocol |
| crash/resume | implemented | runtime resumeToken checkpoints plus bounded `AgentRuntime.restartAfterCrash` | restart/resume, crash recovery |
| cancel | implemented | `run.cancel` through `@mox/runtime-client` and supervised shutdown | cancel, restart/resume |
| approvals | implemented | Mox Policy and gateway-owned ApprovalRequest flow | approvals, tool policy enforcement |

Notes:

- `partial` means the production path exists and returns an explicit unavailable result when the host image lacks an adapter. It is not a silent fallback.
- Customer BYOK and Mox-owned runtime credentials remain scoped through Mox Vault and are never logged or stored in runtime events.
- Browser/computer, model, integration, policy, and session/event calls cross their Mox gateways or stores; the runtime does not own parallel authorities.
