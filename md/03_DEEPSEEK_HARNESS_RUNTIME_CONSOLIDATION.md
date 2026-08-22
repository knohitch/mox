# Prompt 03 — DeepSeek Harness becomes the single native Mox runtime

**Recommended Codex reasoning: Ultra**

Continue from Prompt 02.

## Goal

Make a DeepSeek Harness-derived runtime the sole native agent execution kernel for Mox while preserving OpenBot's control-plane identity and OpenMaus's future UX/provider compatibility.

## Source to inspect

DeepSeek Harness:
- core agent/agent-loop/tools/session/system-prompt packages;
- llm family;
- interaction family;
- fs/shell/terminal/subprocess/sandbox/code-runtime;
- skills/hooks/context/compaction/guard;
- subagent/agent-team/jobs/workflow/schedule/goal/plan/todo/feedback;
- attachment/storage/workspace;
- SDK/ACP/bundle/preset/settings/credentials;
- tests.

OpenBot:
- `agent-bot/`
- `agent-langgraph/`
- `server/src/agents/*`
- AG-UI endpoint expectations.

OpenMaus:
- harness/provider normalization contracts for compatibility study only.

## Required Mox runtime

Create `runtime/agent-runtime` with a Mox composition around DSH.

Runtime must accept `AgentDefinition` plus runtime-scoped credentials/config and provide:
- start/resume/cancel run;
- stream canonical `AgentEvent`s;
- tool registry;
- model bridge;
- filesystem/workspace;
- shell/terminal;
- skills;
- subagents;
- workflows/jobs/schedules;
- approval/question seam;
- compaction/memory hooks;
- attachments;
- structured errors;
- health/capability reporting.

## Single runtime authority

OpenBot `agent-bot` and OpenMaus harness must not remain parallel native agent loops.

Do not delete them yet. Instead:
- mark as compatibility/reference;
- route native Mox-created agents to Mox Runtime;
- create explicit adapter if legacy agents still invoke an old endpoint.

## Runtime protocol

Prefer DSH out-of-process SDK/JSON-RPC where it keeps failure boundaries clean.

Create `packages/runtime-client` so Control Plane does not import DSH internals.

Protocol must support:
- runtime health;
- runtime version/capabilities;
- create/resume thread;
- invoke agent;
- stream events;
- approval response;
- cancel;
- list/recover active runs;
- graceful shutdown.

## Persistence boundary

DSH local session/credential/settings storage must not be authoritative in hosted Mox.
Implement provider seams:
- Mox credentials provider;
- Mox runtime config provider;
- Mox session/event persistence adapter.

It is acceptable to bridge persistence during this prompt if full Postgres event ownership is finalized in Prompt 06.

## Policy boundary

DSH approvals/questions remain useful interaction seams, but policy authority is not local DSH configuration.
Tool execution capable of side effects must call Mox Policy/Computer/Integration gateways.

## Tests

Add contract and integration tests for:
- Control Plane `AgentDefinition` → runtime launch;
- model stub → agent output;
- tool request → canonical event;
- approval request/response;
- cancel/retry;
- runtime crash/restart behavior;
- tenant isolation at runtime routing;
- no plaintext credential leakage.

## Acceptance criteria

- New Mox agents execute through DSH-derived runtime.
- Runtime can be controlled out-of-process.
- Agent events are normalized to Mox contracts.
- DSH local settings/credentials are no longer authoritative in hosted mode.
- OpenBot/OpenMaus native loops are compatibility-only, not equal authorities.
