# Prompt 11 — Channels, integrations, voice and device capabilities

**Recommended Codex reasoning: Extra High**

Continue from Prompt 10.

## Goal

Build the complete external communications and app-integration layer around the same Mox agents.

## Channel Gateway

Implement canonical flow:

```text
external channel
→ adapter
→ ChannelMessage
→ Mox thread
→ agent
→ response
→ adapter
→ external channel
```

## Required adapters

Create production-ready adapter architecture and implement/configure where official APIs permit:

- Mox web chat
- WhatsApp
- Telegram
- Slack
- Discord
- Microsoft Teams
- generic webhook/API channel

Each adapter must support:
- external user/conversation/message ids;
- text;
- attachments;
- reply/thread references;
- delivery state;
- deduplication/idempotency;
- webhook signature verification where applicable;
- rate-limit/error handling.

Do not hard-code one agent per channel. A single agent can attach to many channels.

## External conversation mapping

Store:
- channel connection;
- external conversation id;
- Mox thread id;
- external participant mapping;
- delivery receipts where available.

## Integration Gateway

Implement provider architecture for:
- MCP;
- Composio;
- native OAuth/API providers;
- Make.com webhooks/API;
- n8n;
- generic webhook/API token integrations.

Port/adapt OpenBot plugin catalogue/MCP concepts and OpenMaus Composio broker where useful.

Every integration produces Mox `ToolDefinition`s and every tool grant is explicit per org/user/agent.

## Voice

Port OpenMaus voice/TTS functionality into a `VoiceProvider` abstraction.

Support:
- ElevenLabs adapter from existing code;
- extension hooks for OpenAI/Google/Azure/AWS/etc.;
- voice selection;
- TTS;
- future realtime call provider interface;
- usage metering hooks.

Port useful CallView UI into Mox web.

## Device/CUA

Port selected OpenMaus Android/device/CUA capabilities behind `ComputerProvider` or `DeviceProvider` interfaces.

Requirements:
- capability-advertised;
- entitlement-gated;
- explicit user authorization;
- policy/audit;
- no assumption that desktop-local Electron exists.

## Security

- verify all incoming webhooks;
- no shared secrets in frontend;
- OAuth tokens in Mox Vault;
- outbound tool calls pass policy/audit;
- channel attachments are scanned/validated according to configured security policy;
- protect against replay.

## Tests

- duplicate webhook;
- bad signature;
- attachment;
- reply/thread mapping;
- agent on multiple channels;
- disconnect/reconnect;
- integration tool permission;
- voice usage event;
- device capability unavailable gracefully.

## Acceptance criteria

- All channel traffic normalizes into Mox threads.
- Integrations are provider-neutral.
- MCP and Composio coexist.
- Make/n8n have first-class connector paths.
- voice/device capabilities are preserved without requiring Electron.
