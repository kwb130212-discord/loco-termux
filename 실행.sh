#!/data/data/com.termux/files/usr/bin/bash
set -u
cd "$(dirname "$0")" || exit 1

export PYTHONIOENCODING="utf-8"
export PYTHONUNBUFFERED="1"

if ! command -v node >/dev/null 2>&1; then
  echo "[LOCO] Node.js가 없습니다. 먼저: pkg install nodejs"
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1 && ! command -v python >/dev/null 2>&1; then
  echo "[LOCO] Python이 없습니다. 먼저: pkg install python"
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "[LOCO] 의존성 설치 중..."
  npm install || exit 1
fi
if [ ! -f dist/termux-panel.js ]; then
  echo "[LOCO] 최초 빌드 중..."
  npm run build || exit 1
fi

trap 'exit 0' INT TERM
while true; do
  echo "[LOCO] LOCO-Termux Control Center 시작..."
  node dist/termux-panel.js
  code=$?
  [ "$code" -eq 0 ] && exit 0
  echo "[LOCO] 프로세스 종료(code=$code) — 2초 후 자동 재시작"
  sleep 2
done
