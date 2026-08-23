# Prompt 06 — Full-system deep debugging and defect sweep

**Reasoning: Ultra**

Run only after Prompts 01–05 are complete.

## Goal

Perform a repository-wide deep bug hunt across the now-complete Mox system.

This is not a feature-building prompt. Find and fix defects, inconsistencies, broken wiring, unsafe assumptions and dead placeholders.

## Audit domains

### Authentication / authorization
- browser sessions
- PAT scopes
- role/capability enforcement
- org switching
- admin RBAC
- session revoke/expiry
- CSRF
- CORS
- cross-tenant access
- API token escalation

### Billing
- Paystack
- Flutterwave
- Stripe
- PayPal
- checkout
- webhook verification
- exact raw body
- idempotency
- out-of-order events
- reconciliation
- subscription lifecycle
- regional pricing
- money precision
- cancellation/resubscription
- addon billing

### Notifications
- admin targeting
- user inbox
- IDOR
- realtime
- fan-out
- persistence
- read/unread/archive
- system events

### Compute
- Contabo
- Hetzner
- order idempotency
- provider retries
- Mox Node enrollment
- node auth
- stale token handling
- resize
- cancellation
- retention
- provider outage

### Agents/runtime
- full runtime mode
- no reference fallback
- session resume
- tools
- policy
- browser
- terminal/files
- subagents
- rooms
- workflows
- schedules
- model routing
- crash recovery

### Admin
- permissions
- secret handling
- provider configuration
- plans/pricing
- notifications
- abuse
- backups
- costs/margins

### Branding
- donor name leaks
- generic GPT leaks
- actual model/provider exceptions

### Persistence
- every durable domain survives process restart
- no production in-memory source of truth
- migrations clean
- upgrade migrations safe
- transaction boundaries correct

## Required methodology

1. search for:
   - TODO
   - FIXME
   - HACK
   - placeholder
   - mock
   - fake
   - demo
   - `InMemory`
   - `return []`
   - `return true`
   - `not_configured`
   - hard-coded URLs
   - hard-coded credentials
   - `any`
   - unsafe casts
   - swallowed exceptions
   - unhandled promises

2. For every match classify:
   - legitimate test/dev
   - honest unsupported capability
   - production defect
   - dead code

3. Fix production defects.

4. Do not turn honest `not_configured` into fake success.

## Runtime tests

Run:
- full unit suite
- integration suite
- real PostgreSQL suite
- migration clean install
- upgrade drill
- web build
- admin build
- CLI build
- runtime build
- container builds where configured

## Security tests

At minimum:
- cross-tenant access
- notification IDOR
- PAT scope bypass
- PAT privilege escalation
- billing mutation by plain member
- webhook forgery
- replay
- amount/currency tampering
- node enrollment hijack
- node command auth
- SSRF
- secret redaction
- computer policy bypass
- unauthorized admin
- browser auth token leakage

## Deliverable

Create:
`docs/verification/FULL_SYSTEM_DEBUG_SWEEP.md`

For each finding:
- severity
- file/path
- bug
- fix
- test proving fix
- remaining blocker

Do not hide unfixed defects.

## Acceptance criteria

- no known critical/high defect remains undocumented
- all fixed defects have regression tests
- no production demo/mock authority remains
- full durable test suite passes
