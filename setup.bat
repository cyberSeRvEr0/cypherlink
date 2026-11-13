@echo off
setlocal
title Cypherlink Setup

echo.
echo  ╔══════════════════════════════════╗
echo  ║        CYIPHERLINK SETUP         ║
echo  ╚══════════════════════════════════╝
echo.

:: --- 1. Python ---
where python >nul 2>&1
if %errorlevel% neq 0 (
    echo [1/3] Installing Python 3...
    winget install Python.Python.3.12 --accept-package-agreements --accept-source-agreements
    if %errorlevel% neq 0 (
        echo ERROR: Install Python 3.12+ from python.org manually.
        pause
        exit /b 1
    )
    set "PATH=%LOCALAPPDATA%\Programs\Python\Python312;%LOCALAPPDATA%\Programs\Python\Python312\Scripts;%PATH%"
) else (
    echo [1/3] Python 3 found ✓
)

:: --- 2. Firewall ---
echo [2/3] Configuring firewall...
netsh advfirewall firewall add rule name="Cypherlink Web" dir=in action=allow protocol=TCP localport=3000 >nul 2>&1
netsh advfirewall firewall add rule name="Cypherlink TURN" dir=in action=allow protocol=TCP localport=3478 >nul 2>&1
netsh advfirewall firewall add rule name="Cypherlink TURN UDP" dir=in action=allow protocol=UDP localport=3478 >nul 2>&1
echo       Firewall rules added ✓

:: --- 3. Start ---
echo [3/3] Starting Cypherlink...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3000.*LISTENING"') do taskkill /f /pid %%a >nul 2>&1
timeout /t 1 /nobreak >nul

start /b python -m http.server 3000 --directory web
timeout /t 2 /nobreak >nul
start http://localhost:3000

echo.
echo  ══════════════════════════════════════
echo   Cypherlink is running!
echo.
echo   Open: http://localhost:3000
echo.
echo   To stop: Close this window
echo  ══════════════════════════════════════
echo.
pause   