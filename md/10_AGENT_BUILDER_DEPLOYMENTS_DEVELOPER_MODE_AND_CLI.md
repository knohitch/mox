# Prompt 10 — Full agent builder, deployments, Developer Mode and CLI

**Recommended Codex reasoning: Extra High**

Continue from Prompt 09.

## Goal

Build the complete agent authoring/deployment experience for both non-technical business users and developers, using one `AgentDefinition`.

## Simple Mode

Implement a no-code/low-code builder supporting:
- name/avatar/role;
- instructions;
- model;
- tools/apps;
- knowledge;
- browser/computer;
- channels;
- schedules;
- target server;
- voice;
- permissions presets;
- deploy.

A drag/drop or step-based flow is acceptable, but all settings must compile into the same canonical domain object used by Developer Mode.

## Developer Mode

Expose:
- raw/system instructions;
- model/provider/reasoning controls;
- environment variables;
- secrets references;
- MCP servers/tools;
- skills;
- hooks;
- files/workspace;
- shell;
- terminal;
- Git repository;
- Docker image/command;
- ports;
- volumes;
- resource limits;
- network policy;
- schedules;
- jobs/workflows;
- goals/plans/todos;
- subagents;
- runtime version;
- logs;
- raw validated configuration editor.

## Agent versioning

Every deployable definition must be versioned:
- draft;
- published version;
- deployment references exact version;
- diff/history;
- rollback.

Do not mutate a running deployment's definition invisibly.

## Deployment targets

Support:
- Mox-native DSH runtime;
- imported external AG-UI/compatible endpoint where supported;
- custom Docker agent;
- Git-based deployment;
- future framework templates.

Provide import/plugin paths for common ecosystems without forcing them all into DSH internals.

## Mox Node deployment

`AgentDeployment` desired state must be reconciled through Mox Node:
- image/runtime version;
- env/secret mounts;
- workspace;
- resource limits;
- browser/computer binding;
- health;
- restart policy;
- logs.

## CLI

Create `apps/cli` / Mox CLI with at least:
- login;
- whoami;
- organizations;
- servers list/get;
- agents list/get/create/update;
- deploy;
- deployment status;
- logs;
- model connections list;
- channels/integrations list;
- terminal/session where entitled.

CLI talks to public Mox APIs; it does not bypass policy/entitlements.

## Browser terminal

For entitled Pro/Max/custom plans, provide browser terminal into the customer's VPS/workspace with:
- session audit;
- explicit target;
- safe reconnect;
- no terminal access to Mox control-plane hosts.

## Entitlements

Gate capabilities through Entitlement Service:
- CLI sessions;
- developer mode;
- active agents;
- browser sessions;
- deployment resources;
- server count.

Do not check plan name strings.

## Acceptance criteria

- Simple and Developer modes round-trip the same `AgentDefinition`.
- Versioning/rollback works.
- Deployments reconcile via Mox Node.
- Git/Docker/native runtime options exist.
- CLI uses supported APIs.
- browser terminal targets only customer-authorized compute.
