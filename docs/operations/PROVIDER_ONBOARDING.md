# Provider Onboarding Guide

How to bring a new compute/model/channel/integration provider into Mox.
All providers implement a Mox-owned interface; nothing binds business logic
to a specific vendor.

## Compute provider (e.g. adding a third VPS vendor)

1. Implement `ComputeProvider` (`packages/compute-providers/src/types.ts`):
   list products/regions, provision, lifecycle ops, health. Declare honest
   capability flags — missing operations must report, not fake.
2. Add an adapter file next to `contabo.ts` / `hetzner.ts`. Use the injected
   fetch seam for unit tests; normalize errors to `ProviderError` with
   correct `retryable` semantics.
3. Register with the orchestrator + create provider account(s):
   ```ts
   orchestrator.registerProvider(provider);
   await orchestrator.registerProviderAccount({
     providerName: "vendor-x", accountLabel: "eu-1",
     commercialStatus: "verify", enabled: true,
   });
   ```
4. Commercial gate stays `verify` until an admin approves
   (`setProviderCommercialApproval`). Selection never routes traffic to
   unapproved providers regardless of health score.
5. Map SKUs inside compute classes (`skuMap`) — never in code paths.
6. Tests: auth/header behavior, error normalization, state mapping, plus one
   chaos case proving no duplicate purchase on retry.

## Model provider

Implement against the model gateway's provider interface (see prompt 07
suites). BYOK connections store vault references only; system credentials
are admin-managed and reported as metadata.

## Channel adapter

Extend `services/channel-gateway` with a `ChannelAdapter`: verifyWebhook
(timing-safe HMAC + stale-timestamp window), normalize inbound ids/text/
attachments/reply refs, formatOutbound for your platform. One agent may
attach many channels; do not hard-bind pairs.

## Integration provider

Produce real `ToolDefinition`s from your catalogue via
`IntegrationProvider.listTools` (empty when unconfigured — never fakes) and
route execution through explicit grants.

## Voice / device

Voice: implement `VoiceProvider` with key verification, voice listing,
synthesis and usage-metering hooks. Device: implement behind
`DeviceTransport`; capabilities must be advertised up front; unauthorized or
offline devices fail gracefully with reasons.

## Checklist before enabling production traffic

- [ ] Adapter unit tests green (auth, retries, mapping)
- [ ] Health observations wired into selection
- [ ] Provider account created with `verify`, then admin-approved
- [ ] Blast radius documented (accounts per region)
- [ ] Rotation path verified
