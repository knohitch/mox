# Provenance: adapted components (Prompt 15 final record)

Each entry lists Mox-owned code derived from the vendored upstream trees,
the nature of adaptation, and where the donor's obligations are preserved.
Full license texts live in `third_party/licenses/`; attribution summary in
`third_party/notices/NOTICES.md`.

## From OpenBot (MIT © 2026 CopilotKit)

| Mox path | Adaptation |
|---|---|
| `packages/database/src/schema/*` | Multi-tenant reshaping of OpenBot drizzle schema patterns |
| `services/audit-service` | Append-only audit model with redaction boundary |
| `packages/security` | Egress identity model hardened into EgressPolicy + redaction + gateway tokens |
| `packages/policy`, computer layer | Action gateway resolve→policy→audit→act flow |
| `apps/web` admin concepts | Role-protected admin surface design (`services/admin`) |

## From DeepSeek Harness (MIT © 2026 DeepSeek)

| Mox path | Adaptation |
|---|---|
| `runtime/agent-runtime` | DSH runtime kernel consolidated as the single agent loop; DSH model seam retained as the provider abstraction seam |
| `packages/adapters/src/dsh-events.ts`, `dsh-session.ts` | Structural mirrors of event/session shapes — documented no-import |

## From OpenMausBot (Apache-2.0, Milind Soni)

| Mox path | Adaptation |
|---|---|
| `packages/adapters/src/openmaus-providers.ts` | Provider-driver metadata mirrored structurally (no import) |
| `packages/voice-device` (ElevenLabsVoiceProvider) | TTS client behavior ported from OpenMausBot server/tts/elevenlabs.ts behind a neutral VoiceProvider |
| `runtime/computer-runtime`, device capability model | CUA/device concepts re-hosted behind DeviceProvider with explicit authorization |

## Verification

- Authority scan (`scripts/authority-scan.mjs`, run in CI): asserts zero
  imports/requires referencing the vendored trees from Mox-owned code.
- Vendored trees are gitignored reference snapshots, never built, tested or
  deployed by Mox tooling.
