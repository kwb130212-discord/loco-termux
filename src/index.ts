import 'dotenv/config';
import crypto from 'node:crypto';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { AuthApiClient, TalkClient } from 'node-kakao';
import { loadConfig, saveConfig, parseRoomList, roomListToString, type Account } from './config';

const config = loadConfig();
const client = new TalkClient();
let activeAccount: Account | null = null;
let running = false;
let pendingRegistration: { code: string; expiresAt: number } | null = null;

function banner(): void {
  console.clear();
  console.log('╔══════════════════════════════════╗');
  console.log('║          LOCO TERMUX BOT         ║');
  console.log('╚══════════════════════════════════╝');
}

function isAllowedRoom(roomName: string): boolean {
  return config.rooms.length === 0 || config.rooms.includes(roomName);
}

function generateCode(): string {
  return crypto.randomInt(10_000_000, 100_000_000).toString();
}

function printBotRegistrationCode(): void {
  const code = generateCode();
  pendingRegistration = { code, expiresAt: Date.now() + 5 * 60_000 };
  console.log(`\n[+] 봇등록 코드: ${code}`);
  console.log('[+] 유효시간: 5분');
  console.log('[+] 원하는 카카오톡 방에 위 8자리 코드를 단독 메시지로 보내세요.');
}

async function registerAccount(): Promise<void> {
  const rl = readline.createInterface({ input, output });
  try {
    const name = (await rl.question('계정 이름: ')).trim();
    const email = (await rl.question('카카오 계정 이메일/전화번호: ')).trim();
    const password = await rl.question('비밀번호: ', { hideEchoBack: true });
    if (!name || !email || !password) {
      console.log('[!] 모든 값을 입력해야 합니다.');
      return;
    }
    const existing = config.accounts.findIndex(a => a.name === name);
    const account: Account = {
      name,
      email,
      password,
      deviceUuid: crypto.randomUUID(),
    };
    if (existing >= 0) config.accounts[existing] = account;
    else config.accounts.push(account);
    config.activeAccount = name;
    saveConfig(config);
    activeAccount = account;
    console.log(`[✓] ${name} 계정이 로컬에 등록되었습니다.`);
    console.log('[!] 계정 정보는 GitHub가 아닌 Termux의 ~/.loco-termux/config.json에 저장됩니다.');
  } finally {
    rl.close();
  }
}

async function roomSettings(): Promise<void> {
  const rl = readline.createInterface({ input, output });
  try {
    console.log(`\n현재 방: ${roomListToString(config.rooms)}`);
    const value = await rl.question('방 이름 (,이름,이름,) : ');
    const rooms = parseRoomList(value);
    config.rooms = rooms;
    saveConfig(config);
    console.log(`[✓] ${rooms.length}개 방 등록 완료`);
    console.log(`[✓] 저장값: ${roomListToString(rooms)}`);
  } finally {
    rl.close();
  }
}

async function chooseAccount(): Promise<Account | null> {
  if (!config.accounts.length) {
    console.log('[!] 등록된 계정이 없습니다. 2번으로 계정을 등록하세요.');
    return null;
  }
  console.log('\n계정 목록');
  config.accounts.forEach((a, i) => console.log(`[+] ${i + 1}번 ${a.name}`));
  const rl = readline.createInterface({ input, output });
  try {
    const n = Number(await rl.question('선택 > '));
    const account = config.accounts[n - 1];
    if (!account) {
      console.log('[!] 잘못된 번호입니다.');
      return null;
    }
    config.activeAccount = account.name;
    saveConfig(config);
    return account;
  } finally {
    rl.close();
  }
}

async function startBot(): Promise<void> {
  if (running) {
    console.log('[!] 이미 실행 중입니다.');
    return;
  }
  activeAccount = config.accounts.find(a => a.name === config.activeAccount) || await chooseAccount();
  if (!activeAccount) return;

  running = true;
  console.log(`[+] 계정: ${activeAccount.name}`);
  console.log(`[+] 등록 방: ${roomListToString(config.rooms)}`);
  console.log('[+] node-kakao 연결 중...');

  const api = await AuthApiClient.create('loco-termux', activeAccount.deviceUuid);
  const loginRes = await api.login({
    email: activeAccount.email,
    password: activeAccount.password,
    forced: false,
  });
  if (!loginRes.success) throw new Error(`Web login failed: ${loginRes.status}`);

  const result = await client.login(loginRes.result);
  if (!result.success) throw new Error(`KakaoTalk login failed: ${result.status}`);
  console.log('[✓] 로그인 성공. 봇 실행 중');
}

client.on('chat', async (data, channel) => {
  const roomName = channel.getDisplayName?.() || channel.getName?.() || '';
  const text = data.text?.trim();
  if (!text) return;

  // !봇등록은 방 목록에 없는 방에서도 사용할 수 있도록 별도 처리한다.
  if (text === `${config.prefix}봇등록`) {
    printBotRegistrationCode();
    return;
  }

  // 8자리 등록 코드를 방에 입력하면 해당 방을 자동 등록한다.
  if (/^\d{8}$/.test(text) && pendingRegistration && Date.now() < pendingRegistration.expiresAt && text === pendingRegistration.code) {
    if (!roomName) return;
    if (!config.rooms.includes(roomName)) config.rooms.push(roomName);
    saveConfig(config);
    pendingRegistration = null;
    console.log(`[✓] 자동 방 등록: ${roomName}`);
    await channel.sendChat('✓ 이 채팅방이 봇 방으로 등록되었습니다.');
    return;
  }

  if (!isAllowedRoom(roomName)) return;
  if (!text.startsWith(config.prefix)) return;

  const [command, ...args] = text.slice(config.prefix.length).trim().split(/\s+/);
  const cmd = command?.toLowerCase();

  if (cmd === 'ping') await channel.sendChat('Pong!');
  else if (cmd === 'help' || cmd === '명령어') {
    await channel.sendChat([
      '📖 명령어',
      '!ping - 응답 확인',
      '!명령어 - 명령어 목록',
      '!echo <내용> - 내용 반복',
      '!봇등록 - Termux에 8자리 방 등록 코드 생성',
      '!방등록해제 - 현재 채팅방의 봇 등록 해제',
      '!kick @멘션 - 관리자 전용 내보내기 명령(지원 API가 있는 경우)',
    ].join('\n'));
  } else if (cmd === 'echo') {
    await channel.sendChat(args.join(' ') || '사용법: !echo <내용>');
  } else if (cmd === '방등록해제') {
    const index = config.rooms.indexOf(roomName);
    if (index === -1) {
      await channel.sendChat('ℹ️ 이 채팅방은 등록되어 있지 않습니다.');
      return;
    }
    config.rooms.splice(index, 1);
    saveConfig(config);
    console.log(`[✓] 방 등록 해제: ${roomName}`);
    await channel.sendChat('✓ 이 채팅방의 봇 등록을 해제했습니다.');
  } else if (cmd === 'kick') {
    // node-kakao 버전별 관리자/강퇴 API 차이가 있어 임의의 내부 API를 호출하지 않는다.
    await channel.sendChat('⚠️ 강퇴 기능은 현재 연결된 node-kakao 버전의 채널 관리자 API 확인이 필요합니다.');
  }
});

client.on('error', error => console.error('[node-kakao] error:', error));

async function menu(): Promise<void> {
  while (true) {
    banner();
    console.log('[+] 1번 봇 시작');
    console.log('[+] 2번 계정 등록');
    console.log('[+] 3번 계정 목록');
    console.log('[+] 4번 방 설정');
    console.log('[+] 5번 설정 확인');
    console.log('[+] 6번 종료');
    const rl = readline.createInterface({ input, output });
    const choice = (await rl.question('\n선택 > ')).trim();
    rl.close();

    try {
      if (choice === '1') await startBot();
      else if (choice === '2') await registerAccount();
      else if (choice === '3') {
        console.log('\n[+] 등록 계정');
        config.accounts.forEach((a, i) => console.log(`[+] ${i + 1}번 ${a.name}${a.name === config.activeAccount ? ' (사용중)' : ''}`));
      } else if (choice === '4') await roomSettings();
      else if (choice === '5') {
        console.log(`\n[+] 계정: ${config.activeAccount || '없음'}`);
        console.log(`[+] 방: ${roomListToString(config.rooms)}`);
        console.log(`[+] 접두사: ${config.prefix}`);
      } else if (choice === '6') {
        console.log('[✓] 종료합니다.');
        process.exit(0);
      } else console.log('[!] 1~6번 중에서 선택하세요.');
    } catch (error) {
      running = false;
      console.error('[FATAL]', error);
    }

    await new Promise(resolve => setTimeout(resolve, 800));
  }
}

menu().catch(error => {
  console.error('[FATAL]', error);
  process.exitCode = 1;
});
