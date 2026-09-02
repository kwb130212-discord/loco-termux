# loco-termux

Node.js + TypeScript Termux bot template using `node-kakao`.

> `node-kakao` is an unofficial client and may stop working or result in service restrictions. Use a test/dedicated account and comply with KakaoTalk's rules.

## Current features

- TypeScript + strict compiler configuration
- `node-kakao` 4.5.0 authentication layer
- Interactive Termux configuration; no `.env` is required for account setup
- Local persistent configuration at `~/.loco-termux/config.json`
- Configuration directory `0700` and config file `0600` where supported
- Automatic config normalization/migration for malformed or older values
- Multiple account entries with persistent device UUIDs
- Room allow-list and per-room enabled state
- Admin/moderator configuration
- Chat statistics
- Join/leave event history
- Command audit log
- 8-digit `!봇등록` room registration code with a 5-minute lifetime
- `!핑`, `!명령어`, `!echo`, `!채팅순위`, `!입퇴장로그`, `!봇정보`, `!봇등록`, `!방등록해제`
- `kick` reply workflow when the underlying channel API exposes a supported member-removal operation
- Termux bridge management panel with room, admin, settings, logs, statistics and data-maintenance screens
- `00` returns to the panel from a detail screen
- Mock login for local UI/testing only
- Authentication diagnostics that report failures without fabricating sessions

## Termux setup

```bash
pkg update
pkg install nodejs-lts git

git clone https://github.com/kwb130212-discord/loco-termux.git
cd loco-termux
npm install
npm run build
npm run start:loco
```

## Panel

The bridge panel provides:

```text
1  방 설정
2  방 목록
3  관리자
4  설정
5  명령 로그
6  통계
7  명령 로그 초기화
8  데이터 정리
00 패널 복귀
9  종료
```

## Configuration

Configuration is stored locally at:

```text
~/.loco-termux/config.json
```

The loader validates and normalizes lists, timestamps, counters, accounts and room configuration. Invalid configuration falls back to safe defaults rather than crashing startup. Persistent statistics and logs are bounded to prevent unbounded growth.

**Do not commit `~/.loco-termux/config.json` or any real credentials to GitHub.**

## Room registration

There are two supported ways to configure rooms:

1. Set the allow-list from the Termux panel.
2. Use `!봇등록` in a room to generate an 8-digit registration code, then send that code in the same room before it expires.

When a room allow-list is non-empty, the bot only handles configured rooms. Game-related commands are intentionally not included in this project.

## Authentication

The login menu contains:

```text
1. 기본 로그인
2. QR 로그인
3. 카카오톡 간편 로그인
4. 테스트 가짜 로그인
5. 뒤로가기
```

Only the authentication APIs actually exposed by the installed library are called. The QR and KakaoTalk-style convenience entries do not invent unsupported endpoints, and no fake session is created when real authentication fails. The mock option is explicitly local/test-only.

The project does not implement authentication bypasses, packet interception, anti-reversing bypasses, or rate-limit evasion.
