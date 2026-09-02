from __future__ import annotations

"""Termux launcher for loco-termux.

The launcher deliberately does not request or store a Kakao account password.
Authentication is handled by the documented OAuth flow in 분석기_auth.py.
"""

import json
import os
import subprocess
import sys
from pathlib import Path

try:
    from 분석기_auth import DEFAULT_REDIRECT_URI
except Exception:
    DEFAULT_REDIRECT_URI = "http://127.0.0.1:8765/callback"


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _client_id() -> str:
    return _env("KAKAO_CLIENT_ID") or _env("KAKAO_REST_API_KEY")


def _client_secret() -> str:
    return _env("KAKAO_CLIENT_SECRET")


def _redirect_uri() -> str:
    return _env("KAKAO_REDIRECT_URI", DEFAULT_REDIRECT_URI)


def run_auth(mode: str) -> int:
    client_id = _client_id()
    if not client_id:
        print("[FAIL] KAKAO_CLIENT_ID가 설정되지 않았습니다.")
        print("      export KAKAO_CLIENT_ID='카카오 REST API 키'")
        return 2

    command = [
        sys.executable,
        str(Path(__file__).with_name("분석기_cli.py")),
        "--client-id", client_id,
        "--client-secret", _client_secret(),
        "--redirect-uri", _redirect_uri(),
    ]
    command.append("--qr-login" if mode == "qr" else "--oauth-login")
    return subprocess.call(command)


def status() -> int:
    command = [
        sys.executable,
        str(Path(__file__).with_name("분석기_cli.py")),
        "--status",
    ]
    client_id = _client_id()
    if client_id:
        command += ["--client-id", client_id, "--client-secret", _client_secret()]
    result = subprocess.run(command, capture_output=True, text=True)
    output = result.stdout.strip()
    if output:
        try:
            data = json.loads(output)
            if data.get("authenticated"):
                print(f"[OK] 로그인됨: {data.get('nickname', 'Kakao User')} (ID {data.get('user_id')})")
            else:
                print("[INFO] 로그인 세션이 없습니다.")
                if data.get("reason"):
                    print(f"       사유: {data['reason']}")
        except json.JSONDecodeError:
            print(output)
    return result.returncode


def logout() -> int:
    command = [sys.executable, str(Path(__file__).with_name("분석기_cli.py")), "--logout"]
    return subprocess.call(command)


def main() -> int:
    while True:
        print("\n========================================")
        print("          LOCO-TERMUX PANEL")
        print("========================================")
        print("1. 빠른 로그인 (OAuth)")
        print("2. QR 로그인 (OAuth URL QR)")
        print("3. 로그인 상태 / 세션 복구")
        print("4. 로그아웃")
        print("0. 종료")
        choice = input("선택: ").strip()

        try:
            if choice == "1":
                run_auth("oauth")
            elif choice == "2":
                run_auth("qr")
            elif choice == "3":
                status()
            elif choice == "4":
                logout()
            elif choice == "0":
                return 0
            else:
                print("[!] 0~4 중에서 선택하세요.")
        except KeyboardInterrupt:
            print("\n[INFO] 종료합니다.")
            return 0
        except Exception as exc:
            print(f"[ERROR] {exc}")


if __name__ == "__main__":
    raise SystemExit(main())
