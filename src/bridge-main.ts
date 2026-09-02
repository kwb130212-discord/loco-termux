import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { loadConfig, saveConfig, type Account } from './config';

const config = loadConfig();
let activeAccount: Account | null = null;
let loggedIn = false;
let authStatus = '미인증';
let sessionId = '';

async function ask(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input, output });
  try { return (await rl.question(prompt)).trim(); }
  finally { rl.close(); }
}

function runCommand(command: string, args: string[], timeout = 300_000) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    timeout,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
}

function runPython(args: string[]) {
  const candidates = [process.env.PYTHON_BIN, 'python3', 'python'].filter(Boolean) as string[];
  let last: ReturnType<typeof spawnSync> | null = null;
  for (const command of candidates) {
    const result = runCommand(command, args, 210_000);
    last = result;
    if (!result.error) return result;
  }
  return last;
}

function updateTermux(): void {
  console.clear();
  console.log('================================');
  console.log('       LOCO-TERMUX UPDATE        ');
  console.log('================================');
  console.log('[UPDATE] GitHub main 최신 버전 확인 중...');

  const pull = runCommand('git', ['pull', '--ff-only', 'origin', 'main'], 120_000);
  if (pull.stdout?.trim()) console.log(pull.stdout.trim());
  if (pull.stderr?.trim()) console.error(pull.stderr.trim());
  if (pull.error || pull.status !== 0) {
    console.log(`[FAIL] GitHub 업데이트 실패: ${pull.error?.message ?? `exit=${pull.status}`}`);
    console.log('[TIP] 로컬 수정사항이 있으면 먼저 커밋/되돌린 뒤 다시 시도하세요.');
    return;
  }

  console.log('[UPDATE] 의존성 최신 상태로 동기화 중...');
  const install = runCommand('npm', ['install'], 300_000);
  if (install.stdout?.trim()) console.log(install.stdout.trim());
  if (install.stderr?.trim()) console.error(install.stderr.trim());
  if (install.error || install.status !== 0) {
    console.log(`[FAIL] npm install 실패: ${install.error?.message ?? `exit=${install.status}`}`);
    return;
  }

  console.log('[UPDATE] 최신 소스 빌드 중...');
  const build = runCommand('npm', ['run', 'build'], 300_000);
  if (build.stdout?.trim()) console.log(build.stdout.trim());
  if (build.stderr?.trim()) console.error(build.stderr.trim());
  if (build.error || build.status !== 0) {
    console.log(`[FAIL] 빌드 실패: ${build.error?.message ?? `exit=${build.status}`}`);
    return;
  }

  console.log('[OK] 최신 버전 업데이트 완료. 프로그램을 재시작합니다.');
  const child = spawn(process.execPath, ['dist/bridge-main.js'], { stdio: 'inherit' });
  child.on('error', error => {
    console.error(`[FAIL] 재시작 실패: ${error.message}`);
    process.exitCode = 1;
  });
  process.exit(0);
}

function showPanel(): void {
  console.clear();
  console.log('================================');
  console.log('        LOCO-TERMUX TEST         ');
  console.log('================================');
  console.log(`계정 : ${activeAccount?.email ?? config.activeAccount ?? '없음'}`);
  console.log(`인증 : ${loggedIn ? '성공' : authStatus}`);
  console.log(`세션 : ${sessionId || '없음'}`);
  console.log('--------------------------------');
  console.log('1. 계정 등록/선택');
  console.log('2. Kakao OAuth 로그인');
  console.log('3. OAuth 설정');
  console.log('4. 현재 상태');
  console.log('5. GitHub 최신버전 업데이트');
  console.log('6. 종료');
  console.log('================================');
}

async function registerAccount(): Promise<void> {
  const email = await ask('카카오 계정 식별자(로그인 힌트용, 선택): ');
  if (!email) return;
  const index = config.accounts.findIndex(a => a.email === email);
  const account: Account = index >= 0 ? config.accounts[index] : { email, deviceUuid: crypto.randomUUID() };
  if (index >= 0) config.accounts[index] = account;
  else config.accounts.push(account);
  config.activeAccount = email;
  activeAccount = account;
  saveConfig(config);
  console.log('[OK] 계정 저장');
}

async function selectAccount(): Promise<Account | null> {
  if (!config.accounts.length) { await registerAccount(); return activeAccount; }
  console.log('\n등록 계정');
  config.accounts.forEach((account, i) => console.log(`${i + 1}. ${account.email}`));
  const raw = await ask('번호(엔터=현재): ');
  if (!raw) return config.accounts.find(a => a.email === config.activeAccount) ?? config.accounts[0];
  const index = Number(raw) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= config.accounts.length) return null;
  activeAccount = config.accounts[index];
  config.activeAccount = activeAccount.email;
  saveConfig(config);
  return activeAccount;
}

async function configureOAuth(): Promise<void> {
  console.log('\nOAuth 설정');
  const clientId = await ask(`REST API Key [${config.kakao.clientId ? '설정됨' : '없음'}]: `);
  const clientSecret = await ask(`Client Secret [${config.kakao.clientSecret ? '설정됨' : '없음'}]: `);
  const redirectUri = await ask(`Redirect URI [${config.kakao.redirectUri}]: `);
  if (clientId) config.kakao.clientId = clientId;
  if (clientSecret) config.kakao.clientSecret = clientSecret;
  if (redirectUri) config.kakao.redirectUri = redirectUri;
  saveConfig(config);
  console.log('[OK] OAuth 설정 저장');
}

async function login(): Promise<void> {
  const account = activeAccount ?? config.accounts.find(a => a.email === config.activeAccount) ?? null;
  if (!account) { console.log('[!] 먼저 계정을 등록하세요.'); return; }
  if (!config.kakao.clientId || !config.kakao.redirectUri) {
    authStatus = 'OAuth 설정 필요';
    console.log('[!] 먼저 OAuth 설정을 입력하세요.');
    return;
  }
  authStatus = '인증중';
  console.log('[LOGIN] 실제 Kakao OAuth 인증 시작');
  const result = runPython([
    '분석기_cli.py', '--oauth-login', '--client-id', config.kakao.clientId,
    '--client-secret', config.kakao.clientSecret, '--redirect-uri', config.kakao.redirectUri,
    '--login-hint', account.email,
  ]);
  if (!result || result.error) {
    authStatus = '실패';
    console.log(`[FAIL] Python 실행 실패: ${result?.error?.message ?? 'unknown'}`);
    return;
  }
  if (result.stderr?.trim()) console.error(result.stderr.trim());
  try {
    const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
    const payload = JSON.parse(lines.at(-1) ?? '');
    if (result.status !== 0 || !payload.ok || !payload.authenticated) {
      authStatus = '실패';
      console.log(`[FAIL] Kakao 인증 실패: ${payload?.error ?? `exit=${result.status}`}`);
      return;
    }
    activeAccount = account;
    config.activeAccount = account.email;
    saveConfig(config);
    loggedIn = true;
    authStatus = '성공';
    sessionId = String(payload.session_id ?? '');
    console.log(`[OK] Kakao OAuth 로그인 성공: ${payload.nickname ?? account.email}`);
    console.log(`[OK] session=${sessionId}`);
  } catch (error) {
    authStatus = '응답 오류';
    console.log(`[FAIL] 인증 응답 파싱 실패: ${error instanceof Error ? error.message : error}`);
  }
}

async function main(): Promise<void> {
  while (true) {
    showPanel();
    const choice = await ask('> ');
    if (choice === '1') await selectAccount();
    else if (choice === '2') await login();
    else if (choice === '3') await configureOAuth();
    else if (choice === '4') {
      console.log(`\n상태=${authStatus}`);
      console.log(`로그인=${loggedIn}`);
      console.log(`세션=${sessionId || '없음'}`);
      await ask('엔터 > ');
    } else if (choice === '5') {
      updateTermux();
    } else if (choice === '6' || choice === 'exit') {
      saveConfig(config);
      return;
    }
  }
}

main().catch(error => {
  console.error('[FATAL]', error);
  process.exitCode = 1;
});
