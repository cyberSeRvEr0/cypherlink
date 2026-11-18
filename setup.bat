@echo off
setlocal
title Cypherlink Setup

echo.
echo  ╔══════════════════════════════════╗
echo  ║        CYPHERLINK SETUP          ║
echo  ╚══════════════════════════════════╝
echo.

:: --- 1. Python ---
where python >nul 2>&1
if %errorlevel% neq 0 (
    echo [1/5] Installing Python 3...
    winget install Python.Python.3.12 --accept-package-agreements --accept-source-agreements
    if %errorlevel% neq 0 (
        echo ERROR: Install Python 3.12+ from python.org manually.
        pause
        exit /b 1
    )
    set "PATH=%LOCALAPPDATA%\Programs\Python\Python312;%LOCALAPPDATA%\Programs\Python\Python312\Scripts;%PATH%"
) else (
    echo [1/5] Python 3 found ✓
)

:: --- 2. Node.js & npm ---
where npm >nul 2>&1
if %errorlevel% neq 0 (
    echo [2/5] Installing Node.js LTS...
    winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
    if %errorlevel% neq 0 (
        echo ERROR: Install Node.js 20+ from nodejs.org manually.
        pause
        exit /b 1
    )
    set "PATH=%ProgramFiles%\nodejs;%PATH%"
) else (
    echo [2/5] Node.js & npm found ✓
)

:: --- 3. Install npm packages & build bundle ---
echo [3/5] Installing dependencies and building web bundle...
if not exist "node_modules" (
    call npm install
    if %errorlevel% neq 0 (
        echo ERROR: npm install failed.
        pause
        exit /b 1
    )
)
call npm run build
if %errorlevel% neq 0 (
    echo ERROR: npm run build failed.
    pause
    exit /b 1
)
echo       Web bundle built ✓

:: --- 4. Firewall ---
echo [4/5] Configuring firewall...
netsh advfirewall firewall add rule name="Cypherlink Web" dir=in action=allow protocol=TCP localport=3000 >nul 2>&1
netsh advfirewall firewall add rule name="Cypherlink Relay" dir=in action=allow protocol=TCP localport=9090 >nul 2>&1
netsh advfirewall firewall add rule name="Cypherlink TURN" dir=in action=allow protocol=TCP localport=3478 >nul 2>&1
netsh advfirewall firewall add rule name="Cypherlink TURN UDP" dir=in action=allow protocol=UDP localport=3478 >nul 2>&1
echo       Firewall rules added ✓

:: --- 5. Start Relay & Web Server ---
echo [5/5] Starting Cypherlink Relay & Web UI...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3000.*LISTENING"') do taskkill /f /pid %%a >nul 2>&1
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":9090.*LISTENING"') do taskkill /f /pid %%a >nul 2>&1
timeout /t 1 /nobreak >nul

start /b node relay.js
timeout /t 2 /nobreak >nul

start /b python -m http.server 3000 --directory web
timeout /t 2 /nobreak >nul
start http://localhost:3000

echo.
echo  ══════════════════════════════════════
echo   Cypherlink is running!
echo.
echo   Open:  http://localhost:3000
echo   Relay: Copy the /ip4/.../ws/p2p/... address printed above
echo.
echo   To stop: Close this window
echo  ══════════════════════════════════════
echo.
pause
