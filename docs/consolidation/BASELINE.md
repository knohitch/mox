# Mox Consolidation Baseline

Status: **Step 1 of consolidation.** This document records the state of the
three imported upstream trees **before any Mox changes**, so later
consolidation can distinguish pre-existing failures from new ones.

- Baseline recorded at: 2026-08-20/21 (America/Chicago)
- Root HEAD SHA: `96c6d9c0421c0b32e310923fb8bd803e8fc37977`
- Host: Windows Server 2019, x64
- Toolchain observed: Node v26.2.0, pnpm 10.15.1 (auto-delegates to each
  project's `packageManager`: pnpm 10.33.0 / pnpm 11.7.0), Python 3.11.15,
  git, npm. **Bun is NOT installed** on this host.
- Imported trees (untouched): `OpenBot-main/`, `OpenMausBot-main/`,
  `deepseek-harness-master/`

---

## 1. Project summaries

### `OpenBot-main/` — control plane / computer / security donor

| Field | Value |
|---|---|
| License | MIT (Copyright (c) 2026 CopilotKit) |
| Package manager | **Bun** (`packageManager: bun@1.3.14`, `bun.lock`, `bunfig.toml`); Node >= 24 engines |
| Layout | Bun workspaces: `agent-bot`, `agent-computer`, `agent-langgraph`, `app`, `server`, `shared`, `supervisor`, `worker`, `spire`, `tests` |
| Build | `bun run build` (per-workspace `tsc -b` / vite builds) |
| Typecheck | `bun run typecheck` (tsc -b) |
| Lint/format | `bun run lint` / `bun run format` (Biome, `biome.json`) |
| Tests | `bun test` (bun:test; `tests/` + per-workspace `*.test.ts`) |
| Deploy | `Dockerfile`, `docker-compose.yml`, `docker/` (server + supervisor + worker + postgres + redis) |
| Entry points | `server/` (Hono API + CopilotKit runtime + admin UI), `supervisor/` (per-bot computer containers), `worker/` (computer lifecycle), `app/` (React/Vite web UI), `agent-*` (AG-UI example agents) |
| Key deps | CopilotKit (`@copilotkit/*`), Hono, Drizzle ORM + Postgres, Redis, better-auth, CEL (policy), Docker/gVisor via supervisor |

### `OpenMausBot-main/` — GrokBot UX / provider / voice / device donor

| Field | Value |
|---|---|
| License | Apache-2.0 + `NOTICE` (relicensed MIT→Apache-2.0 with contributor consent) |
| Package manager | **pnpm** (`packageManager: pnpm@10.33.0`, `pnpm-lock.yaml`, single-package + `cloudflare/composio-broker` workspace); Node >= 24 |
| Build | `pnpm run build` (vite build + esbuild companion + electron builder config present) |
| Typecheck | `pnpm run typecheck` = `tsc -b && tsc -p tsconfig.server.json` |
| Lint | `pnpm run lint` = `oxlint .` (`.oxlintrc.json`, includes "anti-slop" rules) |
| Tests | `pnpm test` = `test-floor.mjs` + `broker:test` + `test:updater` + `test:packaged-server`; vitest 4 + `node --test` |
| Deploy | Electron desktop app (`electron-builder.yml`), Cloudflare Worker broker (`cloudflare/composio-broker`, wrangler), Vite web build |
| Entry points | `server/index.ts` (local HTTP server + drivers), `src/` (React chat UI), `electron/` (desktop shell), `companion/` (device companion), `cloudflare/composio-broker/` (worker) |
| Key deps | React 19, Vite 7, Electron 43, `@trycua/cua-driver` (vendored third_party), Composio (via broker), PostHog, provider CLIs driven as child processes (claude/codex/grok/gemini/kimi/droid/cursor via ACP) |

### `deepseek-harness-master/` — runtime kernel donor

| Field | Value |
|---|---|
| License | MIT (Copyright (c) 2026 DeepSeek); generated `THIRD_PARTY_NOTICES.md`; vendored MIT deps under `vendor/` |
| Package manager | **pnpm** (`packageManager: pnpm@11.7.0`, `pnpm-workspace.yaml`, 245 workspace projects); Node >= 24; Python SDK under `python/` (uv/hatch) |
| Build | `pnpm run build` (tsdown per package); `build:lib:host` = `tsc -b tsconfig.host.json && tsdown --env.DSH_BUILD_FACE host` |
| Typecheck | `pnpm run typecheck` = `build:lib:host` + `tsc -b tsconfig.client.json` ("contracts-ready") |
| Lint | `pnpm run lint` (oxlint via `scripts/run-oxlint.ts`, staged variant `lint:staged`); lefthook git hooks |
| Tests | `pnpm test` (vitest 4; unit + `test:e2e`, `test:web`, `test:snapshot`, `test:perf` configs); Python: pytest (`pytest.ini`) |
| Deploy | None required (library/CLI); `apps/cli` (`dsh`), `apps/web` (dev UI), `website/` (docs site) |
| Entry points | `packages/host` + `packages/boot` (runtime host), `packages/session` (event-sourced sessions), `packages/llm` (model adapters), `packages/sdk` (embeddable SDK), `apps/cli` (dsh CLI), `python/` (Python SDK) |
| Key deps | cordis (vendored plugin framework), node-pty (patched), koffi, zod, vitest/tsdown toolchain; `@anthropic-ai/claude-agent-sdk` payloads (special license terms — see PROVENANCE) |

---

## 2. Baseline command results (exact)

Legend: results below were produced on the baseline host with **zero Mox
modifications** to the trees. "Execution window" = the task runner kills
background processes after 10 minutes; several full-suite commands exceed it.

### OpenBot-main — **BLOCKED (toolchain unavailable)**

| Command | Result |
|---|---|
| `bun --version` | **Not runnable**: Bun is not installed. `npx --yes bun@1.3.14 --version` was attempted and the download exceeded the 10-minute execution window; the npx cache entry was left corrupted (`ENOENT ..._npx\60c3515df86f25b1\package.json`). |
| `bun install` / `bun run typecheck` / `bun run lint` / `bun test` | **Not executed** (blocked by missing Bun). |

No OpenBot baseline verdict exists yet. To produce one, install Bun 1.3+ and
run `scripts\baseline-checks.cmd openbot`.

### OpenMausBot-main

| Command | Result |
|---|---|
| `pnpm install` | **PASS** (2m 2.7s, pnpm v10.33.0, 545 packages). Warnings: ignored build scripts `core-js@3.50.0`, `workerd@1.20260811.1`. |
| `pnpm run lint` (oxlint) | **FAIL (pre-existing)**: `Found 35 warnings and 1180 errors. Finished in 10.4s on 379 files with 111 rules using 4 threads.` Exit 1. Dominated by the project's own `anti-slop` rule set (no-unknown-parameters, require-safety-comment-for-type-assertion, no-runtime-typeof, etc.) across `server/` and `src/`. |
| `pnpm run typecheck` (`tsc -b && tsc -p tsconfig.server.json`) | **PASS**, exit 0. |
| `pnpm run test:updater` (`node --test electron/updater-coordinator.node-test.mjs`) | **PASS**: 15 tests, 15 pass, 0 fail (352 ms). |
| `pnpm run broker:test` (vitest, `cloudflare/composio-broker`) | **PASS**: 1 file, 2 tests passed (4.34s). |
| `pnpm test` step 1: `node scripts/test-floor.mjs` | **INCOMPLETE — exceeds the 10-minute execution window** (killed mid-run). Partial observations before the kill: `server/index.test.ts` 67 tests / **14 failed** / 1 skipped; `server/store.test.ts` 47 tests / **46 failed**; `server/drivers/acp/acp.test.ts` 38 tests / **2 failed**; `server/drivers/claude.test.ts` 36 passed; `server/comms.test.ts` 19 passed; `companion/test/proxy.test.ts` 17 passed. Many failures are 5-second timeouts consistent with missing provider CLIs / named-pipe timing on this Windows host. **Also note:** test-floor runs vitest from the git root, so in the Mox layout it sweeps `deepseek-harness-master/` and `OpenBot-main/` specs too (most collect 0 tests without their own build artifacts). This cross-tree sweep is a layout artifact of the import, not an upstream defect. |

### deepseek-harness-master

| Command | Result |
|---|---|
| `pnpm install` | **PASS** (3m 18.1s, pnpm v11.7.0, 935 packages, 245 workspace projects; lockfile passed supply-chain policy check, 1215 entries). Warnings: `native/landlock-run` linux packages unsupported on win32 (expected); cyclic workspace dependencies (5 cycles, upstream-known); 2 `.bin` shim creation warnings for unbuilt example packages. Side effect: lefthook postinstall created a stray `lefthook.yml` at the **Mox root** (git-root detection); it was deleted and is not part of the baseline. |
| `pnpm run typecheck` | **PASS**. First attempt was killed by the 10-minute execution window during `tsc -b tsconfig.host.json`; re-run detached to completion: `build:lib:host` finished with all tsdown package builds OK and no type errors, then `tsc -b tsconfig.client.json` (contracts-ready) completed with no errors. Incremental confirmation re-run: `tsc -b tsconfig.client.json` → exit 0. Note: the full command takes well over 10 minutes on this host and must be run detached (or in two steps) to complete. |
| `pnpm run lint` | Not yet executed (requires the same heavy host build; deferred — see §4). |
| `pnpm test` | Not executed (full suite exceeds the execution window; deferred — see §4). |

---

## 3. Known baseline failures (pre-existing, before any Mox change)

1. **OpenMausBot `pnpm run lint` fails**: 1180 errors / 35 warnings from its
   own oxlint config. Pre-existing upstream state; do not "fix" as part of
   consolidation unless a ported file is being touched anyway.
2. **OpenMausBot server test failures on this host** (observed in the
   incomplete test-floor run): `server/index.test.ts` 14 failed,
   `server/store.test.ts` 46 failed, `server/drivers/acp/acp.test.ts`
   2 failed. Failure signatures are dominated by 5-second timeouts around
   provider-CLI availability and named-pipe/IPC timing on Windows Server —
   environment-sensitive tests, not code Mox changed.
3. **OpenBot baseline unverifiable on this host** until Bun 1.3+ is
   installed.
4. **deepseek-harness full typecheck/test exceed the 10-minute execution
   window** of the task runner; they complete only when run detached.
   (The typecheck itself passes when given time; the full test suite has
   not yet been run to completion.)
5. **Cross-tree test sweep**: OpenMausBot's `test-floor.mjs` (and any
   root-invoked vitest) discovers specs in sibling trees because all three
   projects share one git root. Expect 0-test collections and spurious
   failures from foreign trees until workspaces are separated.

None of the above were introduced by Mox. Any *new* failure in these
commands after Mox changes is a Mox regression.

## 4. Deferred baseline work (tracked, not forgotten)

- [ ] Install Bun 1.3+ and record the full OpenBot baseline
      (`scripts\baseline-checks.cmd openbot`).
- [ ] Run `deepseek-harness-master` `pnpm run lint` and a full `pnpm test`
      (detached, >10 min) and record exact results.
- [ ] Re-run OpenMausBot `pnpm test` to completion (detached) and record the
      full pass/fail table per file.

## 5. Mox workspace baseline (new code, verified)

The Mox packages (`packages/contracts`, `packages/events`,
`packages/provider-sdk`, `packages/adapters`, `packages/database`,
`packages/credentials`, `services/audit-service`) were verified on the
baseline host after this document was first written:

| Command | Result |
|---|---|
| `pnpm install` (root) | **PASS** (pnpm 10.15.1; 8 workspace projects). Note: an interrupted first install left `packages/database/node_modules` unlinked; `pnpm --filter @mox/database... install --force` repaired it. |
| `pnpm -r run build` | **PASS** — all 7 packages `tsc -b` clean. |
| `pnpm -r run typecheck` | **PASS** — all 7 packages (`tsc -b` + `tsc -p tsconfig.test.json`). |
| `pnpm -r run test` | **PASS** — 46 tests / 0 failures across 10 files (contracts 10, events 3, provider-sdk 5, adapters 5, database 11 [tenant 5, schema-invariants 2, cross-tenant 4], credentials 9 [secretbox 5, redact 4], audit-service 3). |
| `pnpm lint` (oxlint) | **PASS** — 0 warnings, 0 errors. |
| `pnpm test` (root vitest) | **PASS** — 10 files, 46 tests. |

Database migration baseline:

| Command | Result |
|---|---|
| `drizzle-kit generate` (`pnpm -C packages/database exec drizzle-kit generate`) | **PASS** — generated `packages/database/migrations/0000_sticky_thor_girl.sql`: 44 tables, deterministic snapshot from `src/schema/index.ts`. Committed SQL is applied by `scripts/migrate.mjs` (checksum-verified, transactional per file). |
| `db:migrate` against a live Postgres | Not executed in the baseline window (no DATABASE_URL provisioned); the runner is checksum-guarded so re-runs are idempotent. |

Fixes made while verifying (all new-code defects, not upstream changes):
circular/wrong import of `organizations` from `agents-core.js` in six schema
files (now imported from `identity-users.js`), and stray echo artifacts in
`repos.ts` / `event.ts` / `tenant.test.ts`.

These are the reference numbers for the Mox-side baseline. Any deviation in a
later step is a Mox regression.

## 6. Reproducing this baseline

Run `scripts\baseline-checks.cmd [openbot|openmausbot|deepseek|mox|all]`.
The script runs the practical install/lint/typecheck/test commands in place
and changes nothing. Results should be compared against §2 and §5; any
deviation is either environment drift or a Mox regression.
