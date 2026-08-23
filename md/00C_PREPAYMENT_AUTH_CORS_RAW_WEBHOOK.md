# Repair Prompt 00C — Pre-payment auth response, CORS/session transport and raw-webhook foundation

**Reasoning: Ultra**

Repository: `knohitch/mox`
Current audited commit after 00B: `dccb6a80ba0030ebff19d7a15098e2afb64b4fa4`

Run this before Repair Prompt 01. Do not implement payment providers yet.

## Confirmed blockers

1. Browser login/signup set an HttpOnly cookie but still return `sessionToken` in JSON via `toAuthResponse()` / `AuthSessionResponse`. Browser JavaScript therefore still receives the reusable session credential.
2. `apps/web` supports absolute `VITE_MOX_API_URL` + `credentials: "include"`, but the control plane does not emit `Access-Control-Allow-Credentials: true`; app/API subdomain deployments are therefore inconsistent/broken.
3. The HTTP kernel parses JSON and `/webhooks/billing/:provider` reconstructs the body with `JSON.stringify(ctx.body)`. Real payment signature verification needs the exact untouched raw body.
4. `/node/:nodeId/commands` is currently unauthenticated.
5. Signup workspace-slug retry can abort on the first PostgreSQL unique violation instead of safely retrying.
6. A real PostgreSQL verification harness exists, but rerun it after these fixes and record the result truthfully.

## A — Browser sessions must be cookie-only

For browser:
- `POST /api/auth/login`
- `POST /api/auth/signup`
- `POST /api/auth/orgs/select`

must not return a reusable session token in JSON.

Return safe identity/org/expiry metadata only. The browser authenticates subsequent requests exclusively with the HttpOnly cookie.

Update server, contracts, web client and tests.

Do not merely ignore `sessionToken` in frontend code; stop sending it from browser auth endpoints.

## B — Separate CLI/programmatic auth

CLI/automation still needs bearer auth, but use a separate explicit mechanism:
- preferably personal/API access tokens with hashed-at-rest token, scopes, expiry and revocation;
- or a dedicated programmatic token-login endpoint.

Do not overload browser cookie login to return bearer material.

## C — Make web/API topology explicit and functional

Prefer supporting:
- `https://app.<mox-domain>`
- `https://api.<mox-domain>`

For allowlisted browser origins:
- exact `Access-Control-Allow-Origin`
- `Access-Control-Allow-Credentials: true`
- narrow methods/headers
- `Vary: Origin`
- no wildcard
- HttpOnly + Secure cookie
- SameSite policy validated for the supported topology

Do not determine cross-origin by checking only for localhost; compare real origins where client logic requires it.

Add tests for allowed origin + login cookie + `/api/me` + SSE, and denial of unlisted origins.

If intentionally choosing same-origin-only reverse proxy instead, enforce and document it and remove misleading cross-origin support. Do not leave the current contradictory state.

## D — Preserve exact raw webhook bytes

Refactor the HTTP request layer so handlers receive:
- exact raw body (`Buffer` or byte-identical string)
- parsed JSON when appropriate

Keep body-size limits. Never log raw bodies.

`POST /webhooks/billing/:provider` must pass the exact original body to billing webhook verification. Never verify against `JSON.stringify(parsedBody)`.

Add tests with whitespace/escaping differences proving the exact incoming bytes are passed unchanged and reserialization would differ.

This is mandatory before Paystack/Flutterwave/Stripe/PayPal.

## E — Secure node command polling

`GET /node/:nodeId/commands` must require the durable node `agentToken`.

- missing/wrong token -> 401/403
- node A token cannot poll node B
- no unauthenticated command metadata

Until durable command dispatch exists, authenticate then return either the honest empty queue or `501 not_configured`.

Do not claim durable replay protection for a command queue that does not exist yet.

## F — Fix workspace slug collision

Use a PostgreSQL-safe bounded retry such as `ON CONFLICT DO NOTHING ... RETURNING`.

Test two signups requesting the same workspace name:
- both succeed
- slugs differ
- no 500
- memberships remain correctly isolated

## G — Rerun real PostgreSQL verification

Run `scripts/run-postgres-verification.ps1` or equivalent disposable PostgreSQL workflow after these changes.

Create `docs/verification/FOUNDATION_00C_POSTGRES.md` from the actual run only, containing:
- timestamp
- PostgreSQL version
- command
- migration result
- PG suite names/counts
- upgrade-drill result
- pass/fail

No passwords or connection strings.

If it cannot run, mark BLOCKED; do not fabricate success.

## Required tests

Prove:
1. browser login JSON contains no `sessionToken`
2. signup JSON contains no `sessionToken`
3. HttpOnly cookie authenticates `/api/me`
4. web source does not persist reusable auth credentials
5. programmatic bearer auth is a separate contract
6. chosen CORS/same-origin deployment works
7. unlisted origin is denied
8. SSE uses no token URL
9. exact raw webhook body reaches BillingProvider verification unchanged
10. node command endpoint requires correct node token
11. duplicate workspace names are handled safely
12. real PostgreSQL verification passes after fixes

## Acceptance criteria

Repair Prompt 01 is safe only when:
- browser auth JSON never contains reusable session token
- CLI/programmatic auth is separate
- deployment-origin topology works securely
- raw webhook body is preserved and used
- node command polling is authenticated
- slug collision is safe
- PostgreSQL verification is rerun and recorded truthfully

## Final report
Return:
- old SHA
- new SHA
- branch
- browser auth response shape
- programmatic auth design
- CORS/deployment topology
- raw webhook-body design
- node command behavior
- slug collision test result
- PostgreSQL verification result
- tests/typecheck/lint/build
- blockers
- `Repair Prompt 01 SAFE TO RUN: YES/NO`
