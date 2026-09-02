# loco-termux

Node.js + TypeScript Termux bridge using the repository's Python analyzer and Kakao's documented OAuth 2.0 login flow.

## Current features

- TypeScript + strict compiler configuration
- Python analyzer as the canonical room/event state layer
- Real Kakao OAuth authorization-code authentication
- Termux interactive account and OAuth configuration
- No Kakao account password is stored or submitted by this project
- Local persistent configuration at `~/.loco-termux/config.json`
- Configuration directory `0700` and config file `0600` where supported
- Multiple account entries with persistent device UUIDs
- Room allow-list and per-room enabled state
- Admin/moderator configuration
- Chat statistics
- Join/leave event history
- Command audit log
- 8-digit `!봇등록` room registration code with a 5-minute lifetime
- `!핑`, `!명령어`, `!echo`, `!채팅순위`, `!입퇴장로그`, `!봇정보`, `!봇등록`, `!방등록해제`
- Termux bridge management panel with room, admin, settings, logs, statistics and data-maintenance screens
- Discord webhook logging with account/token/password redaction
- Robust Python executable fallback (`python3` → `python`) and JSON IPC handling
- No forced-success, fake session, or silent `-999` bypass

## Termux setup

```bash
pkg update
pkg install nodejs-lts git python

git clone https://github.com/kwb130212-discord/loco-termux.git
cd loco-termux
npm install
npm run build
npm run start:loco
```

## Authentication

The authentication path is now:

```text
Termux panel
  -> 분석기_cli.py
  -> 분석기_auth.py
  -> Kakao OAuth authorization endpoint
  -> user authentication + consent
  -> registered redirect URI
  -> authorization code
  -> Kakao token endpoint
  -> Kakao user profile
  -> 분석기.py authenticated_user()
  -> Termux authenticated state
```

Kakao's OAuth flow requires a REST API key and a registered redirect URI. If the app uses a client secret, it is supplied to the token request. The redirect URI must match the URI registered for the Kakao app.

For a local Termux callback, the analyzer supports an explicit `http://127.0.0.1:<port>/...` or `http://localhost:<port>/...` redirect URI. Other registered redirect URIs can use the manual callback-URL input mode.

Authentication failures are surfaced as failures. They are recorded as diagnostics rather than converted into successful sessions.

## Panel

```text
1 계정/로그인
  1 계정 등록/수정
  2 등록 계정 선택
  3 선택 계정 Kakao OAuth 로그인
  4 OAuth 설정
  5 세션 상태

2 방 설정
3 방 목록
4 관리자
5 설정 / Discord Webhook
6 명령 로그
7 통계
8 데이터 정리
9 로그아웃
00 패널 복귀
```

## Security

- Do not commit `~/.loco-termux/config.json` or `~/.loco-termux/kakao-session.json`.
- Kakao access/refresh tokens are stored locally with restrictive file permissions when persistence is enabled.
- Passwords are not stored by the account model.
- Tokens and secrets are not sent to Discord webhooks.
- The project does not implement authentication bypasses, packet interception, anti-reversing bypasses, credential stuffing, or rate-limit evasion.

## Room registration

1. Set the room allow-list from the Termux panel, or
2. Use `!봇등록` in a room to generate an 8-digit registration code and complete registration before it expires.

When a room allow-list is non-empty, the bot only handles configured rooms. Game-related commands are intentionally not included in this project.
