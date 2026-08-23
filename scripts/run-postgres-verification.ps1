# Prompt 00B Â§H â€” real PostgreSQL verification against a fresh, disposable
# cluster. Provisions a private initdb instance on port 5433 (trust auth,
# loopback only), applies ALL migrations to an empty database, runs the
# PG-gated suites, then shuts everything down and removes the data dir.
#
# Usage:  powershell -File scripts\run-postgres-verification.ps1
#         powershell -File scripts\run-postgres-verification.ps1 -KeepData

param(
    [switch]$KeepData
)

$ErrorActionPreference = "Stop"

$pgBin = Split-Path -Parent (Get-Command psql).Source
# Pick a FREE ephemeral port: other local clusters may already occupy 5433.
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = $listener.LocalEndpoint.Port
$listener.Stop()
$dataDir = Join-Path $env:TEMP ("mox-pgverify-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
$logFile = Join-Path $dataDir "pg.log"
$pwFile = Join-Path $env:TEMP "mox-pgverify-pw.txt"

Write-Host "== Prompt 00B/00C PostgreSQL verification =="
Write-Host "bin:      $pgBin"
Write-Host "port:     $port"
Write-Host "data dir: $dataDir"

try {
    # 1. Fresh disposable cluster (empty DB, superuser postgres/postgres).
    Set-Content -Path $pwFile -Value "postgres" -NoNewline -Encoding ASCII
    & (Join-Path $pgBin "initdb.exe") -D $dataDir -U postgres --pwfile=$pwFile -E UTF8 -A trust | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "initdb failed" }

    & (Join-Path $pgBin "pg_ctl.exe") -D $dataDir -o "-p $port -c listen_addresses=127.0.0.1" -l $logFile start
    if ($LASTEXITCODE -ne 0) { throw "pg_ctl start failed (see $logFile)" }

    # Wait for readiness.
    $ready = $false
    for ($i = 0; $i -lt 30 -and -not $ready; $i++) {
        & (Join-Path $pgBin "pg_isready.exe") -h 127.0.0.1 -p $port | Out-Null
        $ready = ($LASTEXITCODE -eq 0)
        if (-not $ready) { Start-Sleep -Milliseconds 500 }
    }
    if (-not $ready) { throw "cluster never became ready" }

    $env:PGPASSWORD = "postgres"
    $psql = Join-Path $pgBin "psql.exe"
    $baseUrl = "postgresql://postgres@127.0.0.1:${port}"

    # 2. Empty business database + migrations applied through current head.
    & $psql -h 127.0.0.1 -p $port -U postgres -c "DROP DATABASE IF EXISTS mox_verify;" -c "CREATE DATABASE mox_verify;" | Out-Null
    $env:DATABASE_URL = "$baseUrl/mox_verify"
    Write-Host "`n== applying migrations to empty mox_verify =="
    node packages/database/scripts/migrate.mjs
    if ($LASTEXITCODE -ne 0) { throw "migrations failed" }

    # 3. PG-gated suites: restart/idempotency + auth/security integration.
    Write-Host "`n== running PostgreSQL-gated suites =="
    $env:MOX_TEST_DATABASE_URL = "$baseUrl/mox_verify"
    Push-Location services/control-plane
    try {
        npx vitest run tests/restart.test.ts tests/auth-integration.test.ts
        if ($LASTEXITCODE -ne 0) { throw "PG-gated suites failed" }
    } finally {
        Pop-Location
    }

    # 4. Upgrade drill: pre-0006 schema + legacy rows -> apply 0006+0007 ->
    #    history preserved. Implemented as a script for precise SQL control.
    Write-Host "`n== pre-0006 -> current upgrade drill =="
    $env:UPGRADE_BASE_URL = $baseUrl
    node packages/database/scripts/pg-upgrade-drill.mjs
    if ($LASTEXITCODE -ne 0) { throw "upgrade drill failed" }

    Write-Host "`nPASS: real PostgreSQL verification completed."
} finally {
    Remove-Item Env:MOX_TEST_DATABASE_URL -ErrorAction SilentlyContinue
    Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
    Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
    & (Join-Path $pgBin "pg_ctl.exe") -D $dataDir stop 2>$null | Out-Null
    if (-not $KeepData) {
        Start-Sleep -Milliseconds 800
        Remove-Item -Recurse -Force $dataDir -ErrorAction SilentlyContinue
        Remove-Item -Force $pwFile -ErrorAction SilentlyContinue
    }
}
