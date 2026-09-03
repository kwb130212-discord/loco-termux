from __future__ import annotations

"""LOCO-TERMUX interactive Termux panel.

Authentication is intentionally user-mediated: the panel uses Kakao OAuth and
can render the official authorization URL as a QR code. It does not fabricate,
extract, or bypass KakaoTalk private-client sessions.

Room management operates on state actually observed by the analyzer. This
keeps the panel honest when an official API/transport does not expose a
specific Open Chat operation.
"""

import json
import os
import subprocess
import sys
from pathlib import Path

try:
    from 분석기_auth import (
        DEFAULT_REDIRECT_URI,
        KakaoOAuthError,
        delete_session,
        load_session,
        login_interactive,
        login_qr_interactive,
        logout_session,
        refresh_session,
        save_session,
        validate_session,
    )
except Exception:
    DEFAULT_REDIRECT_URI = "http://127.0.0.1:8765/callback"
    KakaoOAuthError = RuntimeError

DATA_DIR = Path.home() / ".loco-termux"
CONFIG_FILE = DATA_DIR / "config.json"
SESSION_FILE = DATA_DIR / "kakao-session.json"


def load_config() -> dict:
    try:
        value = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError, TypeError):
        return {}


def save_config(config: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = CONFIG_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")
    try:
        tmp.chmod(0o600)
    except OSError:
        pass
    tmp.replace(CONFIG_FILE)
    try:
        CONFIG_FILE.chmod(0o600)
    except OSError:
        pass


def prompt_config() -> dict:
    config = load_config()
    print("\n[KAKAO 설정]")
    print("카카오 개발자 콘솔에서 발급한 REST API 키를 입력하세요.")
    print("비밀키가 없는 앱은 Enter로 건너뛸 수 있습니다.")
    client_id = input(f"REST API 키 [{config.get('client_id', '')}]: ").strip() or str(config.get("client_id", ""))
    client_secret = input("Client Secret [저장값 유지하려면 Enter]: ").strip()
    if not client_secret:
        client_secret = str(config.get("client_secret", ""))
    redirect_uri = input(f"Redirect URI [{config.get('redirect_uri', DEFAULT_REDIRECT_URI)}]: ").strip()
    redirect_uri = redirect_uri or str(config.get("redirect_uri", DEFAULT_REDIRECT_URI))
    config.update({"client_id": client_id, "client_secret": client_secret, "redirect_uri": redirect_uri})
    save_config(config)
    return config


def _credentials() -> tuple[str, str, str]:
    config = load_config()
    client_id = str(config.get("client_id", "")).strip() or os.environ.get("KAKAO_CLIENT_ID", "").strip()
    client_secret = str(config.get("client_secret", "")).strip() or os.environ.get("KAKAO_CLIENT_SECRET", "").strip()
    redirect_uri = str(config.get("redirect_uri", "")).strip() or os.environ.get("KAKAO_REDIRECT_URI", "").strip() or DEFAULT_REDIRECT_URI
    return client_id, client_secret, redirect_uri


def run_auth(mode: str) -> int:
    client_id, client_secret, redirect_uri = _credentials()
    if not client_id:
        print("[INFO] 최초 1회 카카오 REST API 키를 입력합니다.")
        config = prompt_config()
        client_id = str(config.get("client_id", "")).strip()
        client_secret = str(config.get("client_secret", "")).strip()
        redirect_uri = str(config.get("redirect_uri", DEFAULT_REDIRECT_URI)).strip()
    if not client_id:
        print("[FAIL] REST API 키가 필요합니다.")
        return 2

    try:
        session = load_session(str(SESSION_FILE))
        if session:
            try:
                if session.needs_refresh() and session.refresh_token:
                    session = refresh_session(client_id, client_secret, session)
                    save_session(session, str(SESSION_FILE))
                validate_session(session)
                print(f"[OK] 기존 세션 복구: {session.nickname} (ID {session.user_id})")
                return 0
            except Exception:
                session = None

        if mode == "qr":
            print("\n[QR] 공식 Kakao OAuth 인증 QR을 준비합니다.")
            session = login_qr_interactive(client_id, client_secret, redirect_uri)
        else:
            session = login_interactive(client_id, client_secret, redirect_uri)
        save_session(session, str(SESSION_FILE))
        print(f"[OK] 로그인 성공: {session.nickname} (ID {session.user_id})")
        return 0
    except KakaoOAuthError as exc:
        print(f"[FAIL] Kakao 인증 실패: {exc}")
        return 1
    except Exception as exc:
        print(f"[FAIL] 인증 처리 실패: {exc}")
        return 1


def status() -> int:
    session = load_session(str(SESSION_FILE))
    if not session:
        print("[INFO] 로그인 세션이 없습니다.")
        return 0
    client_id, client_secret, _ = _credentials()
    try:
        if session.needs_refresh() and client_id and session.refresh_token:
            session = refresh_session(client_id, client_secret, session)
            save_session(session, str(SESSION_FILE))
        validate_session(session)
        print(f"[OK] 로그인됨: {session.nickname} (ID {session.user_id})")
        print(f"     만료 시각(epoch): {session.access_expires_at()}")
        print(f"     인증 방식: {session.mode}")
        return 0
    except Exception as exc:
        print(f"[FAIL] 세션 검증 실패: {exc}")
        return 1


def logout() -> int:
    session = load_session(str(SESSION_FILE))
    if session:
        try:
            logout_session(session)
        except Exception as exc:
            print(f"[WARN] 서버 로그아웃 실패: {exc}")
    delete_session(str(SESSION_FILE))
    print("[OK] 로컬 로그인 세션을 삭제했습니다.")
    return 0


def room_command(command: str) -> int:
    script = Path(__file__).with_name("방관리_cli.py")
    args = [sys.executable, str(script), command]
    if command in {"add", "enable", "disable", "remove", "members"}:
        room = input("방 ID: ").strip()
        if not room:
            print("[FAIL] 방 ID가 필요합니다.")
            return 2
        args.append(room)
    elif command == "readers":
        message_id = input("메시지 ID: ").strip()
        if not message_id:
            print("[FAIL] 메시지 ID가 필요합니다.")
            return 2
        args.append(message_id)
    elif command in {"export", "departed-export"}:
        room = input("방 ID (전체는 Enter): ").strip()
        fmt = input("형식 json/csv [json]: ").strip().lower() or "json"
        output = input("출력 파일 [자동]: ").strip()
        if room:
            args += ["--room-id", room]
        args += ["--format", fmt]
        if output:
            args += ["--output", output]
    return subprocess.call(args)


def panel() -> int:
    while True:
        print("\n========================================")
        print("          LOCO-TERMUX PANEL")
        print("========================================")
        print("1. 기본 로그인 (Kakao OAuth)")
        print("2. QR 로그인 (Kakao OAuth QR)")
        print("3. 로그인 상태 / 세션 복구")
        print("4. 로그아웃")
        print("5. 방 목록")
        print("6. 방 등록")
        print("7. 방 활성화")
        print("8. 방 비활성화")
        print("9. 방 삭제")
        print("10. 방 멤버")
        print("11. 메시지 읽은 사람")
        print("12. 전체 데이터 내보내기")
        print("13. 나간 사람 내보내기")
        print("14. Kakao 인증 설정")
        print("0. 종료")
        choice = input("선택: ").strip()
        try:
            if choice == "1": run_auth("oauth")
            elif choice == "2": run_auth("qr")
            elif choice == "3": status()
            elif choice == "4": logout()
            elif choice == "5": room_command("rooms")
            elif choice == "6": room_command("add")
            elif choice == "7": room_command("enable")
            elif choice == "8": room_command("disable")
            elif choice == "9": room_command("remove")
            elif choice == "10": room_command("members")
            elif choice == "11": room_command("readers")
            elif choice == "12": room_command("export")
            elif choice == "13": room_command("departed-export")
            elif choice == "14": prompt_config()
            elif choice == "0": return 0
            else: print("[!] 올바른 메뉴를 선택하세요.")
        except KeyboardInterrupt:
            print("\n[INFO] 메뉴 작업을 취소했습니다.")
        except Exception as exc:
            print(f"[ERROR] {exc}")


def main() -> int:
    return panel()


if __name__ == "__main__":
    raise SystemExit(main())
