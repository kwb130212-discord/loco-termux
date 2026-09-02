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

function clear(): void { process.stdout.write('\x1b[2J\x1b[H'); }
function showPanel(): void {
  clear();
  console.log('╔════════════════════════════════════════════════════╗');
  console.log('║              TERMUX-LOCO BRIDGE PANEL             ║');
  console.log('╠════════════════════════════════════════════════════╣');
  console.log(`║ 계정       : ${activeAccount ? maskAccount(activeAccount.email) : (config.activeAccount ? maskAccount(config.activeAccount) : '없음')}`.padEnd(53) + '║');
  console.log(`║ 인증       : ${loggedIn ? '성공' : '대기'}${sessionId ? ` (${sessionId})` : ''}`.padEnd(53) + '║');
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

async function registerAccount(): Promise<void> {
  console.log('\n===== ACCOUNT REGISTER =====');
  const email = await inputLine('카카오 계정 이메일/전화번호: ');
  const password = await inputLine('비밀번호: ');
  if (!email || !password) { console.log('[!] 이메일과 비밀번호를 모두 입력해야 합니다.'); return; }
  const existing = config.accounts.findIndex(a => a.email === email);
  const account: Account = {
    email,
    password,
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

async function loginWithAnalyzer(account: Account): Promise<void> {
  console.log('[LOGIN] 분석기.py 기반 로그인 시작...');
  console.log('[LOGIN] node-kakao는 사용하지 않습니다.');
  console.log('[LOGIN] -999 강제 성공 모드는 유지됩니다.');

  const result = spawnSync('python3', ['분석기_cli.py', '--mock-login', '--user-id', account.email, '--nickname', account.email, '--room-id', 'local'], { encoding: 'utf8' });
  if (result.error) {
    console.error(`[LOGIN] Python 실행 실패: ${result.error.message}`);
    await sendWebhook(config, '로그인 실패', `계정: ${maskAccount(account.email)}\n원인: Python 실행 실패`, 'ERROR');
    return;
  }
  if (result.status !== 0) {
    console.error(`[LOGIN] 분석기.py 로그인 실패 (exit=${result.status})`);
    if (result.stderr?.trim()) console.error(result.stderr.trim());
    await sendWebhook(config, '로그인 실패', `계정: ${maskAccount(account.email)}\nexit: ${result.status}`, 'ERROR');
    return;
  }

  try {
    const payload = JSON.parse(result.stdout.trim());
    if (!payload.ok) throw new Error('analyzer returned ok=false');
    activeAccount = account;
    config.activeAccount = account.email;
    loggedIn = true;
    sessionId = String(payload.session_id);
    saveConfig(config);
    console.log(`[✓] 계정 로그인 성공: ${maskAccount(account.email)}`);
    console.log(`[✓] 분석기 session: ${sessionId}`);
    console.log('[✓] -999 강제 성공 처리 유지');
    await sendWebhook(config, '로그인 성공', `계정: ${maskAccount(account.email)}\n세션: ${sessionId}\n진단: ${payload.diagnostic?.status ?? 'N/A'}\n모드: ${payload.mode ?? 'MOCK'}`, 'SUCCESS');
  } catch (error) {
    console.error('[LOGIN] 분석기 응답 파싱 실패:', error instanceof Error ? error.message : error);
    await sendWebhook(config, '로그인 실패', `계정: ${maskAccount(account.email)}\n원인: analyzer 응답 파싱 실패`, 'ERROR');
  }
}

async function accountMenu(): Promise<void> {
  while (true) {
    console.log('\n===== ACCOUNT / LOGIN =====');
    console.log('1. 계정 등록/수정');
    console.log('2. 등록 계정 선택');
    console.log('3. 선택 계정 로그인');
    console.log('4. 가짜 로그인(-999 강제 성공)');
    console.log('5. 뒤로가기');
    const choice = await inputLine('계정 > ');
    if (choice === '1') await registerAccount();
    else if (choice === '2') {
      const account = await chooseAccount();
      if (account) console.log(`[✓] 선택: ${maskAccount(account.email)}`); else console.log('[!] 잘못된 계정 번호');
    } else if (choice === '3' || choice === '4') {
      let account = config.accounts.find(a => a.email === config.activeAccount) || null;
      if (!account) account = await chooseAccount();
      if (!account) { console.log('[!] 먼저 계정을 등록/선택하세요.'); continue; }
      await loginWithAnalyzer(account);
    } else if (choice === '5') return;
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
  if (!sessionId) { loggedIn = false; activeAccount = null; console.log('[!] 활성 세션이 없습니다.'); return; }
  analyzer.mockLogout(sessionId);
  await sendWebhook(config, '로그아웃', `계정: ${activeAccount ? maskAccount(activeAccount.email) : '알 수 없음'}\n세션: ${sessionId}`, 'INFO');
  console.log(`[✓] 세션 종료: ${sessionId}`);
  sessionId = null; loggedIn = false; activeAccount = null;
}

async function main(): Promise<void> {
  console.log('[✓] Android Bridge 모드 시작');
  console.log('[+] 인증 엔진: 분석기.py');
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