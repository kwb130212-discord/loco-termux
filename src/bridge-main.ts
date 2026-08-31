import './bridge';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { loadConfig, saveConfig, parseRoomList, roomListToString } from './config';

const config = loadConfig();

function showMenu(): void {
  console.log('\n╔══════════════════════════════════╗');
  console.log('║       TERMUX BRIDGE BOT          ║');
  console.log('╚══════════════════════════════════╝');
  console.log('[+] 1번 브리지 상태');
  console.log('[+] 2번 방 설정');
  console.log('[+] 3번 방 목록');
  console.log('[+] 4번 설정 확인');
  console.log('[+] 5번 종료');
}

async function main(): Promise<void> {
  console.log('[✓] Loco 직접 로그인 없이 Android Bridge 모드로 시작합니다.');
  console.log(`[+] 등록 방: ${roomListToString(config.rooms)}`);

  while (true) {
    showMenu();
    const rl = readline.createInterface({ input, output });
    const choice = (await rl.question('\n선택 > ')).trim();
    rl.close();

    if (choice === '1') {
      console.log('[✓] 브리지 서버 실행 중');
      console.log(`[+] 주소: http://${process.env.BRIDGE_HOST || '127.0.0.1'}:${process.env.BRIDGE_PORT || '18080'}`);
    } else if (choice === '2') {
      const r = readline.createInterface({ input, output });
      console.log(`[+] 현재: ${roomListToString(config.rooms)}`);
      const value = await r.question('방 이름 (,이름,이름,) : ');
      r.close();
      config.rooms = parseRoomList(value);
      saveConfig(config);
      console.log(`[✓] 저장: ${roomListToString(config.rooms)}`);
    } else if (choice === '3') {
      console.log(`[+] 방: ${roomListToString(config.rooms)}`);
    } else if (choice === '4') {
      console.log(`[+] 방 수: ${config.rooms.length}`);
      console.log(`[+] 채팅 통계: ${config.chatStats.length}건`);
      console.log(`[+] 입퇴장 로그: ${config.memberEvents.length}건`);
      console.log(`[+] 접두사: ${config.prefix}`);
    } else if (choice === '5') {
      saveConfig(config);
      process.exit(0);
    } else {
      console.log('[!] 1~5번 중에서 선택하세요.');
    }
  }
}

main().catch(error => {
  console.error('[FATAL]', error);
  process.exitCode = 1;
});
