import { mkdirSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createAuthByQR, createClient, type AuthPayload } from './kakaoforge-runtime';
import qrcode from 'qrcode-terminal';

const DATA_DIR = join(homedir(), '.loco-termux');
const AUTH_PATH = join(DATA_DIR, 'kakaoforge-auth.json');

export type LocoQrLoginResult = AuthPayload & { client: ReturnType<typeof createClient> };
const T = { reset: '\x1b[0m', cyan: '\x1b[36m', blue: '\x1b[34m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', dim: '\x1b[2m', bold: '\x1b[1m' };
function ensureSecureDataDir(): void { mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 }); try { chmodSync(DATA_DIR, 0o700); } catch {} }
function line(char = '─', width = 52): string { return char.repeat(width); }
function header(): void { console.clear(); console.log(`${T.cyan}${T.bold}╭${line()}╮${T.reset}`); console.log(`${T.cyan}${T.bold}│${T.reset} ${T.bold}LOCO-TERMUX${T.reset}  ${T.dim}KakaoForge QR LOGIN${T.reset}          ${T.cyan}${T.bold}│${T.reset}`); console.log(`${T.cyan}${T.bold}╰${line()}╯${T.reset}\n`); }
function status(title: string, message: string, color = T.cyan): void { console.log(`${color}${T.bold}┌─ ${title}${T.reset}`); console.log(`${T.dim}│${T.reset} ${message}`); console.log(`${T.dim}└${T.reset}`); }
function deviceUuid(): string { return createHash('sha256').update(`${randomUUID()}-${Date.now()}`, 'utf8').digest('hex'); }

export async function loginLocoByQR(options: { deviceUuid?: string; deviceName?: string; modelName?: string; forced?: boolean; checkAllowlist?: boolean; enforceAllowlist?: boolean; appVer?: string } = {}): Promise<LocoQrLoginResult> {
  ensureSecureDataDir(); header();
  const uuid = options.deviceUuid || deviceUuid();
  status('AUTHENTICATION', '정상 QR 인증 흐름을 시작합니다.', T.blue);
  console.log(`${T.dim}• 비밀번호 수집/인증 우회 없음${T.reset}`);
  console.log(`${T.dim}• KakaoTalk 앱에서 직접 QR 승인${T.reset}\n`);
  const payload = await createAuthByQR({
    authPath: AUTH_PATH, deviceUuid: uuid, deviceName: options.deviceName || 'LOCO-Termux', modelName: options.modelName || 'LOCO-Termux',
    forced: options.forced === true, checkAllowlist: options.checkAllowlist ?? true, enforceAllowlist: options.enforceAllowlist ?? false, appVer: options.appVer, save: true,
    onQrUrl: (url: string) => { console.log(`${T.yellow}${T.bold}▼ KAKAOTALK QR CODE ▼${T.reset}\n`); qrcode.generate(url, { small: true }); console.log(`\n${T.dim}QR URL:${T.reset} ${url}`); console.log(`${T.yellow}※ QR 만료 전 KakaoTalk에서 승인하세요.${T.reset}\n`); },
    onPasscode: (passcode: string) => status('VERIFY CODE', `${T.bold}${passcode}${T.reset}`, T.yellow),
  });
  if (!payload.userId || !payload.accessToken || !payload.deviceUuid) throw new Error('QR 인증 결과에 필수 인증 정보가 없습니다.');
  status('LOGIN SUCCESS', `userId=${payload.userId}`, T.green); console.log(`${T.dim}인증 파일:${T.reset} ${AUTH_PATH}`);
  const client = createClient({ authPath: AUTH_PATH, autoConnect: true, autoReconnect: true, debug: false });
  client.on('error', (error: unknown) => console.error(`${T.red}[KakaoForge]${T.reset}`, error instanceof Error ? error.message : String(error)));
  return { ...payload, client };
}

async function main(): Promise<void> {
  try { const result = await loginLocoByQR(); console.log(`${T.green}${T.bold}✓ KakaoForge 인증 저장 완료${T.reset}`); console.log(`userId: ${result.userId}`); console.log(`auth: ${AUTH_PATH}`); }
  catch (error) { const message = error instanceof Error ? error.message : String(error); console.error(`${T.red}${T.bold}[FAIL]${T.reset} ${message}`); if (/이용|횟수|overused|too many|rate|limit/i.test(message)) console.error(`${T.yellow}[QR] 서버 사용 제한으로 보입니다. QR을 연속 생성하지 말고 잠시 후 다시 시도하세요.${T.reset}`); process.exitCode = 1; }
}
if (require.main === module) void main();
