import fs from 'node:fs';

/**
 * Keep fatal errors visible in the Termux panel until the user presses Enter.
 * This is intentionally a tiny runtime shim so the bot's existing menu logic
 * does not have to be rewritten just for terminal UX.
 */
const originalClear = console.clear.bind(console);
const originalError = console.error.bind(console);
let waitingForEnter = false;

console.error = (...args: unknown[]) => {
  const text = args.map(String).join(' ');
  if (text.includes('[FATAL]') || text.includes('Web login failed') || text.includes('KakaoTalk login failed')) {
    waitingForEnter = true;
  }
  originalError(...args);
};

console.clear = () => {
  if (waitingForEnter && process.stdin.isTTY) {
    originalError('\n[!] 오류 내용을 확인했습니다. 계속하려면 Enter를 누르세요.');
    try {
      const buffer = Buffer.alloc(1);
      while (true) {
        const count = fs.readSync(0, buffer, 0, 1, null);
        if (count > 0 && (buffer[0] === 10 || buffer[0] === 13)) break;
      }
    } catch {
      // Non-interactive Termux/session: do not block forever.
    }
    waitingForEnter = false;
  }
  originalClear();
};
