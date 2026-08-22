# Mox Source Classification

Status: **Baseline (Step 1 of consolidation).** Disposition of the major
directories/modules of the three imported trees. Nothing in this document
authorizes deleting, renaming, or editing the imported trees (Architecture
Rule 7) — classification records *intent* for later consolidation steps.

## Disposition vocabulary

| Label | Meaning |
|---|---|
| **KEEP** | Stays in its imported tree, unmodified, as the working reference (and its tests) until final retirement. |
| **PORT** | Code moves into Mox with minimal change, behind a Mox interface, with provenance header. |
| **ADAPT** | Code moves into Mox with substantial modification (re-hosted, re-shaped to Mox interfaces). |
| **REPLACE** | Mox builds its own implementation; the donor code is reference only and is not carried forward. |
| **RETIRE** | Not carried forward; dies with the source tree at final retirement. |

## Donor roles (binding context)

- **OpenBot** = control plane / computer / security donor.
- **DeepSeek Harness** = runtime kernel donor.
- **OpenMausBot** = GrokBot UX / provider / voice / device donor.

---

## `OpenBot-main/` — control plane / computer / security donor

| Path | Disposition | Rationale |
|---|---|---|
| `server/src/computer/` (gateway: resolve → policy → audit → act) | **PORT** | The security-critical action gateway is exactly Mox's Action Gateway + Policy Engine core. |
| `server/src/audit.ts` + `/admin/audit` | **PORT** | Append-only audit model matches Architecture Rule 4. |
| `server/src/credentials.ts` (encrypted, write-only) | **PORT** | Credential vault pattern (encrypted at rest, never logged). |
| `server/src/auth/` (better-auth) | **ADAPT** | Auth patterns ported into Mox Identity Service; provider/config re-shaped for Mox. |
| `server/src/channels/`, channel routes | **ADAPT** | Channel concepts feed Mox Channel Service; web-first re-shaping. |
| `server/src/db/` (drizzle schema/migrations) | **ADAPT** | Schema patterns reused; Mox owns its own migrations. |
| `server/src/agents` + `agents.yaml` model | **ADAPT** | Becomes input to the single `AgentDefinition` registry (Rule 5). |
| `server/src/connectors*`, `knowledge/`, `plugins/` (MCP governance) | **ADAPT** | Governed-MCP catalogue and connector policy ported behind tool-policy interfaces. |
| `server/src/components/` (component gallery/playground governance) | **RETIRE** | CopilotKit-specific component pipeline; revisit only if Mox adopts the pattern. |
| `server/src/copilot.ts`, CopilotKit runtime wiring | **KEEP** (until replacement) | CopilotKit is explicitly not replaced yet; stays working in-tree. |
| `app/` (React/Vite web UI) | **KEEP** (reference) / **REPLACE** (long-term) | Web app is primary (Rule 6), but Mox UI will be its own; OpenBot UI is the reference for admin surfaces (audit, boundaries, computers, credentials). |
| `worker/` (supervisor worker) | **PORT** | Desired-state/computer lifecycle logic feeds the Desired-State Controller. |
| `supervisor/` (per-bot computer containers, gVisor option) | **PORT** | Core compute-provisioning donor for Compute Registry + Desired-State Controller. |
| `agent-bot/`, `agent-langgraph/`, `agent-computer/` (example AG-UI agents) | **KEEP** | Working reference agents; validate AG-UI adapter behavior. |
| `shared/` | **ADAPT** | Shared types feed Mox contracts where relevant. |
| `spire/` (configs) | **RETIRE** | Deployment-specific config; Mox defines its own deployment. |
| `Dockerfile`, `docker-compose.yml`, `docker/` | **KEEP** | Reference deployment; Mox deployment designed later. |
| `scripts/`, `tests/` | **KEEP** | Baseline verification + porting reference for gateway tests. |
| `docs/` | **KEEP** | Architecture/configuration reference during consolidation. |

## `deepseek-harness-master/` — runtime kernel donor

| Path | Disposition | Rationale |
|---|---|---|
| `packages/core`, `packages/session`, `packages/session-query`, `packages/storage`, `packages/spill` | **PORT** | The kernel: session/event-sourcing and storage are the backbone of Mox Agent Runtime + Session Store. |
| `packages/host`, `packages/boot`, `packages/sdk` | **ADAPT** | Host/boot lifecycle re-hosted under Mox runtime interfaces. |
| `packages/llm` | **ADAPT** | Model abstraction feeds the Model Router; provider adapters re-cut to Mox interfaces. |
| `packages/subagent`, `packages/workflow`, `packages/plan`, `packages/goal`, `packages/todo`, `packages/schedule`, `packages/jobs` | **PORT/ADAPT** | Agent orchestration primitives carried into the runtime kernel. |
| `packages/mcp`, `packages/shell`, `packages/fs`, `packages/terminal`, `packages/subprocess`, `packages/sandbox`, `packages/guard`, `packages/credentials` | **ADAPT** | Tool/execution surfaces re-cut behind Mox tool-policy + action-gateway interfaces (OpenBot gateway remains the policy authority). |
| `packages/code-runtime`, `packages/e2b` | **ADAPT** | Sandboxed code execution providers behind the compute interface. |
| `packages/client`, `packages/web`, `apps/web` (Web UI) | **KEEP** (reference) / **REPLACE** (long-term) | Reference for runtime-driven UI; Mox web app is its own (Rule 6). |
| `apps/cli` (`dsh` CLI) | **KEEP** | Working reference for driving the kernel headlessly. |
| `packages/typert`, `packages/context`, `packages/compaction`, `packages/attachment`, `packages/skill`, `packages/preset`, `packages/settings`, `packages/hooks`, `packages/interaction`, `packages/lsp`, `packages/feedback`, `packages/workspace`, `packages/util`, `packages/bundle`, `packages/api`, `packages/acp`, `packages/experimental`, `packages/extensions`, `packages/runtime-diagnostics`, `packages/test-support` | **PORT/ADAPT** (case-by-case at port time) | Kernel support libraries; each is evaluated when the subsystem that needs it is ported. |
| `vendor/` (cordis + foundation, MIT) | **PORT** | Plugin/composability framework the kernel is built on; carries its own upstream licenses. |
| `native/landlock-run` (BSD-3-Clause) | **RETIRE** (on Windows-first Mox) / **KEEP** in-tree | Linux Landlock sandboxing; irrelevant to Windows hosts, kept as reference. |
| `python/` (SDK + sdk-runtime) | **KEEP** | Secondary SDK; not on the Mox critical path. |
| `website/`, `examples/`, `docs/` | **KEEP** | Documentation/examples reference. |
| `patches/node-pty@*.patch` | **PORT** (with any node-pty usage) | Required modification record if node-pty is used. |
| Claude-agent-sdk payload integration | **ADAPT** | Provider adapter only (Rule 2); payload license terms per PROVENANCE §1. |

## `OpenMausBot-main/` — GrokBot UX / provider / voice / device donor

| Path | Disposition | Rationale |
|---|---|---|
| `src/` (chat UX: roster, model picker, approval cards, computer panel) | **ADAPT** | The GrokBot-style messaging UX is the donor for Mox web UX (re-hosted web-first, Rule 6). |
| `server/harness/` + CLI drivers (claude/codex/grok engines) | **ADAPT** | Engine drivers become provider adapters behind the Agent Runtime interface. |
| `server/local-routing.ts` + model picker/provider rail | **ADAPT** | Feeds Model Router UX + policy. |
| `server/computer-control.ts`, `computer-observation.ts`, `computer-proxy.ts`, `screen-preview` | **ADAPT** | Computer UX (live preview, takeover) ported behind the Action Gateway. |
| `server/vps-computer.ts`, `vps-routing.ts`, `local-vm-*.ts`, `container-computer.ts`, `box*.ts` | **ADAPT** | Compute backends become providers behind Compute Registry / Desired-State Controller; untrusted-VPS rules (Rule 3) applied during adaptation. |
| `server/permission-proxy.ts`, `peer-approval.ts`, `auto-approve.ts`, `decision-log.ts` | **ADAPT** | Approval UX + decision records merge into Policy Engine + Audit Log. |
| `server/message-db.ts`, `thread-events.ts`, `store.ts`, `schema.ts` | **RETIRE** | Local-first storage replaced by Mox server-side Session Store. |
| `server/composio.ts` + `cloudflare/composio-broker/` | **ADAPT** | Connected-apps (Composio) integration becomes a tool provider adapter. |
| `server/notify.ts`, `webhooks.ts`, `webhook-ingress.ts` | **ADAPT** | Feeds Notification Service + external channel adapters. |
| `server/tts/`, `electron/speech.mjs`, speech helper build | **PORT/ADAPT** | Voice donor: TTS/STT pipeline ported behind a voice-provider interface. |
| `electron/` (desktop shell, updater, cua runtime, android-device) | **ADAPT** (device bits) / **RETIRE** (shell/updater) | Device integration (screen, speech, Android device bridge) is the donor value; the Electron app shell itself is retired — web is primary (Rule 6). |
| `companion/` | **RETIRE** | Companion app tied to the Electron/desktop model. |
| `ios/` | **RETIRE** | Native iOS app; out of scope for web-first Mox. |
| `build/` (icons, packaging assets), `electron-builder.yml` | **RETIRE** | Desktop packaging. |
| `skills/`, `tools/` (phone-harness, oxlint config) | **ADAPT** / **RETIRE** | Skills concepts feed AgentDefinition capabilities; phone-harness evaluated with device work. |
| `third_party/cua-driver/` (MIT, Cua AI) | **PORT** (with attribution) | Computer-use driver; license obligations per PROVENANCE §1. |
| `mascot-preview.html`, `public/` assets | **RETIRE** | Branding assets; Mox defines its own. |
| `cloudflare/` (broker worker) | **ADAPT** | Broker pattern may inform Mox's credential-broker design; not deployed as-is. |

## Cross-cutting notes

1. **Conflicts resolve by donor role.** Where two trees implement the same
   concern (e.g., computer control in OpenBot vs OpenMausBot; sessions in
   deepseek-harness vs OpenMausBot), the donor role decides: OpenBot wins
   control-plane/security shapes, deepseek-harness wins kernel shapes,
   OpenMausBot wins UX/voice/device shapes. The loser is RETIRE/ADAPT, never
   a second authority (AUTHORITY_MATRIX Rule 2).
2. **KEEP is temporary.** Every KEEP becomes RETIRE at final retirement
   (Architecture Rule 7). KEEP means "still our working reference," not
   "permanent."
3. **PORT/ADAPT items must land with**: provenance header (PROVENANCE §2),
   tests ported or re-written, and the corresponding AUTHORITY_MATRIX
   authority in place to receive them.
4. **Nothing here authorizes editing the imported trees.** If a donor file
   must change to be portable, it is copied out and changed in Mox, never in
   place.
5. **Prompt 03 update — single runtime authority.** Native agent execution
   authority is now `runtime/agent-runtime` (`@mox/agent-runtime`), reached
   from the Control Plane only through `packages/runtime-client`. OpenBot
   `agent-bot/` and OpenMausBot `server/harness/` + CLI drivers are marked
   COMPATIBILITY/REFERENCE (see `MOX_COMPATIBILITY.md` markers in both
   trees); they are no longer parallel authorities and no Mox code routes
   new agents to them. See `PROMPT_03_RUNTIME_MIGRATION.md`.