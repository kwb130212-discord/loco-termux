#!/data/data/com.termux/files/usr/bin/bash

# LOCO-Termux self-healing launcher
# - keeps the control center alive
# - retries dependency installation/builds
# - restarts after crashes, including clean exits
# - never silently gives up while Termux is running

cd "$(dirname "$0")" || exit 1

export PYTHONIOENCODING="utf-8"
export PYTHONUNBUFFERED="1"
export NODE_OPTIONS="${NODE_OPTIONS:-}"

log() { echo "[LOCO] $*"; }

bootstrap_tools() {
  if ! command -v pkg >/dev/null 2>&1; then
    log "Termux 환경이 아닙니다. 이 스크립트는 Termux에서 실행하세요."
    return 1
  fi

  if ! command -v node >/dev/null 2>&1; then
    log "Node.js 없음 → 설치 시도"
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

  if [ ! -d node_modules ] || [ ! -f node_modules/.package-lock.json ]; then
    log "의존성 설치/복구 중..."
    npm install || return 1
  fi

  if [ ! -f dist/termux-panel.js ]; then
    log "빌드 산출물 없음 → 빌드 중..."
    npm run build || return 1
  fi

  return 0
}

trap 'log "종료 신호 수신 — 정리 후 종료"; exit 0' INT TERM

while true; do
  if ! prepare; then
    log "준비 단계 실패 — 5초 후 다시 시도"
    sleep 5
    continue
  fi

  log "LOCO-Termux Control Center 시작..."
  node dist/termux-panel.js
  code=$?

  # 정상 종료도 서비스 재시작으로 처리해 실수로 종료되어도 다시 올라옵니다.
  log "Control Center 종료(code=$code) — 2초 후 자동 재시작"
  sleep 2
done
