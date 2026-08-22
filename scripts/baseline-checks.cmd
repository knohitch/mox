@echo off
REM ============================================================
REM Mox baseline checks (Step 1 - consolidation baseline)
REM
REM Runs the practical baseline lint/typecheck/test commands for
REM each imported source tree, in place, without modifying them.
REM Results are printed with PASS/FAIL per step. This script does
REM NOT repair anything; pre-existing failures are expected and
REM are recorded in docs/consolidation/BASELINE.md.
REM
REM Usage: scripts\baseline-checks.cmd [openbot|openmausbot|deepseek|mox|all]
REM ============================================================
setlocal enabledelayedexpansion
set "ROOT=%~dp0.."
set "TARGET=%~1"
if "%TARGET%"=="" set "TARGET=all"

if /i "%TARGET%"=="openbot" goto openbot
if /i "%TARGET%"=="openmausbot" goto openmausbot
if /i "%TARGET%"=="deepseek" goto deepseek
if /i "%TARGET%"=="mox" goto mox
if /i not "%TARGET%"=="all" echo Unknown target "%TARGET%" & exit /b 2

:openbot
echo ============================================================
echo [OpenBot-main] requires Bun 1.3+ (packageManager: bun@1.3.14)
echo ============================================================
where bun >nul 2>nul
if errorlevel 1 (
  echo SKIP: bun not found on PATH. Install Bun 1.3+ to run:
  echo   cd OpenBot-main ^&^& bun install
  echo   pnpm/bun run typecheck, lint, test - see OpenBot-main/package.json
  goto openmausbot
)
pushd "%ROOT%\OpenBot-main"
echo --- bun install ---
call bun install
echo --- bun run typecheck ---
call bun run typecheck
echo --- bun run lint ---
call bun run lint
echo --- bun test ---
call bun test
popd

:openmausbot
echo ============================================================
echo [OpenMausBot-main] pnpm@10.33.0, Node ^>=24
echo ============================================================
pushd "%ROOT%\OpenMausBot-main"
if not exist node_modules (
  echo --- pnpm install ---
  call pnpm install
)
echo --- pnpm run lint (oxlint) ---
call pnpm run lint
echo --- pnpm run typecheck (tsc -b ^&^& tsc -p tsconfig.server.json) ---
call pnpm run typecheck
popd
if /i "%TARGET%"=="openmausbot" goto end

:deepseek
echo ============================================================
echo [deepseek-harness-master] pnpm@11.7.0, Node ^>=24
echo ============================================================
pushd "%ROOT%\deepseek-harness-master"
if not exist node_modules (
  echo --- pnpm install ---
  call pnpm install
)
echo --- pnpm run typecheck (build:lib:host + tsc -b tsconfig.client.json) ---
call pnpm run typecheck
echo --- pnpm run lint (oxlint via scripts/run-oxlint.ts) ---
call pnpm run lint
popd
if /i "%TARGET%"=="deepseek" goto end

:mox
echo ============================================================
echo [Mox workspace] pnpm 10.x, Node ^>=24 (8 workspace projects)
echo ============================================================
pushd "%ROOT%"
echo --- pnpm -r run build ---
call pnpm -r run build
echo --- pnpm -r run typecheck ---
call pnpm -r run typecheck
echo --- pnpm -r run test ---
call pnpm -r run test
echo --- pnpm lint (oxlint) ---
call pnpm lint
popd
if /i "%TARGET%"=="mox" goto end

:end
echo ============================================================
echo Baseline run complete. Record exact results in
echo docs/consolidation/BASELINE.md. Do not fix failures here.
echo ============================================================
endlocal