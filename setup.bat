@echo off
title Cypherlink Setup
echo.
echo  ╔══════════════════════════════════╗
echo  ║        CYIPHERLINK SETUP         ║
echo  ╚══════════════════════════════════╝
echo.

:: 1. Check Python
where python >nul 2>&1
if %errorlevel% neq 0 (
    echo [1/4] Installing Python...
    winget install Python.Python.3.12
    if %errorlevel% neq 0 (
        echo ERROR: Install Python 3.12+ from python.org manually.
        pause
        exit /b 1
    )
) else (
    echo [1/4] Python found ✓
)

:: 2. Check Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [2/4] Installing Node.js...
    winget install OpenJS.NodeJS.LTS
    if %errorlevel% neq 0 (
        echo ERROR: Install Node.js 18+ from nodejs.org manually.
        pause
        exit /b 1
    )
) else (
    echo [2/4] Node.js found ✓
)

:: 3. Install dependencies
echo [3/4] Installing dependencies...
python3 -m venv .venv
.venv/bin/pip install -r server/requirements.txt -q   
call npm install --silent
echo       Dependencies installed ✓

:: 4. Start server + open browser
echo [4/4] Starting Cypherlink...
start /b python server\server.py
timeout /t 2 /nobreak >nul
start /b python -m http.server 3000 --directory web
timeout /t 1 /nobreak >nul
start http://localhost:3000

echo.
echo  ══════════════════════════════════════
echo   Cypherlink is running!
echo   Browser: http://localhost:3000
echo   Relay:   ws://localhost:9001
echo.
echo   Close this window to stop everything.
echo  ══════════════════════════════════════
pause   