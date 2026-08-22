# Mox Full-System Verification Matrix (Prompt 15)

Every row maps a required full-system capability to its Mox-owned authority
and the automated tests proving it. Suites: `pnpm test` (53 files, 368+ tests),
`pnpm typecheck`, `pnpm lint`, `node scripts/authority-scan.mjs`.

Legend: ✅ verified by named tests · 🔒 honest-blocked pending external
credentials/approval (interface exists, reports UNAVAILABLE/REQUIRES_APPROVAL).

## Account / commercial

| Capability | Authority | Verification |
|---|---|---|
| Verified-payment activation | services/billing | forged redirect cannot activate; webhook-only activation (`billing.test.ts`) |
| Plus/Pro/Max/Enterprise entitlements | packages/entitlements + billing seed | override precedence, contract layers (`entitlements.test.ts`) |
| Regional pricing (USD/GBP/NGN/GHS) | billing price books | fixed/fx_derived/disabled selection (`billing.test.ts`) |
| Recurring renewal | billing renewal engine | successful renewal with exact invoice (`billing.test.ts`) |
| Failed renewal → past_due → grace → suspend | state machine | failure ladder test incl. recovery payment |
| Add-ons (consumable vs persistent) | addon catalog + attach gating | attach/deny-by-state tests |
| Cancel → retention → delete | lifecycle sweep | audited transition chain test |

## Compute

| Capability | Authority | Verification |
|---|---|---|
| Dedicated VPS provisioning (desired state) | services/compute-orchestrator | double-click buys one VPS; reconcile → running |
| Root/SSH delivery | ssh_keys schema + cloud-init | credential redaction test; no secrets in orders/logs |
| Mox Node enroll/heartbeat | runtime/mox-node + orchestrator | enrollment token rules; lost/recovery sweeps |
| Workload deploy to node | signed commands + DockerWorkloadManager | apply/replace/limits tests |
| Resize | provider op via class SKU map | resize test CX22→CX32 |
| Provider failure isolation | retry/backoff + terminal abandonment | chaos suite: no duplicate VPS |
| Cancellation while node offline | provider-side cancel | cancel→retention→destroyed test |
| BYOVPS | enroll contract exists | 🔒 documented interface; token flow tested |
| Contabo/Hetzner adapters | packages/compute-providers | header/auth/provision mapping; commercial gate 🔒 until creds |

## Agents

| Capability | Authority | Verification |
|---|---|---|
| Simple builder → canonical definition | agent-control builder | compile + preset tests |
| Developer mode (same engine) | AgentDefinition zod round-trip | round-trip test |
| Version/deploy/rollback | immutable revisions | history/diff/rollback tests; unpublished refusal |
| Concurrent-agent limits | entitlement gate | org-wide limit enforcement test |
| Chat/rooms/subagents/schedules | canonical definition fields + runtime | schedule compile; runtime suites (prompts 03–06) |
| Browser/computer | computer layer (prompt 04) + sandbox settings | existing computer-runtime suites |
| Terminal | ownership-checked sessions | tenant denial + entitled-access tests |
| Node workload reconciliation | NodeChannel apply/stop | pinned-revision reconcile test |

## Models

| Capability | Authority | Verification |
|---|---|---|
| BYOK/system credentials | credentials vault + model connections | vault suites (prompt 07); refs never carry secrets |
| Multiple providers | model gateway routing | gateway suites (prompt 07) |
| Provider unavailable | honest health reporting | health state tests |
| Usage metering of tokens | services/usage-meter | idempotent ingest, all 14 kinds |
| Official CLI connectors | adapters structural mirrors | openmaus driver metadata tests |

## Channels / integrations

| Capability | Authority | Verification |
|---|---|---|
| Web/WhatsApp/Telegram/Slack/Discord/Teams/webhook | channel-gateway adapters | per-provider normalize/outbound + signature tests |
| Duplicate webhooks | connection-level dedupe | storm + replay tests |
| Reply/thread mapping | conversation mapping store | telegram reply_to passthrough |
| MCP | McpProvider catalogue | tool normalization + danger levels |
| Composio | ComposioProvider | coexistence with MCP |
| Make.com / n8n | WebhookAutomationProvider | first-class connector tools |
| Tool grants explicit per subject | IntegrationGateway grants | grant/revoke/isolation tests |
| Voice TTS | ElevenLabsVoiceProvider | synthesize + usage metering + unconfigured honesty 🔒 key |
| Device/CUA | DeviceProvider | offline/capability/unauthorized graceful failures |

## Operations

| Capability | Authority | Verification |
|---|---|---|
| Centralized notifications | notification-service | routes/templates/mutes/dedupe/unread realtime |
| Audit trail | audit-service + admin audit | redaction + admin mutation trails |
| Usage aggregation & limits | usage-meter | hourly buckets; hard block / soft warn + overage ref |
| Cost/MRR/margin | cost-engine | FX conversion, dimension grouping, dedupe |
| Backups outside VPS | packages/backups | snapshot+S3 idempotency, restore test, retention, export |
| Abuse suspend (node offline OK) | platform-ops via provider API | emergency suspension test |
| Incidents | incident records/lifecycle | all four kinds lifecycle test |
| Provider health scoring | packages/provider-health | score/rank/incident/capacity tests |
| Health-aware safe selection | orchestrator selectCandidate | ranks among approved only; skips offline |
| Feature flags (6 scopes, audited) | packages/feature-flags | precedence/rollout/audit tests |
| Admin RBAC surface | services/admin | role boundaries; no-deploy plan changes; enterprise contracts |

## Security

| Capability | Verification |
|---|---|
| Cross-tenant denial | terminal cross-org rejection; entitlement isolation |
| Policy denial | egress default-deny; approval flags on dangerous tools |
| Node impersonation denial | enroll token mismatch; forged command signatures rejected |
| Secret redaction | metadata + log scrubbing tests |
| SSRF defense | private/metadata/encoded-host blocks; bounded reads |
| Webhook replay defense | stale timestamps; single-use nonces; applied-event dedupe |
| Admin escalation denial | support actor cannot reach settings/billing/compute caps |

## Quality gates (run before every release)

1. `node scripts/authority-scan.mjs` — vendored-tree import guard
2. `pnpm typecheck`
3. `pnpm lint`
4. `pnpm test` — full unit/integration matrix above
5. `pnpm build`
6. Clean-database migration check: `db:generate` journal matches
   `packages/database/migrations` head (0000–0005)
7. Container builds — deployment-config dependent (documented in runbook)
8. Real-provider smoke — only with explicitly configured credentials;
   otherwise providers report UNAVAILABLE/REQUIRES_APPROVAL honestly
