# UI Parity 06 - Support Surface

Date: 2026-08-28

## Scope

Completed the Support surface parity pass for the support-safe inventory:

- `SUPPORT_VISIBLE`: customer/workspace lookup, safe identity and workspace metadata, subscription lifecycle diagnosis, safe server/node/agent/deployment state, support notes, and recent support-safe activity.
- `SUPPORT_CAPABILITY_GATED`: lookup/diagnostics/activity under `support.customer.lookup`, note creation under `support.ticket.write`, and manager `support.escalate` shown only as capability status because there is no audited escalation domain action to invoke.

Support remains separate from Admin. No support route or navigation exposes platform billing mutation, compute lifecycle mutation, provider configuration, feature flag mutation, staff management, system intelligence mutation, unrestricted runtime commands, wholesale costs, margins, credentials, raw provider IDs, raw node tokens, host/IP material, or raw sensitive audit payloads.

## Implemented

- Added support-safe projection helpers in `services/control-plane/src/projections.ts`:
  - server lifecycle projection with coarse error summaries;
  - Mox Node heartbeat health projection without node IDs, metrics, or tokens;
  - coarse suspension reason projection;
  - support note validation with max length and executable markup rejection.
- Expanded `GET /api/support/customers` and `GET /api/support/customers/:orgId`:
  - subscription lifecycle fields needed for diagnosis;
  - diagnostic counters;
  - server lifecycle and node health;
  - agent deployment/runtime health;
  - configured/not-configured model, integration, and channel connection state;
  - recent notification failure summaries with sanitized error text.
- Tightened support note creation:
  - explicit 400 validation instead of silent truncation;
  - audited persistence remains `support.note`;
  - notes remain org-targeted through `audit_events.org_id`;
  - no edit/delete route was added.
- Added Support UI section navigation:
  - Lookup, Diagnostics, Notes, Activity;
  - Escalation appears only with `support.escalate` and does not perform an action without an audited service model.
- Updated shared contracts and web API types for the new support DTOs.

## Tests

Added or extended coverage for:

- Support navigation capability gates.
- Support-safe diagnostic projections.
- Sensitive field absence from support responses.
- Note persistence/audit behavior.
- Note length and markup validation.
- Cross-org note isolation.
- Support inability to access Admin staff endpoints.

## Verification

Passed locally:

- `pnpm --filter @mox/control-plane-contracts typecheck`
- `pnpm --filter @mox/control-plane typecheck`
- `pnpm --filter @mox/web typecheck`
- `pnpm --filter @mox/control-plane test -- projections.test.ts phase-05-admin.test.ts auth-integration.test.ts`
- `pnpm --filter @mox/web test`
- `pnpm secret-scan`
- `pnpm typecheck`
- `pnpm test`

`auth-integration.test.ts` includes the PostgreSQL-backed support route tests, but they are skipped in this local run because `MOX_TEST_DATABASE_URL` is not set.
