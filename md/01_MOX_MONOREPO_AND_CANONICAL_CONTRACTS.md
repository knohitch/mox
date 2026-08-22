# Prompt 01 — Mox monorepo skeleton and canonical contracts

**Recommended Codex reasoning: Ultra**

Continue from Prompt 00. Build the Mox-owned repository skeleton and canonical contracts without yet deleting or renaming upstream source trees.

## Goal

Create stable Mox package boundaries so no future feature directly depends on arbitrary internals from OpenBot, OpenMausBot or DeepSeek Harness.

## Required target areas

Create/establish:

```text
apps/
services/
runtime/
packages/
infra/
docs/
third_party/
```

Do not create empty directories just for appearance. Create package manifests/README/contracts where a boundary is actually used.

## Canonical contracts

Under `packages/contracts`, define validated TypeScript contracts for at least:

- `AgentDefinition`
- `AgentVersion`
- `AgentDeployment`
- `AgentRuntime`
- `AgentEvent`
- `AgentThread`
- `AgentRoom`
- `ModelProvider`
- `ModelDefinition`
- `ModelConnection`
- `ModelSelection`
- `ComputerProvider`
- `ComputerSession`
- `ComputerAction`
- `ComputeProvider`
- `ComputeProduct`
- `ComputeClass`
- `ComputeInstance`
- `ChannelAdapter`
- `ChannelConnection`
- `ChannelMessage`
- `IntegrationProvider`
- `IntegrationConnection`
- `ToolDefinition`
- `CredentialReference`
- `PolicyDecision`
- `ApprovalRequest`
- `UsageEvent`
- `CostEvent`
- `NotificationEvent`
- `AuditEvent`
- `DesiredState`
- `OperationRecord`

Use discriminated unions where they materially improve safety. Do not over-generalize into `Record<string, any>`.

## Contract requirements

### AgentDefinition
Must support:
- identity/avatar/title/role;
- system instructions;
- model selection;
- tools/integrations;
- skills;
- knowledge;
- browser/computer settings;
- voice;
- channels;
- deployment target;
- permissions;
- memory configuration;
- schedules;
- subagents/workflows;
- Simple/Developer UI metadata without creating separate runtime schemas.

### DesiredState / OperationRecord
Must support idempotent reconciliation:
- operation id;
- idempotency key;
- desired state;
- observed state;
- provider request/resource identifiers;
- retry metadata;
- terminal/non-terminal error classification.

### Provider interfaces
Keep vendor-specific fields behind provider metadata/extensions while preserving common operations.

## Repository tooling

1. Introduce a root pnpm workspace **only if it can coexist safely** with still-Bun OpenBot areas.
2. Node 24 is the target for Mox-owned packages.
3. Do not force-convert OpenBot's Bun-specific packages yet.
4. Add root lint/typecheck/test orchestration for Mox-owned packages.
5. Create `packages/provider-sdk` with shared provider registration, capability discovery, health status and unavailable/degraded states.
6. Create `packages/events` with canonical envelope:
   - event id;
   - type;
   - version;
   - tenant/org/user/resource scope;
   - causation/correlation ids;
   - timestamp;
   - payload;
   - audit metadata where relevant.

## Adapters

Create thin adapter packages or stubs that prove the old systems can be represented by Mox contracts, but do not migrate full implementations yet:
- OpenBot agent profile → `AgentDefinition`;
- OpenMaus provider metadata → `ModelProvider` capabilities;
- DSH runtime/session event → `AgentEvent`.

Add tests for these mappings.

## Documentation

Create:
- `docs/architecture/CONTRACTS.md`
- `docs/architecture/REPOSITORY_LAYOUT.md`
- `docs/consolidation/PROMPT_01_RESULT.md`

## Forbidden

- No source-tree deletion.
- No full runtime migration.
- No full database rewrite.
- No production provider calls.
- No UI redesign.
- No fake “completed provider” implementations.

## Acceptance criteria

- Mox-owned packages build independently.
- Canonical contracts are type-safe and tested.
- Old-source adapters prove compatibility at boundaries.
- Provider SDK has explicit healthy/degraded/unavailable semantics.
- No imported project has become a dependency sink for new Mox code.
