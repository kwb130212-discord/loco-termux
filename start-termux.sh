#!/data/data/com.termux/files/usr/bin/bash
set -eu
cd "$(dirname "$0")" || exit 1

export PYTHONIOENCODING="utf-8"
export PYTHONUNBUFFERED="1"

fail() {
  echo "[FAIL] $1"
  exit 1
}

command -v python3 >/dev/null 2>&1 || fail "python3가 없습니다. 실행: pkg update && pkg install python"

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

exec python3 main.py
