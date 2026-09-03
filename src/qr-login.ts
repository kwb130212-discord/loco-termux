import { mkdirSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createAuthByQR, createClient } from 'kakaoforge';
import type { AuthPayload } from 'kakaoforge';
import qrcode from 'qrcode-terminal';
import { loadConfig } from './config';

const DATA_DIR = join(homedir(), '.loco-termux');
const AUTH_PATH = join(DATA_DIR, 'auth.json');

export type LocoQrLoginResult = AuthPayload & { client: any };

function ensureSecureDataDir(): void {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  try { chmodSync(DATA_DIR, 0o700); } catch {}
}

/**
 * Perform KakaoForge's KakaoTalk sub-device QR flow.
 * The user must approve the QR on their own KakaoTalk device.
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

  console.log('');
  console.log('========================================');
  console.log('       LOCO Termux - LOCO QR LOGIN');
  console.log('========================================');
  console.log('[AUTH] KakaoTalk 비공식 클라이언트용 QR 인증을 시작합니다.');
  console.log('[AUTH] KakaoTalk에서 QR을 직접 승인해야 합니다.');
  console.log('[AUTH] OAuth REST API Key/비밀번호 입력은 사용하지 않습니다.');
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
      console.log('[QR] 아래 터미널 QR을 KakaoTalk로 스캔/승인하세요.');
      qrcode.generate(url, { small: true });
      console.log(`[QR] 원본 값: ${url}`);
      console.log('');
    },
    onPasscode: (passcode: string) => {
      console.log(`[QR] 확인 코드: ${passcode}`);
      console.log('[QR] KakaoTalk에 표시된 코드와 일치하는지 확인하세요.');
    },
  });

  if (!payload.userId || !payload.accessToken || !payload.deviceUuid) {
    throw new Error('QR 인증은 완료되었지만 LOCO 인증 정보가 완전하지 않습니다.');
  }

  console.log(`[OK] LOCO QR 인증 성공: userId=${payload.userId}`);
  console.log(`[OK] auth=${AUTH_PATH}`);
  console.log('[LOCO] 인증 결과로 KakaoForge 클라이언트를 연결합니다.');

  const client = createClient({
    userId: payload.userId,
    oauthToken: payload.accessToken,
    refreshToken: payload.refreshToken,
    deviceUuid: payload.deviceUuid,
    authPath: AUTH_PATH,
    autoConnect: true,
  });

  client.on?.('error', (error: unknown) => {
    console.error('[LOCO]', error instanceof Error ? error.message : String(error));
  });

  return { ...payload, client };
}

async function main(): Promise<void> {
  try {
    const config = loadConfig();
    const account = config.accounts.find(a => a.email === config.activeAccount) ?? config.accounts[0];
    const result = await loginLocoByQR({ deviceUuid: account?.deviceUuid });

    console.log('');
    console.log('[READY] LOCO 클라이언트 연결을 시작했습니다.');
    console.log('[READY] 인증 파일: ~/.loco-termux/auth.json');
    console.log(`[READY] userId=${result.userId}`);
    console.log('');
  } catch (error) {
    console.error('[FAIL]', error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main();
}
