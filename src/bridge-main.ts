import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { loadConfig, saveConfig, type Account } from './config';

const config = loadConfig();
let activeAccount: Account | null = config.accounts.find(a => a.email === config.activeAccount) ?? config.accounts[0] ?? null;
let loggedIn = false;
let authStatus = '미인증';
let sessionId = '';
let lastAuthError = '';
let busy = false;
let restoring = false;

async function ask(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input, output });
  try { return (await rl.question(prompt)).trim(); } finally { rl.close(); }
}

function runCommand(command: string, args: string[], timeout = 300_000) {
  return spawnSync(command, args, { encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
}

function runPythonSync(args: string[], timeout = 60_000) {
  const candidates = [process.env.PYTHON_BIN, 'python3', 'python'].filter(Boolean) as string[];
  let last: ReturnType<typeof spawnSync> | null = null;
  for (const command of candidates) { const result = runCommand(command, args, timeout); last = result; if (!result.error) return result; }
  return last;
}

// Fast path: only non-secret session metadata is inspected by Node.
function restoreLocalSessionCache(): boolean {
  try {
    const raw = JSON.parse(readFileSync(`${homedir()}/.loco-termux/kakao-session.json`, 'utf8')) as Record<string, unknown>;
    const userId = String(raw.user_id ?? '');
    const createdAt = Number(raw.created_at ?? 0);
    const expiresIn = Number(raw.expires_in ?? 0);
    if (raw.authenticated !== true || !userId || !createdAt || !expiresIn) return false;
    if (Math.floor(Date.now() / 1000) >= createdAt + Math.max(0, expiresIn) - 60) return false;
    loggedIn = true; authStatus = '성공'; sessionId = `oauth_${userId}`; lastAuthError = '';
    return true;
  } catch { return false; }
}

/**
 * Startup is deliberately cache-first. A valid local session is enough for the
 * interactive panel; network/Python validation is only performed when the user
 * explicitly asks for a re-check. This removes Python startup + network latency
 * from the critical boot path while keeping an authoritative validation path.
 */
async function restoreSession(validate = false): Promise<void> {
  if (restoring || !activeAccount || !config.kakao.clientId) return;
  const cached = restoreLocalSessionCache();
  if (!validate && cached) return;
  if (restoring) return;
  restoring = true;
  if (!cached) authStatus = '세션 복구중';

  const candidates = [process.env.PYTHON_BIN, 'python3', 'python'].filter(Boolean) as string[];
  let child: ReturnType<typeof spawn> | null = null;
  let stdout = '';
  try {
    for (const command of candidates) {
      const attempt = spawn(command, ['분석기_cli.py', '--status', '--client-id', config.kakao.clientId, '--client-secret', config.kakao.clientSecret], {
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const ok = await new Promise<boolean>(resolve => {
        let settled = false;
        attempt.once('spawn', () => { settled = true; resolve(true); });
        attempt.once('error', () => { if (!settled) resolve(false); });
      });
      if (ok) { child = attempt; break; }
    }
    if (!child) {
      if (!cached) { loggedIn = false; sessionId = ''; authStatus = '미인증'; lastAuthError = 'Python 실행 실패'; }
      return;
    }
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', chunk => { stdout += String(chunk); });
    const result = await new Promise<{ code: number | null; error?: string }>(resolve => {
      const timer = setTimeout(() => { child?.kill('SIGTERM'); resolve({ code: null, error: 'session validation timeout' }); }, 10_000);
      child!.once('close', code => { clearTimeout(timer); resolve({ code }); });
      child!.once('error', error => { clearTimeout(timer); resolve({ code: 1, error: error.message }); });
    });
    const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
    const payload = JSON.parse(lines.at(-1) ?? '');
    if (result.code === 0 && payload.ok && payload.authenticated) {
      loggedIn = true; authStatus = '성공'; sessionId = `oauth_${payload.user_id}`; lastAuthError = '';
    } else {
      loggedIn = false; sessionId = ''; authStatus = '미인증';
      if (payload?.reason && payload.reason !== 'no_saved_session') lastAuthError = String(payload.reason);
      else if (result.error) lastAuthError = result.error;
    }
  } catch (error) {
    if (!cached || validate) {
      loggedIn = false; sessionId = ''; authStatus = '미인증';
      lastAuthError = error instanceof Error ? error.message : String(error);
    }
  } finally { restoring = false; }
}

async function login(): Promise<void> {
  const account = activeAccount ?? config.accounts.find(a => a.email === config.activeAccount) ?? null;
  if (!account) { console.log('[!] 먼저 계정을 등록하세요.'); return; }
  if (!config.kakao.clientId || !config.kakao.redirectUri) { authStatus = 'OAuth 설정 필요'; console.log('[!] 먼저 OAuth 설정을 입력하세요.'); return; }
  if (busy) { console.log('[!] 다른 작업이 진행 중입니다.'); return; }
  busy = true; loggedIn = false; sessionId = ''; lastAuthError = ''; authStatus = '인증중';
  console.log('\n================================'); console.log('        KAKAO OAUTH AUTH'); console.log('================================');
  console.log('[AUTH] 실제 Kakao OAuth 인증을 시작합니다.'); console.log('[AUTH] 브라우저에서 로그인을 완료하면 자동으로 복귀합니다.');
  const candidates = [process.env.PYTHON_BIN, 'python3', 'python'].filter(Boolean) as string[];
  let child: ReturnType<typeof spawn> | null = null; let spawnError = '';
  for (const command of candidates) {
    const attempt = spawn(command, ['분석기_cli.py', '--oauth-login', '--client-id', config.kakao.clientId, '--client-secret', config.kakao.clientSecret, '--redirect-uri', config.kakao.redirectUri, '--login-hint', account.email], {
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const ok = await new Promise<boolean>(resolve => { let done = false; attempt.once('spawn', () => { done = true; resolve(true); }); attempt.once('error', error => { if (!done) { spawnError = error.message; resolve(false); } }); });
    if (ok) { child = attempt; break; }
  }
  if (!child) { busy = false; authStatus = '실패'; lastAuthError = spawnError || 'Python 실행 실패'; console.log(`[FAIL] ${lastAuthError}`); return; }
  let stdout = ''; let stderr = '';
  child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', chunk => { const text = String(chunk); stdout += text; for (const line of text.split(/\r?\n/).filter(Boolean)) console.log(`[PY] ${line}`); });
  child.stderr?.on('data', chunk => { const text = String(chunk); stderr += text; for (const line of text.split(/\r?\n/).filter(Boolean)) console.error(`[AUTH] ${line}`); });
  const timer = setTimeout(() => { console.error('[TIMEOUT] OAuth 인증이 240초를 초과했습니다.'); child?.kill('SIGTERM'); }, 240_000);
  const exitCode = await new Promise<number | null>(resolve => { child!.once('close', code => resolve(code)); child!.once('error', error => { lastAuthError = error.message; resolve(1); }); });
  clearTimeout(timer); busy = false;
  try {
    const lines = stdout.trim().split(/\r?\n/).filter(Boolean); const payload = JSON.parse(lines.at(-1) ?? '');
    if (exitCode !== 0 || !payload.ok || !payload.authenticated) { authStatus = '실패'; lastAuthError = String(payload?.error ?? `exit=${exitCode}`); console.log(`[FAIL] Kakao 인증 실패: ${lastAuthError}`); return; }
    activeAccount = account; config.activeAccount = account.email; saveConfig(config); loggedIn = true; authStatus = '성공'; lastAuthError = ''; sessionId = String(payload.session_id ?? '');
    showPanel(); console.log(`[OK] Kakao OAuth 로그인 성공: ${payload.nickname ?? account.email}`); console.log(`[OK] session=${sessionId || 'persistent'}`);
  } catch (error) { authStatus = '응답 오류'; lastAuthError = error instanceof Error ? error.message : String(error); console.log(`[FAIL] 인증 응답 파싱 실패: ${lastAuthError}`); if (stderr.trim()) console.error(`[DEBUG] ${stderr.trim()}`); }
}

async function logout(): Promise<void> {
  if (busy) { console.log('[!] 인증 작업이 진행 중입니다.'); return; }
  const result = runPythonSync(['분석기_cli.py', '--logout']);
  loggedIn = false; authStatus = '미인증'; sessionId = ''; lastAuthError = '';
  console.log(result?.status === 0 ? '[OK] Kakao 로그아웃 및 로컬 세션 삭제 완료' : '[WARN] 로컬 인증 상태를 초기화했습니다.');
}

function updateTermux(): void {
  console.clear(); console.log('================================'); console.log('       LOCO-TERMUX UPDATE        '); console.log('================================');
  const before = runCommand('git', ['rev-parse', '--short', 'HEAD'], 20_000).stdout?.trim(); console.log('[UPDATE] GitHub main 최신 버전 확인 중...');
  const pull = runCommand('git', ['pull', '--ff-only', 'origin', 'main'], 120_000);
  if (pull.stdout?.trim()) console.log(pull.stdout.trim()); if (pull.stderr?.trim()) console.error(pull.stderr.trim());
  if (pull.error || pull.status !== 0) { console.log(`[FAIL] GitHub 업데이트 실패: ${pull.error?.message ?? `exit=${pull.status}`}`); return; }
  console.log('[UPDATE] npm 의존성 동기화 중...'); const install = runCommand('npm', ['install'], 300_000);
  if (install.stdout?.trim()) console.log(install.stdout.trim()); if (install.stderr?.trim()) console.error(install.stderr.trim());
  if (install.error || install.status !== 0) { console.log(`[FAIL] npm install 실패: ${install.error?.message ?? `exit=${install.status}`}`); return; }
  console.log('[UPDATE] TypeScript 빌드 중...'); const build = runCommand('npm', ['run', 'build'], 300_000);
  if (build.stdout?.trim()) console.log(build.stdout.trim()); if (build.stderr?.trim()) console.error(build.stderr.trim());
  if (build.error || build.status !== 0) { console.log(`[FAIL] 빌드 실패: ${build.error?.message ?? `exit=${build.status}`}`); return; }
  const after = runCommand('git', ['rev-parse', '--short', 'HEAD'], 20_000).stdout?.trim(); console.log(`[OK] 업데이트 완료: ${before || '?'} -> ${after || '?'}`); console.log('[OK] 재시작합니다.');
  const child = spawn(process.execPath, ['dist/bridge-main.js'], { stdio: 'inherit' }); child.on('error', error => console.error(`[FAIL] 재시작 실패: ${error.message}`)); process.exit(0);
}

function showPanel(): void {
  console.clear(); console.log('========================================'); console.log('          LOCO-TERMUX ULTRA             '); console.log('========================================');
  console.log(`계정 : ${activeAccount?.email ?? config.activeAccount ?? '없음'}`); console.log(`인증 : ${loggedIn ? '성공' : authStatus}`); console.log(`세션 : ${sessionId || (loggedIn ? 'persistent' : restoring ? '복구중' : '없음')}`);
  if (lastAuthError) console.log(`오류 : ${lastAuthError.slice(0, 160)}`);
  console.log('----------------------------------------'); console.log('1. 계정 등록/선택'); console.log('2. Kakao OAuth 로그인'); console.log('3. OAuth 설정'); console.log('4. 현재 상태/세션 재검증'); console.log('5. GitHub 최신버전 업데이트'); console.log('6. Kakao 로그아웃'); console.log('7. 종료'); console.log('========================================');
}

async function registerAccount(): Promise<void> {
  const email = await ask('카카오 계정 식별자(로그인 힌트용, 선택): '); if (!email) return;
  const index = config.accounts.findIndex(a => a.email === email); const account: Account = index >= 0 ? config.accounts[index] : { email, deviceUuid: crypto.randomUUID() };
  if (index >= 0) config.accounts[index] = account; else config.accounts.push(account); config.activeAccount = email; activeAccount = account; saveConfig(config); console.log('[OK] 계정 저장');
}

async function selectAccount(): Promise<void> {
  if (!config.accounts.length) { await registerAccount(); return; }
  console.log('\n등록 계정'); config.accounts.forEach((a, i) => console.log(`${i + 1}. ${a.email}`));
  const raw = await ask('번호(엔터=현재): '); const current = config.accounts.findIndex(a => a.email === config.activeAccount); const index = raw ? Number(raw) - 1 : (current >= 0 ? current : 0);
  if (!Number.isInteger(index) || index < 0 || index >= config.accounts.length) return;
  activeAccount = config.accounts[index]; config.activeAccount = activeAccount.email; saveConfig(config); loggedIn = false; sessionId = ''; authStatus = '미인증'; await restoreSession(false);
}

async function configureOAuth(): Promise<void> {
  console.log('\nOAuth 설정');
  const clientId = await ask(`REST API Key [${config.kakao.clientId ? '설정됨' : '없음'}]: `); const clientSecret = await ask(`Client Secret [${config.kakao.clientSecret ? '설정됨' : '없음'}]: `); const redirectUri = await ask(`Redirect URI [${config.kakao.redirectUri}]: `);
  if (clientId) config.kakao.clientId = clientId; if (clientSecret) config.kakao.clientSecret = clientSecret; if (redirectUri) config.kakao.redirectUri = redirectUri; saveConfig(config); console.log('[OK] OAuth 설정 저장');
}

async function main(): Promise<void> {
  // Zero-network / zero-Python startup when a valid local OAuth session exists.
  showPanel();
  restoreLocalSessionCache();
  showPanel();
  while (true) {
    const choice = await ask('> ');
    if (choice === '1') await selectAccount();
    else if (choice === '2') await login();
    else if (choice === '3') await configureOAuth();
    else if (choice === '4') { await restoreSession(true); showPanel(); console.log(`\n상태=${authStatus}\n로그인=${loggedIn}\n세션=${sessionId || '없음'}`); if (lastAuthError) console.log(`오류=${lastAuthError}`); await ask('엔터 > '); }
    else if (choice === '5') updateTermux();
    else if (choice === '6') await logout();
    else if (choice === '7' || choice === 'exit') { saveConfig(config); return; }
  }
}

main().catch(error => { console.error('[FATAL]', error); process.exitCode = 1; });
