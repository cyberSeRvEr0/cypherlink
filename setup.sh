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
        sudo apt update && sudo apt install -y python3 python3-pip
    elif command -v brew &>/dev/null; then
        brew install python3
    else
        echo "ERROR: Cannot install Python automatically. Install Python 3.10+ manually."
        exit 1
    fi
else
    echo "[1/4] Python 3 found ✓"
fi

# --- 2. Check Node.js ---
if ! command -v node &>/dev/null; then
    echo "[2/4] Installing Node.js..."
    if command -v apt &>/dev/null; then
        curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
        sudo apt install -y nodejs
    elif command -v brew &>/dev/null; then
        brew install node
    else
        echo "ERROR: Cannot install Node.js automatically. Install Node 18+ manually."
        exit 1
    fi
else
    echo "[2/4] Node.js found ✓"
fi

# --- 3. Install dependencies ---
echo "[3/4] Installing dependencies..."
pip3 install -r server/requirements.txt -q
npm install --silent
echo "      Dependencies installed ✓"

# --- 4. Start server + open browser ---
echo "[4/4] Starting Cypherlink..."

# Kill any previous instance
pkill -f "cypherlink/server.py" 2>/dev/null || true
sleep 1

# Start relay server in background
python3 server/server.py &
SERVER_PID=$!
echo "      Server running (PID $SERVER_PID)"

# Wait for server to be ready
for i in {1..10}; do
    if curl -s http://localhost:3000 > /dev/null 2>&1; then
        break
    fi
    sleep 0.5
done

# Serve web files + open browser
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