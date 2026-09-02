import './bridge';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { loadConfig, saveConfig, parseRoomList, roomListToString } from './config';

const config = loadConfig();
let panelMode = true;

function clear(): void { process.stdout.write('\x1b[2J\x1b[H'); }
function showPanel(): void {
  clear();
  console.log('╔════════════════════════════════════════════════════╗');
  console.log('║              TERMUX-LOCO BRIDGE PANEL             ║');
  console.log('╠════════════════════════════════════════════════════╣');
  console.log(`║ 상태       : ${process.env.BRIDGE_HOST || '127.0.0.1'}:${process.env.BRIDGE_PORT || '18080'}`.padEnd(53) + '║');
  console.log(`║ 등록 방    : ${config.rooms.length}개`.padEnd(53) + '║');
  console.log(`║ 관리자     : ${config.admins.length}명`.padEnd(53) + '║');
  console.log(`║ 명령 로그  : ${config.commandLogs.length}건`.padEnd(53) + '║');
  console.log(`║ 채팅 통계  : ${config.chatStats.length}건`.padEnd(53) + '║');
  console.log(`║ 입퇴장 로그: ${config.memberEvents.length}건`.padEnd(53) + '║');
  console.log('╠════════════════════════════════════════════════════╣');
  console.log('║ 1 방 설정   2 방 목록   3 관리자   4 설정         ║');
  console.log('║ 5 명령 로그 6 통계       7 로그 초기화             ║');
  console.log('║ 8 데이터 정리 00 패널 복귀  9 종료                ║');
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
  const top = [...config.chatStats].sort((a, b) => b.count - a.count).slice(0, 10);
  if (top.length) {
    console.log('\n상위 채팅 활동:');
    top.forEach((x, i) => console.log(`${i + 1}. ${x.userName} — ${x.count}회 (${x.room})`));
  }
}

async function inputLine(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input, output });
  try { return (await rl.question(prompt)).trim(); } finally { rl.close(); }
}

async function main(): Promise<void> {
  console.log('[✓] Android Bridge 모드 시작');
  console.log('[+] Loco 직접 로그인은 기본 실행에서 사용하지 않습니다.');
  while (true) {
    if (panelMode) showPanel();
    const choice = await inputLine('\n패널 > ');
    if (choice === '00') { panelMode = true; continue; }

    if (choice === '1') {
      const value = await inputLine(`방 이름 (,이름,이름,) [현재 ${roomListToString(config.rooms)}] : `);
      config.rooms = parseRoomList(value);
      for (const room of config.rooms) config.roomConfigs[room] = { name: room, enabled: true };
      saveConfig(config); console.log(`[✓] ${config.rooms.length}개 방 설정 저장`); panelMode = false;
    } else if (choice === '2') {
      console.log('\n===== ROOMS =====');
      if (!config.rooms.length) console.log('(등록된 방 없음)');
      config.rooms.forEach((room, i) => console.log(`${i + 1}. ${room} [${config.roomConfigs[room]?.enabled === false ? 'OFF' : 'ON'}]`));
      panelMode = false;
    } else if (choice === '3') {
      const value = await inputLine(`관리자 ID (,ID,ID,) [현재 ${config.admins.join(', ') || '없음'}] : `);
      config.admins = [...new Set(value.split(',').map(v => v.trim()).filter(Boolean))];
      saveConfig(config); console.log(`[✓] 관리자 ${config.admins.length}명 저장`); panelMode = false;
    } else if (choice === '4') {
      console.log(`\n[설정] prefix=${config.prefix}`);
      console.log(`[설정] logLevel=${config.logLevel}`);
      console.log(`[설정] activeAccount=${config.activeAccount ?? '없음'}`);
      console.log(`[설정] accounts=${config.accounts.length}`);
      console.log(`[설정] rooms=${config.rooms.length}`);
      panelMode = false;
    } else if (choice === '5') {
      showLogs(); panelMode = false;
    } else if (choice === '6') {
      showStats(); panelMode = false;
    } else if (choice === '7') {
      const confirm = await inputLine('명령 로그를 전부 삭제합니다. YES 입력 > ');
      if (confirm === 'YES') { config.commandLogs = []; saveConfig(config); console.log('[✓] 명령 로그 초기화'); }
      else console.log('[!] 취소');
      panelMode = false;
    } else if (choice === '8') {
      const confirm = await inputLine('오래된 통계/로그를 보존 한도에 맞춰 정리합니다. YES 입력 > ');
      if (confirm === 'YES') {
        config.chatStats = config.chatStats.slice(-5000);
        config.memberEvents = config.memberEvents.slice(-5000);
        config.commandLogs = config.commandLogs.slice(-5000);
        saveConfig(config); console.log('[✓] 데이터 정리 완료');
      } else console.log('[!] 취소');
      panelMode = false;
    } else if (choice === '9') {
      saveConfig(config); process.exit(0);
    } else if (choice) {
      console.log('[!] 1~9 또는 00을 입력하세요.'); panelMode = false;
    }
  }
}

main().catch(error => { console.error('[FATAL]', error); process.exitCode = 1; });
