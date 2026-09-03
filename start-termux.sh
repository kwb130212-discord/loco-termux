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

# 시작할 때마다 원격 main을 확인한다. 로컬 수정사항이 있으면 안전하게 건너뛴다.
if command -v git >/dev/null 2>&1 && [ -d .git ]; then
  echo "[UPDATE] GitHub 최신 버전 확인 중..."
  git fetch origin main --quiet 2>/dev/null || echo "[WARN] 원격 확인 실패 — 현재 코드로 계속합니다."
  LOCAL="$(git rev-parse HEAD 2>/dev/null || true)"
  REMOTE="$(git rev-parse origin/main 2>/dev/null || true)"
  if [ -n "$REMOTE" ] && [ "$LOCAL" != "$REMOTE" ]; then
    if git diff --quiet && git diff --cached --quiet; then
      echo "[UPDATE] 새 버전: ${LOCAL:0:8} -> ${REMOTE:0:8}"
      git pull --ff-only origin main || echo "[WARN] 자동 업데이트 실패 — 현재 코드로 계속합니다."
    else
      echo "[WARN] 로컬 수정사항이 있어 자동 pull을 건너뜁니다."
    fi
  else
    echo "[UPDATE] 최신 상태입니다."
  fi
fi

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
