# Prompts 13–15 — Enterprise/admin, hardening, retirement

## Prompt 13 — Enterprise, admin, provider health and platform controls

- `packages/feature-flags` — six-scope flags (global/region/plan/organization/
  user/provider) with deterministic percentage rollouts and a full change
  audit log. Flags gate rollout only; entitlements remain the paid-capability
  authority.
- `packages/provider-health` — operation outcome/latency tracking for any
  provider class; 0–100 scores from failure rate, latency, last-success
  recency, incident state and capacity headroom; healthy/degraded/offline
  states; unknown providers rank degraded-neutral so proven providers win.
- Compute orchestrator: selection now ranks eligible (approved + enabled)
  candidates by health score, skips offline providers fail-closed, and never
  overrides commercial/entitlement/region gates. Provision outcomes feed the
  health registry. Provider accounts gained credential rotation + disable
  with reason (blast-radius control).
- `services/admin` — role-protected facade (superadmin/billing_admin/
  ops_admin/support) over billing, compute, agents, operations, costs,
  flags, settings: account status, support notes, no-deploy plan version +
  price publishing, controlled overrides, provider approvals/rotation,
  margin reports, audited mutations.
- Enterprise contracts (`services/admin/src/enterprise.ts`) — negotiated
  terms flow through the SAME entitlement engine as a custom-contract layer;
  metadata covers custom price, included nodes, custom compute classes,
  private models, dedicated DB/runtime flags, retention, domains, audit
  export, SSO/SAML readiness, private networking hooks, SLA and white-label.

Tests: RBAC boundaries, audit trail, no-deploy plan changes, override grants,
enterprise contract lifecycle through the shared engine, flag precedence/
rollout/audit, health scoring/ranking/incidents/capacity.

## Prompt 14 — Security hardening, chaos, DR, production readiness

- SSRF guard (`packages/security/ssrf.ts`): blocks private/link-local/
  metadata addresses (incl. hex IPv4-mapped), encoded hosts, non-HTTPS,
  credentials-in-URL, odd ports; allowlists; bounded response reads with
  timeouts.
- `packages/observability`: OTel-compatible tracer/metrics with semantic
  span names for every critical transaction path; exporters can never break
  traced operations; trace-id propagation verified.
- Chaos suites: webhook storm ×5 concurrent → one subscription/one
  transition; raced renewal sweeps → exactly one invoice; provider timeout
  after successful order → exactly one VPS; total outage → clean abandon;
  duplicate reconcile workers → ≤1 provision call; cancel-during-outage
  idempotent. Race windows closed in-code (renewal claims, op claims,
  checkout application lock).
- Security suite: cross-tenant terminal denial, entitlement isolation across
  orgs on a shared plan, admin escalation rejection, node enrollment token
  mismatch, forged command signatures, gateway-token expiry, secret
  redaction (metadata + logs incl. card PANs), webhook replay no-op.
- Docs: `docs/security/THREAT_MODEL.md` (16 scenarios with controls),
  `docs/operations/DISASTER_RECOVERY.md` (RTO/RPO, seven recovery
  procedures, chaos drill matrix).

## Prompt 15 — Retirement, parity and final verification

- Authority scan (`scripts/authority-scan.mjs`, wired as `pnpm scan:authority`):
  zero vendored-tree imports from Mox production code (verified clean).
- Duplicate-authority table recorded in `docs/consolidation/RETIREMENT.md`;
  vendored trees are gitignored reference snapshots excluded from build,
  test and deploy surfaces.
- `third_party/licenses/` preserves MIT (OpenBot, DeepSeek) and Apache-2.0
  (OpenMausBot) texts; `third_party/notices/NOTICES.md` records attribution;
  `third_party/provenance/PROVENANCE_ADAPTATIONS.md` inventories every
  adapted component.
- Final docs: root README, SYSTEM_OVERVIEW, RUNBOOK, PROVIDER_ONBOARDING,
  RELEASE_CHECKLIST, SECURITY_BOUNDARIES, FULL_SYSTEM_MATRIX mapping every
  required capability to its authority + proving tests.

## Final gates at close

- typecheck ✓ · lint ✓ · build ✓ · authority scan ✓
- vitest: 53 files / 368+ tests passing
