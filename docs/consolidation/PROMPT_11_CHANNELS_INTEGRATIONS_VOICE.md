# Prompt 11 — Channels, integrations, voice and device capabilities

## What was built

- `services/channel-gateway`
  - Canonical flow implemented: external channel → adapter → normalized
    ChannelMessage → Mox thread mapping → agent handler → response → adapter
    → external channel, with delivery receipts.
  - Adapter architecture + seven adapters: Mox web chat, WhatsApp Cloud API,
    Telegram Bot API, Slack Events, Discord, Microsoft Teams, generic
    webhook/API. Each normalizes external conversation/user/message ids,
    text, attachments and reply/thread references; timing-safe signature
    verification per provider scheme; dedupe by (connection, message id);
    stale-timestamp replay protection.
  - External conversation mapping table (connection ↔ external conversation ↔
    Mox thread ↔ participant) plus delivery receipts.
  - One agent attaches to MANY channels; nothing hard-binds a single pair.
  - Disconnect/reconnect cycles pause processing honestly (`paused`).
- `services/integration-gateway`
  - Providers: MCP (descriptor-backed catalogue), Composio broker, native
    OAuth/API template, Make.com, n8n and generic webhook/token automations.
  - Every integration normalizes into Mox `ToolDefinition`s with danger
    levels and approval flags preserved; disconnected connections expose no
    tools (capability-honest).
  - Explicit tool grants per org/user/agent with revocation; authorization
    check gates every outbound call; grants only possible for tools actually
    exposed by the connection's live catalogue.
- `packages/voice-device`
  - `VoiceProvider` abstraction porting OpenMaus' ElevenLabs TTS
    (verifyKey/listVoices/synthesize, friendly provider errors, key stays
    server-side), extension points for OpenAI/Google/Azure/AWS realtime,
    usage-metering hook registry emitting character counts per voice.
  - `DeviceProvider` for Android/device CUA behind capability advertisement;
    explicit user authorization, graceful offline/capability-missing/
    not-authorized results; no Electron assumption.

## Tests

30 new tests: end-to-end webhook flow, duplicate rejection, forged signature +
connection error flagging, attachment passthrough (WhatsApp document payload),
reply/thread mapping (Telegram reply_to), same agent on many channels with
per-provider outbound formats, disconnect/reconnect, MCP+Composio coexistence,
Make/n8n connector paths, grant enforcement incl. cross-agent isolation and
revocation, unexposed-tool grant refusal, OAuth token gating, ElevenLabs
synthesize/metering/error mapping/unconfigured honesty, device actions on
capable devices, offline/capability/unauthorized graceful failures.
