# loco-termux

Node.js + TypeScript KakaoTalk bot template using `node-kakao`.

> `node-kakao` is an unofficial client and may stop working or result in service restrictions. Use a test/dedicated account and comply with KakaoTalk's rules.

## Features

- TypeScript project structure
- `node-kakao` v4.5.0
- **No `.env` setup required for account configuration**
- Interactive Termux panel for account registration and room settings
- Local persistent configuration under `~/.loco-termux/config.json`
- Password input is hidden in the terminal
- `!ping`, `!help`, `!echo`, `!args` style bot commands
- Chat statistics and member join/leave logs
- Termux-friendly npm scripts

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

### Interactive configuration

After starting the bot, use the panel:

```text
╔══════════════════════════════════╗
║          LOCO TERMUX BOT         ║
╚══════════════════════════════════╝

[+] 1번 봇 시작
[+] 2번 계정 등록
[+] 3번 계정 목록
[+] 4번 방 설정
[+] 5번 설정 확인
[+] 6번 종료
```

Choose **2번 계정 등록** to enter the account in the terminal. The password is entered without echoing it to the screen.

Configuration is stored locally at:

```text
~/.loco-termux/config.json
```

The configuration directory is created with restricted permissions and the config file is written with mode `600` where supported by Termux.

**Do not commit `~/.loco-termux/config.json` or any real credentials to GitHub.**

## Room settings

Use **4번 방 설정** in the panel to set allowed rooms. The bot only handles commands/events for configured rooms when a room list is present.

## Commands

- `!핑`
- `!명령어`
- `!echo hello`
- `!채팅순위`
- `!입퇴장로그`
- `!전체보기`
- `!봇정보`
- `!봇등록`
- `!방등록해제`

## Notes

The project does not implement authentication bypasses, packet interception, anti-reversing bypasses, or rate-limit evasion. Authentication remains behind `node-kakao`.
