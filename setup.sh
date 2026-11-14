#!/usr/bin/env bash
set -Eeuo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

echo "=================================="
echo "       CYPHERLINK SETUP"
echo "=================================="
echo

if [[ ! -f package.json || ! -f web/index.html || ! -f web/app.js ]]; then
  echo "ERROR: Expected package.json, web/index.html, and web/app.js."
  echo "Run this script from the Cypherlink project directory."
  exit 1
fi

install_deps() {
  if command -v apt-get >/dev/null 2>&1; then
    local sudo_cmd=()
    if [[ "${EUID}" -ne 0 ]]; then
      command -v sudo >/dev/null 2>&1 || {
        echo "ERROR: sudo is required to install system packages."
        exit 1
      }
      sudo_cmd=(sudo)
    fi

    "${sudo_cmd[@]}" apt-get update
    "${sudo_cmd[@]}" apt-get install -y \
      ca-certificates curl nodejs npm python3 coturn

  elif command -v brew >/dev/null 2>&1; then
    brew install node python coturn

  else
    echo "ERROR: Unsupported package manager."
    echo "Install Node.js (with npm), Python 3, and coturn manually."
    exit 1
  fi
}

echo "[1/4] Checking required tools..."
if ! command -v npm >/dev/null 2>&1 ||
   ! command -v python3 >/dev/null 2>&1 ||
   ! command -v turnserver >/dev/null 2>&1; then
  echo "Installing Node.js/npm, Python 3, and coturn..."
  install_deps
fi

for tool in npm python3 turnserver; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "ERROR: $tool was not found after installation."
    exit 1
  fi
done

node_major="$(node --version | sed 's/^v//' | cut -d. -f1)"
if [[ "$node_major" -lt 20 ]]; then
  echo "ERROR: Node.js 20 or newer is required; found $(node --version)."
  echo "Upgrade Node.js, then run this script again."
  exit 1
fi
echo "Node.js, npm, Python, and coturn found."

echo
echo "[2/4] Installing project dependencies..."
npm install

echo
echo "[3/4] Building Cypherlink..."
npm run build

echo
echo "[4/4] Starting local web server..."
if command -v xdg-open >/dev/null 2>&1; then
  xdg-open http://localhost:3000 >/dev/null 2>&1 &
elif command -v open >/dev/null 2>&1; then
  open http://localhost:3000 >/dev/null 2>&1 &
fi

echo
echo "Cypherlink is available at http://localhost:3000"
echo "Press Ctrl+C to stop the local web server."
echo "coturn is installed but not configured or exposed."
echo

exec python3 -m http.server 3000 --bind 127.0.0.1 --directory web
