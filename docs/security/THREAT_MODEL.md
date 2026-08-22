# Mox Threat Model (Prompt 14)

Status: **Living document.** Reviewed on every security-relevant change.
Scope: the complete Mox platform — Control Plane services, Mox Node agents,
customer VPS workloads, provider integrations and admin surfaces.

## Assets

| Asset | Location of truth | Notes |
|---|---|---|
| Subscription/entitlement state | `services/billing` + `packages/entitlements` | Commercial authority; drives what customers may do |
| Payment-provider webhook stream | `services/billing/src/provider.ts` | HMAC-verified, deduped by external event id |
| Provider API credentials | Vault (`packages/credentials`), refs only in DB | Contabo/Hetzner/model/channel credentials |
| Customer VPS root access | SSH keys (`compute` schema), one-time enroll tokens | Customers legitimately hold root |
| Agent definitions & secrets refs | `services/agent-control`, vault references | Secrets never inline in definitions |
| Session/thread history | runtime persistence schema | Tenant-scoped by orgId everywhere |
| Backup artifacts | `packages/backups` → Mox-owned S3 | Never only on the customer VPS |

## Actors

1. **Honest customer with root** — pays for a dedicated VPS, has full root.
2. **Malicious customer with root** — tries to escape billing, attack other
   tenants, or abuse the provider relationship.
3. **Malicious/compromised agent** — an AI agent whose instructions were
   hijacked (prompt injection) or that misbehaves.
4. **External attacker** — no accounts; probes public endpoints/webhooks.
5. **Compromised provider account** — attacker with stolen gateway creds.
6. **Malicious Mox insider/admin** — must be constrained by RBAC + audit.

## Threat scenarios and controls

### T1 — Malicious customer with root on their VPS
- **Risk:** tamper with Mox Node to self-grant entitlements, hide abuse,
  pivot into control plane.
- **Controls:** Mox Node is *untrusted* — enrollment is advisory telemetry;
  ownership/billing/entitlements live exclusively in the Control Plane
  (`services/compute-orchestrator` treats node data as advisory). Node
  commands are HMAC-signed with replay protection (staleness window +
  single-use nonces, `runtime/mox-node` `CommandVerifier`). Emergency
  suspension runs through the PROVIDER API, so a disabled node cannot block
  enforcement (`services/platform-ops`). Enrollment requires the one-time
  cloud-init token; a node id cannot be re-enrolled under a different token.

### T2 — Malicious or compromised AI agent
- **Risk:** destructive tool calls, spend abuse, cross-agent data leakage.
- **Controls:** every tool grant is explicit per org/user/agent in
  `services/integration-gateway`; danger levels force approval flags;
  permission presets compile approval requirements into the canonical
  definition; egress policy (`packages/security` EgressPolicy) defaults to
  deny; computer actions flow through policy+audit (computer layer).

### T3 — Prompt injection
- **Risk:** injected content hijacks an agent into exfiltrating or spending.
- **Controls:** sensitive tools require explicit grants AND approval flags;
  browser/computer sessions are sandboxed per container; outbound fetches go
  through the SSRF guard + egress policy; audit trail preserves tool I/O for
  forensics. Residual risk acknowledged: injection cannot be fully solved at
  platform level — containment (T2) limits blast radius.

### T4 — Tool abuse / dangerous shell paths
- **Risk:** shell entitlement used as generic RCE against the workspace host.
- **Controls:** CLI/shell sessions are entitlement-gated (`cli_sessions`),
  audited, target-only-customer-servers (ownership check), never control-plane
  hosts; Docker workloads run with resource caps and no Docker socket mounts
  by default (`runtime/mox-node` workload specs).

### T5 — Credential theft
- **Risk:** leaked provider/API keys.
- **Controls:** secrets live only in the credential vault; databases store
  references (`credentialRefId`) never material; log scrubbing redacts
  secret-shaped strings (`scrubLogLine`); rotation flows per provider account
  (`rotateProviderAccountCredential`).

### T6 — Browser session theft
- **Risk:** hijacked terminal/browser session reaches another tenant's VPS.
- **Controls:** terminal sessions are opened per-request with ownership
  validation; gateway tokens are short-lived and verified
  (`verifyGatewayToken` rejects expired/forged tokens); internal ports are
  structurally non-public (`COMPUTER_INTERNAL_PORTS` invariant checks).

### T7 — Cross-tenant data access
- **Risk:** org A reads org B's subscriptions/threads/servers.
- **Controls:** every store query filters by `orgId`; tests assert isolation
  (`security-hardening.test.ts` — entitlement overrides don't leak across
  orgs sharing a plan version; terminal ownership denial). Admin surfaces are
  role-gated separately from tenant APIs.

### T8 — SSRF via agent web fetch / integrations
- **Controls:** `assertSafeOutboundUrl` blocks private/link-local/metadata
  addresses, encoded hosts, non-HTTPS, credentials-in-URL, odd ports;
  allowlists supported for locked-down integrations; response size + timeout
  bounded (`readBoundedBody`, `DEFAULT_FETCH_LIMITS`). Callers must resolve
  DNS and re-check resolved IPs with `isPrivateIp` (rebinding defense).

### T9 — Webhook forgery/replay
- **Controls:** all inbound webhooks verify timing-safe HMAC signatures with
  stale-timestamp windows (billing, channels); provider events dedupe by
  external event id and apply idempotently — replay after application is a
  no-op (tested in chaos + hardening suites). Forged signatures mark the
  connection error state.

### T10 — Billing fraud
- **Risk:** activate paid plans without paying; double-refund tricks.
- **Controls:** redirects never grant entitlements — activation happens only
  through verified webhooks; concurrent-delivery race closed with an
  application lock (`applyingCheckouts`); state machine transitions are
  validated + idempotent-keyed; renewal sweeps claim in-flight subscriptions.

### T11 — Provider API credential compromise
- **Blast-radius design:** multiple accounts per provider
  (`provider_accounts`), per-account enable/disable, credential rotation,
  health scoring quarantines failing accounts. Compromised account can be
  disabled without touching others.

### T12 — Supply chain
- pnpm lockfile pinned deps; upstream trees vendored read-only under
  gitignored reference dirs; CI gates: typecheck + lint + full tests.

### T13 — Queue replay/duplication
- Durable operations carry idempotency keys; reconcile claims in-flight ops;
  chaos tests prove duplicate workers/ticks produce ≤1 side effect.

### T14 — Mox Node impersonation
- One-time enrollment tokens hashed at rest; node-id reuse with different
  token rejected; commands signed server-side; heartbeats untrusted.

### T15 — Object-storage exposure
- Backup bucket is Mox-owned, referenced by key; adapters enforce
  authenticated access points; restore tests verify readability without
  touching customer servers.

### T16 — Admin account compromise
- Role model (superadmin/billing/ops/support) with least privilege per
  capability; every mutation audited with actor identity; enterprise
  contract changes require `enterprise.write`.

## Known residual risks (documented, accepted)

1. Prompt injection cannot be eliminated — mitigated by containment.
2. In-process concurrency claims protect single-instance deployments;
   multi-replica production requires the Postgres store's unique constraints
   + row-level claims (schema already unique-indexed).
3. DNS rebinding defense requires fetch-time resolution checks at deployment
   wiring (helper provided).
