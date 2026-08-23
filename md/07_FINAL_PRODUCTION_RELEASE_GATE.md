# Prompt 07 — Final Mox production release gate

**Reasoning: Ultra**

Run after Prompt 06 deep debugging.

## Goal

Perform final end-to-end release validation of the complete Mox platform.

Do not add broad new features here. Fix only release-blocking defects discovered during verification.

## CI

Ensure mandatory CI covers:
- install
- lint
- typecheck
- unit tests
- integration tests
- PostgreSQL tests
- migrations
- upgrade drill
- web build
- admin build
- CLI build
- runtime build
- branding scan
- secret scan
- dependency/security checks
- container builds where configured

No mandatory step may use `|| true`.

## End-to-end customer flow

Test:
1. signup
2. login
3. organization
4. plan selection
5. regional price
6. provider checkout
7. redirect alone grants nothing
8. verified webhook activates
9. entitlements
10. dedicated VPS order
11. node enrollment
12. agent creation
13. deployment
14. model connection
15. chat/run
16. browser/computer
17. notification
18. renewal
19. failed renewal/grace/suspend
20. cancellation/retention
21. resubscribe

Use payment sandbox/fakes and compute fake/sandbox unless explicitly authorized for live spend.

## Payment matrix

Verify:
- Paystack
- Flutterwave
- Stripe
- PayPal

For each:
- checkout
- webhook
- recurring
- failure
- cancel
- reconcile
- duplicate
- out-of-order
- wrong amount
- wrong currency
- restart persistence

## Admin matrix

Verify:
- plans
- entitlements
- regional pricing
- payment providers
- compute providers
- model providers
- internal intelligence credentials
- notifications
- feature flags
- health
- costs/margins
- abuse/backups

## Runtime matrix

Verify:
- Simple Mode
- Developer Mode
- version/deploy/rollback
- full runtime
- browser
- terminal/files
- subagent
- Agent Room
- workflow/schedule
- restart/resume

## Notification matrix

Verify:
- admin single-user send
- org broadcast
- plan/region targeting
- realtime
- read/unread
- IDOR denial
- payment-triggered notification
- server-triggered notification

## Branding

Manually and automatically confirm:
- Mox only
- no donor runtime branding
- no generic GPT terminology
- actual provider/model names only where appropriate

## Release document

Create:
`docs/verification/FINAL_PRODUCTION_RELEASE_GATE.md`

Columns:
- area
- scenario
- result
- evidence/test
- blocker
- production-ready yes/no

Do not mark production-ready while any critical/high blocker exists.

## Acceptance criteria

- all mandatory CI passes
- end-to-end flow passes
- payment providers pass test/sandbox flows
- compute flow passes safe test flow
- admin works
- notifications work
- full runtime works
- security regressions pass
- branding passes
- remaining external credential/commercial blockers are explicitly listed
