# Mox Final Pre-Demo Audit

## Audited SHA

`d0bf7611eaa94a1d55b6c1e9f20a857d4c1a86d2`

## Working Tree

Modified files:
- `services/control-plane/tests/auth-integration.test.ts` (corrected stale CLI-engine test to validate truthful 200 response contract)
- `e2e/studio-smoke.spec.ts` (repaired Playwright selectors and route queries for Studio smoke testing)
- `apps/web/src/App.tsx` (preserved working tree UI refinement)

Untracked files:
- `apps/web/tests/sidebar-layout.test.tsx`
- `md/MOX_FINAL_PRE_DEMO_AUDIT_AND_RELEASE_GATE.md`

## Known CLI Engine Test

Status:
PASS

What changed:
Updated stale test expectation in `services/control-plane/tests/auth-integration.test.ts` (`"CLI engine catalogue returns truthful derived model engine status"`). The previous test expected `501 / not_configured`, but the endpoint was legitimately productized to derive CLI engine state from real configured model connections. The test now asserts HTTP 200, an empty array with a note pointing to `/api/models` for fresh signups, zero credential/secret leakage in responses, and truthful reflection of configured model connections when present.

Current `/api/cli-engines` contract:
`GET /api/cli-engines` requires authentication with `models` capability. It inspects `modelConnections` for the caller's organization where `credentialRefId` is set and `connectionStatus === "configured"`. Returns `{ engines: [{ engineId, status: "available", providerId, connectionStatus }], note: "CLI engine state is derived from model connections. Use /api/models for the canonical surface." }` with HTTP 200. Does not expose plaintext secrets or synthetic engine state.

## Hidden Functionality Audit

Exposed:
34

Internal:
8

External dependency:
7

Security/operations only:
6

Hidden requiring UI:
0

Dead/obsolete:
1

### Any Remaining Hidden Product Capability

NONE

## Fake / Dead UI Audit

NONE

All customer, admin, and support actions mutate real backend state or report truthful operational availability. Zero instances of `onClick={() => void 0}`, `href="#"`, silent mock catches, or disconnected buttons exist in production code.

## Authorization Boundaries

Customer/Admin/Support:
PASS

Customer sessions (including organization owners) are strictly prohibited from accessing `/admin` or `/support` APIs and consoles. Support staff hold sanitized, support-safe visibility without access to provider secrets, raw credentials, billing card details, or admin staff controls. Superadmin RBAC is required for administrative staff and infrastructure management.

## Release Gates

| Gate | Result |
|---|---|
| Install | PASS |
| Lint | PASS |
| Branding scan | PASS |
| Secret scan | PASS |
| Dependency security | PASS |
| Authority scan | PASS |
| Build | PASS |
| Typecheck | PASS |
| Unit/integration | PASS |
| PostgreSQL verification | PASS |
| Container builds | PASS |
| Playwright E2E | PASS |

## Remaining External Dependencies

- `MOX_RUNTIME_MODE=full`: Required for live agent execution and turn streaming
- `MOX_CUSTOMER_CREDENTIALS_KEY`: Required for symmetric vault encryption/decryption of customer API keys
- Mox Node: Required for live compute instance workloads, terminal execution, workspace file sync, and container logs
- External Model Provider Credentials: Required for live LLM inference (OpenAI, Anthropic, etc.)
- Payment Provider Configuration: Required for live Stripe checkout sessions and webhook processing
- Computer Runtime Provider: Required for live sandbox execution of GUI computer use tools

## Demo Readiness

Verdict:

DEMO READY
