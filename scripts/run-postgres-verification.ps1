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

function Get-MissingPostgresExecutables {
    param(
        [Parameter(Mandatory = $true)][string]$Candidate,
        [Parameter(Mandatory = $true)][string[]]$Required
    )
    if (-not $Candidate -or -not (Test-Path -LiteralPath $Candidate -PathType Container)) {
        return $Required
    }
    $missing = @()
    foreach ($exe in $Required) {
        if (-not (Test-Path -LiteralPath (Join-Path $Candidate $exe) -PathType Leaf)) {
            $missing += $exe
        }
    }
    return $missing
}

function Resolve-PostgresBin {
    $required = @("psql.exe", "initdb.exe", "pg_ctl.exe", "pg_isready.exe")
    $inspected = New-Object System.Collections.Generic.List[string]
    $pgBinValue = $env:PGBIN
    $pathPsql = Get-Command psql -ErrorAction SilentlyContinue

    $tryCandidate = {
        param([string]$Candidate)
        if (-not $Candidate) { return $null }
        $expanded = [Environment]::ExpandEnvironmentVariables($Candidate.Trim('"'))
        $inspected.Add($expanded)
        $missing = @(Get-MissingPostgresExecutables -Candidate $expanded -Required $required)
        if ($missing.Count -eq 0) {
            return (Resolve-Path -LiteralPath $expanded).Path
        }
        return $null
    }

    $resolved = & $tryCandidate $pgBinValue
    if ($resolved) { return $resolved }

    if ($pathPsql) {
        $resolved = & $tryCandidate (Split-Path -Parent $pathPsql.Source)
        if ($resolved) { return $resolved }
    }

    $programRoots = @(
        $env:ProgramFiles,
        [Environment]::GetEnvironmentVariable("ProgramW6432"),
        [Environment]::GetEnvironmentVariable("ProgramFiles(x86)")
    ) | Where-Object { $_ } | Select-Object -Unique

    $installedCandidates = @()
    foreach ($root in $programRoots) {
        $postgresRoot = Join-Path $root "PostgreSQL"
        $inspected.Add($postgresRoot)
        if (-not (Test-Path -LiteralPath $postgresRoot -PathType Container)) { continue }
        $installedCandidates += Get-ChildItem -LiteralPath $postgresRoot -Directory -ErrorAction SilentlyContinue |
            ForEach-Object {
                [pscustomobject]@{
                    Path = Join-Path $_.FullName "bin"
                    Version = if ($_.Name -match '^\d+(\.\d+)?$') { [version]$_.Name } else { [version]"0.0" }
                }
            }
    }

    foreach ($candidate in ($installedCandidates | Sort-Object Version -Descending)) {
        $resolved = & $tryCandidate $candidate.Path
        if ($resolved) { return $resolved }
    }

    $diagnostic = New-Object System.Collections.Generic.List[string]
    $diagnostic.Add("PostgreSQL binaries were not found.")
    $diagnostic.Add("PGBIN: " + ($(if ($pgBinValue) { $pgBinValue } else { "<unset>" })))
    $diagnostic.Add("psql on PATH: " + ($(if ($pathPsql) { $pathPsql.Source } else { "no" })))
    $diagnostic.Add("paths inspected:")
    foreach ($path in ($inspected | Select-Object -Unique)) {
        $missing = @(Get-MissingPostgresExecutables -Candidate $path -Required $required)
        $diagnostic.Add("  - ${path} (missing: " + ($(if ($missing.Count -eq 0) { "<none>" } else { $missing -join ", " })) + ")")
    }
    $diagnostic.Add("Required executables: " + ($required -join ", "))
    throw ($diagnostic -join [Environment]::NewLine)
}

$pgBin = Resolve-PostgresBin
$env:PATH = "$pgBin;$env:PATH"
$psql = Join-Path $pgBin "psql.exe"
$initdb = Join-Path $pgBin "initdb.exe"
$pgCtl = Join-Path $pgBin "pg_ctl.exe"
$pgIsReady = Join-Path $pgBin "pg_isready.exe"

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
    & $initdb -D $dataDir -U postgres --pwfile=$pwFile -E UTF8 -A trust | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "initdb failed" }

    & $pgCtl -D $dataDir -o "-p $port -c listen_addresses=127.0.0.1" -l $logFile start
    if ($LASTEXITCODE -ne 0) { throw "pg_ctl start failed (see $logFile)" }

    # Wait for readiness.
    $ready = $false
    for ($i = 0; $i -lt 30 -and -not $ready; $i++) {
        & $pgIsReady -h 127.0.0.1 -p $port | Out-Null
        $ready = ($LASTEXITCODE -eq 0)
        if (-not $ready) { Start-Sleep -Milliseconds 500 }
    }
    if (-not $ready) { throw "cluster never became ready" }

    $env:PGPASSWORD = "postgres"
    $baseUrl = "postgresql://postgres@127.0.0.1:${port}"

    # 2. Empty business database + migrations applied through current head.
    & $psql -h 127.0.0.1 -p $port -U postgres -c "DROP DATABASE IF EXISTS mox_verify;" -c "CREATE DATABASE mox_verify;" | Out-Null
    $env:DATABASE_URL = "$baseUrl/mox_verify"
    Write-Host "`n== applying migrations to empty mox_verify =="
    node packages/database/scripts/migrate.mjs
    if ($LASTEXITCODE -ne 0) { throw "migrations failed" }

    # 3. PG-gated suites: restart/idempotency + auth/security integration +
    #    Security Repair 05B distributed-hardening races + retained-branch
    #    rescue (credential authority isolation + billing seed idempotency).
    Write-Host "`n== running PostgreSQL-gated suites =="
    $env:MOX_TEST_DATABASE_URL = "$baseUrl/mox_verify"
    Push-Location services/control-plane
    try {
        npx vitest run tests/restart.test.ts tests/auth-integration.test.ts tests/security-repair-05b.test.ts tests/security-repair-07.test.ts tests/rescue-postgres.test.ts
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
    if ($pgCtl -and $dataDir -and (Test-Path -LiteralPath $dataDir -PathType Container)) {
        & $pgCtl -D $dataDir stop 2>$null | Out-Null
    }
    if (-not $KeepData) {
        Start-Sleep -Milliseconds 800
        if ($dataDir) {
            Remove-Item -Recurse -Force $dataDir -ErrorAction SilentlyContinue
        }
        Remove-Item -Force $pwFile -ErrorAction SilentlyContinue
    }
}
