# Mox Full-System Codex Build Pack

Repository: `https://github.com/knohitch/mox.git`  
Target branch baseline: `master`  
Product: **Mox — hosted AI-agent cloud + VPS reseller/control plane + multi-model agent runtime**

## Important scope rule

This build pack is **not an MVP plan**.

Every numbered prompt is one implementation slice of the complete production system. The slices exist only to keep Codex from attempting a dangerous all-at-once rewrite. Do not remove a feature merely because it is complex. If a feature cannot safely be completed in its assigned prompt, preserve the contract and leave a clearly documented blocker rather than silently dropping it.

## Source projects already in the repository

- `OpenBot-main/`
- `OpenMausBot-main/`
- `deepseek-harness-master/`

These are upstream technology donors. They must not remain three competing production applications.

### Final ownership model

- OpenBot contributes the initial SaaS/control-plane foundation, browser/computer gateway, policy, credentials, audit, agents/coworkers, plugins and admin concepts.
- DeepSeek Harness becomes the single native Mox agent-runtime kernel.
- OpenMausBot contributes the GrokBot-style agent UX, chat/composer, model/provider UX, approvals UI, computer UI, voice/calling, selected provider-driver concepts and selected CUA/device capabilities.
- New Mox-owned services provide billing, pricing, plans, entitlements, compute provisioning, Mox Node, model gateway, messaging gateway, notifications, usage, costs, backups, abuse controls and enterprise functions.

## Non-negotiable architectural rules

1. **One authority per concern.**
   Do not keep parallel authoritative stores/engines for sessions, credentials, entitlements, policies, model routing, billing, deployments or agent execution.

2. **Provider-specific code stays behind provider interfaces.**
   Contabo logic must not leak into billing. OpenAI logic must not leak into the agent loop. WhatsApp logic must not leak into session storage.

3. **Customer VPS nodes are untrusted execution environments.**
   Mox Control Plane owns identity, subscription, billing, entitlement and server ownership truth. A user has root/SSH and may modify Mox Node.

4. **External side effects must be idempotent and auditable.**
   Payments, VPS purchases, resizing, cancellation, model usage, deployment, backups and tool execution must tolerate retries.

5. **Simple Mode and Developer Mode compile to the same `AgentDefinition`.**
   There is only one agent engine.

6. **The web product is primary.**
   Do not require a desktop download to use Mox. Electron-specific capabilities may be ported as providers.

7. **Do not delete the imported upstream trees until Prompt 15.**
   Early prompts may port/copy/adapt code, but source trees stay available for reference and parity testing.

8. **Preserve licensing/provenance.**
   Keep MIT/Apache notices and a clear record of code copied/adapted from upstream.

9. **Do not rewrite stable technology merely for fashion.**
   Keep React/Vite and Hono where they work. Do not introduce Laravel/PHP. Do not force a Next.js rewrite of the authenticated app.

10. **No silent mock success.**
    External-provider adapters may use fakes in tests, but production code must report unavailable/not-configured states honestly.

## Target stack

- TypeScript
- Node.js 24 target
- pnpm target package manager
- Bun temporarily permitted only for still-unported OpenBot components
- React + Vite for authenticated web app
- Hono for APIs
- PostgreSQL + Drizzle
- pgvector where useful
- Redis
- BullMQ or equivalent durable Redis-backed job queues
- Supabase Realtime or Mox-owned WebSocket service behind a Mox realtime interface
- Docker
- Playwright/Chromium
- S3-compatible object storage
- OpenTelemetry-compatible observability
- Zod or equivalent runtime validation

## Canonical target repository shape

```text
mox/
├── apps/
│   ├── web/
│   ├── admin/
│   ├── cli/
│   └── marketing/
├── services/
│   ├── control-plane/
│   ├── billing/
│   ├── entitlements/
│   ├── pricing/
│   ├── compute-orchestrator/
│   ├── agent-control/
│   ├── model-gateway/
│   ├── channel-gateway/
│   ├── integration-gateway/
│   ├── notification-service/
│   ├── realtime/
│   ├── usage-meter/
│   ├── cost-engine/
│   ├── audit-service/
│   └── workers/
├── runtime/
│   ├── agent-runtime/
│   ├── computer-runtime/
│   └── mox-node/
├── packages/
│   ├── contracts/
│   ├── database/
│   ├── events/
│   ├── auth/
│   ├── policy/
│   ├── credentials/
│   ├── money/
│   ├── entitlements/
│   ├── jobs/
│   ├── provider-sdk/
│   ├── runtime-client/
│   ├── observability/
│   ├── security/
│   ├── compute-providers/
│   ├── model-providers/
│   ├── channel-adapters/
│   └── integration-providers/
├── infra/
├── docs/
└── third_party/
```

The exact physical split may be adjusted if the repository proves that another grouping is materially safer, but ownership boundaries must remain.

## Canonical contracts that must exist by the end of Prompt 01

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

## Full product requirements to preserve across all prompts

### Commercial
- Plus, Pro, Max and Enterprise.
- Recurring monthly subscriptions.
- Regional price books and multiple currencies.
- Fixed regional overrides or FX-derived prices.
- Immutable price versions.
- Add-ons: additional VPS, resize, storage, backups, AI credits, messaging, voice, seats.
- Suspension → grace/retention → destruction lifecycle.
- Customer root/SSH access.
- Dedicated VPS per paid workspace.
- General VPS use is permitted; Mox is also a VPS reseller/control plane.
- Contabo first; Hetzner adapter second, activation gated by commercial approval.
- Additional providers remain pluggable.

### Agents
- GrokBot/OpenMaus/OpenBot-style agent roster/coworker experience.
- Agent identities, avatars, roles, model, memory, computer, tools, apps, skills, knowledge, voice, channels and server.
- Individual agent chat.
- Multi-agent rooms.
- No-code/Simple builder.
- Full Developer mode.
- Browser/computer.
- Terminal/CLI for entitled plans.
- Imported agents and custom runtime endpoints.
- Git/Docker deployment support.
- Schedules, goals, workflows, plans, todos, jobs and subagents.

### Models
- Mox Model Gateway.
- Mox-managed provider credentials.
- User/org/agent BYOK scopes.
- API providers for OpenAI, Anthropic, Gemini, xAI/Grok, DeepSeek, Qwen, GLM, Kimi, MiMo, NVIDIA, OpenRouter and generic OpenAI-compatible endpoints.
- Official subscription/CLI engines only where technically and commercially permitted.
- DSH model seam is the runtime-facing abstraction.

### Messaging and integrations
- Web chat.
- WhatsApp.
- Telegram.
- Slack.
- Discord.
- Microsoft Teams.
- API/webhooks.
- MCP.
- Composio.
- Make.com.
- n8n.
- Extensible provider SDK.

### Platform operations
- PostgreSQL is durable source of truth.
- Redis only for queues/cache/locks/rate limits/ephemeral state.
- Notifications: in-app, email, push-ready, SMS-ready, WhatsApp-ready, webhook.
- Usage metering.
- Cost/margin engine.
- Backups outside customer VPS.
- Abuse case management.
- Provider health scoring.
- Multi-provider/multi-account blast-radius design.
- OpenTelemetry observability.
- Audit trail.
- Feature flags.
- Enterprise custom contracts/entitlements.
- Security hardening, disaster recovery and restore testing.

## Working discipline for every prompt

Before changing code:

1. Run `git status`.
2. Record current branch and HEAD SHA.
3. Read the files named in the prompt plus directly related implementations/tests.
4. Run the relevant baseline tests before edits.
5. Do not touch unrelated files just to clean style.
6. Keep a migration note under `docs/consolidation/`.
7. Add or update tests for every material behavior.
8. Run targeted tests, type-check and lint after edits.
9. Do not deploy production infrastructure from Codex.
10. Do not push to GitHub unless the human explicitly asks.
11. Do not continue automatically to the next numbered prompt.
12. At the end, output:
    - old SHA
    - new SHA
    - branch
    - files changed
    - schema/migration changes
    - tests run/results
    - remaining blockers
    - exact next prompt number

## Recommended Codex reasoning levels

- Use **Ultra** for architecture, persistence, runtime, security, billing, compute and retirement prompts.
- Use **Extra High** for UI, channels, integrations and operational feature implementation.
- Do not use low reasoning for this project.

## Execution order

1. `00_BASELINE_AND_ARCHITECTURE_GUARDRAILS.md`
2. `01_MOX_MONOREPO_AND_CANONICAL_CONTRACTS.md`
3. `02_CONTROL_PLANE_MULTITENANCY_AND_DATABASE.md`
4. `03_DEEPSEEK_HARNESS_RUNTIME_CONSOLIDATION.md`
5. `04_COMPUTER_POLICY_BROWSER_AND_RUNTIME_SUPERVISION.md`
6. `05_UNIFIED_MOX_WEB_GROKBOT_AGENT_EXPERIENCE.md`
7. `06_SESSION_EVENT_STORE_REALTIME_AND_MEMORY_OWNERSHIP.md`
8. `07_MODEL_GATEWAY_VAULT_AND_PROVIDER_SYSTEM.md`
9. `08_BILLING_PRICING_ENTITLEMENTS_AND_REGIONAL_COMMERCE.md`
10. `09_COMPUTE_ORCHESTRATOR_CONTABO_HETZNER_AND_MOX_NODE.md`
11. `10_AGENT_BUILDER_DEPLOYMENTS_DEVELOPER_MODE_AND_CLI.md`
12. `11_CHANNELS_INTEGRATIONS_VOICE_AND_DEVICE_CAPABILITIES.md`
13. `12_NOTIFICATIONS_USAGE_COST_BACKUPS_ABUSE_AND_OPERATIONS.md`
14. `13_ENTERPRISE_ADMIN_PROVIDER_HEALTH_AND_PLATFORM_CONTROLS.md`
15. `14_SECURITY_HARDENING_CHAOS_DR_AND_PRODUCTION_READINESS.md`
16. `15_UPSTREAM_RETIREMENT_PARITY_AND_FINAL_SYSTEM_VERIFICATION.md`

Do not skip a prompt unless its acceptance criteria were already demonstrably satisfied by earlier work.
