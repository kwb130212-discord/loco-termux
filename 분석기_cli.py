from __future__ import annotations

"""CLI adapter for the analyzer's real Kakao OAuth authentication."""

import argparse
import contextlib
import io
import json
import sys
from 분석기 import LocoAnalyzer
from 분석기_auth import (
    DEFAULT_REDIRECT_URI,
    KakaoOAuthError,
    delete_session,
    load_session,
    login_interactive,
    logout_session,
    refresh_session,
    save_session,
    validate_session,
)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--oauth-login", action="store_true")
    parser.add_argument("--status", action="store_true")
    parser.add_argument("--logout", action="store_true")
    parser.add_argument("--client-id", default="")
    parser.add_argument("--client-secret", default="")
    parser.add_argument("--redirect-uri", default=DEFAULT_REDIRECT_URI)
    parser.add_argument("--login-hint", default="")
    parser.add_argument("--session-file", default="~/.loco-termux/kakao-session.json")
    args = parser.parse_args()

    if args.status:
        try:
            session = load_session(args.session_file)
            if not session:
                print(json.dumps({"ok": True, "authenticated": False, "reason": "no_session"}, ensure_ascii=False))
                return 0
            if args.client_id and session.needs_refresh() and session.refresh_token:
                session = refresh_session(args.client_id, args.client_secret, session)
                save_session(session, args.session_file)
            validate_session(session)
            print(json.dumps({"ok": True, "authenticated": True, "user_id": session.user_id, "nickname": session.nickname, "session": session.public()}, ensure_ascii=False))
            return 0
        except KakaoOAuthError as exc:
            print(json.dumps({"ok": True, "authenticated": False, "reason": str(exc)}, ensure_ascii=False)); return 0

    if args.logout:
        try:
            session = load_session(args.session_file)
            if session:
                logout_session(session)
            delete_session(args.session_file)
            print(json.dumps({"ok": True, "logged_out": True}, ensure_ascii=False))
            return 0
        except KakaoOAuthError as exc:
            print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False)); return 1

    if not args.oauth_login:
        print(json.dumps({"ok": False, "error": "oauth_login_required"}, ensure_ascii=False)); return 2
    if not args.client_id:
        print(json.dumps({"ok": False, "error": "client_id_required"}, ensure_ascii=False)); return 2
    if not args.redirect_uri:
        print(json.dumps({"ok": False, "error": "redirect_uri_required"}, ensure_ascii=False)); return 2

    try:
        session = load_session(args.session_file)
        if session:
            try:
                if session.needs_refresh():
                    if session.refresh_token:
                        session = refresh_session(args.client_id, args.client_secret, session)
                        save_session(session, args.session_file)
                    else:
                        session = None
                if session:
                    validate_session(session)
            except KakaoOAuthError:
                session = None

        if not session:
            captured = io.StringIO()
            with contextlib.redirect_stdout(captured):
                session = login_interactive(args.client_id, args.client_secret, args.redirect_uri, args.login_hint)
            if captured.getvalue().strip(): print(captured.getvalue().strip(), file=sys.stderr)
            save_session(session, args.session_file)

        analyzer = LocoAnalyzer()
        result = analyzer.authenticated_user("local", session.user_id, session.nickname, f"oauth_{session.user_id}_{session.created_at}")
        print(json.dumps({"ok": True, "mode": session.mode, "authenticated": session.authenticated, "user_id": session.user_id, "nickname": session.nickname, "session_id": result["session_id"], "diagnostic": {"status": "AUTHENTICATED", "error_code": None}, "session": session.public()}, ensure_ascii=False))
        return 0
    except KakaoOAuthError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False)); return 1
    except Exception as exc:
        print(json.dumps({"ok": False, "error": f"unexpected_auth_error: {exc}"}, ensure_ascii=False)); return 1


if __name__ == "__main__":
    raise SystemExit(main())
