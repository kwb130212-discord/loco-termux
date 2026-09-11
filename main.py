from __future__ import annotations

"""LOCO-Termux Python entrypoint.

The control plane, configuration, OAuth authentication, persistence and room
management are Python-only. Authentication uses Kakao's documented OAuth 2.0
flow; no password collection, fake session, or security bypass is performed.
"""

import json
import os
import subprocess
import sys
from pathlib import Path

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

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = Path.home() / ".loco-termux"
CONFIG_FILE = DATA_DIR / "config.json"
SESSION_FILE = DATA_DIR / "kakao-session.json"
ANALYZER_FILE = BASE_DIR / "loco_analyzer.json"


def load_json(path: Path, default):
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, type(default)) else default
    except (OSError, ValueError, TypeError):
        return default


def save_config(config: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = CONFIG_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")
    try:
        tmp.chmod(0o600)
    except OSError as exc:
        print(f"[WARN] config 권한 설정 실패: {exc}")
    tmp.replace(CONFIG_FILE)
    try:
        CONFIG_FILE.chmod(0o600)
    except OSError as exc:
        print(f"[WARN] config 권한 설정 실패: {exc}")


def config() -> dict:
    return load_json(CONFIG_FILE, {})


def credentials() -> tuple[str, str, str]:
    value = config()
    return (
        str(value.get("client_id", "")).strip() or os.environ.get("KAKAO_CLIENT_ID", "").strip(),
        str(value.get("client_secret", "")).strip() or os.environ.get("KAKAO_CLIENT_SECRET", "").strip(),
        str(value.get("redirect_uri", "")).strip() or os.environ.get("KAKAO_REDIRECT_URI", "").strip() or DEFAULT_REDIRECT_URI,
    )


def oauth_config() -> None:
    value = config()
    print("\n[KAKAO OAuth 설정]")
    client_id = input(f"REST API 키 [{value.get('client_id', '')}]: ").strip() or str(value.get("client_id", ""))
    client_secret = input("Client Secret [Enter=기존값 유지]: ").strip() or str(value.get("client_secret", ""))
    redirect = input(f"Redirect URI [{value.get('redirect_uri', DEFAULT_REDIRECT_URI)}]: ").strip() or str(value.get("redirect_uri", DEFAULT_REDIRECT_URI))
    save_config({**value, "client_id": client_id, "client_secret": client_secret, "redirect_uri": redirect})
    print("[OK] OAuth 설정 저장 완료")


def oauth_login(qr: bool) -> None:
    client_id, secret, redirect = credentials()
    if not client_id:
        oauth_config()
        client_id, secret, redirect = credentials()
    if not client_id:
        print("[FAIL] REST API 키가 없습니다.")
        return
    try:
        session = load_session(str(SESSION_FILE))
        if session:
            try:
                if session.needs_refresh() and session.refresh_token:
                    session = refresh_session(client_id, secret, session)
                    save_session(session, str(SESSION_FILE))
                validate_session(session)
                print(f"[OK] 세션 복구: {session.nickname} / {session.user_id}")
                return
            except KakaoOAuthError:
                pass
        session = login_qr_interactive(client_id, secret, redirect) if qr else login_interactive(client_id, secret, redirect)
        save_session(session, str(SESSION_FILE))
        print(f"[OK] OAuth 로그인: {session.nickname} / {session.user_id}")
    except Exception as exc:
        print(f"[FAIL] Kakao 인증 실패: {exc}")


def oauth_status() -> None:
    session = load_session(str(SESSION_FILE))
    if not session:
        print("[INFO] 로그인 세션 없음")
        return
    client_id, secret, _ = credentials()
    try:
        if session.needs_refresh() and client_id and session.refresh_token:
            session = refresh_session(client_id, secret, session)
            save_session(session, str(SESSION_FILE))
        validate_session(session)
        print(f"[OK] 인증됨: {session.nickname} / {session.user_id}")
    except Exception as exc:
        print(f"[FAIL] 세션 검증 실패: {exc}")


def oauth_logout() -> None:
    session = load_session(str(SESSION_FILE))
    if session:
        try:
            logout_session(session)
        except Exception as exc:
            print(f"[WARN] 서버 로그아웃 실패: {exc}")
    delete_session(str(SESSION_FILE))
    print("[OK] 로컬 OAuth 세션 삭제 완료")


def room_cli(*args: str) -> None:
    script = BASE_DIR / "방관리_cli.py"
    result = subprocess.run([sys.executable, str(script), *args], cwd=BASE_DIR, check=False)
    if result.returncode:
        print(f"[FAIL] 방 관리 명령 종료 코드: {result.returncode}")


def rooms() -> None:
    room_cli("rooms")


def room_add() -> None:
    room = input("방 ID: ").strip()
    if room:
        room_cli("add", room)


def room_toggle(action: str) -> None:
    room = input("방 ID: ").strip()
    if room:
        room_cli(action, room)


def room_members() -> None:
    room = input("방 ID: ").strip()
    if room:
        room_cli("members", room)


def room_readers() -> None:
    message = input("메시지 ID: ").strip()
    if message:
        room_cli("readers", message)


def export_data(departed: bool = False) -> None:
    room = input("방 ID [전체]: ").strip()
    fmt = input("형식 json/csv [json]: ").strip().lower() or "json"
    output = input("출력 파일 [자동]: ").strip()
    args = ["departed-export" if departed else "export"]
    if room:
        args += ["--room-id", room]
    args += ["--format", fmt]
    if output:
        args += ["--output", output]
    room_cli(*args)


def stats() -> None:
    data = load_json(ANALYZER_FILE, {})
    events = data.get("events", []) if isinstance(data, dict) else []
    messages = data.get("messages", {}) if isinstance(data, dict) else {}
    online = data.get("online", {}) if isinstance(data, dict) else {}
    print("\n[통계]")
    print(f"이벤트: {len(events)}")
    print(f"메시지: {len(messages)}")
    print(f"온라인 기록: {len(online)}")
    print(f"읽음 메시지: {len(data.get('reads', {})) if isinstance(data, dict) else 0}")


def panel() -> int:
    while True:
        print("\n========================================")
        print("          LOCO-TERMUX PYTHON")
        print("========================================")
        print("1. Kakao OAuth 로그인")
        print("2. Kakao OAuth QR 로그인")
        print("3. 인증 상태")
        print("4. OAuth 설정")
        print("5. 방 목록")
        print("6. 방 등록")
        print("7. 방 활성화")
        print("8. 방 비활성화")
        print("9. 방 삭제")
        print("10. 방 멤버")
        print("11. 메시지 읽은 사람")
        print("12. 전체 데이터 내보내기")
        print("13. 나간 사람 내보내기")
        print("14. 통계")
        print("15. 로그아웃")
        print("0. 종료")
        choice = input("선택: ").strip()
        try:
            actions = {
                "1": lambda: oauth_login(False),
                "2": lambda: oauth_login(True),
                "3": oauth_status,
                "4": oauth_config,
                "5": rooms,
                "6": room_add,
                "7": lambda: room_toggle("enable"),
                "8": lambda: room_toggle("disable"),
                "9": lambda: room_toggle("remove"),
                "10": room_members,
                "11": room_readers,
                "12": lambda: export_data(False),
                "13": lambda: export_data(True),
                "14": stats,
                "15": oauth_logout,
            }
            if choice == "0":
                return 0
            action = actions.get(choice)
            if action:
                action()
            else:
                print("[!] 올바른 메뉴를 선택하세요.")
        except KeyboardInterrupt:
            print("\n[INFO] 작업 취소")
        except Exception as exc:
            print(f"[ERROR] {exc}")


def main() -> int:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    return panel()


if __name__ == "__main__":
    raise SystemExit(main())
