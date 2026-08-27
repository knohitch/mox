# Security Repair 09 — Pinned HTTP Request Target

## Repository State

- Original snapshot repository: `E:\MyCodes\Mox`
- Original snapshot branch: `master`
- Original snapshot SHA: `0fe5dd1b48fa6302c14bad1392f5d5f5bad4b7c4`
- Repair-07 working-tree digest before the Revalidation-08 report: `cb9ee29ac7610150cec6e950e5c753201e84100c5acdca52af949e15fa41fd96`
- `_MOX_SOURCE_INFO.txt` recorded the original uploaded source tree as `CLEAN` before the uncommitted repairs.
- `.git` is intentionally absent from this source-only environment.
- Repair 07 and Repair 09 remain uncommitted in the current working tree. Revalidation 08 was read-only except for its verification report.

## Defect

Revalidation 08 proved that the Repair-07 pinned Node HTTP(S) transport preserved the logical scheme, hostname, port, DNS/IP pinning authority and TLS hostname, but omitted Node `RequestOptions.path`.

For a URL such as:

`https://api.example.com/hook/task?token=abc`

`buildPinnedRequestOptions()` produced no explicit request target, so Node defaulted the outgoing request to `/` instead of `/hook/task?token=abc`.

This did **not** reopen the previously repaired HIGH DNS-rebinding SSRF issue, but it was a production-reachable Medium routing/integrity/availability defect for non-root webhooks and integrations.

During the required direct default-caller probe, one tightly adjacent compatibility defect in the same pinned transport also became executable: a valid HTTP `204` response was converted to `new Response(Buffer.alloc(0), { status: 204 })`. The Fetch `Response` constructor requires a null body for null-body statuses, so a legitimate 204 webhook response could fail locally. The existing channel regression intentionally uses 204, so the implementation was corrected rather than weakening that test.

## Fix

Primary authoritative request-target construction in `packages/security/src/ssrf.ts`:

```ts
path: `${parsed.pathname}${parsed.search}`,
```

This uses WHATWG `URL`'s already-canonicalized encoded `pathname` and `search` directly:

- pathname is preserved;
- query string is preserved;
- encoded path/query identity is not manually decoded/re-encoded;
- URL fragments are excluded because `parsed.hash` is not part of the request target;
- URL credentials are still rejected earlier by `assertSafeOutboundUrl()` and are never incorporated into the request target.

The tightly adjacent 204/205/304 response-adaptation correction is:

```ts
const responseBody = status === 204 || status === 205 || status === 304 ? null : body;
resolve(new Response(responseBody, { status, headers: responseHeaders }));
```

No database migration was added.

## Security Preservation

Source re-inspection after the patch confirmed the pinned transport still performs:

`URL parse → scheme/host/port validation → DNS resolution → validate every answer → pinned socket lookup → logical-host TLS verification → correct pathname/query`

Specifically:

- `safeOutboundFetch()` still calls `resolveValidatedAddresses()` before `performPinnedRequest()`.
- `resolveValidatedAddresses()` still rejects the entire DNS answer set when **any** answer is private/blocked.
- `buildPinnedRequestOptions()` still installs `lookup: pinnedLookup(pinned)`, so the actual socket lookup can use only the validated address set.
- Production/default `HttpOutboundTransport` still leaves `fetchImpl` undefined unless explicitly supplied as a test seam.
- Production/default `WebhookAutomationProvider` still leaves `fetchImpl` undefined unless explicitly supplied as a test seam.
- No production caller was switched back to ordinary/global `fetch`.
- `servername` remains the original logical hostname.
- There is no `rejectUnauthorized: false` and no permissive `checkServerIdentity` override in the repaired path.
- Literal/private IP and mixed DNS-answer rejection are unchanged.
- Redirects still update `current` to the new URL and repeat parse/validate/resolve/pin for every hop.
- Each redirected request constructs `path` from that redirect URL's own `pathname + search`.
- Cross-host redirects still strip `authorization`, `cookie`, and `proxy-authorization`.

## Regression Tests

The focused Repair-09 regressions are in the existing Repair-07 SSRF test files so they remain adjacent to the original security repair.

| ID | Coverage | Test/source state | Executable evidence in this environment |
| --- | --- | --- | --- |
| R09-1 | `/hook/task` remains `/hook/task` | Added in `packages/security/tests/security-repair-07.test.ts` | **PASSED** direct request-target matrix |
| R09-2 | pathname + query preserved | Added in security test | **PASSED** direct matrix and local Node server request probe |
| R09-3 | root remains `/` | Added in security test | **PASSED** direct request-target matrix |
| R09-4 | encoded path/query identity preserved | Added in security test | **PASSED** direct matrix and local Node server request probe |
| R09-5 | fragment never transmitted | Added in security test | **PASSED** direct request-target matrix |
| R09-6 | redirect hop gets its own pathname/query and repins | Repair-07 redirect test expanded/renamed | **PASSED** direct pinned redirect probe |
| R09-7 | default `HttpOutboundTransport` preserves non-root target and does not use global fetch | Channel Repair-07 test expanded/renamed; fixture returns HTTP 204 | **PASSED** direct default-caller probe, including 204 handling |
| R09-8 | default `WebhookAutomationProvider` preserves non-root target and does not use global fetch | Integration Repair-07 test expanded/renamed | **PASSED** direct default-caller probe |
| R09-9 | DNS rebinding/pinned lookup remains closed | Existing A3 test explicitly mapped to R09-9 | **PASSED** direct rebinding probe: resolver called once; pinned lookup returned only validated `8.8.8.8`; mixed public/private answer rejected |
| R09-10 | logical hostname/SNI and certificate verification remain intact | Existing A5 test explicitly mapped to R09-10 | **PASSED** direct TLS-options/pinned probe; no verification-disable option present |

The Vitest test files themselves could not be executed because the source-only snapshot has no `node_modules` and `pnpm` is unavailable. The direct probes above transpiled the **actual current source** with the locally installed TypeScript compiler and exercised the relevant runtime paths without changing the repository.

## Verification

### PASSED

- Direct R09 request-target matrix over the current `buildPinnedRequestOptions()`:
  - R09-1: `/hook/task`
  - R09-2: `/hook/task?token=abc&mode=full`
  - R09-3: `/`
  - R09-4: encoded path/query preserved exactly
  - R09-5: fragment omitted
- Local Node HTTP server probe using the actual generated Node `RequestOptions`: server observed `/hook/%2Ftenant?q=a%2Fb&space=hello%20world` exactly; fragment was absent.
- Direct pinned redirect probe over `safeOutboundFetch()`:
  - first target `/start/%2Fencoded?a=1%2F2`;
  - second target `/hooks/final?b=2`;
  - redirect hosts resolved independently;
  - logical host remained SNI authority;
  - cross-host credentials were stripped;
  - TLS verification was not disabled.
- Direct default-caller probe over transpiled current source:
  - `HttpOutboundTransport` sent `/hook/task?token=abc&mode=full` through the pinned Node transport;
  - `WebhookAutomationProvider` sent `/hooks/final?token=xyz&mode=full` through the pinned Node transport;
  - global `fetch` was not called;
  - the channel's HTTP 204 success path completed successfully after the null-body-status adaptation correction.
- Direct SSRF rebinding regression probe:
  - hostile resolver would return `8.8.8.8` first and `127.0.0.1` on a hypothetical second call;
  - resolver was called exactly once for the request;
  - actual pinned lookup exposed only `8.8.8.8`;
  - mixed public + `127.0.0.1` answers were rejected;
  - request path remained `/hook?x=1`;
  - `servername` remained `public.example`;
  - TLS verification was not disabled.
- Changed-TypeScript syntax/transpile validation: **PASSED** for the four Repair-09 TypeScript files.
- `node scripts/public-branding-scan.mjs`: **PASSED**.
- `node scripts/authority-scan.mjs`: **PASSED**.
- Source-only equivalent of the repository secret scanner, using the same active roots/exclusions/patterns but filesystem enumeration instead of `git ls-files`: **PASSED**, 453 files scanned.
- Repair-09 source diff-style check: **PASSED**; no trailing whitespace, conflict markers, or missing final newline in the four changed TypeScript files.
- Scoped grep found no `rejectUnauthorized: false`, permissive `checkServerIdentity`, `fetchImpl = fetch`, or `globalThis.fetch` production fallback in the repaired SSRF/caller path.

### UNEXECUTED

These gates are **not** counted as passes:

- `pnpm lint` — attempted; shell returned exit 127 because `pnpm` is not installed/on PATH.
- `pnpm typecheck` — attempted; exit 127 because `pnpm` is unavailable.
- `pnpm test` — attempted; exit 127 because `pnpm` is unavailable.
- `pnpm build` — attempted; exit 127 because `pnpm` is unavailable.
- Focused Vitest command for the security/channel/integration Repair-09 suites — attempted; exit 127 because `pnpm` is unavailable.
- `pnpm dependency-security` / repository `pnpm audit --audit-level high` — unexecuted because `pnpm` is unavailable and the snapshot has no installed dependency tree.
- Official `node scripts/secret-scan.mjs` — attempted after the final source repair; it cannot enumerate files because it requires `git ls-files` and `.git` is intentionally absent. It exited non-zero for that environment reason. The filesystem-equivalent scan above passed, but it is not represented as the official command passing.
- Dependency-complete TypeScript project typecheck — unavailable because `node_modules` is intentionally excluded.
- The environment is Node `v22.16.0`; repository `package.json` requires Node `>=24`.
- Corepack/package download was not retried during Repair 09 because Repair 07 already established the environment's registry/DNS failure (`EAI_AGAIN`) and the Repair-09 instructions explicitly said not to repeatedly attempt downloads.
- PowerShell/PostgreSQL verification — not rerun: this environment has no `powershell`/`pwsh` and no PostgreSQL command-line binaries. Repair 09 changes no database code or migration, so no new PostgreSQL verification logic was introduced; dependency-complete/local verification remains required before release.

## Files Changed by Repair 09

1. `packages/security/src/ssrf.ts`
2. `packages/security/tests/security-repair-07.test.ts`
3. `services/channel-gateway/tests/security-repair-07.test.ts`
4. `services/integration-gateway/tests/security-repair-07.test.ts`
5. `docs/verification/SECURITY_REPAIR_09_REQUEST_TARGET.md`

No migration was added.

## Remaining Critical

`NONE`

## Remaining High

`NONE`

The Repair-07 DNS-rebinding HIGH remains closed by source inspection and direct executable pinning/rebinding probes.

## Remaining Medium

`NONE` within the narrowly scoped Repair-09 outbound transport/caller path after the request-target repair and the directly discovered 204 null-body-status compatibility correction.

## Repair-09 Readiness

A final targeted **source revalidation is safe to run** against the current uncommitted working tree.

This is **not** authorization to release, commit, push, or deploy. The unavailable Node 24 + pnpm + dependency-complete Vitest/typecheck/build gates must still be run in the proper local/CI environment before release authority is granted.
