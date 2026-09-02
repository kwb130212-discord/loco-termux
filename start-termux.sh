#!/data/data/com.termux/files/usr/bin/bash
set -u
cd "$(dirname "$0")"

command -v python3 >/dev/null 2>&1 || {
  echo "[FAIL] python3가 없습니다."
  echo "       pkg install python"
  exit 1
}

# QR 표시가 필요하면 한 번만 설치하면 됩니다.
#   pkg install qrencode
# qrencode가 없어도 URL 방식 로그인은 계속 사용할 수 있습니다.

export PYTHONUNBUFFERED=1
exec python3 main.py
