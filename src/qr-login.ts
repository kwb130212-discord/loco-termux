import { mkdirSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createAuthByQR, createClient } from './kakaoforge-loader';
import type { AuthPayload } from './kakaoforge-loader';
import qrcode from 'qrcode-terminal';
import { loadConfig } from './config';

const DATA_DIR = join(homedir(), '.loco-termux');
const AUTH_PATH = join(DATA_DIR, 'auth.json');

export type LocoQrLoginResult = AuthPayload & { client: any };

const T = {
  reset: '\x1b[0m',
  cyan: '\x1b[36m',
  blue: '\x1b[34m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
};

function ensureSecureDataDir(): void {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  try { chmodSync(DATA_DIR, 0o700); } catch {}
}

function line(char = '─', width = 52): string {
  return char.repeat(width);
}

function printHeader(): void {
  console.clear();
  console.log(`${T.cyan}${T.bold}╭${line()}╮${T.reset}`);
  console.log(`${T.cyan}${T.bold}│${T.reset} ${T.bold}LOCO-TERMUX${T.reset}  ${T.dim}SECURE LOGIN PANEL${T.reset}             ${T.cyan}${T.bold}│${T.reset}`);
  console.log(`${T.cyan}${T.bold}│${T.reset} ${T.dim}KakaoForge QR Authentication${T.reset}                  ${T.cyan}${T.bold}│${T.reset}`);
  console.log(`${T.cyan}${T.bold}╰${line()}╯${T.reset}`);
  console.log('');
}

function printStatus(title: string, message: string, color = T.cyan): void {
  console.log(`${color}${T.bold}┌─ ${title}${T.reset}`);
  console.log(`${T.dim}│${T.reset} ${message}`);
  console.log(`${T.dim}└${T.reset}`);
}

/**
 * Perform KakaoForge's KakaoTalk sub-device QR flow.
 * The user must approve the QR on their own KakaoTalk device.
 * Login transport/options are intentionally unchanged; this file only improves
 * the terminal presentation around the existing QR authentication flow.
 */
export async function loginLocoByQR(options: {
  deviceUuid?: string;
  deviceName?: string;
  modelName?: string;
  forced?: boolean;
  checkAllowlist?: boolean;
  enforceAllowlist?: boolean;
  appVer?: string;
} = {}): Promise<LocoQrLoginResult> {
  ensureSecureDataDir();
  printHeader();

  printStatus('AUTHENTICATION', 'KakaoTalk QR 승인을 기다리는 중입니다.', T.blue);
  console.log(`${T.dim}  • OAuth REST API Key / 비밀번호 입력 없음${T.reset}`);
  console.log(`${T.dim}  • 본인 KakaoTalk 앱에서 직접 승인${T.reset}`);
  console.log(`${T.dim}  • QR은 보안상 터미널에만 표시${T.reset}`);
  console.log('');

  const payload = await createAuthByQR({
    authPath: AUTH_PATH,
    deviceUuid: options.deviceUuid,
    deviceName: options.deviceName || 'LOCO-Termux',
    modelName: options.modelName || 'SM-T733',
    forced: options.forced === true,
    checkAllowlist: options.checkAllowlist ?? true,
    enforceAllowlist: options.enforceAllowlist ?? false,
    appVer: options.appVer,
    save: true,
    onQrUrl: (url: string) => {
      console.log('');
      console.log(`${T.cyan}${T.bold}╔════════════════════════════════════════════════════════════╗${T.reset}`);
      console.log(`${T.cyan}${T.bold}║${T.reset}              ${T.bold}KAKAOTALK QR LOGIN${T.reset}                     ${T.cyan}${T.bold}║${T.reset}`);
      console.log(`${T.cyan}${T.bold}╠════════════════════════════════════════════════════════════╣${T.reset}`);
      console.log(`${T.cyan}${T.bold}║${T.reset}  ${T.green}${T.bold}①${T.reset} KakaoTalk 앱 실행                                 ${T.cyan}${T.bold}║${T.reset}`);
      console.log(`${T.cyan}${T.bold}║${T.reset}  ${T.green}${T.bold}②${T.reset} QR 로그인/기기 연결 메뉴 선택                     ${T.cyan}${T.bold}║${T.reset}`);
      console.log(`${T.cyan}${T.bold}║${T.reset}  ${T.green}${T.bold}③${T.reset} 아래 ${T.bold}큰 QR 코드${T.reset} 스캔 → 승인                    ${T.cyan}${T.bold}║${T.reset}`);
      console.log(`${T.cyan}${T.bold}╚════════════════════════════════════════════════════════════╝${T.reset}`);
      console.log('');
      console.log(`${T.yellow}${T.bold}                 ▼ QR CODE — 크게 표시 ▼${T.reset}`);
      console.log('');
      // small:false is intentional: the QR is rendered at the largest
      // qrcode-terminal matrix available in the current terminal.
      qrcode.generate(url, { small: false });
      console.log('');
      console.log(`${T.dim}QR content:${T.reset} ${url}`);
      console.log(`${T.yellow}${T.bold}※ QR은 약 60초 후 만료될 수 있습니다.${T.reset}`);
      console.log(`${T.dim}스캔 후 이 화면을 닫지 말고 승인 완료를 기다리세요.${T.reset}`);
      console.log('');
    },
    onPasscode: (passcode: string) => {
      printStatus('VERIFY CODE', `${T.bold}${passcode}${T.reset}  ← KakaoTalk에 표시된 코드와 대조하세요.`, T.yellow);
    },
  });

  if (!payload.userId || !payload.accessToken || !payload.deviceUuid) {
    throw new Error('QR 인증은 완료되었지만 LOCO 인증 정보가 완전하지 않습니다.');
  }

  console.log('');
  printStatus('LOGIN SUCCESS', `userId=${payload.userId}`, T.green);
  console.log(`${T.dim}인증 파일:${T.reset} ${AUTH_PATH}`);
  console.log(`${T.green}${T.bold}✓${T.reset} KakaoForge 클라이언트 연결 준비 완료`);
  console.log('');

  const client = createClient({
    userId: payload.userId,
    oauthToken: payload.accessToken,
    refreshToken: payload.refreshToken,
    deviceUuid: payload.deviceUuid,
    authPath: AUTH_PATH,
    autoConnect: true,
  });

  client.on?.('error', (error: unknown) => {
    console.error(`${T.red}[LOCO]${T.reset}`, error instanceof Error ? error.message : String(error));
  });

  return { ...payload, client };
}

async function main(): Promise<void> {
  try {
    const config = loadConfig();
    const account = config.accounts.find(a => a.email === config.activeAccount) ?? config.accounts[0];
    const result = await loginLocoByQR({ deviceUuid: account?.deviceUuid });

    console.log(`${T.cyan}${T.bold}╭${line()}╮${T.reset}`);
    console.log(`${T.cyan}${T.bold}│${T.reset} ${T.green}${T.bold}READY${T.reset}  LOCO 클라이언트 연결을 시작했습니다.`.padEnd(61) + `${T.cyan}${T.bold}│${T.reset}`);
    console.log(`${T.cyan}${T.bold}╰${line()}╯${T.reset}`);
    console.log(`${T.dim}인증 파일:${T.reset} ~/.loco-termux/auth.json`);
    console.log(`${T.dim}userId:${T.reset} ${result.userId}`);
    console.log('');
  } catch (error) {
    console.error(`${T.red}${T.bold}[FAIL]${T.reset}`, error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main();
}
