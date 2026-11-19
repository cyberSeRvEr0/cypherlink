#!/usr/bin/env bash
set -e

echo "╔══════════════════════════════════╗"
echo "║        CYPHERLINK SETUP          ║"
echo "╚══════════════════════════════════╝"
echo ""

# --- 1. Node.js 22+ ---
export PATH="/snap/bin:$PATH"
NODE_MAJOR=$(node -v 2>/dev/null | cut -d'.' -f1 | tr -d 'v' || echo 0)
if [ "$NODE_MAJOR" -lt 22 ]; then
    echo "[1/2] Installing Node.js 22..."
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
echo "[1/2] Node.js $(node -v) ready ✓"

# --- 2. Build & open ---
echo "[2/2] Building..."
npm install --loglevel=error --no-fund --no-audit
npm run build --loglevel=error
echo "[2/2] Built ✓"

echo ""
echo "══════════════════════════════════════"
echo "  Cypherlink ready."
echo ""
echo "  Open: web/index.html in your browser"
echo "  (or: npx serve web)"
echo ""
echo "  No server. No relay. No process."
echo "  Rooms vanish when the last member leaves."
echo "══════════════════════════════════════"   