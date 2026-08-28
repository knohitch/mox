# 04 — CUSTOMER EXTENDED CAPABILITY PARITY

## Objective

Surface the remaining Mox-owned customer capabilities that belong in the product, while distinguishing "implemented service but not production-composed" from truly customer-ready functionality.

---

# A. USAGE / LIMITS / CREDITS

The usage-meter domain supports more than raw totals.

Expose customer-safe:
- current consumption
- included quantity
- remaining quantity
- unlimited state
- soft-limit warning
- hard-limit blocked state
- overage state where product supports overage
- Mox AI credits when applicable
- plan period/window

Do not expose internal wholesale cost/margin.

Use canonical entitlement and usage authorities.

---

# B. NOTIFICATION PREFERENCES

The notification domain already supports:
- per-event route preferences
- muted events
- in-app
- email
- web push
- SMS
- WhatsApp
- webhook

Build Settings -> Notifications.

Requirements:
- only show routes actually configured/available for the deployment;
- preserve mandatory billing/security event behavior;
- users must not be able to mute mandatory categories contrary to service policy;
- per-user/org scoping must be explicit;
- inbox behavior remains unchanged.

Add safe preference GET/PUT endpoints if absent.

---

# C. BACKUPS

The Mox backup package supports:
- provider snapshots
- optional Mox-owned S3 copy
- idempotent backup runs
- restore verification
- retention
- cancellation export

Determine the intended customer-safe subset from existing contracts/entitlements.

At minimum surface:
- backup availability
- retention allowance
- recent backup status
- last successful backup
- failed backup visibility
- restore-test status if supported
- manual backup action only if product/service safely supports it
- export/cancellation information if applicable

Do not expose:
- provider credentials
- internal object-store credentials
- sensitive raw storage topology

Admin controls belong in Admin phase.

---

# D. TEAM / WORKSPACE MEMBERS

Canonical entitlement includes `team_members`.

Build customer workspace member management separate from platform staff.

Required when supported by identity schema:
- list members
- invite
- role
- pending state
- revoke/remove
- disable where appropriate
- owner-safety rules
- entitlement/team limit
- audit-safe mutations

Never reuse platform staff invitations for customer workspace members.

If the required customer invitation lifecycle is not implemented, build the minimum proper durable workflow; do not create users by insecure direct DB mutation from the UI.

---

# E. SCHEDULES / WORKFLOWS / SUBAGENTS / SKILLS / KNOWLEDGE / MEMORY

These exist in the canonical AgentDefinition.

Surface them in the agent authoring/settings experience according to actual runtime support.

For each:

## Schedules
- list
- create/edit/delete
- cron/schedule
- timezone
- prompt
- enabled state
- enforce `schedule_workflow_limit`

## Workflows
- configure only if the runtime has a real workflow authority
- otherwise show accurate unavailable state rather than storing inert JSON

## Subagents
- select valid same-org agents
- delegation mode
- prevent cycles if runtime/domain requires it

## Skills
- select/configure real registered skills
- do not expose donor/internal skills merely because files exist

## Knowledge
- bind valid same-org knowledge resources
- enforce read/search/attach access

## Memory
- enabled
- scope
- retention
- ensure runtime actually consumes the canonical configuration

A setting that is merely stored but never read by runtime must be documented as blocked and not presented as fully operational.

---

# F. VOICE

Mox-owned voice code includes provider abstractions and usage metering.

If production composition is sufficient, surface:
- enable/disable
- available voice provider(s)
- voice list
- voice preview/test where safe
- selected voice
- usage
- entitlement/voice-minute state

If provider credential configuration is Admin/system-owned, customers select from allowed Mox-managed voices without seeing credentials.

If BYOK voice is product-supported, use customer credential authority.

---

# G. DEVICES / LOCAL DEVICE TARGET

Mox-owned device capability code includes:
- registered devices
- authorization
- online state
- capability advertisement
- screen capture
- tap
- typing
- app launch

Agent contracts include local-device target concepts.

Only productize this if a real device relay/enrollment path exists.

If it does:
- device list
- authorization
- online state
- capabilities
- target selection

If not:
- classify `NOT_PRODUCTIZED_BLOCKED`;
- do not build a fake device list.

---

# H. STORAGE

Canonical entitlement includes `storage_gb`.

If customer-owned files/knowledge/storage usage exists in Mox-owned runtime:
- show usage/quota;
- provide appropriate file/knowledge UX.

Do not confuse this with the currently-unconfigured agent workspace filesystem endpoint.

---

# I. FEATURE DISCOVERABILITY PASS

After A-H, revisit the inventory.

Every customer feature must have:
- navigation entry, or
- contextual entry point, or
- Settings section, or
- agent-builder section.

No customer-ready backend capability should be reachable only by manually typing an API path.

---

# J. TESTS

Add coverage for all productized items:
- usage limits;
- notification preferences and mandatory categories;
- backup tenant isolation/status;
- team-member authorization/limits;
- schedules/subagents cross-org rejection;
- voice gating;
- device blocked/available state;
- storage quotas.

---

# REPORT

Create:

`docs/verification/UI_PARITY_04_CUSTOMER_EXTENDED.md`

Local commit after green verification:

`feat(ui-parity): surface extended customer capabilities`
