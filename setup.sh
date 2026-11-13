#!/usr/bin/env bash
set -e

echo "╔══════════════════════════════════╗"
echo "║        CYIPHERLINK SETUP         ║"
echo "╚══════════════════════════════════╝"
echo ""

# --- 1. Check Python ---
if ! command -v python3 &>/dev/null; then
    echo "[1/4] Installing Python 3..."
    if command -v apt &>/dev/null; then
        sudo apt update && sudo apt install -y python3 python3-pip python3-venv python3-full
    elif command -v brew &>/dev/null; then
        brew install python3
    else
        echo "ERROR: Install Python 3.10+ manually."
        exit 1
    fi
else
    echo "[1/4] Python 3 found ✓"
fi

# --- 2. Install coturn (NAT traversal) ---
if ! command -v turnserver &>/dev/null; then
    echo "[2/4] Installing TURN server..."
    if command -v apt &>/dev/null; then
        sudo apt install -y coturn
    elif command -v brew &>/dev/null; then
        brew install coturn
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
    echo "[2/4] TURN server found ✓"
    sudo systemctl restart coturn 2>/dev/null || true
fi

# --- 3. Firewall ---
echo "[3/4] Configuring firewall..."
if command -v ufw &>/dev/null; then
    sudo ufw --force enable 2>/dev/null || true
    sudo ufw allow 3000/tcp 2>/dev/null || true
    sudo ufw allow 3478/tcp 2>/dev/null || true
    sudo ufw allow 3478/udp 2>/dev/null || true
    sudo ufw allow 49152:65535/udp 2>/dev/null || true
    echo "      Firewall active (default deny) ✓"
fi

# --- 4. Start ---
echo "[4/4] Starting Cypherlink..."

pkill -f "http.server 3000" 2>/dev/null || true
sleep 1

python3 -m http.server 3000 --directory web &
WEB_PID=$!

sleep 1

if command -v xdg-open &>/dev/null; then
    xdg-open http://localhost:3000
elif command -v open &>/dev/null; then
    open http://localhost:3000
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