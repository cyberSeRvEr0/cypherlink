#!/usr/bin/env bash
set -e

echo "╔══════════════════════════════════╗"
echo "║        CYPHERLINK SETUP          ║"
echo "╚══════════════════════════════════╝"
echo ""

# --- 1. Node.js 22+ ---
export PATH="$HOME/.local/bin:/snap/bin:$PATH"
NODE_MAJOR=$(node -v 2>/dev/null | cut -d'.' -f1 | tr -d 'v' || echo 0)
if [ "$NODE_MAJOR" -lt 22 ]; then
    echo "[1/5] Installing Node.js 22..."
    if command -v snap &>/dev/null; then
        sudo snap install node --classic > /dev/null 2>&1
        hash -r
    elif command -v brew &>/dev/null; then
        brew install node@22 > /dev/null 2>&1
    else
        echo "ERROR: Please install Node.js 22+ manually."
        exit 1
    fi
fi
echo "[1/5] Node.js $(node -v) ready ✓"

# --- 2. cloudflared ---
if ! command -v cloudflared &>/dev/null; then
    echo "[2/5] Installing cloudflared..."
    ARCH=$(uname -m)
    case "$ARCH" in
        aarch64|arm64) CLOUDFLARED_ARCH=arm64 ;;
        x86_64|amd64) CLOUDFLARED_ARCH=amd64 ;;
        *)
            echo "ERROR: Unsupported architecture for cloudflared: $ARCH"
            exit 1
            ;;
    esac
    mkdir -p "$HOME/.local/bin"
    curl --fail --location --show-error --retry 3 \
        "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$CLOUDFLARED_ARCH" \
        -o "$HOME/.local/bin/cloudflared"
    chmod +x "$HOME/.local/bin/cloudflared"
    "$HOME/.local/bin/cloudflared" --version
else
    echo "[2/5] cloudflared ready ✓"
fi

# --- 3. Build ---
echo "[3/5] Building..."
npm install --loglevel=error --no-fund --no-audit
npm run build --loglevel=error
echo "[3/5] Built ✓"

# --- 4. Ask for role ---
echo ""
echo "[4/5] What do you want to do?"
echo "      1) Create a new group (you will be the host)"
echo "      2) Join an existing group"
echo ""
read -p "      Choose 1 or 2: " ROLE

# --- 5. Launch ---
echo "[5/5] Starting..."

if [ "$ROLE" = "1" ]; then
    # HOST: start cloudflared tunnel + relay
    cloudflared tunnel --url http://localhost:9090 > /tmp/cypherlink-cf.log 2>&1 &
    CF_PID=$!
    CF_URL=""
    for attempt in {1..30}; do
        CF_URL=$(grep -Eo 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' /tmp/cypherlink-cf.log | head -1 || true)
        if [ -n "$CF_URL" ]; then
            break
        fi
        if ! kill -0 "$CF_PID" 2>/dev/null; then
            break
        fi
        sleep 1
    done

    if [ -z "$CF_URL" ]; then
        echo "ERROR: Cloudflare did not provide a tunnel URL."
        echo "       cloudflared output:"
        if [ -s /tmp/cypherlink-cf.log ]; then
            tail -n 40 /tmp/cypherlink-cf.log
        else
            echo "       (no output; cloudflared exited before writing a log)"
        fi
        kill "$CF_PID" 2>/dev/null || true
        exit 1
    fi

    CF_DOMAIN="${CF_URL#https://}"
    RELAY_PUBLIC_HOST="$CF_DOMAIN" node relay.js &
    RELAY_PID=$!
    sleep 2

    RELAY_ADDR=$(node -e "console.log(JSON.parse(require('fs').readFileSync('web/relay-config.json','utf8')).relayAddress)")

    if command -v xdg-open &>/dev/null; then
        xdg-open http://localhost:3000 > /dev/null 2>&1 || true
    elif command -v open &>/dev/null; then
        open http://localhost:3000 > /dev/null 2>&1 || true
    fi

    echo ""
    echo "══════════════════════════════════════════════"
    echo "  You are the HOST."
    echo ""
    echo "  Your relay address (send this to members):"
    echo ""
    echo "    $RELAY_ADDR"
    echo ""
    echo "  Members will paste this into the Custom Relay"
    echo "  field when they join."
    echo ""
    echo "  No port forwarding needed. No public IP needed."
    echo "  This URL is unique to this session and will"
    echo "  stop working when you close this terminal."
    echo ""
    echo "  Keep this terminal open. Close it to end the group."
    echo "  Stop early: Ctrl+C"
    echo "══════════════════════════════════════════════"
    echo ""

    wait $RELAY_PID 2>/dev/null || true
    kill $CF_PID 2>/dev/null || true
    echo ""
    echo "  Relay stopped. Group is closed."

else
    # MEMBER: start local web server, open browser
    node -e "
const http=require('http'),fs=require('fs'),path=require('path');
const MIME={'.html':'text/html','.js':'application/javascript','.css':'text/css','.json':'application/json','.png':'image/png'};
const WEB=path.resolve(process.cwd(),'web');
http.createServer((req,res)=>{
  let p=path.join(WEB,decodeURIComponent(req.url)==='/'?'index.html':decodeURIComponent(req.url));
  if(!p.startsWith(WEB)){res.writeHead(403);res.end();return}
  fs.readFile(p,(e,d)=>{if(e){res.writeHead(404);res.end();return}
  res.writeHead(200,{'Content-Type':MIME[path.extname(p)]||'application/octet-stream'});res.end(d)});
}).listen(3000,()=>console.log('  http://localhost:3000'));
" &
    WEB_PID=$!
    sleep 1

    if command -v xdg-open &>/dev/null; then
        xdg-open http://localhost:3000 > /dev/null 2>&1 || true
    elif command -v open &>/dev/null; then
        open http://localhost:3000 > /dev/null 2>&1 || true
    fi

    echo ""
    echo "══════════════════════════════════════════════"
    echo "  You are a MEMBER."
    echo ""
    echo "  Open: http://localhost:3000"
    echo ""
    echo "  Enter the group name, invite key, nickname,"
    echo "  and the relay address the host sent you."
    echo ""
    echo "  Stop: Ctrl+C"
    echo "══════════════════════════════════════════════"

    wait $WEB_PID 2>/dev/null || true
fi   