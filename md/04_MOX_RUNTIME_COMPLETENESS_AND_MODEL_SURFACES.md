# Repair Prompt 04 — Complete Mox Runtime capability set and model-facing surfaces

**Reasoning: Ultra**

Run after the production spine is stable.

## Goal
Close the gap between the current reference/runtime wrapper and the intended full Mox native agent runtime. Keep one runtime authority and expose everything publicly as Mox.

Do not reintroduce donor runtimes as parallel production products.

## Capability inventory
Inspect current:
- `runtime/agent-runtime`
- `packages/runtime-client`
- Mox contracts
- retained provenance/source references/history

Create a matrix for:
- model loop
- tool registry
- session/event log
- filesystem/workspace
- shell
- persistent terminal
- subprocess
- sandbox/code runtime
- LSP/developer tooling
- skills
- hooks
- context management
- compaction
- guards/policy integration
- subagents
- agent-team/multi-agent coordination
- jobs/background work
- workflows
- schedules
- goals
- plans
- todos
- feedback/human interaction
- attachments
- large-result spill/artifacts
- storage
- web search/fetch
- SDK/client protocol
- crash/resume
- cancellation
- approvals

For each: implemented / partial / missing, production path, tests.

## Production engine rule
A reference/test engine may remain for tests.

Production must never silently fall back to a simplistic reference loop while claiming full Mox Runtime.

Use explicit modes such as:
- `production-full`
- `test-reference`

If full runtime cannot start in production, fail honestly.

## Port/implement missing capabilities
Bring missing capabilities into Mox-owned runtime/packages.

Rules:
- public class/service/UI names are Mox
- preserve attribution privately
- one policy authority
- one credential authority
- one event/session authority
- browser/computer side effects via Mox Computer Gateway
- model calls via Mox Model Gateway
- integration tools via Mox Integration Gateway

## Multi-agent
Complete:
- subagents
- agent delegation
- Agent Rooms
- shared objective
- task/plan coordination
- scoped shared files/context
- explicit agent-to-agent permissions
- runtime/event visibility
- anti-recursion/resource limits/entitlements

## Developer Mode runtime support
Ensure real support for:
- shell
- terminal
- files
- Git workspace
- diffs
- code execution
- hooks
- skills
- MCP/tools
- schedules/workflows
- LSP where supported

## Model-facing wording
Generic product UI uses:
- Mox AI
- Models
- Intelligence
- Mox Agent
- Mox Runtime

Never generic “GPT”.

Actual provider/model names are permitted in:
- Models/API Connections
- provider setup
- actual model selector
- actual provider/model usage/cost records

## Tests
- production cannot silently select reference engine
- capability tests for every supported runtime family
- restart/resume from Mox event store
- credential scoping
- policy enforcement
- subagent quotas
- terminal/files tenant/server isolation

## Acceptance criteria
- production Mox Runtime is the intended full runtime, not merely a reference loop;
- reference engine is test-only/explicit;
- capability matrix has no undocumented missing core capability;
- Mox is the sole public runtime identity;
- provider/model names appear only where technically meaningful.
