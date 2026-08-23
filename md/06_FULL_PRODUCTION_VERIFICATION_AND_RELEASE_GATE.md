# Repair Prompt 06 — Full end-to-end production verification and release gate

**Reasoning: Ultra**

Run after Prompts 00–05.

## Goal
Prove Mox is a coherent production system rather than individually passing libraries. Fix defects exposed by verification; do not add unrelated broad features.

## CI
The audited commit had no reported GitHub commit-status checks.

Create/verify CI for:
- install
- lint/format checks
- typecheck
- unit tests
- integration tests
- builds
- clean DB migration
- upgrade migration
- public-branding scan
- secret scan
- dependency/security checks where configured
- container builds

Mandatory gates must not use `|| true`.

## Production boot smoke test
Start actual production composition in a staging/test-safe environment with:
- PostgreSQL
- Redis
- object-storage test/emulator where needed
- control plane
- web
- admin
- workers
- full runtime
- computer runtime where testable

Verify no production service silently chooses demo/in-memory authority.

## Flow A — customer + billing
Test:
1. signup/login
2. org creation/selection
3. Plus/Pro/Max price resolution
4. regional price book
5. provider sandbox checkout
6. redirect alone does not activate
7. verified webhook activates
8. entitlements appear
9. renewal
10. failed renewal
11. grace/suspend
12. cancel
13. retention
14. resubscribe with historical subscription preserved

Exercise safe sandbox/fake paths for Paystack, Flutterwave, Stripe and PayPal.

## Flow B — compute
Test:
1. eligible subscription requests dedicated VPS
2. idempotent order
3. provider fake/sandbox
4. expected node token persisted before bootstrap
5. cloud-init uses configured control-plane URL
6. correct node enrolls
7. wrong/replayed token denied
8. heartbeat
9. restart preserves operation
10. resize
11. cancellation works with node offline

Do not purchase a live VPS unless the human explicitly authorizes it.

## Flow C — agents
Test:
1. Simple Mode creates AgentDefinition
2. Developer Mode edits the same definition
3. version/publish/deploy
4. runtime starts in full production engine mode
5. model gateway stub/sandbox
6. tool call
7. approval
8. browser/computer
9. files/terminal where entitled
10. restart/resume
11. subagent
12. Agent Room

## Flow D — notifications
Test:
1. admin sends one-user notification
2. correct user receives realtime
3. wrong user cannot read/mark it
4. user marks read
5. unread count updates
6. admin broadcasts to org/segment
7. restart retains inbox
8. billing/server event creates automatic notification

## Flow E — admin
Verify configuration of:
- plans
- entitlements
- regional prices
- Paystack/Flutterwave/Stripe/PayPal
- Contabo/Hetzner
- compute classes
- Mox-owned model/API credentials
- internal intelligence routing
- notifications
- feature flags
- provider health

Secrets must never be returned plaintext.

## Security regressions
At minimum:
- cross-tenant API denial
- notification IDOR denial
- node-enrollment hijack denial
- webhook forgery/replay denial
- payment amount/currency tampering denial
- secret redaction
- SSRF controls
- direct computer-control bypass denial
- unauthorized admin denial

## Branding regression
Run branding scanner and manually inspect main UI, agent chat, runtime errors, notifications, CLI and admin.

Customers see Mox.
No donor harness identity.
No generic GPT terminology.

## Release document
Create `docs/verification/POST_REPAIR_RELEASE_GATE.md` with:
- area
- test
- result
- evidence/test name
- blocker
- production-ready yes/no

Do not mark production-ready while any critical/high blocker remains.

## Acceptance criteria
- meaningful CI is active;
- production composition boots durably;
- no DemoMoxApi/in-memory authoritative production fallback;
- four payment providers pass sandbox/test flows;
- node-enrollment hijack is closed;
- admin notifications + user inbox work;
- admin control surface works;
- full Mox runtime path works;
- security/tenant tests pass;
- branding rules pass;
- release gate truthfully lists remaining external credential/commercial blockers.
