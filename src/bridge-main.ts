import './bridge';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { loadConfig, saveConfig, parseRoomList, roomListToString, type CommandLog } from './config';

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
  console.log(`║ 명령 로그  : ${config.commandLogs.length}건`.padEnd(53) + '║');
  console.log(`║ 채팅 통계  : ${config.chatStats.length}건`.padEnd(53) + '║');
  console.log(`║ 입퇴장 로그: ${config.memberEvents.length}건`.padEnd(53) + '║');
  console.log('╠════════════════════════════════════════════════════╣');
  console.log('║ 1 방 설정   2 방 목록   3 설정   4 로그           ║');
  console.log('║ 5 로그 초기화   00 패널 복귀   6 종료             ║');
  console.log('╚════════════════════════════════════════════════════╝');
}

function showLogs(): void {
  console.log('\n===== COMMAND LOG =====');
  const logs = config.commandLogs.slice(-100).reverse();
  if (!logs.length) console.log('(로그 없음)');
  for (const l of logs) console.log(`${new Date(l.at).toLocaleString('ko-KR')} | ${l.room} | ${l.userName} | ${l.command} | ${l.result}`);
}

async function inputLine(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input, output });
  const value = await rl.question(prompt);
  rl.close();
  return value.trim();
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
      config.rooms = parseRoomList(value); saveConfig(config); console.log('[✓] 방 설정 저장'); panelMode = false;
    } else if (choice === '2') {
      console.log(`[+] ${roomListToString(config.rooms)}`); panelMode = false;
    } else if (choice === '3') {
      console.log(`[+] prefix=${config.prefix}`); console.log(`[+] rooms=${config.rooms.length}`); panelMode = false;
    } else if (choice === '4') {
      showLogs(); panelMode = false;
    } else if (choice === '5') {
      config.commandLogs = []; saveConfig(config); console.log('[✓] 명령 로그 초기화'); panelMode = false;
    } else if (choice === '6') {
      saveConfig(config); process.exit(0);
    } else if (choice) {
      console.log('[!] 1~6 또는 00을 입력하세요.'); panelMode = false;
    }
  }
}

main().catch(error => { console.error('[FATAL]', error); process.exitCode = 1; });
