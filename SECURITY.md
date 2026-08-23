# Security Guidance for Mox Scans

This file guides security review and automated scanner triage for the active
Mox production codebase. Do not run scans by excluding broad categories that
could hide vulnerabilities in active Mox paths.

## Production Scan Scope

Scan these paths as production-relevant:

- `apps/`
- `services/`
- `packages/`
- `runtime/`
- `infra/`
- `scripts/`
- `.github/`
- root package/workspace/deployment configuration, including `package.json`,
  `pnpm-lock.yaml`, `pnpm-workspace.yaml`, and CI/deployment scripts
- database migrations and migration scripts

These top-level source-reference trees are not active Mox production entry
points:

- `OpenBot-main/`
- `OpenMausBot-main/`
- `deepseek-harness-master/`

Do not suppress a finding merely because adapted code originated in those
trees. Adapted code under active Mox paths is fully in scope.

## Required Security Invariants

1. Tenant/org isolation is enforced on every protected durable access.
2. Authentication happens before protected access.
3. PAT scopes constrain API surface but never create role privilege.
4. Browser/client state and assertions are untrusted.
5. Admin capability checks are server-side.
6. Payment redirects never grant entitlements.
7. Payment webhooks require authentic provider verification, exact raw body
   where required, replay/idempotency protection, and exact server-derived
   amount/currency reconciliation.
8. Customer VPS/Mox Node state is untrusted and cannot grant billing or
   entitlements.
9. Node enrollment credentials are single-use, expiring, and bound to order,
   org, and instance.
10. Secrets are server/vault only and never exposed through browser responses,
    logs, query strings, analytics, or normal read APIs.
11. SSRF/egress protections apply to attacker-controlled outbound targets.
12. Browser/computer/shell/files require policy and ownership checks.
13. Provider credentials are least privilege and blast-radius separated.
14. External side effects are idempotent across restart and multiple workers.
15. Unsupported capabilities fail closed and honestly.
16. Production never silently uses demo or in-memory authority.

## Findings to Report

Report realistic findings in these areas:

- authentication and session handling
- IDOR and cross-tenant access
- privilege escalation and admin/RBAC bypass
- PAT scope bypass or PAT-to-role escalation
- billing fraud, payment redirect misuse, webhook forgery, replay, and
  amount/currency tampering
- SSRF and unsafe outbound egress
- secret exposure in browser responses, logs, query strings, analytics,
  runtime events, or source
- node impersonation, enrollment hijack, stale token reuse, and forged node
  telemetry
- browser/computer/shell/filesystem policy bypass, path traversal, or unsafe
  command execution
- SQL/query injection and unsafe dynamic query construction
- race conditions, idempotency failures, restart replay issues, and multiple
  worker side effects
- supply-chain, dependency, CI, and deployment misconfiguration

## Scanner Notes

- Treat `apps/web` as untrusted browser/client code, not as part of the trusted
  Control Plane.
- Treat provider callbacks and customer/Mox Node telemetry as untrusted until
  server-side verification and reconciliation succeed.
- Treat tests and explicit fake/sandbox providers as test harnesses, but still
  report if production code imports or depends on them as runtime authority.
- Do not add broad exclusions that hide vulnerabilities in active Mox paths.
