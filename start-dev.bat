@echo off
setlocal enabledelayedexpansion

set "ROOT_DIR=%~dp0"
set "BACKEND_DIR=%ROOT_DIR%backend"
set "FRONTEND_DIR=%ROOT_DIR%frontend"
set "UV_EXE=uv"

echo ============================================================
echo   GGPrint - Cegep Gerald-Godin 3D Print Portal (Local Dev)
echo ============================================================
echo.

where uv >nul 2>nul
if errorlevel 1 (
    if exist "%USERPROFILE%\.local\bin\uv.exe" (
        set "UV_EXE=%USERPROFILE%\.local\bin\uv.exe"
    ) else (
        set "UV_EXE="
    )
)

where npm >nul 2>nul
if errorlevel 1 (
    if exist "C:\Program Files\nodejs\npm.cmd" (
        set "PATH=C:\Program Files\nodejs;%PATH%"
    )
)

where npm >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js / npm not found in PATH or C:\Program Files\nodejs.
    echo Please install Node.js LTS from https://nodejs.org/ and try again.
    pause
    exit /b 1
)

if not exist "%BACKEND_DIR%\.venv\Scripts\python.exe" (
    echo [Backend] Creating Python virtual environment in backend\.venv...
    pushd "%BACKEND_DIR%"
    if defined UV_EXE (
        "%UV_EXE%" venv .venv --python 3.13
        if errorlevel 1 "%UV_EXE%" venv .venv
    ) else (
        python -m venv .venv
    )
    if errorlevel 1 (
        echo [ERROR] Failed to create backend\.venv. Ensure Python 3.13+ or uv is installed.
        popd
        pause
        exit /b 1
    )
    popd
)

"%BACKEND_DIR%\.venv\Scripts\python.exe" -c "import fastapi, uvicorn, sqlalchemy, trimesh" >nul 2>nul
if errorlevel 1 (
    echo [Backend] Installing/updating Python dependencies...
    pushd "%BACKEND_DIR%"
    if defined UV_EXE (
        "%UV_EXE%" pip install --python .venv\Scripts\python.exe -e ".[dev]"
    ) else (
        .venv\Scripts\python.exe -m pip install --upgrade pip && .venv\Scripts\python.exe -m pip install -e ".[dev]"
    )
    if errorlevel 1 (
        echo [ERROR] Failed to install backend dependencies.
        popd
        pause
        exit /b 1
    )
    popd
)

if not exist "%FRONTEND_DIR%\node_modules" (
    echo [Frontend] Installing npm dependencies...
    pushd "%FRONTEND_DIR%"
    call npm install
    if errorlevel 1 (
        echo [ERROR] Failed to install frontend dependencies.
        popd
        pause
        exit /b 1
    )
    popd
)

if not defined DEV_SEED set "DEV_SEED=true"

echo [Backend] Starting FastAPI on http://127.0.0.1:8000 ...
start "GGPrint Backend (FastAPI :8000)" cmd /k "cd /d ""%BACKEND_DIR%"" && set DEV_SEED=%DEV_SEED% && .venv\Scripts\uvicorn.exe app.main:app --reload --host 127.0.0.1 --port 8000"

echo [Frontend] Starting Vite on http://localhost:5173 ...
start "GGPrint Frontend (Vite :5173)" cmd /k "cd /d ""%FRONTEND_DIR%"" && npm run dev -- --port 5173"

echo.
echo   Frontend URL : http://localhost:5173
echo   Backend API  : http://127.0.0.1:8000/docs
echo   Demo Admin   : DA 0000001 / admin123
echo   Demo Student : DA 2345678 / student123
echo   New DA Reg.  : 2333572 (unclaimed whitelist)
echo.

timeout /t 3 /nobreak >nul
start "" "http://localhost:5173"

echo Servers launched in separate windows. Close those windows to stop them.
endlocal
