# Prompt 04 — Computer, policy, browser and runtime supervision

**Recommended Codex reasoning: Ultra**

Continue from Prompt 03.

## Goal

Make OpenBot-derived computer/browser infrastructure the authoritative Mox computer layer, connect DSH tools to it, and generalize supervision so each customer VPS can safely run agent/browser workloads.

## Source to inspect

OpenBot:
- `agent-computer/src/*`
- `server/src/computer/*`
- `supervisor/src/*`
- related tests/docs

OpenMaus:
- `ComputerPanel`
- CUA connection/runtime modules
- cloud/box computer concepts
- device capabilities
for optional-provider patterns, not authority.

## Mox computer architecture

Create/establish:

- `runtime/computer-runtime`
- `packages/policy`
- `packages/security`
- computer provider contracts implementation
- server-side Computer Gateway

Canonical flow:

```text
agent tool request
→ Mox runtime
→ Mox Computer Gateway
→ entitlement check
→ policy decision
→ optional human approval
→ audit
→ ComputerProvider
→ action/result
```

## Required capabilities

Preserve/port:
- Playwright/Chromium browser control;
- ARIA snapshots;
- navigation;
- click/type/select/upload/download;
- screenshots;
- screencast/live browser;
- browser profiles/cookies;
- human takeover;
- workspace files;
- shell where entitled;
- egress/network controls;
- computer identity/session state.

## Policy

OpenBot-derived policy becomes authoritative Mox Policy.

Unify DSH/OpenMaus approval semantics around:
- `PolicyDecision`;
- `ApprovalRequest`;
- allow/deny/ask;
- scope: action/session/agent/organization;
- expiration;
- audit.

Do not make DSH local presets or OpenMaus auto-approve authoritative.

## Provider abstraction

Implement:
- `PlaywrightComputerProvider` as default;
- capability hooks for future OpenMaus CUA/local/cloud/device providers.

A provider must advertise:
- browser;
- shell;
- filesystem;
- screencast;
- desktop/CUA;
- mobile/device;
- human takeover;
- region/runtime constraints.

## Runtime supervision

Adapt OpenBot Supervisor concepts into a Mox runtime supervisor that can later run under Mox Node:
- deterministic container names;
- agent/browser container lifecycle;
- per-agent/per-session isolation;
- health;
- restart;
- resource limits;
- volumes/workspaces;
- no shared browser/login state across tenants.

## Security

- browser internal control ports must not be public;
- privileged Docker socket access must be isolated to Mox Node/supervisor;
- shell/browser actions must be audited;
- agent cannot bypass policy by directly reaching browser service;
- secrets never appear in screencast metadata/logs.

## Tests

Include:
- policy allow/deny/ask;
- human takeover;
- browser action happy path;
- cross-agent isolation;
- cross-tenant isolation;
- crash/restart;
- unauthorized direct browser request rejection;
- resource-limit behavior;
- egress policy.

## Acceptance criteria

- DSH uses Mox Computer Gateway for computer/browser side effects.
- One policy engine is authoritative.
- Default browser runs through isolated Playwright computer runtime.
- Human takeover and screencast survive.
- Supervisor logic is Mox-owned and ready to embed into Mox Node later.
