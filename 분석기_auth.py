from __future__ import annotations

"""Real Kakao Login OAuth adapter for the analyzer.

This module uses Kakao's documented OAuth authorization-code flow. It never
accepts or submits a Kakao account password, fabricates a session, or ignores
server authentication failures.
"""

from dataclasses import dataclass, asdict
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Optional
from urllib.parse import urlencode, urlparse, parse_qs
import json
import secrets
import time
import urllib.error
import urllib.request
import webbrowser


AUTH_URL = "https://kauth.kakao.com/oauth/authorize"
TOKEN_URL = "https://kauth.kakao.com/oauth/token"
ME_URL = "https://kapi.kakao.com/v2/user/me"


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


class KakaoOAuthError(RuntimeError):
    pass


def _post_form(url: str, data: dict[str, str], timeout: int = 20) -> dict:
    body = urlencode(data).encode()
    request = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8")
            return json.loads(raw)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:1000]
        raise KakaoOAuthError(f"Kakao token endpoint HTTP {exc.code}: {detail}") from exc
    except (urllib.error.URLError, TimeoutError) as exc:
        raise KakaoOAuthError(f"Kakao token endpoint connection failed: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise KakaoOAuthError("Kakao token endpoint returned invalid JSON") from exc


def _get_json(url: str, access_token: str, timeout: int = 20) -> dict:
    request = urllib.request.Request(
        url,
        headers={"Authorization": f"Bearer {access_token}"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:1000]
        raise KakaoOAuthError(f"Kakao user API HTTP {exc.code}: {detail}") from exc
    except (urllib.error.URLError, TimeoutError) as exc:
        raise KakaoOAuthError(f"Kakao user API connection failed: {exc}") from exc


def build_authorize_url(client_id: str, redirect_uri: str, state: str, login_hint: str = "") -> str:
    params = {
        "response_type": "code",
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "state": state,
    }
    if login_hint:
        params["login_hint"] = login_hint
    return f"{AUTH_URL}?{urlencode(params)}"


def exchange_code(client_id: str, client_secret: str, redirect_uri: str, code: str) -> dict:
    return _post_form(TOKEN_URL, {
        "grant_type": "authorization_code",
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "code": code,
        "client_secret": client_secret,
    })


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
        user_id=str(account_id),
        nickname=nickname,
        created_at=int(time.time()),
    )


def wait_for_callback(redirect_uri: str, expected_state: str, timeout: int = 180) -> str:
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
                self.send_response(404)
                self.end_headers()
                return
            query = parse_qs(incoming.query)
            if query.get("state", [""])[0] != expected_state:
                result["error"] = "OAuth state mismatch"
            elif query.get("error", [""])[0]:
                result["error"] = query.get("error_description", query["error"])[0]
            else:
                result["code"] = query.get("code", [""])[0]
                if not result["code"]:
                    result["error"] = "Callback did not contain an authorization code"
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write("Kakao login callback received. Return to Termux.".encode())

        def log_message(self, *_args):
            return

    server = HTTPServer((parsed.hostname, parsed.port), Handler)
    server.timeout = 1
    deadline = time.time() + timeout
    try:
        while time.time() < deadline and not result:
            server.handle_request()
    finally:
        server.server_close()
    if result.get("error"):
        raise KakaoOAuthError(result["error"])
    if not result.get("code"):
        raise KakaoOAuthError("Timed out waiting for Kakao OAuth callback")
    return result["code"]


def login_interactive(client_id: str, client_secret: str, redirect_uri: str, login_hint: str = "") -> OAuthSession:
    state = secrets.token_urlsafe(32)
    url = build_authorize_url(client_id, redirect_uri, state, login_hint)
    print("[AUTH] Open this Kakao Login URL in a browser:")
    print(url)
    try:
        webbrowser.open(url)
    except Exception:
        pass

    parsed = urlparse(redirect_uri)
    if parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "localhost"}:
        code = wait_for_callback(redirect_uri, state)
    else:
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


def save_session(session: OAuthSession, path: str) -> None:
    target = Path(path).expanduser()
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(asdict(session), ensure_ascii=False, indent=2), encoding="utf-8")
    try:
        target.chmod(0o600)
    except OSError:
        pass


def load_session(path: str) -> Optional[OAuthSession]:
    target = Path(path).expanduser()
    if not target.exists():
        return None
    try:
        raw = json.loads(target.read_text(encoding="utf-8"))
        return OAuthSession(**raw)
    except (OSError, ValueError, TypeError, KeyError):
        return None
