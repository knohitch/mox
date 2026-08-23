# Prompt 04 — Complete Mox Runtime capability set

**Reasoning: Ultra**

Run after Prompt 03.

## Goal

Make production Mox Runtime the full intended native agent runtime, not merely a reference loop.

Do not create parallel runtime authorities.

## Capability audit

Produce and then close a matrix covering:
- model loop
- tool registry
- session/event integration
- filesystem/workspace
- shell
- persistent terminal
- subprocess
- sandbox/code runtime
- LSP
- skills
- hooks
- context management
- compaction
- guards
- subagents
- multi-agent coordination
- jobs
- workflows
- schedules
- goals
- plans
- todos
- human feedback
- attachments
- large-result spill/artifacts
- storage
- web search/fetch
- SDK/runtime protocol
- crash/resume
- cancel
- approvals

Each row:
- implemented
- partial
- missing
- production path
- tests

## Production mode

Reference/test engine may remain only for tests/explicit development.

Production must have an explicit full runtime mode.

If full runtime is unavailable:
- fail honestly
- do not silently fall back to reference engine

## Runtime boundaries

- model calls → Mox Model Gateway
- browser/computer → Mox Computer Gateway
- integrations/tools → Mox Integration Gateway
- credentials → Mox Vault
- policy → Mox Policy
- session/events → Mox event store

No direct bypass.

## Multi-agent

Complete:
- subagents
- delegation
- Agent Rooms
- shared objectives
- shared task/plan state
- scoped shared files/context
- explicit agent permissions
- event visibility
- recursion/concurrency limits
- entitlement/resource limits

## Developer Mode

Real support for:
- shell
- terminal
- files
- Git workspace
- diffs
- code execution
- hooks
- skills
- MCP/tools
- schedules
- workflows
- LSP where available

## Naming

Publicly:
- Mox Runtime
- Mox Agent
- Mox Computer
- Mox Models

No donor runtime/harness names.

## Tests

- production cannot silently use reference engine
- restart/resume
- tool policy enforcement
- credential scoping
- subagent quotas
- terminal/files isolation
- multi-agent room
- workflow/schedule
- crash recovery
- model gateway integration

## Acceptance criteria

- full Mox runtime path exists
- reference engine is test/dev only
- capability matrix has no undocumented core gap
- one runtime authority remains
- public runtime identity is Mox
