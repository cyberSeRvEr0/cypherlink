#!/usr/bin/env bash
set -e

echo "╔══════════════════════════════════╗"
echo "║        CYIPHERLINK SETUP         ║"
echo "╚══════════════════════════════════╝"
echo ""

# --- 1. Check Python ---
if ! command -v python3 &>/dev/null; then
    echo "[1/3] Installing Python 3..."
    if command -v apt &>/dev/null; then
        sudo apt update && sudo apt install -y python3 python3-pip python3-venv python3-full
    elif command -v brew &>/dev/null; then
        brew install python3
    else
        echo "ERROR: Install Python 3.10+ manually."
        exit 1
    fi
else
    echo "[1/3] Python 3 found ✓"
fi

# --- 2. Install dependencies ---
echo "[2/3] Installing dependencies..."
python3 -m venv .venv 2>/dev/null || true
.venv/bin/pip install -r server/requirements.txt -q
echo "      Done ✓"

# --- 3. Start everything ---
echo "[3/3] Starting Cypherlink..."

# Kill previous instance
pkill -f "cypherlink/server.py" 2>/dev/null || true
pkill -f "http.server 3000" 2>/dev/null || true
sleep 1

# Start signaling server
.venv/bin/python server/server.py &
SERVER_PID=$!
echo "      Signaling: ws://localhost:9001"

# Serve web page
python3 -m http.server 3000 --directory web &
WEB_PID=$!
echo "      Web:       http://localhost:3000"

sleep 1

# Open browser
if command -v xdg-open &>/dev/null; then
    xdg-open http://localhost:3000
elif command -v open &>/dev/null; then
    open http://localhost:3000
fi

echo ""
echo "══════════════════════════════════════"
echo "  Cypherlink is running!"
echo ""
echo "  Open http://localhost:3000"
echo "  For 2 users: open a 2nd browser/incognito"
echo "  Both join same group + key → P2P chat"
echo ""
echo "  Stop: Ctrl+C"
echo "══════════════════════════════════════"

trap "kill $SERVER_PID $WEB_PID 2>/dev/null; exit" INT TERM
wait   