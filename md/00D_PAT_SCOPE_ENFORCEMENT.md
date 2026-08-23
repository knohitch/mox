# Repair Prompt 00D — PAT scope enforcement and token-management contract fix

**Reasoning: Extra High**

Repository: `knohitch/mox`
Current audited commit after 00C: `ca79db524a46d8e81b1ada499e3dbbb15bf3c1c0`

This is a small security correction before payment integrations. Do not implement Paystack, Flutterwave, Stripe or PayPal in this prompt.

## Confirmed issue

00C correctly created scoped personal/API access tokens, but the control plane currently authenticates a PAT and then routes it through the same generic `requireAuth()` path without enforcing `auth.scopes`.

Consequences:
- a PAT issued with only `agents` / `servers` can call unrelated authenticated APIs;
- a restricted PAT can call `POST /api/auth/tokens` and mint a new `*` token, defeating the restriction;
- current tests verify scopes are stored/returned, not that denied scopes are actually denied.

There is also a wire-contract mismatch: `HttpMoxApi.createApiToken()` declares `ProgrammaticAuthResponse`, but `POST /api/auth/tokens` returns only token-creation metadata and not `MeResponse` identity fields.

## A — Enforce PAT scopes server-side

Keep browser cookie sessions as full permissions subject to normal user/org role/entitlement checks.

For `authKind === "api_token"`, every protected route must require either `*` or the explicit scope for that route family.

Create a central helper, e.g. `requireAuth(ctx, requiredScope?)` / `requireScope(auth, scope)`, so enforcement cannot be forgotten route-by-route.

Suggested route mapping (adapt carefully to existing route semantics):
- `agents` — agent definitions/roster and agent-specific mutations
- `threads` — threads/messages/events/realtime related to conversations
- `servers` — servers, deployments, computer/files/logs tied to server/runtime operations
- `billing` — subscription, checkout, invoices, cancellation/payment-related APIs
- `models` — model/provider connections
- `integrations` — integrations/MCP/app connections
- `channels` — messaging/channel connections
- `usage` — usage/metering reads
- `approvals` — approval read/resolve
- `settings` — user/org settings safe for API-token use
- `admin` — admin APIs only, still additionally requiring the user's real admin capability/role; an `admin` scope must NEVER create admin privilege by itself

Identity endpoints such as `/api/me` may be allowed to any valid PAT.

Active-org switching for a PAT must remain membership-checked.

## B — Prevent restricted-token self-escalation

Preferred policy:
- `POST /api/auth/tokens` — browser/session auth only
- `GET /api/auth/tokens` — browser/session auth only
- `DELETE /api/auth/tokens/:tokenId` — browser/session auth only

CLI can obtain its first token through `/api/auth/token-login`.

If PAT-driven token management is intentionally kept, require a dedicated `tokens.manage` scope and never allow creating scopes broader than the caller's own effective scope set.

For `/api/auth/token-login`:
- password auth may create a token only for that user's existing role/capabilities;
- scopes constrain API surface, never elevate privileges;
- reject `admin` scope unless the authenticated user already has the corresponding server-side admin capability;
- `*` means all API scopes available to that user, not superadmin.

## C — Fix API token response contracts

Create distinct typed responses:

`ProgrammaticLoginResponse`
- identity/orgs
- token
- tokenId
- scopes
- expiresAt

`CreateApiTokenResponse`
- token
- tokenId
- scopes
- expiresAt

`ApiTokenMetadata`
- metadata only, never plaintext token

Update shared contracts, web client, server responses and tests so runtime payload and TypeScript contract match exactly.

## D — Tests

Add real PostgreSQL integration tests proving:
1. PAT with `agents` can access agent endpoints.
2. Same PAT is denied from billing.
3. Same PAT is denied from servers when `servers` is absent.
4. PAT with `billing` can access permitted billing reads but not admin.
5. Restricted PAT cannot call `POST /api/auth/tokens` to mint `*`.
6. Restricted PAT cannot manage token inventory through session-only endpoints.
7. `admin` scope on a non-admin account never grants admin power.
8. `*` PAT cannot exceed the user's real role/capabilities.
9. Revoked/expired PAT remains rejected.
10. `CreateApiTokenResponse` matches actual JSON exactly.
11. Browser cookie auth remains unchanged.
12. Cross-org membership protection remains intact.

Rerun the existing disposable PostgreSQL verification.

## Acceptance criteria

Repair Prompt 01 is safe only when:
- PAT scopes are enforced server-side;
- limited PATs cannot call unrelated route families;
- limited PATs cannot self-escalate by minting broader tokens;
- admin scope never creates admin privilege;
- token-management endpoint policy is explicit;
- API-token response contracts match actual JSON;
- PostgreSQL-backed scope tests pass.

## Final report

Return:
- old SHA
- new SHA
- branch
- scope enforcement design
- route/scope matrix
- token-management policy
- response-contract changes
- PostgreSQL tests/results
- typecheck/lint/build results
- blockers
- `Repair Prompt 01 SAFE TO RUN: YES/NO`
