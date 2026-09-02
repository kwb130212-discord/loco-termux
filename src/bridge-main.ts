import './bridge';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { loadConfig, saveConfig, parseRoomList, roomListToString, type Account } from './config';
import { RoomAnalyzer } from './analyzer';
import { maskAccount, sendWebhook } from './webhook';

const config = loadConfig();
const analyzer = new RoomAnalyzer(config);
let panelMode = true;
let activeAccount: Account | null = null;
let loggedIn = false;
let sessionId: string | null = null;
let authStatus = '미인증';

function clear(): void { process.stdout.write('\x1b[2J\x1b[H'); }
function showPanel(): void {
  clear();
  console.log('╔════════════════════════════════════════════════════╗');
  console.log('║              TERMUX-LOCO BRIDGE PANEL             ║');
  console.log('╠════════════════════════════════════════════════════╣');
  console.log(`║ 계정       : ${activeAccount ? maskAccount(activeAccount.email) : (config.activeAccount ? maskAccount(config.activeAccount) : '없음')}`.padEnd(53) + '║');
  console.log(`║ 인증       : ${loggedIn ? '성공' : authStatus}`.padEnd(53) + '║');
  console.log(`║ 세션       : ${sessionId ?? '없음'}`.padEnd(53) + '║');
  console.log(`║ 등록 계정  : ${config.accounts.length}개`.padEnd(53) + '║');
  console.log(`║ 등록 방    : ${config.rooms.length}개`.padEnd(53) + '║');
  console.log(`║ 관리자     : ${config.admins.length}명`.padEnd(53) + '║');
  console.log(`║ 웹훅 로그  : ${config.webhook.enabled ? 'ON' : 'OFF'}`.padEnd(53) + '║');
  console.log('╠════════════════════════════════════════════════════╣');
  console.log('║ 1 계정/로그인  2 방 설정   3 방 목록   4 관리자  ║');
  console.log('║ 5 설정         6 명령 로그 7 통계       8 데이터 ║');
  console.log('║ 9 로그아웃     00 패널 복귀  종료=exit            ║');
  console.log('╚════════════════════════════════════════════════════╝');
}

function showLogs(): void {
  console.log('\n===== COMMAND LOG =====');
  const logs = config.commandLogs.slice(-100).reverse();
  if (!logs.length) console.log('(로그 없음)');
  for (const l of logs) console.log(`${new Date(l.at).toLocaleString('ko-KR')} | ${l.room} | ${l.userName} | ${l.command} | ${l.result}`);
}

function showStats(): void {
  console.log('\n===== STATISTICS =====');
  console.log(`채팅 통계: ${config.chatStats.length}건`);
  console.log(`입퇴장 기록: ${config.memberEvents.length}건`);
  console.log(`명령 로그: ${config.commandLogs.length}건`);
  console.log(`분석기 상태: ${JSON.stringify(analyzer.stats())}`);
}

async function inputLine(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input, output });
  try { return (await rl.question(prompt)).trim(); } finally { rl.close(); }
}

async function configureKakaoOAuth(): Promise<void> {
  console.log('\n===== KAKAO OAUTH CONFIG =====');
  console.log('Kakao Developers에서 등록한 값만 입력합니다. 계정 비밀번호는 저장/전송하지 않습니다.');
  const clientId = await inputLine(`REST API Key [현재 ${config.kakao.clientId ? '설정됨' : '없음'}]: `);
  const clientSecret = await inputLine(`Client Secret [현재 ${config.kakao.clientSecret ? '설정됨' : '없음'}]: `);
  const redirectUri = await inputLine(`Redirect URI [현재 ${config.kakao.redirectUri || '없음'}]: `);
  if (clientId) config.kakao.clientId = clientId;
  if (clientSecret) config.kakao.clientSecret = clientSecret;
  if (redirectUri) config.kakao.redirectUri = redirectUri;
  saveConfig(config);
  console.log(`[✓] OAuth 설정 저장: client=${config.kakao.clientId ? 'OK' : 'MISSING'}, redirect=${config.kakao.redirectUri ? 'OK' : 'MISSING'}`);
}

async function registerAccount(): Promise<void> {
  console.log('\n===== ACCOUNT REGISTER =====');
  const email = await inputLine('카카오 계정 이메일/전화번호(로그인 힌트용): ');
  if (!email) { console.log('[!] 계정 식별자를 입력하세요.'); return; }
  const existing = config.accounts.findIndex(a => a.email === email);
  const account: Account = {
    email,
    deviceUuid: existing >= 0 ? config.accounts[existing].deviceUuid : crypto.randomUUID(),
  };
  if (existing >= 0) config.accounts[existing] = account; else config.accounts.push(account);
  config.activeAccount = email;
  activeAccount = account;
  saveConfig(config);
  console.log(`[✓] 계정 등록 완료: ${maskAccount(email)}`);
  await sendWebhook(config, '계정 등록', `계정: ${maskAccount(email)}\n결과: 등록 완료`, 'SUCCESS');
}

async function chooseAccount(): Promise<Account | null> {
  if (!config.accounts.length) return null;
  console.log('\n===== SAVED ACCOUNTS =====');
  config.accounts.forEach((a, i) => console.log(`${i + 1}. ${maskAccount(a.email)}${a.email === config.activeAccount ? ' [기본]' : ''}`));
  const raw = await inputLine('계정 번호: ');
  const index = Number(raw) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= config.accounts.length) return null;
  const account = config.accounts[index];
  config.activeAccount = account.email;
  activeAccount = account;
  saveConfig(config);
  return account;
}

function runPython(args: string[]) {
  const candidates = [process.env.PYTHON_BIN, 'python3', 'python'].filter(Boolean) as string[];
  let last: ReturnType<typeof spawnSync> | null = null;
  for (const command of candidates) {
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      timeout: 210_000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    last = result;
    if (!result.error) return result;
  }
  return last;
}

async function loginWithAnalyzer(account: Account): Promise<void> {
  console.log('[LOGIN] 분석기.py 실인증 시작...');
  if (!config.kakao.clientId || !config.kakao.redirectUri) {
    authStatus = 'OAuth 설정 필요';
    console.error('[LOGIN] 먼저 1 → 6 OAuth 설정에서 REST API Key와 Redirect URI를 입력하세요.');
    return;
  }
  authStatus = '인증중';
  const args = [
    '분석기_cli.py', '--oauth-login',
    '--client-id', config.kakao.clientId,
    '--client-secret', config.kakao.clientSecret,
    '--redirect-uri', config.kakao.redirectUri,
    '--login-hint', account.email,
  ];
  const result = runPython(args);
  if (!result) { authStatus = '실패'; return; }
  if (result.error) {
    authStatus = '실패';
    console.error(`[LOGIN] Python 실행 실패: ${result.error.message}`);
    await sendWebhook(config, '로그인 실패', `계정: ${maskAccount(account.email)}\n원인: Python 실행 실패`, 'ERROR');
    return;
  }
  if (result.stderr?.trim()) console.error(result.stderr.trim());
  let payload: any;
  try {
    const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
    payload = JSON.parse(lines[lines.length - 1] ?? '');
  } catch (error) {
    authStatus = '응답 오류';
    console.error('[LOGIN] 분석기 JSON 응답 파싱 실패:', error instanceof Error ? error.message : error);
    if (result.stdout?.trim()) console.error(result.stdout.trim().slice(-2000));
    return;
  }
  if (result.status !== 0 || !payload.ok || !payload.authenticated) {
    authStatus = '실패';
    console.error(`[LOGIN] Kakao 인증 실패: ${payload?.error ?? `exit=${result.status}`}`);
    await sendWebhook(config, '로그인 실패', `계정: ${maskAccount(account.email)}\n원인: ${String(payload?.error ?? '인증 실패').slice(0, 900)}`, 'ERROR');
    return;
  }
  activeAccount = account;
  config.activeAccount = account.email;
  loggedIn = true;
  authStatus = '성공';
  sessionId = String(payload.session_id);
  saveConfig(config);
  console.log(`[✓] Kakao OAuth 인증 성공: ${maskAccount(account.email)}`);
  console.log(`[✓] 분석기 session: ${sessionId}`);
  await sendWebhook(config, '로그인 성공', `계정: ${maskAccount(account.email)}\n세션: ${sessionId}\n모드: KAKAO_OAUTH`, 'SUCCESS');
}

async function accountMenu(): Promise<void> {
  while (true) {
    console.log('\n===== ACCOUNT / LOGIN =====');
    console.log('1. 계정 등록/수정');
    console.log('2. 등록 계정 선택');
    console.log('3. 선택 계정 Kakao OAuth 로그인');
    console.log('4. OAuth 설정');
    console.log('5. 세션 상태');
    console.log('6. 뒤로가기');
    const choice = await inputLine('계정 > ');
    if (choice === '1') await registerAccount();
    else if (choice === '2') {
      const account = await chooseAccount();
      if (account) console.log(`[✓] 선택: ${maskAccount(account.email)}`); else console.log('[!] 잘못된 계정 번호');
    } else if (choice === '3') {
      let account = config.accounts.find(a => a.email === config.activeAccount) || null;
      if (!account) account = await chooseAccount();
      if (!account) { console.log('[!] 먼저 계정을 등록/선택하세요.'); continue; }
      await loginWithAnalyzer(account);
    } else if (choice === '4') await configureKakaoOAuth();
    else if (choice === '5') console.log(`상태=${authStatus}, 로그인=${loggedIn}, 세션=${sessionId ?? '없음'}`);
    else if (choice === '6') return;
  }
}

async function webhookMenu(): Promise<void> {
  console.log('\n===== DISCORD WEBHOOK =====');
  console.log(`현재: ${config.webhook.enabled ? 'ON' : 'OFF'}`);
  const url = await inputLine('Webhook URL (빈칸=변경 안 함): ');
  if (url) config.webhook.url = url;
  const enabled = await inputLine('사용 여부 (ON/OFF, 빈칸=현재 유지): ');
  if (enabled.toUpperCase() === 'ON') config.webhook.enabled = true;
  if (enabled.toUpperCase() === 'OFF') config.webhook.enabled = false;
  const username = await inputLine(`로그 이름 [현재 ${config.webhook.username}]: `);
  if (username) config.webhook.username = username;
  saveConfig(config);
  console.log(`[✓] 웹훅 설정 저장: ${config.webhook.enabled ? 'ON' : 'OFF'}`);
  if (config.webhook.enabled) await sendWebhook(config, 'Webhook 연결 테스트', 'LOCO-Termux 로그 웹훅이 정상적으로 설정되었습니다.', 'SUCCESS');
}

async function logoutAnalyzer(): Promise<void> {
  if (!loggedIn) { console.log('[!] 활성 인증 세션이 없습니다.'); return; }
  await sendWebhook(config, '로그아웃', `계정: ${activeAccount ? maskAccount(activeAccount.email) : '알 수 없음'}\n세션: ${sessionId ?? '없음'}`, 'INFO');
  loggedIn = false;
  authStatus = '미인증';
  sessionId = null;
  activeAccount = null;
  console.log('[✓] 로컬 인증 상태가 종료되었습니다.');
}

async function main(): Promise<void> {
  console.log('[✓] Android Bridge 모드 시작');
  console.log('[+] 인증 엔진: 분석기.py + Kakao OAuth');
  console.log('[+] node-kakao: 제거됨');
  while (true) {
    if (panelMode) showPanel();
    const choice = await inputLine('\n패널 > ');
    if (choice === '00') { panelMode = true; continue; }
    if (choice === 'exit' || choice === '0') { saveConfig(config); process.exit(0); }
    if (choice === '1') { await accountMenu(); panelMode = true; }
    else if (choice === '2') {
      const value = await inputLine(`방 이름 (,이름,이름,) [현재 ${roomListToString(config.rooms)}] : `);
      config.rooms = parseRoomList(value); for (const room of config.rooms) config.roomConfigs[room] = { name: room, enabled: true };
      saveConfig(config); console.log(`[✓] ${config.rooms.length}개 방 설정 저장`); panelMode = false;
    } else if (choice === '3') {
      console.log('\n===== ROOMS ====='); if (!config.rooms.length) console.log('(등록된 방 없음)');
      config.rooms.forEach((room, i) => console.log(`${i + 1}. ${room} [${config.roomConfigs[room]?.enabled === false ? 'OFF' : 'ON'}]`)); panelMode = false;
    } else if (choice === '4') {
      const value = await inputLine(`관리자 ID (,ID,ID,) [현재 ${config.admins.join(', ') || '없음'}] : `);
      config.admins = [...new Set(value.split(',').map(v => v.trim()).filter(Boolean))]; saveConfig(config); console.log(`[✓] 관리자 ${config.admins.length}명 저장`); panelMode = false;
    } else if (choice === '5') { await webhookMenu(); panelMode = false; }
    else if (choice === '6') { showLogs(); panelMode = false; }
    else if (choice === '7') { showStats(); panelMode = false; }
    else if (choice === '8') {
      const confirm = await inputLine('오래된 통계/로그를 보존 한도에 맞춰 정리합니다. YES 입력 > ');
      if (confirm === 'YES') { config.chatStats = config.chatStats.slice(-5000); config.memberEvents = config.memberEvents.slice(-5000); config.commandLogs = config.commandLogs.slice(-5000); saveConfig(config); console.log('[✓] 데이터 정리 완료'); }
      else console.log('[!] 취소'); panelMode = false;
    } else if (choice === '9') { await logoutAnalyzer(); panelMode = false; }
    else if (choice) { console.log('[!] 올바른 메뉴를 선택하세요.'); panelMode = false; }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
}
main().catch(error => { console.error('[FATAL]', error); process.exitCode = 1; });
