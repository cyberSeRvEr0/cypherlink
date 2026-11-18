#!/usr/bin/env bash
set -e

echo "╔══════════════════════════════════╗"
echo "║        CYPHERLINK SETUP          ║"
echo "╚══════════════════════════════════╝"
echo ""

# --- 1. Check Python ---
if ! command -v python3 &>/dev/null; then
    echo "[1/6] Installing Python 3..."
    if command -v apt &>/dev/null; then
        sudo apt update && sudo apt install -y python3 python3-pip python3-venv python3-full
    elif command -v brew &>/dev/null; then
        brew install python3
    else
        echo "ERROR: Install Python 3.10+ manually."
        exit 1
    fi
else
    echo "[1/6] Python 3 found ✓"
fi

# --- 2. Check Node.js 22+ & npm ---
NODE_MAJOR=$(node -v 2>/dev/null | cut -d'.' -f1 | tr -d 'v' || echo 0)
if [ "$NODE_MAJOR" -lt 22 ]; then
    echo "[2/6] Installing Node.js 22 LTS..."
    if command -v apt &>/dev/null; then
        curl -fsSL https://nodesource.com | sudo -E bash - > /dev/null 2>&1
        sudo apt install -y nodejs > /dev/null 2>&1
    elif command -v brew &>/dev/null; then
        brew install node@22 > /dev/null 2>&1
    else
        echo "ERROR: Install Node.js 22+ manually from https://nodejs.org"
        exit 1
    fi
fi
echo "[2/6] Node.js $(node -v) found ✓"

# --- 3. Install npm packages & build bundle ---
echo "[3/6] Installing dependencies & building web bundle..."
if [ ! -d "node_modules" ]; then
    npm install --silent --no-fund --no-audit > /dev/null 2>&1
fi
npm run build --silent > /dev/null 2>&1
echo "      Web bundle built ✓"

# --- 4. Install coturn (mandatory) ---
if ! command -v turnserver &>/dev/null; then
    echo "[4/6] Installing TURN server..."
    if command -v apt &>/dev/null; then
        sudo apt update -qq
        sudo apt install -y coturn
        if [ $? -ne 0 ]; then
            echo ""
            echo "  ERROR: Could not install coturn."
            echo "  Run manually:  sudo apt update && sudo apt install -y coturn"
            echo "  Then re-run:   ./setup.sh"
            exit 1
        fi
    elif command -v brew &>/dev/null; then
        brew install coturn
        if [ $? -ne 0 ]; then
            echo ""
            echo "  ERROR: Could not install coturn."
            echo "  Run manually:  brew install coturn"
            echo "  Then re-run:   ./setup.sh"
            exit 1
        fi
    else
        echo ""
        echo "  ERROR: No package manager found. Install coturn manually."
        echo "  https://github.com/coturn/coturn"
        exit 1
    fi

    # Configure
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
    sudo systemctl enable coturn 2>/dev/null || true
    sudo systemctl restart coturn 2>/dev/null || true
    echo "      TURN installed ✓"
else
    echo "[4/6] TURN server found ✓"
    sudo systemctl restart coturn 2>/dev/null || true
fi   

# --- 5. Firewall ---
echo "[5/6] Configuring firewall..."
if command -v ufw &>/dev/null; then
    sudo ufw --force enable 2>/dev/null || true
    sudo ufw allow 3000/tcp 2>/dev/null || true
    sudo ufw allow 9090/tcp 2>/dev/null || true
    sudo ufw allow 3478/tcp 2>/dev/null || true
    sudo ufw allow 3478/udp 2>/dev/null || true
    sudo ufw allow 49152:65535/udp 2>/dev/null || true
    echo "      Firewall active (default deny) ✓"
fi

# --- 6. Start Relay & Web Server ---
echo "[6/6] Starting Cypherlink Relay & Web UI..."

pkill -f "http.server 3000" 2>/dev/null || true
pkill -f "node relay.js" 2>/dev/null || true
sleep 1

node relay.js &
RELAY_PID=$!

sleep 2

python3 -m http.server 3000 --directory web &
WEB_PID=$!

sleep 1

if command -v xdg-open &>/dev/null; then
    xdg-open http://localhost:3000 2>/dev/null || true
elif command -v open &>/dev/null; then
    open http://localhost:3000 2>/dev/null || true
fi

echo ""
echo "══════════════════════════════════════"
echo "  Cypherlink is running!"
echo ""
echo "  Open:  http://localhost:3000"
echo "  Relay: Copy the /ip4/.../ws/p2p/... address printed above"
echo "  TURN:  turn://localhost:3478"
echo ""
echo "  Stop:  Ctrl+C"
echo "══════════════════════════════════════"

trap "kill $WEB_PID $RELAY_PID 2>/dev/null; exit" INT TERM
wait
