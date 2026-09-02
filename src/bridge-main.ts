import './bridge';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { spawnSync } from 'node:child_process';
import { loadConfig, saveConfig, parseRoomList, roomListToString, type Account } from './config';
import { RoomAnalyzer } from './analyzer';

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
  console.log(`║ 상태       : ${process.env.BRIDGE_HOST || '127.0.0.1'}:${process.env.BRIDGE_PORT || '18080'}`.padEnd(53) + '║');
  console.log(`║ 계정       : ${activeAccount?.email || config.activeAccount || '없음'}`.padEnd(53) + '║');
  console.log(`║ 인증       : ${loggedIn ? '성공' : '대기'}${sessionId ? ` (${sessionId})` : ''}`.padEnd(53) + '║');
  console.log(`║ 등록 방    : ${config.rooms.length}개`.padEnd(53) + '║');
  console.log(`║ 관리자     : ${config.admins.length}명`.padEnd(53) + '║');
  console.log(`║ 명령 로그  : ${config.commandLogs.length}건`.padEnd(53) + '║');
  console.log(`║ 채팅 통계  : ${config.chatStats.length}건`.padEnd(53) + '║');
  console.log(`║ 입퇴장 로그: ${config.memberEvents.length}건`.padEnd(53) + '║');
  console.log('╠════════════════════════════════════════════════════╣');
  console.log('║ 1 로그인    2 방 설정   3 방 목록   4 관리자     ║');
  console.log('║ 5 설정      6 명령 로그 7 통계       8 데이터정리 ║');
  console.log('║ 9 로그아웃  00 패널 복귀  종료=exit               ║');
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
  const email = await inputLine('카카오 계정 이메일/전화번호: ');
  const password = await inputLine('비밀번호: ');
  if (!email || !password) { console.log('[!] 이메일과 비밀번호를 모두 입력해야 합니다.'); return; }
  const existing = config.accounts.findIndex(a => a.email === email);
  const account: Account = { email, password, deviceUuid: existing >= 0 ? config.accounts[existing].deviceUuid : cryptoRandomUuid() };
  if (existing >= 0) config.accounts[existing] = account; else config.accounts.push(account);
  config.activeAccount = email;
  activeAccount = account;
  saveConfig(config);
  console.log(`[✓] ${email} 계정이 등록되었습니다.`);
}

function cryptoRandomUuid(): string {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function loginWithAnalyzer(): Promise<void> {
  if (!config.accounts.length) {
    console.log('[!] 등록된 계정이 없습니다. 먼저 계정을 등록합니다.');
    await registerAccount();
  }
  const account = config.accounts.find(a => a.email === config.activeAccount) || config.accounts[0];
  if (!account) return;

  console.log('[LOGIN] 분석기.py 기반 로그인 시작...');
  console.log('[LOGIN] node-kakao는 사용하지 않습니다.');
  console.log('[LOGIN] -999 강제 성공 모드는 유지됩니다.');

  const result = spawnSync('python3', [
    '분석기_cli.py',
    '--mock-login',
    '--user-id', account.email,
    '--nickname', account.email,
    '--room-id', 'local',
  ], { encoding: 'utf8' });

  if (result.error) {
    console.error(`[LOGIN] Python 실행 실패: ${result.error.message}`);
    console.error('[LOGIN] Termux에 python3가 설치되어 있는지 확인하세요.');
    return;
  }
  if (result.status !== 0) {
    console.error(`[LOGIN] 분석기.py 로그인 실패 (exit=${result.status})`);
    if (result.stderr?.trim()) console.error(result.stderr.trim());
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
    console.log(`[✓] 계정 로그인 성공: ${account.email}`);
    console.log(`[✓] 분석기 session: ${sessionId}`);
    console.log('[✓] -999 강제 성공 처리 유지');
  } catch (error) {
    console.error('[LOGIN] 분석기 응답 파싱 실패:', error instanceof Error ? error.message : error);
    if (result.stdout?.trim()) console.error('[LOGIN] analyzer output:', result.stdout.trim());
  }
}

async function logoutAnalyzer(): Promise<void> {
  if (!sessionId) { loggedIn = false; activeAccount = null; console.log('[!] 활성 세션이 없습니다.'); return; }
  // The Python analyzer owns mock session state. Keep the local UI state consistent.
  analyzer.mockLogout(sessionId);
  console.log(`[✓] 세션 종료: ${sessionId}`);
  sessionId = null;
  loggedIn = false;
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

    if (choice === '1') { await loginWithAnalyzer(); panelMode = false; }
    else if (choice === '2') {
      const value = await inputLine(`방 이름 (,이름,이름,) [현재 ${roomListToString(config.rooms)}] : `);
      config.rooms = parseRoomList(value);
      for (const room of config.rooms) config.roomConfigs[room] = { name: room, enabled: true };
      saveConfig(config); console.log(`[✓] ${config.rooms.length}개 방 설정 저장`); panelMode = false;
    } else if (choice === '3') {
      console.log('\n===== ROOMS =====');
      if (!config.rooms.length) console.log('(등록된 방 없음)');
      config.rooms.forEach((room, i) => console.log(`${i + 1}. ${room} [${config.roomConfigs[room]?.enabled === false ? 'OFF' : 'ON'}]`));
      panelMode = false;
    } else if (choice === '4') {
      const value = await inputLine(`관리자 ID (,ID,ID,) [현재 ${config.admins.join(', ') || '없음'}] : `);
      config.admins = [...new Set(value.split(',').map(v => v.trim()).filter(Boolean))];
      saveConfig(config); console.log(`[✓] 관리자 ${config.admins.length}명 저장`); panelMode = false;
    } else if (choice === '5') {
      console.log(`\n[설정] prefix=${config.prefix}`);
      console.log(`[설정] activeAccount=${config.activeAccount ?? '없음'}`);
      console.log(`[설정] accounts=${config.accounts.length}`);
      console.log(`[설정] rooms=${config.rooms.length}`);
      console.log(`[설정] analyzer=${JSON.stringify(analyzer.stats())}`);
      panelMode = false;
    } else if (choice === '6') { showLogs(); panelMode = false; }
    else if (choice === '7') { showStats(); panelMode = false; }
    else if (choice === '8') {
      const confirm = await inputLine('오래된 통계/로그를 보존 한도에 맞춰 정리합니다. YES 입력 > ');
      if (confirm === 'YES') {
        config.chatStats = config.chatStats.slice(-5000);
        config.memberEvents = config.memberEvents.slice(-5000);
        config.commandLogs = config.commandLogs.slice(-5000);
        saveConfig(config); console.log('[✓] 데이터 정리 완료');
      } else console.log('[!] 취소');
      panelMode = false;
    } else if (choice === '9') { await logoutAnalyzer(); panelMode = false; }
    else if (choice === '00') panelMode = true;
    else if (choice) { console.log('[!] 올바른 메뉴를 선택하세요.'); panelMode = false; }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
}

main().catch(error => { console.error('[FATAL]', error); process.exitCode = 1; });
