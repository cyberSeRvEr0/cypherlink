@echo off
setlocal
title Cypherlink Setup

cd /d "%~dp0"

echo.
echo  ==================================
echo         CYPHERLINK SETUP
echo  ==================================
echo.

if not exist "web\index.html" (
    echo ERROR: web\index.html was not found.
    echo Put index.html and style.css in the web folder.
    pause
    exit /b 1
)

if not exist "web\app.js" (
    echo ERROR: web\app.js was not found.
    pause
    exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js and npm are required to build Cypherlink.
    echo Install Node.js, then run this file again.
    pause
    exit /b 1
)

where python >nul 2>&1
if errorlevel 1 (
    echo ERROR: Python is required to serve the web app locally.
    echo Install Python 3, then run this file again.
    pause
    exit /b 1
)

echo Installing project dependencies...
call npm install
if errorlevel 1 (
    echo ERROR: npm install failed.
    pause
    exit /b 1
)

echo.
echo Building Cypherlink...
call npm run build
if errorlevel 1 (
    echo ERROR: Build failed.
    pause
    exit /b 1
)

echo.
echo Starting local web server at http://localhost:3000
start "" http://localhost:3000

echo.
echo Press Ctrl+C in this window to stop the server.
echo.
python -m http.server 3000 --bind 127.0.0.1 --directory web

echo.
echo Cypherlink server stopped.
pause
