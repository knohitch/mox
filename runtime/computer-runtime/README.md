# runtime/computer-runtime

Mox computer layer (Prompt 04): the authoritative path from an agent to any
browser/desktop/shell surface.

- `gateway.ts` — the Computer Gateway. Canonical flow: entitlement check →
  policy decision (`@mox/policy`) → optional human approval → audit →
  provider. Gateway-token gated; direct requests to a browser service are
  rejected.
- `provider.ts` — `ComputerProvider` abstraction: capabilities (browser,
  shell, filesystem, screencast, desktop-CUA, mobile-device, human takeover),
  constraints (regions/runtimes), per-session isolation.
- `playwright-provider.ts` — default provider (isolated Chromium via the
  Playwright seam; reference driver in-process until the container runtime
  attaches).
- `supervisor.ts` — Mox-owned container supervision (deterministic names,
  per-agent/session isolation, health/restart budget, resource limits,
  per-session workspaces), ready to embed into Mox Node.

Donors: OpenBot `server/src/computer/*` (gateway/policy/audit flow) and
`supervisor/` (lifecycle concepts); OpenMaus computer modules are optional
provider patterns only, never authority.
