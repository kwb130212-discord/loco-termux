#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

command -v node >/dev/null 2>&1 || { echo "[FAIL] node가 없습니다. pkg install nodejs-lts"; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "[FAIL] python3가 없습니다. pkg install python"; exit 1; }

if [ ! -d node_modules ]; then
  echo "[SETUP] npm install"
  npm install
fi

if [ ! -f dist/bridge-main.js ]; then
  echo "[BUILD] TypeScript build"
  npm run build
fi

exec npm run start:loco
