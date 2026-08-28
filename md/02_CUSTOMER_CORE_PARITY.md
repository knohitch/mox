# 02 — CUSTOMER CORE PARITY: AGENTS, THREADS, ROOMS, SERVERS, DEPLOYMENTS

## Objective

Surface the core Mox capabilities that already belong to the customer product.

Do not expose Admin-only infrastructure.

---

# A. CUSTOMER NAVIGATION / DISCOVERABILITY

Audit every customer route/component.

For every `CUSTOMER_VISIBLE`, `CUSTOMER_ENTITLEMENT_GATED` or `CUSTOMER_ROLE_GATED` capability in the inventory:
- ensure it has a discoverable entry point;
- avoid duplicate pages for the same authority;
- use contextual actions where a global nav item would be excessive.

Update customer IA only when justified by actual capability ownership.

---

# B. AGENT CREATION AND AUTHORING

Mox-owned agent-control code already provides substantial authoring/domain logic. Wire it into the customer product rather than recreating a second agent schema.

Required user experience:

## New Agent
Add a clear `New Agent` action.

## Simple Mode
Surface fields supported by the canonical builder, including as applicable:
- name/title/role
- instructions
- model
- enabled tools
- knowledge references
- browser/computer intent
- channels
- schedules
- deployment target
- voice
- safe/balanced/full permission preset

## Developer Mode
Surface advanced canonical AgentDefinition controls, including as applicable:
- instructions + appendices
- exact tool list
- integration bindings
- skills
- knowledge
- computer settings
- voice settings
- channel bindings
- deployment target
- permissions
- approval requirements
- max daily spend
- memory scope/retention
- schedules
- workflows
- subagents
- authoring metadata that legitimately belongs in UI

Simple and Developer Mode must compile to the same canonical AgentDefinition.

Do not fork runtime semantics.

---

# C. DRAFT / VERSION / PUBLISH / DIFF / ROLLBACK

Use existing agent-control authority.

Surface:
- current draft state;
- save/update;
- publish revision;
- immutable version history;
- diff between revisions in a useful human form;
- deployment of a published revision;
- rollback to a previous published revision.

Do not invent client-only version numbers.

Mutations must be role/entitlement checked server-side.

---

# D. REAL THREAD LIFECYCLE

Eliminate synthetic thread identifiers such as `t_<agentId>` if still used as authority.

Use:
- list threads;
- create thread;
- select thread;
- load messages;
- archive if supported by the domain.

A visible New Chat action should create a real thread.

Persist thread selection only as UI convenience; server remains authority.

---

# E. TURN EXECUTION

Current historical behavior accepted a message then locally emitted a `turn.failed` because no execution engine was composed.

Trace:
- agent-runtime
- control-plane
- runtime client
- model gateway
- session events
- policy/approval path

If a production turn engine already exists in Mox-owned runtime code, compose it into the customer path with the existing policy, approval, usage and event authorities.

If a required runtime component genuinely does not exist or is unsafe:
- do not fake it;
- make chat availability visibly `not configured`;
- document the exact missing production component in the phase report.

Do not make the UI look active while the only possible result is deterministic failure.

---

# F. AGENT WORKSPACE TABS

Review:
- Chat
- Work
- Computer
- Files
- Terminal
- Logs
- Settings

For each tab:
- fully wire it if the production backend already exists and passes policy/egress/security requirements;
- otherwise render an accurate disabled/unavailable state;
- do not call a guaranteed-501 endpoint from an enabled control.

Special rule:
Browser/computer networking must retain the hardened egress policy. Do not remove the established fail-closed posture merely to make the tab look functional.

---

# G. AGENT ROOMS

Surface:
- Create Room
- choose member agents
- room list
- room membership
- shared conversation/thread
- add/remove members if domain permits
- entitlement limits such as rooms and agents-per-room

Use persisted `room_members`.

Do not synthesize `room:<id>` as a fake thread authority if canonical room-thread support exists or can be safely added.

---

# H. SERVERS

The customer Control Plane already has server ordering authority.

Build the customer flow around safe/provider-independent compute concepts:

- `Provision server` / `Add server`
- allowed compute class list
- hostname
- region if customer-selectable
- optional SSH key reference only if proper customer credential/key infrastructure exists
- quota/plan message
- order/provision progress
- state
- safe lifecycle actions supported by policy:
  - restart
  - reboot where canonical terminology uses reboot
  - stop/start if supported
  - resize if product/plan permits
  - cancel/delete where lifecycle semantics permit

Do not expose:
- provider account ID
- provider credentials
- wholesale price
- internal SKU mapping unless product explicitly needs it
- hidden provider-account topology

If customer lifecycle routes do not exist, add safe customer-authorized routes that call the existing orchestrator authority.

---

# I. DEPLOYMENTS

Surface real:
- agent
- revision/version
- target
- state
- server placement where safe
- created/updated state
- deploy
- redeploy
- rollback linkage where supported

Avoid Admin-only provider internals.

---

# J. AGENT SETTINGS

The Settings tab should no longer be only a model selector.

It should expose the canonical editable settings appropriate to the user's authoring mode and entitlements.

Keep dangerous/internal runtime implementation details hidden.

---

# K. TESTS

Add coverage for:
- New Agent discoverability;
- Simple/Developer equivalence into canonical definition;
- publish/version/diff/rollback;
- role and entitlement gates;
- real thread create/select;
- no synthetic authority;
- room creation and persistent members;
- server provisioning;
- server lifecycle auth;
- deployment truth;
- disabled/unavailable runtime tab behavior;
- tenant isolation.

---

# REPORT

Create:

`docs/verification/UI_PARITY_02_CUSTOMER_CORE.md`

Local commit after green verification:

`feat(ui-parity): surface core customer capabilities`
