@echo off
setlocal enabledelayedexpansion

set "ROOT_DIR=%~dp0"
set "BACKEND_DIR=%ROOT_DIR%backend"
set "FRONTEND_DIR=%ROOT_DIR%frontend"
set "UV_EXE=uv"

echo ============================================================
echo   Print-Web - 3D Print Lab 3D Print Portal (Local Dev)
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

set "REQUESTED_BACKEND_PORT=8000"
if defined BACKEND_PORT set "REQUESTED_BACKEND_PORT=%BACKEND_PORT%"
if not defined REUSE_BACKEND set "REUSE_BACKEND=0"

if "%REUSE_BACKEND%"=="1" (
    for /f "usebackq delims=" %%r in (`node -e "const http=require('http');const req=http.get('http://127.0.0.1:'+process.argv[1]+'/api/health',res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>console.log(d.includes('print-web-backend')?'REUSE':'NO'));});req.on('error',()=>console.log('NO'));req.setTimeout(1500,()=>{req.destroy();console.log('NO');});" %REQUESTED_BACKEND_PORT%`) do (
        if "%%r"=="REUSE" (
            set "BACKEND_PORT=%REQUESTED_BACKEND_PORT%"
            echo [Backend] Print-Web FastAPI is already running on http://127.0.0.1:%REQUESTED_BACKEND_PORT% ^(REUSE_BACKEND=1^).
            goto :backend_port_ready
        )
    )
    set "REUSE_BACKEND=0"
)

REM If an old Print-Web backend is still holding REQUESTED_BACKEND_PORT, try stopping it first so a fresh console opens cleanly.
for /f "usebackq delims=" %%r in (`node -e "const http=require('http');const req=http.get('http://127.0.0.1:'+process.argv[1]+'/api/health',res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>console.log(d.includes('print-web-backend')?'OLD_PRINT_WEB':'NO'));});req.on('error',()=>console.log('NO'));req.setTimeout(1000,()=>{req.destroy();console.log('NO');});" %REQUESTED_BACKEND_PORT%`) do (
    if "%%r"=="OLD_PRINT_WEB" (
        echo [Backend] Found an existing Print-Web backend on port %REQUESTED_BACKEND_PORT%; attempting to stop it for a fresh console...
        for /f "tokens=5" %%a in ('netstat -ano ^| findstr /R /C:":%REQUESTED_BACKEND_PORT% .*LISTENING"') do (
            taskkill /F /T /PID %%a >nul 2>nul
        )
        timeout /t 1 /nobreak >nul
    )
)

for /f "usebackq delims=" %%p in (`node -e "const net=require('net');const list=[Number(process.argv[1]),8000,8001,8081,0];(function next(i){const p=list[i];const s=net.createServer();s.once('error',()=>next(i+1));s.once('listening',()=>{const a=s.address().port;s.close(()=>console.log(a));});s.listen(p,'127.0.0.1');})(0);" %REQUESTED_BACKEND_PORT%`) do set "BACKEND_PORT=%%p"
if not "%BACKEND_PORT%"=="%REQUESTED_BACKEND_PORT%" (
    echo [Backend] Port %REQUESTED_BACKEND_PORT% is still in use ^(e.g. Docker or elevated process^), launching fresh Backend console on port %BACKEND_PORT% instead.
)
:backend_port_ready

set "REQUESTED_FRONTEND_PORT=5173"
if defined FRONTEND_PORT set "REQUESTED_FRONTEND_PORT=%FRONTEND_PORT%"
for /f "usebackq delims=" %%p in (`node -e "const net=require('net');const list=[Number(process.argv[1]),5173,4173,5500,5273,8080,0];(function next(i){const p=list[i];const s=net.createServer();s.once('error',()=>next(i+1));s.once('listening',()=>{const a=s.address().port;s.close(()=>console.log(a));});s.listen(p,'127.0.0.1');})(0);" %REQUESTED_FRONTEND_PORT%`) do set "FRONTEND_PORT=%%p"
if not "%FRONTEND_PORT%"=="%REQUESTED_FRONTEND_PORT%" (
    echo [Frontend] Port %REQUESTED_FRONTEND_PORT% unavailable ^(in use or Windows-reserved^), using port %FRONTEND_PORT% instead.
)

if "%REUSE_BACKEND%"=="0" (
    echo [Backend] Starting FastAPI on http://127.0.0.1:%BACKEND_PORT% ...
    start "Print-Web Backend (FastAPI :%BACKEND_PORT%)" cmd /k "cd /d ""%BACKEND_DIR%"" && set ""DEV_SEED=%DEV_SEED%"" && .venv\Scripts\uvicorn.exe app.main:app --reload --host 127.0.0.1 --port %BACKEND_PORT%"
)

echo [Frontend] Starting Vite on http://127.0.0.1:%FRONTEND_PORT% ...
start "Print-Web Frontend (Vite :%FRONTEND_PORT%)" cmd /k "cd /d ""%FRONTEND_DIR%"" && set ""VITE_API_TARGET=http://127.0.0.1:%BACKEND_PORT%"" && set ""FRONTEND_PORT=%FRONTEND_PORT%"" && npm run dev -- --host 127.0.0.1 --port %FRONTEND_PORT%"

echo.
echo   Frontend URL : http://127.0.0.1:%FRONTEND_PORT%
echo   Backend API  : http://127.0.0.1:%BACKEND_PORT%/docs
echo   Demo Admin   : DA 0000001 / admin123
echo   Demo Student : DA 2345678 / student123
echo   New DA Reg.  : 2333572 (unclaimed whitelist)
echo.

timeout /t 3 /nobreak >nul
start "" "http://127.0.0.1:%FRONTEND_PORT%"

echo Servers launched in separate windows. Close those windows to stop them.
endlocal
