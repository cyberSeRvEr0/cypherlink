#!/usr/bin/env bash
set -e

echo "╔══════════════════════════════════╗"
echo "║        CYPHERLINK SETUP          ║"
echo "╚══════════════════════════════════╝"
echo ""

# --- 1. Python 3 ---
if ! command -v python3 &>/dev/null; then
    echo "[1/5] Installing Python 3..."
    sudo apt-get update -qq && sudo apt-get install -y -qq python3 > /dev/null 2>&1
fi
echo "[1/5] Python 3 ready ✓"

# --- 2. Node.js 22+ & npm ---
NODE_MAJOR=$(node -v 2>/dev/null | cut -d'.' -f1 | tr -d 'v' || echo 0)
if [ "$NODE_MAJOR" -lt 22 ]; then
    echo "[2/5] Installing Node.js 22..."
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
echo "[2/5] Node.js $(node -v) ready ✓"

# --- 3. Dependencies & Bundle (Silent) ---
echo "[3/5] Preparing application..."
if [ ! -d "node_modules" ]; then
    npm install --silent --no-fund --no-audit > /dev/null 2>&1
fi
npm run build --silent > /dev/null 2>&1
echo "[3/5] Application built ✓"

# --- 4. TURN Server (Silent) ---
if ! command -v turnserver &>/dev/null; then
    echo "[4/5] Installing TURN server..."
    sudo apt-get update -qq && sudo apt-get install -y -qq coturn > /dev/null 2>&1
    sudo tee /etc/turnserver.conf > /dev/null << 'TURNCONF'
listening-ip=0.0.0.0
listening-port=3478
min-port=49152
max-port=65535
fingerprint
no-multicast-peers
no-loopback-peers
no-cli
no-stdout-log
no-timestamp-log
use-auth-secret
static-auth-secret=cypherlink123
realm=cypherlink.local
TURNCONF
    echo "TURNSERVER_ENABLED=1" | sudo tee /etc/default/coturn > /dev/null 2>&1 || true
    sudo systemctl enable coturn > /dev/null 2>&1 || true
fi
sudo systemctl restart coturn > /dev/null 2>&1 || true
echo "[4/5] TURN server ready ✓"

# --- 5. Firewall & Launch (Silent) ---
if command -v ufw &>/dev/null; then
    sudo ufw --force enable > /dev/null 2>&1 || true
    sudo ufw allow 3000/tcp > /dev/null 2>&1 || true
    sudo ufw allow 9090/tcp > /dev/null 2>&1 || true
    sudo ufw allow 3478/tcp > /dev/null 2>&1 || true
    sudo ufw allow 3478/udp > /dev/null 2>&1 || true
    sudo ufw allow 49152:65535/udp > /dev/null 2>&1 || true
fi
echo "[5/5] Firewall & server ready ✓"

pkill -f "http.server 3000" > /dev/null 2>&1 || true
sleep 1

python3 -m http.server 3000 --directory web > /dev/null 2>&1 &
WEB_PID=$!
sleep 1

if command -v xdg-open &>/dev/null; then
    xdg-open http://localhost:3000 > /dev/null 2>&1 || true
elif command -v open &>/dev/null; then
    open http://localhost:3000 > /dev/null 2>&1 || true
fi

echo ""
echo "══════════════════════════════════════"
echo "  Cypherlink is running!"
echo ""
echo "  Open: http://localhost:3000"
echo "  TURN: turn://localhost:3478"
echo ""
echo "  Stop: Ctrl+C"
echo "══════════════════════════════════════"

trap "kill $WEB_PID 2>/dev/null; exit" INT TERM
wait
