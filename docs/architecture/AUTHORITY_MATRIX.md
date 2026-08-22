# Mox Authority Matrix

Status: **Baseline (Step 1 of consolidation).** Each concern below has
**exactly one final authority** (Architecture Rule 1). The authority owns the
truth, decides conflicts, and is the only component allowed to finalize
writes for that concern. Everything else reads through its interface or holds
non-authoritative projections.

"Authority (target)" names the Mox module that will own the concern after
consolidation. "Donor today" names where the closest existing logic lives in
the imported trees — a donor is **not** an authority; it is raw material to
be ported behind the target interface.

| # | Concern | Final authority (target) | Donor today | Notes |
|---|---------|--------------------------|-------------|-------|
| 1 | **Identity** (users, authn, sessions-of-persons) | Mox **Identity Service** (server-side; better-auth patterns ported from OpenBot `server/src/auth`) | OpenBot `server/src/auth` (better-auth); OpenMausBot local profile store | Web app is primary client (Rule 6). No identity truth on customer VPS (Rule 3). |
| 2 | **Organizations** (tenants, membership, roles) | Mox **Org Service** (server-side, same DB as Identity) | OpenBot tenant/package concepts (`server/src/tenant-package.ts`); OpenMausBot team manifests (`server/team-manifest.ts`) | Org membership gates every other authority's checks. |
| 3 | **Billing** (subscriptions, invoices, payment state) | Mox **Billing Service** (server-side; provider adapter for the PSP) | None — must be built (explicitly out of scope for baseline) | Payment provider is a provider behind an interface (Rule 2). All charges idempotent + audited (Rule 4). |
| 4 | **Pricing** (price book, plan definitions, metered rates) | Mox **Pricing Service** (server-side; versioned price book) | None — must be built | Pricing is data owned server-side; never computed on clients or VPS. |
| 5 | **Entitlements** (what a plan allows: limits, features, seats) | Mox **Entitlement Service** (server-side; derived from Billing + Pricing, cached read-only elsewhere) | None — must be built | Enforcement points may cache entitlements but never originate them. |
| 6 | **Compute ownership** (which org/user owns which computer/VM/container) | Mox **Compute Registry** (server-side) | OpenBot supervisor + `server/src/computer`; OpenMausBot `server/vps-computer.ts`, `local-vm-*.ts`, `container-computer.ts` | Customer VPS is untrusted (Rule 3): ownership records live server-side only. |
| 7 | **Server desired state** (what a managed machine should run) | Mox **Desired-State Controller** (server-side; emits state, reconciles reported state) | OpenBot supervisor (`supervisor/`, `worker/`); OpenMausBot VPS routing/provisioning | Reported state is verified before trusted; drift is reconciled, never assumed away. |
| 8 | **Agent definitions** (the `AgentDefinition` artifact) | Mox **Agent Registry** (server-side; versioned store; Simple + Developer modes compile into it — Rule 5) | OpenBot `agents.yaml` + `/agents` admin; OpenMausBot bot profiles/team library; deepseek-harness presets (`packages/preset`) | One schema; both authoring modes are compilers over it. |
| 9 | **Agent execution** (running an agent turn) | Mox **Agent Runtime** (kernel ported from deepseek-harness session/host/llm packages, behind Mox runtime interfaces) | deepseek-harness `packages/{session,host,llm,core,subagent,workflow}`; OpenBot AG-UI bot invocation; OpenMausBot harness/CLI drivers | Provider runtimes (Claude Code, Codex, LangGraph, AG-UI) are adapters (Rule 2). |
| 10 | **Model routing** (which model/provider serves a request) | Mox **Model Router** (server-side policy over provider adapters) | deepseek-harness `packages/llm`; OpenMausBot model picker/provider rail (`src/`, `server/local-routing.ts`) | Routing decisions are recorded; fallbacks are explicit policy, not accidents. |
| 11 | **Credentials** (API keys, OAuth tokens, secrets) | Mox **Credential Vault** (server-side; encrypted at rest; write-only reads) | OpenBot `server/src/credentials.ts` (encrypted, never logged); OpenMausBot workspace credentials (`electron/workspace-credentials.mjs`) | Secrets never enter transcripts or audit rows (Rule 4). VPS receives only scoped, revocable grants. |
| 12 | **Tool policy** (what tools/actions an agent may take) | Mox **Policy Engine** (server-side; CEL-style rules ported from OpenBot gateway) | OpenBot gateway policy (`server/src/computer`, CEL fail-closed rules); OpenMausBot permission proxy / peer approval (`server/permission-proxy.ts`, `peer-approval.ts`) | Deny evaluated before allow; missing policy permits nothing; broken rule refuses (fail closed). |
| 13 | **Computer/browser actions** (driving machines and browsers) | Mox **Action Gateway** (server-side; sole path from agent to any computer) | OpenBot gateway (resolve → policy → audit → act); OpenMausBot computer-control/observation (`server/computer-control.ts`, `computer-observation.ts`, `computer-proxy.ts`) | Every action idempotent + audited (Rule 4); help-request/control-takeover recorded. |
| 14 | **Sessions/events** (conversation threads, event streams) | Mox **Session Store** (server-side; event-sourced; kernel session packages ported from deepseek-harness) | deepseek-harness `packages/{session,session-query,storage,spill}`; OpenMausBot `server/message-db.ts`, `thread-events.ts`; OpenBot channels/threads | Events are append-only; projections are rebuildable. |
| 15 | **Channels** (where conversations live: web, Telegram-style rosters, webhooks) | Mox **Channel Service** (server-side; web app is the primary channel — Rule 6) | OpenBot `server/src/channels`; OpenMausBot webhook ingress + chat UX (`server/webhook-ingress.ts`, `webhooks.ts`) | External transports (webhooks, messengers) are adapters. |
| 16 | **Notifications** (user-facing alerts across surfaces) | Mox **Notification Service** (server-side; fan-out to surfaces) | OpenMausBot `server/notify.ts`; OpenBot channel notifications | Delivery attempts are idempotent and audited (Rule 4). |
| 17 | **Usage** (metered events: tokens, actions, minutes) | Mox **Usage Meter** (server-side; fed by audited events, never by client self-report) | None yet — OpenBot audit rows and deepseek session events are raw material | Usage truth originates server-side only (Rule 3). |
| 18 | **Costs** (computed cost of usage against pricing) | Mox **Cost Engine** (server-side; Usage Meter × Pricing Service) | None — must be built | Costs are derived data; the engine is the only writer. |
| 19 | **Audit** (immutable record of decisions and side effects) | Mox **Audit Log** (server-side, append-only; the gateway/policy/billing layers write to it) | OpenBot `server/src/audit.ts` + `/admin/audit`; OpenMausBot decision log (`server/decision-log.ts`) | Audit is itself an authority: nothing may edit or delete audit rows. |

## Rules for changing this matrix

1. A concern may have **exactly one** final authority. Proposals to split or
   merge concerns must update this file in the same PR as the code.
2. "Donor today" columns are historical context only. Once a target
   authority exists, donor code paths are retired per
   `docs/consolidation/SOURCE_CLASSIFICATION.md` — they never become a
   second authority in the meantime.
3. Any component that needs a concern's truth consumes the authority's
   interface. Direct DB reads around an authority are violations.
4. New concerns must be added here **before** the code that introduces them
   lands.