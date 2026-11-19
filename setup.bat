@echo off
setlocal
title Cypherlink Setup

echo.
echo  ╔══════════════════════════════════╗
echo  ║        CYPHERLINK SETUP          ║
echo  ╚══════════════════════════════════╝
echo.

:: --- 1. Node.js ---
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [1/5] Installing Node.js LTS...
    winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
    if %errorlevel% neq 0 (
        echo ERROR: Install Node.js 20+ from nodejs.org manually.
        pause
        exit /b 1
    )
    set "PATH=%ProgramFiles%\nodejs;%PATH%"
)
echo [1/5] Node.js found ✓

:: --- 2. cloudflared ---
where cloudflared >nul 2>&1
if %errorlevel% neq 0 (
    echo [2/5] Installing cloudflared...
    curl -sL -o "%LOCALAPPDATA%\cloudflared.exe" https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe
    set "PATH=%LOCALAPPDATA%;%PATH%"
) else (
    echo [2/5] cloudflared ready ✓
)

:: --- 3. Build ---
echo [3/5] Building...
if not exist "node_modules" (
    call npm install --no-fund --no-audit
)
call npm run build
echo [3/5] Built ✓

:: --- 4. Ask for role ---
echo.
echo [4/5] What do you want to do?
echo       1) Create a new group (you will be the host)
echo       2) Join an existing group
echo.
set /p ROLE="      Choose 1 or 2: "

:: --- 5. Launch ---
echo [5/5] Starting...

if "%ROLE%"=="1" (
    :: HOST: start cloudflared tunnel + relay
    start /b cloudflared tunnel --url http://localhost:9090 > "%TEMP%\cypherlink-cf.log" 2>&1
    timeout /t 4 /nobreak >nul

    for /f "tokens=*" %%a in ('findstr /o "trycloudflare.com" "%TEMP%\cypherlink-cf.log" 2^>nul') do (
        set "CF_FOUND=%%a"
    )

    for /f "delims=" %%a in ('powershell -command "(Select-String -Path '%TEMP%\cypherlink-cf.log' -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com').Matches.Value | Select-Object -First 1"') do set "CF_URL=%%a"

    if not defined CF_URL (
        echo ERROR: Cloudflare tunnel failed to start.
        echo        Check %TEMP%\cypherlink-cf.log for details.
        pause
        exit /b 1
    )

    set "CF_DOMAIN=%CF_URL:https://=%"
    set "RELAY_PUBLIC_HOST=%CF_DOMAIN%"
    start /b node relay.js
    timeout /t 2 /nobreak >nul

    for /f "delims=" %%a in ('node -e "console.log(JSON.parse(require('fs').readFileSync('web/relay-config.json','utf8')).relayAddress)"') do set "RELAY_ADDR=%%a"

    start http://localhost:3000

    echo.
    echo  ══════════════════════════════════════════════════
    echo   You are the HOST.
    echo.
    echo   Your relay address (send this to members):
    echo.
    echo     %RELAY_ADDR%
    echo.
    echo   Members will paste this into the Custom Relay
    echo   field when they join.
    echo.
    echo   No port forwarding needed. No public IP needed.
    echo   This URL is unique to this session and will
    echo   stop working when you close this window.
    echo.
    echo   Keep this window open. Close it to end the group.
    echo   Stop early: Close this window
    echo  ══════════════════════════════════════════════════
    echo.

    :waitloop
    netstat -aon 2>nul | findstr ":9090.*LISTENING" >nul
    if %errorlevel% equ 0 (
        timeout /t 5 /nobreak >nul
        goto waitloop
    )

    echo.
    echo   Relay stopped. Group is closed.
    pause
) else (
    :: MEMBER: start local web server, open browser
    start /b node -e "const http=require('http'),fs=require('fs'),path=require('path');const MIME={'.html':'text/html','.js':'application/javascript','.css':'text/css','.json':'application/json'};const WEB=path.resolve(process.cwd(),'web');http.createServer((req,res)=>{let p=path.join(WEB,decodeURIComponent(req.url)==='/'?'index.html':decodeURIComponent(req.url));if(!p.startsWith(WEB)){res.writeHead(403);res.end();return}fs.readFile(p,(e,d)=>{if(e){res.writeHead(404);res.end();return}res.writeHead(200,{'Content-Type':MIME[path.extname(p)]||'application/octet-stream'});res.end(d)});}).listen(3000,()=>console.log('  http://localhost:3000'))"
    timeout /t 2 /nobreak >nul
    start http://localhost:3000

    echo.
    echo  ══════════════════════════════════════════════════
    echo   You are a MEMBER.
    echo.
    echo   Open: http://localhost:3000
    echo.
    echo   Enter the group name, invite key, nickname,
    echo   and the relay address the host sent you.
    echo.
    echo   Stop: Close this window
    echo  ══════════════════════════════════════════════════
    echo.
    pause
)   