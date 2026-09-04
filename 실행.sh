#!/data/data/com.termux/files/usr/bin/bash

# LOCO-Termux self-healing launcher
# - bootstraps required tools
# - repairs dependencies when node_modules is missing or package.json changed
# - rebuilds stale TypeScript output
# - keeps Termux awake when supported
# - restarts the control center after failures
# - retries preparation failures indefinitely while Termux is alive

cd "$(dirname "$0")" || exit 1

export PYTHONIOENCODING="utf-8"
export PYTHONUNBUFFERED="1"
case " ${NODE_OPTIONS:-} " in
  *" --unhandled-rejections="*) ;;
  *) export NODE_OPTIONS="${NODE_OPTIONS:+${NODE_OPTIONS} }--unhandled-rejections=warn" ;;
esac

log() { echo "[LOCO] $*"; }

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
  command -v pkg >/dev/null 2>&1 || { log "Termux에서 실행하세요."; return 1; }

  # KakaoForge may be installed as a source-only git package. The local
  # runtime loader can build its pinned revision, so git must be available.
  if ! command -v git >/dev/null 2>&1; then
    log "git 없음 → 설치"
    pkg install -y git || return 1
  fi

  if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    log "Node.js/npm 없음 → 설치/복구"
    pkg install -y nodejs || return 1
  fi
  if ! command -v python3 >/dev/null 2>&1 && ! command -v python >/dev/null 2>&1; then
    log "Python 없음 → 설치"
    pkg install -y python || return 1
  fi
  return 0
}

npm_bin() { command -v npm || printf '%s\n' npm; }

prepare() {
  bootstrap_tools || return 1

  if [ ! -d node_modules ] || [ ! -f node_modules/.package-lock.json ]; then
    log "의존성 설치/복구 중..."
    "$(npm_bin)" install --no-audit --no-fund || return 1
  elif [ -f package.json ] && [ package.json -nt node_modules/.package-lock.json ]; then
    log "package.json 변경 감지 → 의존성 갱신"
    "$(npm_bin)" install --no-audit --no-fund || return 1
  fi

  # The pinned KakaoForge revision is source-only in some git installs. The
  # local loader repairs/builds its dist/ lazily, so npm install itself never
  # becomes a single point of failure.
  local rebuild=0
  if [ ! -f dist/termux-panel.js ]; then
    rebuild=1
  elif [ ! -f dist/openchat-main.js ]; then
    rebuild=1
  elif [ ! -f dist/qr-login.js ]; then
    rebuild=1
  elif find src -type f -name '*.ts' -newer dist/termux-panel.js | grep -q .; then
    rebuild=1
  elif [ -f package.json ] && [ package.json -nt dist/termux-panel.js ]; then
    rebuild=1
  elif [ -f tsconfig.json ] && [ tsconfig.json -nt dist/termux-panel.js ]; then
    rebuild=1
  fi

  if [ "$rebuild" -eq 1 ]; then
    log "최신 소스/설정 감지 → TypeScript 전체 빌드"
    "$(npm_bin)" run build || return 1
  fi

  [ -f dist/termux-panel.js ] || { log "dist/termux-panel.js 생성 실패"; return 1; }
  [ -f dist/openchat-main.js ] || { log "dist/openchat-main.js 생성 실패"; return 1; }
  [ -f dist/qr-login.js ] || { log "dist/qr-login.js 생성 실패"; return 1; }
  return 0
}

cleanup() { release_wake_lock; }
trap 'cleanup; log "종료 신호 수신 — 종료"; exit 0' INT TERM EXIT

acquire_wake_lock

while true; do
  if ! prepare; then
    log "준비 단계 실패 — 5초 후 재시도"
    sleep 5
    continue
  fi

  if [ -f "$HOME/.loco-termux/kakaoforge-auth.json" ]; then
    log "KakaoForge 인증 세션 확인 — 로그인 후 OpenChat 실구동 자동 연결 준비 완료"
  else
    log "인증 세션 없음 — Control Center에서 QR 로그인부터 진행"
  fi

  log "LOCO-Termux Control Center 시작..."
  node dist/termux-panel.js
  code=$?
  log "Control Center 종료(code=$code) — 2초 후 자동 재시작"
  sleep 2
done
