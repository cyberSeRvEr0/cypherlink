#!/usr/bin/env bash
set -e

echo "╔══════════════════════════════════╗"
echo "║        CYIPHERLINK SETUP         ║"
echo "╚══════════════════════════════════╝"
echo ""

# --- 1. Check Python ---
if ! command -v python3 &>/dev/null; then
    echo "[1/5] Installing Python 3..."
    if command -v apt &>/dev/null; then
        sudo apt update && sudo apt install -y python3 python3-pip python3-venv
    elif command -v brew &>/dev/null; then
        brew install python3
    else
        echo "ERROR: Install Python 3.10+ manually."
        exit 1
    fi
else
    echo "[1/5] Python 3 found ✓"
fi

# --- 2. Check Node.js ---
if ! command -v node &>/dev/null; then
    echo "[2/5] Installing Node.js..."
    if command -v apt &>/dev/null; then
        curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
        sudo apt install -y nodejs
    elif command -v brew &>/dev/null; then
        brew install node
    else
        echo "ERROR: Install Node.js 18+ manually."
        exit 1
    fi
else
    echo "[2/5] Node.js found ✓"
fi

# --- 3. Create venv + install Python deps ---
echo "[3/5] Installing Python dependencies..."
python3 -m venv .venv
.venv/bin/pip install -r server/requirements.txt -q
echo "      Done ✓"

# --- 4. Install Node deps ---
echo "[4/5] Installing Node dependencies..."
npm install --silent
echo "      Done ✓"

# --- 5. Start everything ---
echo "[5/5] Starting Cypherlink..."

# Kill any previous instance
pkill -f "cypherlink/server.py" 2>/dev/null || true
pkill -f "http.server 3000" 2>/dev/null || true
sleep 1

# Start relay server in background
.venv/bin/python server/server.py &
SERVER_PID=$!
echo "      Relay running (PID $SERVER_PID)"

# Serve web files
python3 -m http.server 3000 --directory web &
WEB_PID=$!

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
echo "  Browser: http://localhost:3000"
echo "  Relay:   ws://localhost:9001"
echo ""
echo "  To stop:  kill $SERVER_PID $WEB_PID"
echo "══════════════════════════════════════"

# Keep script alive so Ctrl+C stops everything
trap "kill $SERVER_PID $WEB_PID 2>/dev/null; exit" INT TERM
wait   