# Repair Prompt 00B — Authentication security, token leakage, node retry hardening and real PostgreSQL verification

**Reasoning: Ultra**

Run this before Repair Prompt 01.

Repository: `knohitch/mox`
Current audited Prompt-00 commit: `91b0bc4872ceac1ff3529a0da4f919bc2daae2fe`

## Confirmed blockers from the pushed code

1. `apps/web/src/config.ts` exposes `VITE_MOX_BOOTSTRAP_TOKEN`. Any `VITE_*` value is browser-side configuration and must never contain a long-lived deployment/master credential.
2. `apps/web/src/api/store.tsx` exchanges that browser-visible token through `/api/auth/session`.
3. `services/control-plane/src/auth.ts#createSessionFromBootstrap()` grants the session to `SELECT users LIMIT 1`. This is not real user authentication.
4. `apps/web/src/api/realtime.ts` places the normal session bearer token in the SSE URL query string.
5. `services/control-plane/src/server.ts` logs `req.url`, so that token can be written to logs.
6. PostgreSQL restart tests were skipped when `MOX_TEST_DATABASE_URL` was unavailable; shared in-memory stores do not prove physical durability.
7. `PgBillingStore.setPlanEntitlementValues()` deletes then inserts without one transaction.
8. Provisioning retries can issue fresh enrollment tokens without enforcing only one currently valid issued token per server order.
9. `PgOrchestratorStore.consumeNonce()` returns `true` unconditionally.

Do not integrate real payment gateways until these are fixed.

---

## A. Remove browser bootstrap authentication

Delete the production use of `VITE_MOX_BOOTSTRAP_TOKEN` and any equivalent browser-visible deployment/admin master secret.

Update:
- `apps/web/src/config.ts`
- `apps/web/src/api/store.tsx`
- `apps/web/src/api/http-api.ts`
- related tests/docs

A deployment bootstrap secret may exist only server-side for one-time initial platform-owner provisioning.

If first-install owner bootstrap is needed:
- expose only via server-side CLI or tightly restricted one-time setup flow;
- explicitly create the designated owner/admin;
- never select an arbitrary “first user”;
- permanently disable/invalidate setup after completion;
- never reuse it as normal login;
- never log it.

---

## B. Implement real Mox account authentication

Implement server-authoritative:
- signup/account creation;
- login;
- logout;
- `/api/me`;
- session revoke;
- expiry;
- organization/workspace list;
- active organization selection/switching.

Use existing `users`, `memberships`, `auth_sessions`, and `external_identities` where appropriate.

For password login:
- add a dedicated credential table/domain;
- use Argon2id preferably, or a secure modern KDF compatible with the repo;
- per-password salt;
- never use plaintext, reversible encryption, or simple SHA hashes;
- never log password/hash.

Keep provider OAuth identity support as an extensible seam, but do not fake providers.

### Browser session requirements
Prefer server sessions using:
- HttpOnly cookie;
- Secure in production;
- intentional SameSite policy;
- random server-generated session token;
- only hash stored in DB;
- explicit logout/revocation;
- rotation when appropriate.

Do not store the primary Mox browser auth token in `localStorage`.

If cookie-authenticated state-changing requests are cross-site/cross-origin, add the appropriate CSRF protection and narrow CORS configuration.

---

## C. Fix multi-organization identity

Current auth uses `.limit(1)` on memberships.

Implement explicit active-org context:
- session references/contains active org;
- user can list memberships;
- switch-org endpoint verifies membership;
- every request derives org from authenticated session context;
- arbitrary client-supplied org IDs are never trusted without membership verification.

Add cross-org tests.

---

## D. Remove reusable auth tokens from URLs and logs

Do not pass the normal session token in SSE query parameters.

Use one of:
1. cookie-authenticated SSE;
2. fetch-based streaming with Authorization header;
3. short-lived, one-time, audience-restricted realtime ticket that cannot authenticate normal API requests.

Change request logging:
- log pathname, not raw query string;
- redact sensitive data;
- never log Authorization, Cookie, session, bootstrap or provider secrets.

Add a test proving a secret in query/header never appears in logs.

---

## E. Make plan entitlement replacement transactional

Fix `PgBillingStore.setPlanEntitlementValues()`.

Requirements:
- one PostgreSQL transaction;
- validate keys/value types before destructive change;
- if insertion fails, old values remain intact;
- concurrent readers do not observe a failed empty replacement;
- rollback test.

---

## F. Harden node enrollment across provisioning retries

Enforce:

> At most one valid `issued` enrollment token may exist for a server order.

Use database enforcement where possible, such as a partial unique index on `order_id WHERE state='issued'`.

Before issuing a new token on retry:
- revoke/expire prior issued token(s), OR safely reuse the one valid expected token.

If provider provisioning fails:
- stale token must not remain usable unless the exact bootstrap payload is intentionally reused.

On success:
- bind token expectation to current provider instance.

During enrollment:
- load the server order;
- verify org binding;
- verify current provider instance exists;
- verify token record provider instance matches the order's current provider instance when bound;
- reject token from an older provisioning attempt;
- atomically consume.

Tests:
- first provider attempt fails after token issuance;
- retry occurs;
- old token fails;
- current token succeeds;
- only one issued token exists.

---

## G. Fix or remove fake nonce consumption

`PgOrchestratorStore.consumeNonce()` must not simply return `true`.

Trace production callers.

If replay protection depends on it:
- implement durable unique nonce persistence with atomic insert/consume and cleanup/TTL;
- duplicate nonce returns false even after process restart.

If unused:
- remove it from the production authority contract instead of pretending it is secure.

Also verify signed privileged Mox Node commands cannot become replayable merely because a process restarts.

---

## H. Real PostgreSQL verification is mandatory

The previous Prompt 00 run skipped the PostgreSQL variant.

Use a fresh disposable PostgreSQL instance via Docker/Testcontainers or a valid `MOX_TEST_DATABASE_URL`.

Required verification:
1. empty DB;
2. apply all migrations through current;
3. run PostgreSQL restart/idempotency tests;
4. recreate DB clients/services between writes and reads;
5. prove:
   - billing persists;
   - pending server operations persist;
   - notifications persist;
   - entitlements persist;
   - enrollment state persists;
   - duplicate webhook stays deduped;
   - cancel → historical subscription → resubscribe works;
6. upgrade-test from pre-0006 schema to current;
7. test transactional entitlement rollback;
8. test enrollment concurrency against PostgreSQL.

If environment cannot run PostgreSQL, final output must say:
`BLOCKED: real PostgreSQL verification not executed`
and provide the exact human command required. Do not call it verified.

---

## I. Security regression tests

Add tests proving:
- production browser bundle contains no bootstrap/master secret;
- normal login works without deployment bootstrap token;
- setup bootstrap cannot authenticate users after setup closes;
- login session belongs to the actual authenticated user, never “first user”;
- multi-org access is membership-checked;
- logout/revoke works;
- expired session fails;
- realtime does not expose reusable session token in URL;
- logs do not contain auth secrets;
- localStorage does not contain the primary Mox session credential;
- stale enrollment token after retry fails;
- nonce replay semantics are real.

---

## Acceptance criteria

Repair Prompt 01 is safe only when:

- no `VITE_MOX_BOOTSTRAP_TOKEN` or equivalent master secret exists in browser production code;
- `/api/auth/session` is no longer a shared-secret → first-user shortcut;
- real user authentication/session identity exists;
- org selection is explicit and membership-checked;
- primary browser auth is not stored in localStorage;
- reusable session bearer is not present in realtime URLs;
- request logs cannot leak query/auth secrets;
- entitlement replacement is transactional;
- only one usable node enrollment token exists per order;
- stale retry tokens fail;
- nonce replay handling is genuine or removed;
- real PostgreSQL verification actually passed, or is truthfully reported as blocked.

## Final report

Return:
- old SHA
- new SHA
- branch
- auth design
- files changed
- migrations
- PostgreSQL test mechanism
- exact PG tests/results
- security tests/results
- blockers
- `Repair Prompt 01 SAFE TO RUN: YES` or `NO`
