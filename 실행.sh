#!/data/data/com.termux/files/usr/bin/bash

# LOCO-Termux self-healing launcher
# - rebuilds automatically when source/config changes
# - repairs npm dependencies
# - keeps Termux awake when supported
# - restarts the control center after crashes or unexpected exits
# - retries preparation failures indefinitely while Termux is alive

cd "$(dirname "$0")" || exit 1

export PYTHONIOENCODING="utf-8"
export PYTHONUNBUFFERED="1"
export NODE_OPTIONS="${NODE_OPTIONS:-}"

log() { echo "[LOCO] $*"; }

# Termux can suspend background processes aggressively while the screen is off.
# wake-lock is best-effort: the bot still works when the command is unavailable.
WAKE_LOCK=0
acquire_wake_lock() {
  if command -v termux-wake-lock >/dev/null 2>&1; then
    termux-wake-lock >/dev/null 2>&1 || true
    WAKE_LOCK=1
    log "Termux wake-lock 활성화"
  fi
}
release_wake_lock() {
  if [ "$WAKE_LOCK" -eq 1 ] && command -v termux-wake-unlock >/dev/null 2>&1; then
    termux-wake-unlock >/dev/null 2>&1 || true
  fi
}

bootstrap_tools() {
  if ! command -v pkg >/dev/null 2>&1; then
    log "Termux 환경이 아닙니다. 이 스크립트는 Termux에서 실행하세요."
    return 1
  fi

  if ! command -v node >/dev/null 2>&1; then
    log "Node.js 없음 → 설치 시도"
    pkg install -y nodejs || return 1
  fi

  if ! command -v npm >/dev/null 2>&1; then
    log "npm 없음 → Node.js 재설치 시도"
    pkg install -y nodejs || return 1
  fi

  if ! command -v python3 >/dev/null 2>&1 && ! command -v python >/dev/null 2>&1; then
    log "Python 없음 → 설치 시도"
    pkg install -y python || return 1
  fi

  return 0
}

prepare() {
  bootstrap_tools || return 1

  if [ ! -f package-lock.json ] || [ ! -d node_modules ]; then
    log "의존성 설치/복구 중..."
    npm install || return 1
  elif [ ! -f node_modules/.package-lock.json ]; then
    log "node_modules 상태 확인/복구 중..."
    npm install || return 1
  fi

  # Always use a build that is at least as new as the source/configuration.
  local rebuild=0
  if [ ! -f dist/termux-panel.js ]; then
    rebuild=1
  elif find src -type f -name '*.ts' -newer dist/termux-panel.js | grep -q .; then
    rebuild=1
  elif [ -f package.json ] && [ package.json -nt dist/termux-panel.js ]; then
    rebuild=1
  elif [ -f package-lock.json ] && [ package-lock.json -nt dist/termux-panel.js ]; then
    rebuild=1
  elif [ -f tsconfig.json ] && [ tsconfig.json -nt dist/termux-panel.js ]; then
    rebuild=1
  fi

  if [ "$rebuild" -eq 1 ]; then
    log "최신 소스/설정 감지 → TypeScript 전체 빌드"
    npm run build || return 1
  fi

  [ -f dist/termux-panel.js ] || return 1
  return 0
}

cleanup() {
  release_wake_lock
}
trap 'cleanup; log "종료 신호 수신 — 정리 후 종료"; exit 0' INT TERM EXIT

acquire_wake_lock

# Keep the supervisor alive. Only an explicit SIGINT/SIGTERM exits it.
while true; do
  if ! prepare; then
    log "준비 단계 실패 — 5초 후 다시 시도"
    sleep 5
    continue
  fi

  log "LOCO-Termux Control Center 시작..."
  node dist/termux-panel.js
  code=$?

  # Any unexpected runtime failure is treated as recoverable.
  log "Control Center 종료(code=$code) — 2초 후 자동 재시작"
  sleep 2
done
