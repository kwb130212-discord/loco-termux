#!/data/data/com.termux/files/usr/bin/bash
set -u
cd "$(dirname "$0")" || exit 1

export PYTHONIOENCODING="utf-8"
export PYTHONUNBUFFERED="1"

fail() {
  echo "[FAIL] $1"
  exit 1
}

command -v python3 >/dev/null 2>&1 || fail "python3가 없습니다. 실행: pkg update && pkg install python"
command -v node >/dev/null 2>&1 || fail "Node.js가 없습니다. 실행: pkg update && pkg install nodejs"
command -v npm >/dev/null 2>&1 || fail "npm이 없습니다. Node.js 설치를 확인하세요."

# 최초 실행에서도 별도 수동 설정 없이 패널까지 진입하도록 보정한다.
if [ ! -d node_modules ]; then
  echo "[BOOT] Node 의존성 설치 중..."
  npm install || fail "npm install 실패"
fi

if [ ! -f dist/bridge-main.js ] || [ ! -f dist/qr-login.js ] || [ ! -f dist/openchat-main.js ]; then
  echo "[BOOT] TypeScript 빌드 중..."
  npm run build || fail "TypeScript 빌드 실패"
fi

# 패널에서 직접 LOCO QR 로그인/연결을 선택할 수 있다.
exec python3 main.py
