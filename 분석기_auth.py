from __future__ import annotations

"""Real Kakao Login OAuth adapter for the analyzer.

Uses Kakao's documented OAuth authorization-code flow. It never accepts or
submits a Kakao account password, fabricates a session, or ignores failures.
"""

from dataclasses import dataclass, asdict
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Callable, Optional
from urllib.parse import urlencode, urlparse, parse_qs
import json
import secrets
import subprocess
import time
import urllib.error
import urllib.request
import webbrowser

AUTH_URL = "https://kauth.kakao.com/oauth/authorize"
TOKEN_URL = "https://kauth.kakao.com/oauth/token"
ME_URL = "https://kapi.kakao.com/v2/user/me"
LOGOUT_URL = "https://kapi.kakao.com/v1/user/logout"
DEFAULT_REDIRECT_URI = "http://127.0.0.1:8765/callback"
DEFAULT_SESSION_FILE = "~/.loco-termux/kakao-session.json"


@dataclass
class OAuthSession:
    access_token: str
    refresh_token: Optional[str]
    token_type: str
    expires_in: int
    refresh_token_expires_in: Optional[int]
    user_id: str
    nickname: str
    created_at: int
    mode: str = "KAKAO_OAUTH"
    authenticated: bool = True

    def public(self) -> dict:
        value = asdict(self)
        value.pop("access_token", None)
        value.pop("refresh_token", None)
        return value

    def access_expires_at(self) -> int:
        return self.created_at + max(0, self.expires_in)

    def needs_refresh(self, skew: int = 60) -> bool:
        return int(time.time()) >= self.access_expires_at() - max(0, skew)


class KakaoOAuthError(RuntimeError):
    pass


def _post_form(url: str, data: dict[str, str], timeout: int = 20) -> dict:
    body = urlencode(data).encode()
    request = urllib.request.Request(url, data=body, headers={"Content-Type": "application/x-www-form-urlencoded"}, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:1000]
        raise KakaoOAuthError(f"Kakao endpoint HTTP {exc.code}: {detail}") from exc
    except (urllib.error.URLError, TimeoutError) as exc:
        raise KakaoOAuthError(f"Kakao endpoint connection failed: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise KakaoOAuthError("Kakao endpoint returned invalid JSON") from exc


def _get_json(url: str, access_token: str, timeout: int = 20) -> dict:
    request = urllib.request.Request(url, headers={"Authorization": f"Bearer {access_token}"}, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:1000]
        raise KakaoOAuthError(f"Kakao user API HTTP {exc.code}: {detail}") from exc
    except (urllib.error.URLError, TimeoutError) as exc:
        raise KakaoOAuthError(f"Kakao user API connection failed: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise KakaoOAuthError("Kakao user API returned invalid JSON") from exc


def build_authorize_url(client_id: str, redirect_uri: str, state: str, login_hint: str = "") -> str:
    params = {"response_type": "code", "client_id": client_id, "redirect_uri": redirect_uri, "state": state}
    if login_hint:
        params["login_hint"] = login_hint
    return f"{AUTH_URL}?{urlencode(params)}"


def exchange_code(client_id: str, client_secret: str, redirect_uri: str, code: str) -> dict:
    data = {"grant_type": "authorization_code", "client_id": client_id, "redirect_uri": redirect_uri, "code": code}
    if client_secret:
        data["client_secret"] = client_secret
    return _post_form(TOKEN_URL, data)


def refresh_session(client_id: str, client_secret: str, session: OAuthSession) -> OAuthSession:
    if not session.refresh_token:
        raise KakaoOAuthError("No refresh token is available; interactive login is required")
    data = {"grant_type": "refresh_token", "client_id": client_id, "refresh_token": session.refresh_token}
    if client_secret:
        data["client_secret"] = client_secret
    token = _post_form(TOKEN_URL, data)
    access_token = str(token.get("access_token", ""))
    if not access_token:
        raise KakaoOAuthError("Kakao did not issue a refreshed access token")
    return OAuthSession(
        access_token=access_token,
        refresh_token=str(token.get("refresh_token") or session.refresh_token),
        token_type=str(token.get("token_type", session.token_type)),
        expires_in=int(token.get("expires_in", 0) or 0),
        refresh_token_expires_in=(int(token["refresh_token_expires_in"]) if token.get("refresh_token_expires_in") else session.refresh_token_expires_in),
        user_id=session.user_id,
        nickname=session.nickname,
        created_at=int(time.time()),
    )


def validate_session(session: OAuthSession) -> dict:
    profile = _get_json(ME_URL, session.access_token)
    account_id = profile.get("id")
    if account_id is None or str(account_id) != str(session.user_id):
        raise KakaoOAuthError("Kakao user identity validation failed")
    return profile


def login_from_code(client_id: str, client_secret: str, redirect_uri: str, code: str) -> OAuthSession:
    token = exchange_code(client_id, client_secret, redirect_uri, code)
    access_token = str(token.get("access_token", ""))
    if not access_token:
        raise KakaoOAuthError("Kakao did not issue an access token")
    profile = _get_json(ME_URL, access_token)
    account_id = profile.get("id")
    if account_id is None:
        raise KakaoOAuthError("Kakao user profile did not contain an id")
    properties = profile.get("properties") if isinstance(profile.get("properties"), dict) else {}
    nickname = str(properties.get("nickname") or "Kakao User")
    return OAuthSession(
        access_token=access_token,
        refresh_token=str(token["refresh_token"]) if token.get("refresh_token") else None,
        token_type=str(token.get("token_type", "bearer")),
        expires_in=int(token.get("expires_in", 0) or 0),
        refresh_token_expires_in=(int(token["refresh_token_expires_in"]) if token.get("refresh_token_expires_in") else None),
        user_id=str(account_id), nickname=nickname, created_at=int(time.time()),
    )


def logout_session(session: OAuthSession) -> None:
    """Log out the current Kakao access token without unlinking the account."""
    request = urllib.request.Request(LOGOUT_URL, headers={"Authorization": f"Bearer {session.access_token}"}, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            response.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:1000]
        raise KakaoOAuthError(f"Kakao logout HTTP {exc.code}: {detail}") from exc
    except (urllib.error.URLError, TimeoutError) as exc:
        raise KakaoOAuthError(f"Kakao logout connection failed: {exc}") from exc


def _open_browser(url: str) -> bool:
    """Open a URL reliably from Termux/Android, then fall back to Python webbrowser."""
    try:
        result = subprocess.run(
            ["am", "start", "-a", "android.intent.action.VIEW", "-d", url],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            timeout=5, check=False,
        )
        if result.returncode == 0:
            return True
    except (OSError, subprocess.SubprocessError):
        pass
    try:
        return bool(webbrowser.open(url))
    except Exception:
        return False


def _manual_callback(expected_state: str) -> str:
    print("[AUTH] 자동 복귀가 되지 않았습니다.")
    print("[AUTH] 브라우저 주소창의 callback URL 전체를 복사해서 아래에 붙여넣으세요.")
    callback = input("[AUTH] Callback URL: ").strip()
    query = parse_qs(urlparse(callback).query)
    if query.get("state", [""])[0] != expected_state:
        raise KakaoOAuthError("OAuth state mismatch")
    if query.get("error", [""])[0]:
        raise KakaoOAuthError(query.get("error_description", query["error"])[0])
    code = query.get("code", [""])[0]
    if not code:
        raise KakaoOAuthError("Callback URL did not contain an authorization code")
    return code


def wait_for_callback(redirect_uri: str, expected_state: str, timeout: int = 120, on_ready: Optional[Callable[[], None]] = None) -> str:
    parsed = urlparse(redirect_uri)
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost"}:
        raise KakaoOAuthError("Automatic callback requires an http://127.0.0.1 or localhost redirect URI")
    if not parsed.port:
        raise KakaoOAuthError("Local redirect URI must include an explicit port")
    result: dict[str, str] = {}
    path = parsed.path or "/"

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            incoming = urlparse(self.path)
            if incoming.path != path:
                self.send_response(404); self.end_headers(); return
            query = parse_qs(incoming.query)
            if query.get("state", [""])[0] != expected_state:
                result["error"] = "OAuth state mismatch"
            elif query.get("error", [""])[0]:
                result["error"] = query.get("error_description", query["error"])[0]
            else:
                result["code"] = query.get("code", [""])[0]
                if not result["code"]: result["error"] = "Callback did not contain an authorization code"
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write("Kakao login callback received. Return to Termux.".encode())

        def log_message(self, *_args):
            return

    try:
        server = HTTPServer((parsed.hostname, parsed.port), Handler)
    except OSError as exc:
        raise KakaoOAuthError(f"Could not start local OAuth callback server on {parsed.hostname}:{parsed.port}: {exc}") from exc
    server.timeout = 1
    if on_ready:
        on_ready()
    deadline = time.time() + timeout
    try:
        while time.time() < deadline and not result:
            server.handle_request()
    finally:
        server.server_close()
    if result.get("error"):
        raise KakaoOAuthError(result["error"])
    if result.get("code"):
        return result["code"]
    raise KakaoOAuthError("Timed out waiting for Kakao OAuth callback")


def login_interactive(client_id: str, client_secret: str, redirect_uri: str, login_hint: str = "") -> OAuthSession:
    state = secrets.token_urlsafe(32)
    url = build_authorize_url(client_id, redirect_uri, state, login_hint)
    parsed = urlparse(redirect_uri)
    if parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "localhost"}:
        def open_browser() -> None:
            print("[AUTH] Kakao Login URL:")
            print(url)
            opened = _open_browser(url)
            print("[AUTH] Android browser open: " + ("OK" if opened else "FAILED"))
        try:
            return login_from_code(client_id, client_secret, redirect_uri, wait_for_callback(redirect_uri, state, on_ready=open_browser))
        except KakaoOAuthError as exc:
            if not str(exc).startswith("Timed out waiting for Kakao OAuth callback"):
                raise
            return login_from_code(client_id, client_secret, redirect_uri, _manual_callback(state))

    print("[AUTH] Kakao Login URL:")
    print(url)
    _open_browser(url)
    callback = input("[AUTH] After login, paste the full callback URL here: ").strip()
    query = parse_qs(urlparse(callback).query)
    if query.get("state", [""])[0] != state:
        raise KakaoOAuthError("OAuth state mismatch")
    if query.get("error", [""])[0]:
        raise KakaoOAuthError(query.get("error_description", query["error"])[0])
    code = query.get("code", [""])[0]
    if not code:
        raise KakaoOAuthError("Callback URL did not contain an authorization code")
    return login_from_code(client_id, client_secret, redirect_uri, code)


def save_session(session: OAuthSession, path: str = DEFAULT_SESSION_FILE) -> None:
    target = Path(path).expanduser(); target.parent.mkdir(parents=True, exist_ok=True)
    try: target.parent.chmod(0o700)
    except OSError: pass
    target.write_text(json.dumps(asdict(session), ensure_ascii=False, indent=2), encoding="utf-8")
    try: target.chmod(0o600)
    except OSError: pass


def delete_session(path: str = DEFAULT_SESSION_FILE) -> None:
    target = Path(path).expanduser()
    try:
        target.unlink()
    except FileNotFoundError:
        pass
    except OSError as exc:
        raise KakaoOAuthError(f"Could not delete local session file: {exc}") from exc


def load_session(path: str = DEFAULT_SESSION_FILE) -> Optional[OAuthSession]:
    target = Path(path).expanduser()
    if not target.exists(): return None
    try:
        return OAuthSession(**json.loads(target.read_text(encoding="utf-8")))
    except (OSError, ValueError, TypeError, KeyError): return None
