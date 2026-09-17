#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR="$ROOT/.vendor/loco-protocol-kotlin"
JAR="$VENDOR/build/libs/loco-protocol-kotlin.jar"
REPO="https://github.com/yushosei/loco-protocol-kotlin.git"
REF="7f7ce6b580f47d4b28f616ca351f347d1a834e44"

command -v git >/dev/null 2>&1 || { echo "git이 필요합니다: pkg install git"; exit 1; }
command -v java >/dev/null 2>&1 || { echo "Java 17+가 필요합니다: pkg install openjdk-17"; exit 1; }

JAVA_MAJOR="$(java -version 2>&1 | awk -F '[\".]' '/version/ {print $2; exit}')"
[ "${JAVA_MAJOR:-0}" -ge 17 ] || { echo "Java 17 이상이 필요합니다. 현재: ${JAVA_MAJOR:-unknown}"; exit 1; }

if [ ! -d "$VENDOR/.git" ]; then
  mkdir -p "$(dirname "$VENDOR")"
  git clone --filter=blob:none "$REPO" "$VENDOR"
fi

git -C "$VENDOR" fetch --depth 1 origin "$REF"
git -C "$VENDOR" checkout --detach "$REF"

if [ ! -f "$JAR" ]; then
  cd "$VENDOR"
  chmod +x ./gradlew
  ./gradlew buildFatJar --no-daemon
fi

[ -f "$JAR" ] || { echo "fat jar 생성 실패: $JAR"; exit 1; }
echo "$JAR"
