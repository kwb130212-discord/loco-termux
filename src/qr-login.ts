import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { loadConfig } from './config';

const DATA_DIR = join(homedir(), '.loco-termux');
const SESSION_PATH = join(DATA_DIR, 'kakao-session.json');

function pythonCandidates(): string[] {
  return [process.env.PYTHON_BIN, 'python3', 'python'].filter(Boolean) as string[];
}

function runPython(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const candidates = pythonCandidates();
    let index = 0;

    const next = () => {
      const command = candidates[index++];
      if (!command) {
        resolve({ code: 127, stdout: '', stderr: 'Python 실행 파일을 찾을 수 없습니다.' });
        return;
      }

      let stdout = '';
      let stderr = '';
      let spawned = false;
      const child = spawn(command, args, {
        cwd: process.cwd(),
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
        stdio: ['inherit', 'pipe', 'pipe'],
      });

      child.once('spawn', () => { spawned = true; });
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => { const text = String(chunk); stdout += text; process.stdout.write(text); });
      child.stderr.on('data', chunk => { const text = String(chunk); stderr += text; process.stderr.write(text); });
      child.once('error', error => {
        if (!spawned) next();
        else resolve({ code: 1, stdout, stderr: stderr || error.message });
      });
      child.once('close', code => resolve({ code, stdout, stderr }));
    };

    next();
  });
}

function lastJsonLine(stdout: string): Record<string, any> {
  const lines = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const value = JSON.parse(lines[i]);
      if (value && typeof value === 'object') return value;
    } catch {}
  }
  return {};
}

async function main() {
  mkdirSync(DATA_DIR, { recursive: true });
  const config = loadConfig();

  console.log('');
  console.log('========================================');
  console.log('      LOCO Termux - 로컬 QR 로그인');
  console.log('========================================');
  console.log('[AUTH] QR 로그인 코드는 loco-termux 내부에 포함되어 있습니다.');
  console.log('[AUTH] npm/Git 기반 QR 인증 모듈을 실행하지 않습니다.');
  console.log('[AUTH] QR/브라우저에서 본인 로그인을 직접 승인해야 합니다.');
  console.log('');

  if (!config.kakao.clientId) {
    console.error('[FAIL] REST API Key(clientId)가 설정되지 않았습니다.');
    console.error('[INFO] LOCO Termux 패널의 OAuth 설정에서 먼저 입력하세요.');
    process.exitCode = 2;
    return;
  }

  const args = [
    '분석기_cli.py', '--qr-login',
    '--client-id', config.kakao.clientId,
    '--client-secret', config.kakao.clientSecret || '',
    '--redirect-uri', config.kakao.redirectUri || 'http://127.0.0.1:8765/callback',
    '--session-file', SESSION_PATH,
  ];

  const result = await runPython(args);
  const payload = lastJsonLine(result.stdout);

  if (result.code !== 0 || payload.ok !== true || payload.authenticated !== true) {
    console.error('');
    console.error('[FAIL] QR 로그인 실패');
    console.error(`[FAIL] ${payload.error || payload.reason || `exit=${result.code}`}`);
    process.exitCode = result.code || 1;
    return;
  }

  console.log('');
  console.log('[OK] 로컬 QR 로그인 성공');
  console.log(`[OK] 사용자: ${payload.nickname || payload.user_id || 'Kakao User'}`);
  console.log(`[OK] 세션: ${SESSION_PATH}`);
  console.log('');
  console.log('[NOTE] 현재 QR 방식은 Kakao 공식 OAuth 인증입니다.');
  console.log('[NOTE] 이것만으로 KakaoTalk 비공식 LOCO 세션이 생성되는 것은 아닙니다.');
}

main().catch(error => {
  console.error('[FATAL]', error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
