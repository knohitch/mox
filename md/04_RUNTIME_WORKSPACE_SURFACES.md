# MOX — PHASE 04
# WIRE COMPUTER, FILES, TERMINAL, AND LOGS TO REAL RUNTIME AUTHORITY

> ✅ **STATUS: DONE** — implemented and verified. See
> `docs/verification/PRODUCT_COMPLETION_04_RUNTIME_WORKSPACE_SURFACES.md`.

Use **Gemini 3.1 Pro High**.

Work in `E:\MyCodes\Mox` on clean `master`. Re-scan current runtime architecture. Preserve onboarding, DEV direct access, auth/RBAC, tenant isolation, entitlement gates, signed node authority, prior SSRF/egress hardening and secret redaction. Do not push.

## GAP

Mox already has UI tabs and lower-level runtime/computer infrastructure, while several Control Plane routes have historically returned honest `501/not_configured` for:

- Computer snapshot/gateway;
- Computer takeover/restart;
- workspace files;
- file preview;
- terminal execution;
- runtime logs.

Finish these surfaces by connecting them to real Mox runtime/node authority. Never replace 501 with fake output.

## FIRST STEP — TRACE THE REAL PATH

For each capability trace:

```text
Customer browser
→ Control Plane
→ authenticated org/entitlement gate
→ runtime gateway / Mox Node
→ owned customer workload/container
```

Inspect `runtime/agent-runtime`, `runtime/computer-runtime`, `runtime/mox-node`, signed commands, node authentication, workload manager, command queue, session events, gateway-token rules and egress policy. Use those authorities instead of inventing a parallel execution path.

## SECURITY BOUNDARY

Customer VPS/root is untrusted. Control Plane stays authoritative.

Every operation must bind authenticated org + owned Agent + owned deployment/runtime + correct node/workload + applicable entitlement.

Never execute file/terminal operations on the Control Plane host.

## A. COMPUTER

Wire real:
- snapshot;
- session lifecycle;
- human takeover;
- handback;
- restart.

Requirements:
- real current session id;
- short-lived scoped gateway authorization;
- takeover pauses Agent browser actions;
- handback resumes safely;
- restart remains tenant/Agent scoped;
- default-deny egress remains;
- no reusable broad secret in browser;
- audit takeover/restart.

If deployment lacks the required runtime image/provider, keep a truthful unavailable result.

## B. FILES

Implement safe Agent workspace file access:
- list files;
- preview bounded text-safe files;
- classify binary/unpreviewable content;
- optional download only if an existing safe product contract supports it.

Block:
- `..` traversal;
- absolute host paths;
- symlink escape;
- secret mounts;
- `.env`/credential/runtime-token exposure;
- unlimited reads/results.

Never allow arbitrary VPS filesystem browsing.

## C. TERMINAL

Wire command execution to the Agent's isolated workload/container.

Requirements:
- entitlement + ownership;
- timeout;
- output byte cap;
- stdout/stderr sanitization;
- cancellation if protocol supports it;
- audit metadata;
- no Control Plane shell;
- no host privilege escalation.

If only bounded command execution exists, expose that honestly rather than pretending to be a full interactive PTY.

## D. LOGS

Implement bounded owned-Agent/deployment logs:
- pagination/cursor or tail;
- timestamps;
- source/stream metadata where safe;
- secret scrub;
- streaming admission limits if SSE/WebSocket;
- reconnect/resume;
- cross-tenant denial.

## UI

Make Computer, Files, Terminal and Logs tabs functional with loading, connected, unavailable, permission-denied, disconnected, retry and relevant active states. No enabled control may exist that is guaranteed to throw locally.

Update Customer DEV fixture states for all four tabs.

## TESTS

Must include cross-org denial, node/workload mismatch, traversal, symlink escape, hidden secret files, terminal host-escape denial, timeout/output cap, log scrub, stale gateway token, takeover ownership, restart ownership and default-deny egress regression.

Run all affected runtime/security/web/control-plane suites and full gates including PostgreSQL.

Report:
`docs/verification/PRODUCT_COMPLETION_04_RUNTIME_WORKSPACE_SURFACES.md`

Clearly separate code completion from external runtime images/provider deployment still required.

Local commit:
`feat(runtime): wire customer workspace computer files terminal and logs`

Do not push.
