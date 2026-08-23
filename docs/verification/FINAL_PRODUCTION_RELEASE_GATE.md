# Final Production Release Gate

Date: 2026-08-23

Release rule: no critical/high code blocker remains from this validation. Rows marked `no` are external deployment readiness gates or intentionally unsupported local-environment checks; they must be closed before declaring a specific production environment ready.

| area | scenario | result | evidence/test | blocker | production-ready yes/no |
| --- | --- | --- | --- | --- | --- |
| CI | mandatory workflow exists and covers install, lint, branding, secret scan, dependency/security check, authority scan, build, typecheck, tests, PostgreSQL migrations/upgrade, containers | pass | `.github/workflows/ci.yml`; local execution of each command below | none | yes |
| CI | no mandatory step uses `|| true` | pass | `rg -n "\|\| true" .github package.json scripts apps packages services runtime infra docs` returned no matches | none | yes |
| CI | install | pass | `pnpm install --frozen-lockfile` | none | yes |
| CI | lint | pass with warnings | `pnpm lint` exited 0; warnings are unused/test cleanup, not release blockers | non-blocking lint warnings remain | yes |
| CI | web/admin/CLI/runtime builds | pass | `pnpm -r run build`; includes `@mox/web`, `@mox/admin`, `@mox/cli`, `@mox/agent-runtime`, `@mox/computer-runtime`, `@mox/mox-node` | none | yes |
| CI | typecheck | pass | `pnpm typecheck` | none | yes |
| CI | unit/integration tests | pass | `pnpm test`: 57 files passed, 1 skipped; 422 passed, 39 skipped | PostgreSQL-gated tests run separately | yes |
| CI | PostgreSQL tests, migrations, upgrade drill | pass | `scripts\run-postgres-verification.ps1`: migrations `0000`-`0010`, 46 PG tests passed, pre-0006 upgrade drill passed | none | yes |
| CI | branding scan | pass | `pnpm public-branding-scan`: clean | none | yes |
| CI | secret scan | pass | `pnpm secret-scan`: clean across active Mox release roots | donor source-drop dirs are excluded from active release roots | yes |
| CI | dependency/security check | pass at high threshold | `pnpm dependency-security`; no critical/high findings | one moderate dev-only `esbuild` advisory remains through `drizzle-kit` transitive loader | yes |
| CI | container builds where configured | pass/not configured | `pnpm container-builds`: no container build files configured in active Mox roots | active Mox release has no Docker/compose files | yes |
| customer flow | signup, login, browser session, organization, org switching | pass | PostgreSQL auth integration tests in `services/control-plane/tests/auth-integration.test.ts` | none | yes |
| customer flow | plan selection, regional price, checkout creation | pass | billing service tests; PostgreSQL auth integration checkout tests; restart tests for regional price books | none | yes |
| customer flow | redirect alone grants nothing | pass | `redirect grants nothing; webhook activates; replay dedupes; out-of-order cannot regress` | none | yes |
| customer flow | verified webhook activates subscription and entitlements | pass | billing tests; PostgreSQL auth integration; payment-triggered notification test | none | yes |
| customer flow | dedicated VPS order and Mox Node enrollment | pass | PostgreSQL auth integration node command/enrollment tests; restart tests for node expected-token durability | live Contabo/Hetzner spend not authorized; fake/sandbox used | yes |
| customer flow | agent creation and deployment | pass | `services/agent-control/tests/agent-control.test.ts` Simple Mode, deploy, rollback tests | none | yes |
| customer flow | model connection | partial/honest | model catalog and provider config paths exist; probe returns explicit `not_configured` until provider SDK/vault probe is wired | external provider credentials and live probe wiring required | no |
| customer flow | chat/run | pass at protocol/runtime test level | runtime-client protocol tests; agent-runtime run/restart tests | live production runtime command must be configured per deployment | no |
| customer flow | browser/computer | pass at gateway/runtime test level | `runtime/computer-runtime/tests/gateway.test.ts`; `runtime/agent-runtime/tests/computer-tool.test.ts` | production browser provider image must be deployed | no |
| customer flow | notification | pass | notification service tests; PostgreSQL notification inbox/admin send/schedule tests | none | yes |
| customer flow | renewal, failed renewal, grace, suspend | pass | `services/billing/tests/billing.test.ts` renewal success/failure/grace/suspend cases | none | yes |
| customer flow | cancellation, retention, resubscribe | pass | billing cancellation/retention tests; restart cancel->resubscribe history test | none | yes |
| payments | Paystack checkout/webhook/duplicate/wrong signature | pass | `services/billing/tests/providers.test.ts`; shared billing webhook replay/wrong amount/currency/reconcile tests | live Paystack sandbox credentials not present | no |
| payments | Flutterwave checkout/webhook/failure/wrong signature | pass | `services/billing/tests/providers.test.ts`; shared billing service matrix | live Flutterwave sandbox credentials not present | no |
| payments | Stripe checkout/webhook/recurring/failure | pass | `services/billing/tests/providers.test.ts`; shared billing service matrix | live Stripe sandbox credentials not present | no |
| payments | PayPal checkout/webhook/recurring/failure | pass | `services/billing/tests/providers.test.ts`; shared billing service matrix | live PayPal sandbox credentials/webhook id not present | no |
| payments | wrong amount/currency, out-of-order, duplicate, restart persistence | pass | billing tests; PostgreSQL auth integration; restart tests | none | yes |
| admin | plans, entitlements, regional pricing | pass | admin tests; PostgreSQL entitlement transaction tests; billing price book tests | none | yes |
| admin | payment providers and secret handling | pass | PostgreSQL admin provider config test confirms platform-admin only and no secret echo | live vault refs must be provisioned | no |
| admin | compute providers | pass at safe fake/sandbox level | compute orchestrator tests; PostgreSQL VPS order/enrollment tests | Contabo/Hetzner commercial approval and credentials required for live production | no |
| admin | model providers/internal intelligence credentials | partial/honest | admin endpoints and secret-ref-only handling present; provider probe returns `not_configured` | Mox Vault credential resolver/live provider probes required | no |
| admin | notifications | pass | PostgreSQL admin notification send/schedule/cancel tests | none | yes |
| admin | feature flags | pass | `packages/feature-flags/tests/flags.test.ts` | none | yes |
| admin | health | pass | `/healthz` PostgreSQL integration test | none | yes |
| admin | costs/margins | pass | `services/cost-engine/tests/cost-engine.test.ts` | none | yes |
| admin | abuse/backups | pass | platform-ops abuse tests; backups tests | object storage adapter required for real backup storage | no |
| runtime | Simple Mode | pass | `services/agent-control/tests/agent-control.test.ts` | none | yes |
| runtime | Developer Mode terminal/files entitlement gates | pass/partial | agent-control terminal entitlement tests; web terminal now fails honestly with `not_configured` until gateway execution is wired | production terminal/files provider must be deployed | no |
| runtime | version/deploy/rollback | pass | agent-control deploy and rollback tests | none | yes |
| runtime | full runtime production mode | pass at config/protocol gate | `runtime/agent-runtime/tests/agent-runtime.test.ts`; `services/control-plane/tests/runtime-config.test.ts` | deployment must provide `MOX_RUNTIME_MODE=full` and `MOX_RUNTIME_COMMAND`; no live external runtime launched locally | no |
| runtime | browser/computer | pass at gateway level | computer-runtime gateway tests and agent-runtime computer tool test | production browser provider image required | no |
| runtime | subagent, Agent Room, workflow/schedule | pass at contract/UI/control level | runtime-client protocol tests, web room demo tests, notification schedule tests, agent definitions include schedules/subagents/workflows | live multi-agent runtime execution depends on full runtime deployment | no |
| runtime | restart/resume/crash recovery | pass | agent-runtime crash/restart tests; runtime-client resume protocol tests; PostgreSQL restart tests | none for code path | yes |
| notifications | admin single-user send | pass | PostgreSQL admin notification send test | none | yes |
| notifications | org/all broadcast | pass | PostgreSQL admin notification broadcast test | none | yes |
| notifications | plan/region targeting | pass at service audience layer | notification service/admin audience job model; PostgreSQL admin jobs | broader live audience population depends on production data | yes |
| notifications | realtime unread updates | pass | notification-service realtime unread test; SSE auth tests | none | yes |
| notifications | read/unread/archive | pass | notification-service tests; PostgreSQL read-all/archive persistence test | none | yes |
| notifications | IDOR denial | pass | PostgreSQL notification IDOR test | none | yes |
| notifications | payment-triggered notification | pass | PostgreSQL payment event notification wiring test | none | yes |
| notifications | server-triggered notification | pass | restart notification test uses `server.provisioned`; notification templates tested | none | yes |
| branding | automatic Mox-only public scan | pass | `pnpm public-branding-scan` | none | yes |
| branding | manual spot check of public/runtime wording | pass | scan terms and current UI/docs use Mox public identity; actual provider/model names remain allowed | donor source-drop dirs excluded from active public surfaces | yes |
| security | auth/PAT/RBAC/cross-tenant regressions | pass | `services/control-plane/tests/security-regression.test.ts`; PostgreSQL auth integration; platform-ops hardening tests | none | yes |
| security | webhook forgery/replay/tampering | pass | billing tests; platform-ops hardening; PostgreSQL auth integration | none | yes |
| security | SSRF/secret redaction/browser token leakage | pass | integration-gateway SSRF tests; security tests; browser bundle security regression tests | none | yes |

## Command Evidence

- `pnpm install --frozen-lockfile` passed.
- `pnpm lint` passed with warnings.
- `pnpm public-branding-scan` passed.
- `pnpm secret-scan` passed.
- `pnpm dependency-security` passed at high severity; one moderate dev-only advisory remains.
- `pnpm scan:authority` passed.
- `pnpm -r run build` passed.
- `pnpm typecheck` passed.
- `pnpm test` passed: 57 files passed, 422 tests passed.
- `powershell -ExecutionPolicy Bypass -File scripts\run-postgres-verification.ps1` passed: clean migrations, PostgreSQL suites, upgrade drill.
- `pnpm container-builds` passed with no active Mox container files configured.

## External Readiness Blockers

These are not hidden as test success:

- Live payment sandbox credentials/webhook registrations for Paystack, Flutterwave, Stripe, and PayPal are not present in this local environment.
- Live Contabo/Hetzner credentials and commercial approvals are not present; compute validation used fake/sandbox providers.
- Production full-runtime deployment requires `MOX_RUNTIME_MODE=full` and `MOX_RUNTIME_COMMAND`; no live external runtime command was launched locally.
- Production browser/computer and terminal/files providers require deployed gateway/provider images.
- Mox Vault-backed model/internal intelligence credential resolution and live provider probes remain external deployment requirements.
- Active Mox roots contain no Docker/compose files, so container builds are not configured.

## Release Verdict

Code release gate: pass for active Mox repository code, with no known critical/high code blocker.

Environment production readiness: no for a live production deployment until the external blockers above are provisioned and revalidated in that environment.
