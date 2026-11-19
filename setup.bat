@echo off
setlocal
title Cypherlink Setup

echo.
echo  ╔══════════════════════════════════╗
echo  ║        CYPHERLINK SETUP          ║
echo  ╚══════════════════════════════════╝
echo.

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [1/2] Installing Node.js LTS...
    winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
    if %errorlevel% neq 0 (
        echo ERROR: Install Node.js 20+ from nodejs.org manually.
        pause
        exit /b 1
    )
    set "PATH=%ProgramFiles%\nodejs;%PATH%"
)
echo [1/2] Node.js found ✓

echo [2/2] Building...
if not exist "node_modules" (
    call npm install --no-fund --no-audit
)
call npm run build
echo [2/2] Built ✓

echo.
echo  ══════════════════════════════════════
echo   Cypherlink ready.
echo.
echo   Open: web\index.html in your browser
echo   (or: npx serve web)
echo.
echo   No server. No relay. No process.
echo   Rooms vanish when the last member leaves.
echo  ══════════════════════════════════════
echo.
pause   