<#
.SYNOPSIS
    Starts the GGPrint local development stack (FastAPI backend + Vite frontend).
.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\start-dev.ps1
#>

$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$BackendDir = Join-Path $RootDir "backend"
$FrontendDir = Join-Path $RootDir "frontend"

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  GGPrint - Cegep Gerald-Godin 3D Print Portal (Local Dev)" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan

# Ensure Node.js is on PATH if installed in default location (use npm.cmd to bypass Restricted ExecutionPolicy on npm.ps1)
$NpmCmdObj = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $NpmCmdObj) {
    $DefaultNodeDir = "C:\Program Files\nodejs"
    if (Test-Path (Join-Path $DefaultNodeDir "npm.cmd")) {
        $env:Path = "$DefaultNodeDir;$env:Path"
        $NpmCmdObj = Get-Command npm.cmd -ErrorAction Stop
    } else {
        throw "Node.js / npm.cmd not found. Install Node.js LTS from https://nodejs.org/."
    }
}
$NpmCmd = $NpmCmdObj.Source

# Locate uv if installed
$UvCmd = Get-Command uv -ErrorAction SilentlyContinue
if (-not $UvCmd) {
    $LocalUv = Join-Path $env:USERPROFILE ".local\bin\uv.exe"
    if (Test-Path $LocalUv) {
        $UvExe = $LocalUv
    } else {
        $UvExe = $null
    }
} else {
    $UvExe = $UvCmd.Source
}

$VenvPython = Join-Path $BackendDir ".venv\Scripts\python.exe"
$VenvUvicorn = Join-Path $BackendDir ".venv\Scripts\uvicorn.exe"

if (-not (Test-Path $VenvPython)) {
    Write-Host "[Backend] Creating virtual environment in backend\.venv..." -ForegroundColor Yellow
    Push-Location $BackendDir
    try {
        if ($UvExe) {
            & $UvExe venv .venv --python 3.13
            if ($LASTEXITCODE -ne 0) { & $UvExe venv .venv }
        } else {
            python -m venv .venv
        }
        if ($LASTEXITCODE -ne 0) { throw "Failed to create backend\.venv." }
    } finally {
        Pop-Location
    }
}

$DepsOk = $true
try {
    & $VenvPython -c "import fastapi, uvicorn, sqlalchemy, trimesh" 2>$null
    if ($LASTEXITCODE -ne 0) { $DepsOk = $false }
} catch {
    $DepsOk = $false
}

if (-not $DepsOk) {
    Write-Host "[Backend] Installing/updating Python dependencies..." -ForegroundColor Yellow
    Push-Location $BackendDir
    try {
        if ($UvExe) {
            & $UvExe pip install --python $VenvPython -e ".[dev]"
        } else {
            & $VenvPython -m pip install --upgrade pip
            & $VenvPython -m pip install -e ".[dev]"
        }
        if ($LASTEXITCODE -ne 0) { throw "Failed to install backend dependencies." }
    } finally {
        Pop-Location
    }
}

if (-not (Test-Path (Join-Path $FrontendDir "node_modules"))) {
    Write-Host "[Frontend] Installing npm dependencies..." -ForegroundColor Yellow
    Push-Location $FrontendDir
    try {
        & $NpmCmd install
        if ($LASTEXITCODE -ne 0) { throw "Failed to install frontend dependencies." }
    } finally {
        Pop-Location
    }
}

if (-not $env:DEV_SEED) {
    $env:DEV_SEED = "true"
}

Write-Host "[Backend]  Starting FastAPI on http://127.0.0.1:8000 ..." -ForegroundColor Green
$BackendProc = Start-Process -FilePath $VenvUvicorn `
    -ArgumentList "app.main:app", "--reload", "--host", "127.0.0.1", "--port", "8000" `
    -WorkingDirectory $BackendDir `
    -NoNewWindow -PassThru

Write-Host "[Frontend] Starting Vite on http://localhost:5173 ..." -ForegroundColor Green
$FrontendProc = Start-Process -FilePath $NpmCmd `
    -ArgumentList "run", "dev", "--", "--port", "5173" `
    -WorkingDirectory $FrontendDir `
    -NoNewWindow -PassThru

Write-Host ""
Write-Host "  Frontend URL : http://localhost:5173" -ForegroundColor Cyan
Write-Host "  Backend API  : http://127.0.0.1:8000/docs" -ForegroundColor Cyan
Write-Host "  Demo Admin   : DA 0000001 / admin123"
Write-Host "  Demo Student : DA 2345678 / student123"
Write-Host "  New DA Reg.  : 2333572 (unclaimed whitelist)"
Write-Host "  Press Ctrl+C to stop both servers." -ForegroundColor DarkGray
Write-Host ""

Start-Sleep -Seconds 3
Start-Process "http://localhost:5173"

try {
    while (-not $BackendProc.HasExited -and -not $FrontendProc.HasExited) {
        Start-Sleep -Milliseconds 500
    }
} finally {
    Write-Host "`nStopping GGPrint dev servers..." -ForegroundColor Yellow
    if ($BackendProc -and -not $BackendProc.HasExited) {
        Stop-Process -Id $BackendProc.Id -Force -ErrorAction SilentlyContinue
    }
    if ($FrontendProc -and -not $FrontendProc.HasExited) {
        Stop-Process -Id $FrontendProc.Id -Force -ErrorAction SilentlyContinue
    }
}
