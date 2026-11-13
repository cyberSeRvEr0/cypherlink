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
    echo [1/4] Installing Python 3...
    winget install Python.Python.3.12 --accept-package-agreements --accept-source-agreements
    if %errorlevel% neq 0 (
        echo ERROR: Install Python 3.12+ from python.org manually.
        pause
        exit /b 1
    )
    set "PATH=%LOCALAPPDATA%\Programs\Python\Python312;%LOCALAPPDATA%\Programs\Python\Python312\Scripts;%PATH%"
) else (
    echo [1/4] Python 3 found ✓
)

:: --- 2. Python dependencies ---
echo [2/4] Installing dependencies...
python -m venv .venv 2>nul
.venv\Scripts\pip install -r server\requirements.txt -q
echo       Done ✓

:: --- 3. Firewall ---
echo [3/4] Configuring firewall...
netsh advfirewall firewall add rule name="Cypherlink Web" dir=in action=allow protocol=TCP localport=3000 >nul 2>&1
netsh advfirewall firewall add rule name="Cypherlink Signal" dir=in action=allow protocol=TCP localport=9001 >nul 2>&1
echo       Firewall rules added ✓

:: --- 4. Start everything ---
echo [4/4] Starting Cypherlink...

:: Kill previous instance
taskkill /f /fi "WINDOWTITLE eq Cypherlink*" >nul 2>&1
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3000.*LISTENING"') do taskkill /f /pid %%a >nul 2>&1
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":9001.*LISTENING"') do taskkill /f /pid %%a >nul 2>&1
timeout /t 1 /nobreak >nul

:: Start signaling server
start /b .venv\Scripts\python server\server.py
:: Start web server
start /b python -m http.server 3000 --directory web

timeout /t 2 /nobreak >nul

:: Open browser
start http://localhost:3000

echo.
echo  ══════════════════════════════════════
echo   Cypherlink is running!
echo.
echo   Web:        http://localhost:3000
echo   Signaling:  ws://localhost:9001
echo.
echo   To stop:    Close this window or run:
echo               taskkill /f /im python.exe
echo  ══════════════════════════════════════
echo.
pause   