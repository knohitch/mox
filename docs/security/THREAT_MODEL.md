# Mox Threat Model

Status: **Living document.** Reviewed on every security-relevant change.

Scope: the complete active Mox platform: untrusted browser/client surfaces,
trusted server-side Control Plane services, Mox Node/customer VPS integrations,
provider integrations, runtime/computer/tooling, admin surfaces, CI, deployment
configuration, and database migrations.

## Assets

| Asset | Location of truth | Notes |
|---|---|---|
| Identity/session state | Control Plane auth tables and server session logic | Browser cookies identify a session but do not make client state authoritative |
| Tenant/org membership | Control Plane durable stores | Required for every protected tenant access |
| Admin capability/RBAC state | Server-side config/stores and audit | PAT scopes never create role privilege |
| Subscription/entitlement state | `services/billing` + `packages/entitlements` | Commercial authority; never granted by redirects, browser state, or node telemetry |
| Payment-provider webhook stream | Provider adapters + billing service | Verified from exact provider data, deduped, and reconciled to server-derived money |
| Provider API credentials | Mox Vault / server-side credential refs | Least privilege and blast-radius separated |
| Customer VPS/Mox Node state | Advisory node channel plus Control Plane order records | Customer can hold root; node data is untrusted until verified |
| Agent definitions and secret refs | `services/agent-control`, vault references | Secrets never inline in definitions |
| Runtime/session/thread history | Mox event/session stores | Tenant-scoped by orgId everywhere |
| Backup artifacts | Mox-owned object storage refs | Never only on the customer VPS |

## Trust Zones

1. **Untrusted browser/client**: `apps/web`, user input, uploads, API
   parameters, browser storage, rendered UI state, and client-side assertions.
2. **Trusted server-side Mox Control Plane**: authenticated server services,
   durable stores, policy, audit, billing, entitlements, admin checks, and vault
   references.
3. **Untrusted customer VPS/Mox Node/customer workloads**: customer-root
   machine state, workload state, node telemetry, node-local files, and node
   reported identifiers.
4. **Untrusted or semi-trusted external providers/webhooks**: payment,
   compute, model, channel, and integration providers. Provider callbacks are
   untrusted network input until verified; provider API responses are reconciled
   against Mox-owned state.

## Actors

1. **Honest customer** using browser, PAT, agents, compute, and billing flows.
2. **Malicious customer** with tenant access or root on their customer VPS.
3. **Malicious/compromised browser session** attempting CSRF, XSS, IDOR, or
   client-side state tampering.
4. **Malicious/compromised Mox Node** trying to impersonate nodes, fake
   telemetry, or self-grant commercial state.
5. **Malicious/compromised agent** affected by prompt injection or excessive
   tool agency.
6. **External attacker** probing public endpoints, webhooks, redirects, CORS,
   SSRF, or supply-chain/deployment gaps.
7. **Compromised provider account or forged provider callback**.
8. **Malicious or compromised Mox staff/admin** constrained by server-side RBAC,
   least privilege, and audit.

## Required Invariants

- Tenant/org isolation is enforced server-side on every durable access.
- Authentication happens before protected access; browser/session and PAT flows
  remain distinct.
- PAT scopes constrain API surface but never create admin, owner, or capability
  privilege.
- Browser/client assertions are untrusted and never authoritative.
- Admin capability checks are server-side and audited for sensitive changes.
- Payment redirects never grant entitlements.
- Payment webhooks require authentic provider verification, exact raw body where
  required, replay/idempotency protection, and exact server-derived
  amount/currency reconciliation.
- Customer VPS/Mox Node state is untrusted and cannot grant billing,
  entitlements, ownership, or admin privilege.
- Node enrollment credentials are single-use, expiring, and bound to order, org,
  and provider instance.
- Secrets are server/vault only and never exposed to browser, logs, query
  strings, analytics, or normal admin read APIs.
- SSRF/egress protections apply to attacker-controlled outbound targets.
- Browser/computer/shell/files require policy, entitlement, ownership, and audit
  checks.
- Provider credentials are least privilege and blast-radius separated.
- External side effects are idempotent across restart and multiple workers.
- Unsupported capabilities fail closed and honestly.
- Production never silently uses demo/in-memory authority.

## Threat Scenarios and Controls

### T1 - Browser/client trust confusion
- **Risk:** browser state, API parameters, uploads, or UI assertions are treated
  as trusted identity, org, admin, billing, model, or node facts.
- **Controls:** server validates session/PAT, CSRF for cookie mutations,
  org membership, route scope, body shape, and capability before action. Public
  responses never echo secrets. Browser redirects do not mutate commercial
  state.

### T2 - Cross-tenant access / IDOR
- **Risk:** org A reads or mutates org B subscriptions, notifications, agents,
  servers, files, events, or runtime sessions.
- **Controls:** store queries are `orgId` scoped; notification and event reads
  require ownership; server-side org switching validates membership; admin APIs
  use a separate capability boundary.

### T3 - PAT privilege escalation
- **Risk:** a PAT with broad or `admin` scope becomes role authority.
- **Controls:** PAT scopes only authorize API families. Role/capability checks
  require server-side membership/capability state. Token management remains
  session-only.

### T4 - Malicious customer with root on VPS / Mox Node
- **Risk:** node telemetry or local root state self-grants entitlements, hides
  abuse, hijacks enrollment, or blocks suspension.
- **Controls:** node data is advisory; node enrollment token is hashed,
  single-use, expiring, and order/org/instance-bound; node commands are
  authenticated and replay protected; enforcement uses provider APIs when the
  node is unavailable or hostile.

### T5 - Payment fraud and webhook forgery
- **Risk:** redirects, forged callbacks, replay, out-of-order events, wrong
  amount/currency, or duplicate workers activate or retain paid plans.
- **Controls:** redirects grant nothing; provider adapters verify authentic
  callbacks with exact raw bytes where required; events dedupe by provider
  event id; checkout completion reconciles server-derived amount/currency;
  state transitions are idempotent and restart-safe.

### T6 - External provider trust abuse
- **Risk:** provider API responses or webhooks are treated as Mox
  authorization, or compromised provider credentials cause broad damage.
- **Controls:** provider responses reconcile against Mox-owned order,
  subscription, and idempotency records. Credentials are least privilege,
  per-provider/account separated, stored as vault refs, and rotatable.

### T7 - SSRF and unsafe egress
- **Risk:** attacker-controlled URLs reach metadata, loopback, private networks,
  odd ports, credential-bearing URLs, or internal services.
- **Controls:** outbound URL validation blocks private/link-local/metadata
  targets, non-HTTPS targets, credentials in URLs, and disallowed ports.
  Integration and computer/browser egress go through policy and audit.

### T8 - Prompt injection / excessive tool agency
- **Risk:** untrusted model context induces destructive tool calls, data
  exfiltration, spend, or cross-agent leakage.
- **Controls:** model output is untrusted. Tools require explicit grants,
  policy, approvals for dangerous effects, tenant scope, and audit. Runtime
  events store references and redacted summaries rather than secrets.

### T9 - Browser/computer/shell/files misuse
- **Risk:** terminal, browser, computer, or file tools become generic RCE or
  path traversal into another tenant or control-plane host.
- **Controls:** terminal/files/computer actions require entitlement, ownership,
  policy, and audit. Customer workloads run in scoped targets, not
  control-plane hosts. Unsupported execution fails closed.

### T10 - Credential and secret exposure
- **Risk:** provider keys, BYOK values, session tokens, webhooks, or runtime
  secrets leak to browser, logs, query strings, analytics, or events.
- **Controls:** vault/server-only storage, secret refs/fingerprints in DB,
  write-only secret inputs, log scrubbing, no token-in-query SSE, no browser
  persistence of bearer/session material.

### T11 - Admin compromise or confused deputy
- **Risk:** support/billing/ops users perform unauthorized provider, billing,
  notification, intelligence, compute, or customer actions.
- **Controls:** server-side admin capability checks, separate platform-admin
  authority, no public signup for staff authority, and audit for sensitive
  changes.

### T12 - Supply chain and deployment drift
- **Risk:** donor source-reference trees, dependencies, CI, or deployment config
  hide production vulnerabilities or skip gates.
- **Controls:** active Mox production paths are fully in scope. Source-reference
  trees are not active entry points, but adapted code under active paths is in
  scope. CI runs install, lint, typecheck, tests, PostgreSQL migrations/upgrade,
  branding, secret scan, dependency/security checks, and configured container
  builds without `|| true`.

### T13 - Restart, race, and idempotency failures
- **Risk:** duplicate workers, retries, crash recovery, or restart replays cause
  double billing, duplicate provisioning, repeated side effects, or lost
  notifications.
- **Controls:** idempotency keys, durable unique constraints, event ids,
  in-flight claims, replay-safe state transitions, and PostgreSQL restart
  verification.

## Known Residual Risks

1. Prompt injection cannot be eliminated; controls reduce blast radius through
   policy, grants, approvals, tenant scope, and audit.
2. Live provider sandbox credentials, production runtime command, provider
   images, and vault-backed probes must be validated in each deployment
   environment.
3. DNS rebinding defenses depend on deployment/runtime fetch wiring preserving
   the safe resolution and egress checks.
