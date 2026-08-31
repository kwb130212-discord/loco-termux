# loco-termux

Node.js + TypeScript KakaoTalk bot template using `node-kakao` (Loco protocol compatible library).

> `node-kakao` is an unofficial client and its README warns that it can stop working and that abuse can result in service restriction. Use a test/dedicated account and comply with KakaoTalk's rules.

## Features

- TypeScript project structure
- `node-kakao` v4.5.0
- Environment-based credentials
- `!ping`, `!help`, `!echo`, `!args` commands
- Minimal error handling and clean startup logs
- Termux-friendly npm scripts

## Termux setup

```bash
pkg update
pkg install nodejs-lts git

git clone https://github.com/kwb130212-discord/loco-termux.git
cd loco-termux
npm install
cp .env.example .env
nano .env
npm run build
npm start
```

## Environment

```env
KAKAO_EMAIL=your-account@example.com
KAKAO_PASSWORD=your-password
KAKAO_DEVICE_NAME=loco-termux
KAKAO_DEVICE_UUID=your-stable-device-uuid
PREFIX=!
```

Never commit `.env` or real credentials.

## Commands

- `!ping`
- `!help`
- `!echo hello`
- `!args one two three`

## Notes

The project deliberately does not implement authentication bypasses, packet interception, anti-reversing bypasses, or rate-limit evasion. The protocol layer is kept behind `node-kakao` so bot features can be expanded independently.
