# Rebuilds dependencies if needed and launches both dev servers, each in its
# own window (Ctrl+C in a window stops that server; close it or Ctrl+C to stop).
#
# Neither server needs a manual "rebuild" for ordinary code changes: uvicorn
# runs with --reload (restarts itself on backend file changes) and Vite's dev
# server hot-reloads the frontend in the browser. `uv sync` / `npm install`
# only matter when a dependency file (pyproject.toml / package.json) changed
# - this script re-runs them every time anyway, since they're fast no-ops
# when nothing changed.
#
# Usage:
#   .\dev.ps1                # sync/install deps, then launch both servers
#   .\dev.ps1 -SkipInstall   # skip uv sync / npm install, just launch

param(
    [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
$repoRoot = $PSScriptRoot

function Test-PortFree($port) {
    -not (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

function Resolve-Port($preferred, $fallback, $label) {
    $conns = Get-NetTCPConnection -LocalPort $preferred -State Listen -ErrorAction SilentlyContinue
    if (-not $conns) {
        return $preferred
    }

    $stoppedOwn = $false
    foreach ($c in $conns) {
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)" -ErrorAction SilentlyContinue
        if ($proc -and $proc.CommandLine -and ($proc.CommandLine -like "*$repoRoot*")) {
            Write-Host "[$label] Port $preferred is held by a leftover process from this repo (PID $($c.OwningProcess)) - stopping it." -ForegroundColor Yellow
            Stop-Process -Id $c.OwningProcess -Force -Confirm:$false
            $stoppedOwn = $true
        }
    }

    if ($stoppedOwn) {
        Start-Sleep -Milliseconds 500
        if (Test-PortFree $preferred) {
            return $preferred
        }
        Write-Host "[$label] Port $preferred still isn't free after stopping our own process - scanning for another." -ForegroundColor Yellow
    }

    # The fallback itself might also be taken (including by a stuck leftover
    # from a previous forcefully-killed run) - don't just assume it's free.
    if (-not (Test-PortFree $fallback)) {
        $candidate = $fallback
        for ($i = 0; $i -lt 20 -and -not (Test-PortFree $candidate); $i++) {
            $candidate++
        }
        if (-not (Test-PortFree $candidate)) {
            throw "[$label] Could not find a free port starting from $fallback after 20 tries."
        }
        Write-Host "[$label] Fallback port $fallback was also taken - using $candidate instead." -ForegroundColor Yellow
        return $candidate
    }

    Write-Host "[$label] Port $preferred is in use by something unrelated to this project - using $fallback instead." -ForegroundColor Yellow
    return $fallback
}

if (-not $SkipInstall) {
    Write-Host "==> uv sync (backend)" -ForegroundColor Cyan
    Push-Location (Join-Path $repoRoot 'backend')
    uv sync
    Pop-Location

    Write-Host "==> npm install (frontend)" -ForegroundColor Cyan
    Push-Location (Join-Path $repoRoot 'frontend')
    npm install
    Pop-Location
}

$backendPort = Resolve-Port -preferred 8000 -fallback 8002 -label 'backend'
$frontendPort = Resolve-Port -preferred 5173 -fallback 5183 -label 'frontend'

# Both ports are already resolved above, so the backend can be told the
# frontend's real origin up front - no restart-and-retry needed even when
# either port had to fall back. Set env vars on this process (not embedded
# in the child command string) so Start-Process's normal environment
# inheritance carries them across - avoids re-escaping JSON/quotes through
# a second layer of PowerShell command-line parsing.
if ($frontendPort -ne 5173) {
    $env:CORS_ORIGINS = '["http://localhost:{0}"]' -f $frontendPort
}
# --ws-ping-interval/--ws-ping-timeout: pin uvicorn's protocol-level
# keepalive on /ws/cascade explicitly (matches the providers' own socket
# settings) so a long quiet session can't be silently dropped by an idle
# proxy, and a vanished client is detected within ~40s.
$backendCmd = "cd '$repoRoot\backend'; uv run uvicorn app.main:app --reload --port $backendPort --ws-ping-interval 20 --ws-ping-timeout 20"
Start-Process powershell -ArgumentList '-NoExit', '-Command', $backendCmd

if ($backendPort -ne 8000) {
    $env:VITE_API_BASE_URL = "http://localhost:$backendPort"
}
$frontendCmd = "cd '$repoRoot\frontend'; npm run dev -- --port $frontendPort"
Start-Process powershell -ArgumentList '-NoExit', '-Command', $frontendCmd

Write-Host ""
Write-Host "Backend:  http://localhost:$backendPort  (health check: /health)" -ForegroundColor Green
Write-Host "Frontend: http://localhost:$frontendPort" -ForegroundColor Green
Write-Host "Two new windows opened - close them (or Ctrl+C inside) to stop the servers." -ForegroundColor Green
