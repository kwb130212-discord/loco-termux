import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createAuthByQR } from './kakaoforge-loader';

const DATA_DIR = join(homedir(), '.loco-termux');
const AUTH_PATH = join(DATA_DIR, 'kakaoforge-auth.json');

async function main() {
  mkdirSync(DATA_DIR, { recursive: true });

  console.log('');
  console.log('========================================');
  console.log('       LOCO Termux - Kakao QR 로그인');
  console.log('========================================');
  console.log('[1] 카카오톡에서 QR을 스캔합니다.');
  console.log('[2] 로그인 승인을 직접 진행합니다.');
  console.log('[3] 승인 완료 후 인증 파일을 저장합니다.');
  console.log('');

  if (existsSync(AUTH_PATH)) {
    console.log(`[INFO] 기존 인증 파일이 있습니다: ${AUTH_PATH}`);
    console.log('[INFO] 새 QR 로그인을 진행하면 인증 정보가 갱신됩니다.');
  }

  try {
    const auth = await createAuthByQR({
      authPath: AUTH_PATH,
      save: true,
    });

    console.log('');
    console.log('[OK] QR 로그인 성공');
    console.log(`[OK] userId: ${String(auth.userId)}`);
    console.log(`[OK] auth: ${AUTH_PATH}`);
    console.log('');
    console.log('이제 npm run start:openchat 으로 LOCO 연결을 시작할 수 있습니다.');
  } catch (error) {
    console.error('');
    console.error('[FAIL] QR 로그인 실패');
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  }
}

main();
