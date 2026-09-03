from __future__ import annotations

"""LOCO-TERMUX interactive Termux panel.

Kakao OAuth remains available for official API identity. Open Chat transport
uses the KakaoForge LOCO bridge and requires the user to complete its own QR
authorization. No password, session-token extraction, or security bypass is
performed by this panel.
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
    try: tmp.chmod(0o600)
    except OSError: pass
    tmp.replace(CONFIG_FILE)
    try: CONFIG_FILE.chmod(0o600)
    except OSError: pass


def prompt_config() -> dict:
    config = load_config()
    print("\n[KAKAO 설정]")
    print("카카오 개발자 콘솔 REST API 키를 입력하세요.")
    client_id = input(f"REST API 키 [{config.get('client_id', '')}]: ").strip() or str(config.get("client_id", ""))
    client_secret = input("Client Secret [저장값 유지하려면 Enter]: ").strip() or str(config.get("client_secret", ""))
    redirect_uri = input(f"Redirect URI [{config.get('redirect_uri', DEFAULT_REDIRECT_URI)}]: ").strip() or str(config.get("redirect_uri", DEFAULT_REDIRECT_URI))
    config.update({"client_id": client_id, "client_secret": client_secret, "redirect_uri": redirect_uri})
    save_config(config)
    return config


def _credentials() -> tuple[str, str, str]:
    config = load_config()
    return (
        str(config.get("client_id", "")).strip() or os.environ.get("KAKAO_CLIENT_ID", "").strip(),
        str(config.get("client_secret", "")).strip() or os.environ.get("KAKAO_CLIENT_SECRET", "").strip(),
        str(config.get("redirect_uri", "")).strip() or os.environ.get("KAKAO_REDIRECT_URI", "").strip() or DEFAULT_REDIRECT_URI,
    )


def run_auth(mode: str) -> int:
    client_id, client_secret, redirect_uri = _credentials()
    if not client_id:
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
                print(f"[OK] 기존 OAuth 세션 복구: {session.nickname} (ID {session.user_id})")
                return 0
            except Exception:
                session = None
        session = login_qr_interactive(client_id, client_secret, redirect_uri) if mode == "qr" else login_interactive(client_id, client_secret, redirect_uri)
        save_session(session, str(SESSION_FILE))
        print(f"[OK] OAuth 로그인 성공: {session.nickname} (ID {session.user_id})")
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
        print("[INFO] OAuth 세션이 없습니다.")
        return 0
    client_id, client_secret, _ = _credentials()
    try:
        if session.needs_refresh() and client_id and session.refresh_token:
            session = refresh_session(client_id, client_secret, session)
            save_session(session, str(SESSION_FILE))
        validate_session(session)
        print(f"[OK] OAuth 로그인됨: {session.nickname} (ID {session.user_id})")
        return 0
    except Exception as exc:
        print(f"[FAIL] 세션 검증 실패: {exc}")
        return 1


def logout() -> int:
    session = load_session(str(SESSION_FILE))
    if session:
        try: logout_session(session)
        except Exception as exc: print(f"[WARN] OAuth 서버 로그아웃 실패: {exc}")
    delete_session(str(SESSION_FILE))
    print("[OK] OAuth 로컬 세션을 삭제했습니다.")
    return 0


def openchat_transport() -> int:
    """Build and launch the KakaoForge LOCO/Open Chat transport."""
    print("\n[LOCO] KakaoForge transport를 준비합니다.")
    print("[LOCO] 최초 실행이면 KakaoForge가 터미널 QR을 표시합니다.")
    print("[LOCO] QR 승인은 본인 KakaoTalk 앱에서 직접 진행해야 합니다.")
    build = subprocess.run(["npm", "run", "build"], cwd=Path(__file__).parent, check=False)
    if build.returncode != 0:
        print("[FAIL] TypeScript 빌드 실패. npm install 후 다시 시도하세요.")
        return build.returncode
    return subprocess.call(["npm", "run", "start:openchat"], cwd=Path(__file__).parent)


def transport_status() -> int:
    state_file = DATA_DIR / "loco-transport.json"
    try:
        state = json.loads(state_file.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        print("[INFO] LOCO transport 상태가 없습니다. 먼저 Open Chat 연결을 실행하세요.")
        return 0
    print(f"[LOCO] 연결: {'YES' if state.get('connected') else 'NO'}")
    print(f"[LOCO] 전송계층: {state.get('transport', 'unknown')}")
    print(f"[LOCO] 방 수: {state.get('roomCount', 0)}")
    if state.get("roomSyncError"): print(f"[WARN] 방 동기화: {state['roomSyncError']}")
    return 0


def room_command(command: str) -> int:
    script = Path(__file__).with_name("방관리_cli.py")
    args = [sys.executable, str(script), command]
    if command in {"add", "enable", "disable", "remove", "members"}:
        room = input("방 ID: ").strip()
        if not room: return 2
        args.append(room)
    elif command == "readers":
        message_id = input("메시지 ID: ").strip()
        if not message_id: return 2
        args.append(message_id)
    elif command in {"export", "departed-export"}:
        room = input("방 ID (전체는 Enter): ").strip()
        fmt = input("형식 json/csv [json]: ").strip().lower() or "json"
        output = input("출력 파일 [자동]: ").strip()
        if room: args += ["--room-id", room]
        args += ["--format", fmt]
        if output: args += ["--output", output]
    return subprocess.call(args)


def panel() -> int:
    while True:
        print("\n========================================")
        print("          LOCO-TERMUX PANEL")
        print("========================================")
        print("1. 기본 로그인 (Kakao OAuth)")
        print("2. OAuth QR 로그인")
        print("3. OAuth 로그인 상태")
        print("4. OAuth 로그아웃")
        print("5. LOCO/Open Chat 연결 + QR")
        print("6. LOCO/Open Chat 연결 상태")
        print("7. 방 목록")
        print("8. 방 등록")
        print("9. 방 활성화")
        print("10. 방 비활성화")
        print("11. 방 삭제")
        print("12. 방 멤버")
        print("13. 메시지 읽은 사람")
        print("14. 전체 데이터 내보내기")
        print("15. 나간 사람 내보내기")
        print("16. Kakao OAuth 설정")
        print("0. 종료")
        choice = input("선택: ").strip()
        try:
            if choice == "1": run_auth("oauth")
            elif choice == "2": run_auth("qr")
            elif choice == "3": status()
            elif choice == "4": logout()
            elif choice == "5": openchat_transport()
            elif choice == "6": transport_status()
            elif choice == "7": room_command("rooms")
            elif choice == "8": room_command("add")
            elif choice == "9": room_command("enable")
            elif choice == "10": room_command("disable")
            elif choice == "11": room_command("remove")
            elif choice == "12": room_command("members")
            elif choice == "13": room_command("readers")
            elif choice == "14": room_command("export")
            elif choice == "15": room_command("departed-export")
            elif choice == "16": prompt_config()
            elif choice == "0": return 0
            else: print("[!] 올바른 메뉴를 선택하세요.")
        except KeyboardInterrupt:
            print("\n[INFO] 작업을 취소했습니다.")
        except Exception as exc:
            print(f"[ERROR] {exc}")


def main() -> int:
    return panel()


if __name__ == "__main__":
    raise SystemExit(main())
