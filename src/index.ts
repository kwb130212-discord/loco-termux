import 'dotenv/config';
import crypto from 'node:crypto';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { AuthApiClient, TalkClient } from 'node-kakao';
import {
  loadConfig,
  saveConfig,
  parseRoomList,
  roomListToString,
  type Account,
  type ChatStat,
} from './config';

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
    const email = (await rl.question('카카오 계정 이메일/전화번호: ')).trim();
    const password = await rl.question('비밀번호: ', { hideEchoBack: true });
    if (!email || !password) {
      console.log('[!] 이메일과 비밀번호를 모두 입력해야 합니다.');
      return;
    }

    const existing = config.accounts.findIndex(a => a.email === email);
    const oldUuid = existing >= 0 ? config.accounts[existing].deviceUuid : crypto.randomUUID();
    const account: Account = { email, password, deviceUuid: oldUuid };

    if (existing >= 0) config.accounts[existing] = account;
    else config.accounts.push(account);

    config.activeAccount = email;
    saveConfig(config);
    activeAccount = account;
    console.log(`[✓] ${email} 계정이 로컬에 등록되었습니다.`);
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
  config.accounts.forEach((a, i) => console.log(`[+] ${i + 1}번 ${a.email}${a.email === config.activeAccount ? ' (사용중)' : ''}`));

  const rl = readline.createInterface({ input, output });
  try {
    const n = Number(await rl.question('선택 > '));
    const account = config.accounts[n - 1];
    if (!account) {
      console.log('[!] 잘못된 번호입니다.');
      return null;
    }
    config.activeAccount = account.email;
    saveConfig(config);
    return account;
  } finally {
    rl.close();
  }
}

function roomNameOf(channel: any): string {
  return channel?.getDisplayName?.() || channel?.getName?.() || '';
}

function userNameOf(user: any): string {
  return user?.nickname || user?.userInfo?.nickname || user?.UserInfo?.Nickname || '알 수 없음';
}

function userKeyOf(user: any): string {
  const id = user?.userId ?? user?.userID ?? user?.id ?? user?.UserId;
  return id != null ? String(id) : userNameOf(user);
}

function nowText(): string {
  return new Intl.DateTimeFormat('ko-KR', {
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date());
}

function recordChat(room: string, user: any): void {
  const userKey = userKeyOf(user);
  const userName = userNameOf(user);
  const now = new Date().toISOString();
  const stat = config.chatStats.find(s => s.room === room && s.userKey === userKey);

  if (stat) {
    stat.count += 1;
    stat.userName = userName;
    stat.lastSeenAt = now;
  } else {
    const newStat: ChatStat = {
      room,
      userKey,
      userName,
      count: 1,
      firstSeenAt: now,
      lastSeenAt: now,
    };
    config.chatStats.push(newStat);
  }
}

function recordMemberEvent(room: string, user: any, type: 'JOIN' | 'LEAVE'): number {
  const userKey = userKeyOf(user);
  const userName = userNameOf(user);
  const count = config.memberEvents.filter(e => e.room === room && e.userKey === userKey && e.type === 'JOIN').length +
    (type === 'JOIN' ? 1 : 0);

  config.memberEvents.push({
    room,
    userKey,
    userName,
    type,
    at: new Date().toISOString(),
    count,
  });

  // 무한히 커지는 설정 파일을 방지하기 위해 최근 2,000건만 보관한다.
  if (config.memberEvents.length > 2000) {
    config.memberEvents.splice(0, config.memberEvents.length - 2000);
  }
  return count;
}

function getRoomChatRanking(room: string): ChatStat[] {
  return config.chatStats
    .filter(s => s.room === room)
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);
}

function formatChatRanking(room: string): string {
  const ranking = getRoomChatRanking(room);
  if (!ranking.length) return '📊 아직 채팅 기록이 없습니다.';

  const lines = ['📊 채팅 순위', ''];
  ranking.forEach((item, index) => {
    const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}위`;
    lines.push(`${medal} ${item.userName} — ${item.count}회`);
  });
  return lines.join('\n');
}

function formatMemberLogs(room: string): string {
  const logs = config.memberEvents.filter(e => e.room === room).slice(-50).reverse();
  if (!logs.length) return '📋 아직 입퇴장 기록이 없습니다.';

  const lines = ['📋 입퇴장 로그', ''];
  for (const event of logs) {
    const time = new Intl.DateTimeFormat('ko-KR', {
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(event.at));
    const mark = event.type === 'JOIN' ? '[+]' : '[-]';
    lines.push(`${mark} ${time} ${event.userName} — ${event.type === 'JOIN' ? '입장' : '퇴장'}`);
  }
  return lines.join('\n');
}

function commandHelp(): string {
  return [
    '📖 명령어',
    '',
    '!핑 - 응답 확인',
    '!명령어 - 명령어 목록',
    '!echo <내용> - 내용 반복',
    '!채팅순위 - 현재 방 채팅 순위',
    '!입퇴장로그 - 최근 입퇴장 로그',
    '!봇정보 - 현재 봇 상태',
    '!봇등록 - 8자리 방 등록 코드 생성',
    '!방등록해제 - 현재 채팅방 등록 해제',
  ].join('\n');
}

async function startBot(): Promise<void> {
  if (running) {
    console.log('[!] 이미 실행 중입니다.');
    return;
  }

  activeAccount = config.accounts.find(a => a.email === config.activeAccount) || await chooseAccount();
  if (!activeAccount) return;

  running = true;
  console.log(`[+] 계정: ${activeAccount.email}`);
  console.log(`[+] 등록 방: ${roomListToString(config.rooms)}`);
  console.log('[+] node-kakao 연결 중...');

  const api = await AuthApiClient.create('loco-termux', activeAccount.deviceUuid);
  const loginRes = await api.login({
    email: activeAccount.email,
    password: activeAccount.password,
    forced: false,
  });
  if (!loginRes.success) {
    running = false;
    throw new Error(`Web login failed: ${loginRes.status}`);
  }

  const result = await client.login(loginRes.result);
  if (!result.success) {
    running = false;
    throw new Error(`KakaoTalk login failed: ${result.status}`);
  }
  console.log('[✓] 로그인 성공. 봇 실행 중');
}

client.on('chat', async (data, channel) => {
  const roomName = roomNameOf(channel);
  const text = data.text?.trim();
  if (!roomName || !text) return;

  const sender = data.getSenderInfo?.(channel);
  if (sender) {
    recordChat(roomName, sender);
    saveConfig(config);
  }

  // !봇등록은 방 목록에 없는 방에서도 사용할 수 있도록 별도 처리한다.
  if (text === `${config.prefix}봇등록`) {
    printBotRegistrationCode();
    return;
  }

  // 8자리 등록 코드를 방에 입력하면 해당 방을 자동 등록한다.
  if (/^\d{8}$/.test(text) && pendingRegistration && Date.now() < pendingRegistration.expiresAt && text === pendingRegistration.code) {
    if (!config.rooms.includes(roomName)) config.rooms.push(roomName);
    saveConfig(config);
    pendingRegistration = null;
    console.log(`[✓] 자동 방 등록: ${roomName}`);
    await channel.sendChat('✓ 이 채팅방이 봇 방으로 등록되었습니다.');
    return;
  }

  // 일반 명령어는 등록된 방에서만 처리한다.
  if (!isAllowedRoom(roomName)) return;
  if (!text.startsWith(config.prefix)) return;

  const [command, ...args] = text.slice(config.prefix.length).trim().split(/\s+/);
  const cmd = command?.toLowerCase();

  if (cmd === 'ping' || cmd === '핑') {
    await channel.sendChat('Pong!');
  } else if (cmd === 'help' || cmd === '명령어') {
    await channel.sendChat(commandHelp());
  } else if (cmd === 'echo') {
    await channel.sendChat(args.join(' ') || '사용법: !echo <내용>');
  } else if (cmd === '채팅순위') {
    await channel.sendChat(formatChatRanking(roomName));
  } else if (cmd === '입퇴장로그') {
    await channel.sendChat(formatMemberLogs(roomName));
  } else if (cmd === '봇정보') {
    await channel.sendChat([
      '🤖 LOCO TERMUX BOT',
      `방: ${roomName}`,
      `등록 방 수: ${config.rooms.length}`,
      `채팅 기록: ${config.chatStats.filter(s => s.room === roomName).length}명`,
      `입퇴장 기록: ${config.memberEvents.filter(e => e.room === roomName).length}건`,
      '상태: 실행 중',
    ].join('\n'));
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
  }
});

// node-kakao v4 계열의 실제 입장/퇴장 이벤트를 사용한다.
client.on('user_join', async (joinLog, channel, user) => {
  const roomName = roomNameOf(channel);
  if (!roomName || !isAllowedRoom(roomName)) return;

  const count = recordMemberEvent(roomName, user, 'JOIN');
  saveConfig(config);

  const name = userNameOf(user);
  const firstLine = `@${name}님이 ${roomName}에 입장하셨습니다.`;
  const secondLine = count === 1 ? '[+] 첫 입장' : `[+] ${count}번째 입장`;
  const message = `${firstLine}\n\n[+] ${nowText()} ${count === 1 ? '첫 입장' : `${count}번째 입장`}`;
  console.log(`[JOIN] ${roomName} / ${name} / ${count}번째 입장`);
  await channel.sendChat(`${message}\n${secondLine}`);
});

client.on('user_left', async (leftLog, channel, user) => {
  const roomName = roomNameOf(channel);
  if (!roomName || !isAllowedRoom(roomName)) return;

  recordMemberEvent(roomName, user, 'LEAVE');
  saveConfig(config);

  const name = userNameOf(user);
  console.log(`[LEAVE] ${roomName} / ${name}`);
  await channel.sendChat(`@${name}님이 ${roomName}에서 나가셨습니다.\n\n[+] ${nowText()} 퇴장`);
});

client.on('error', error => console.error('[node-kakao] error:', error));
client.on('disconnected', reason => {
  running = false;
  console.error('[node-kakao] disconnected:', reason);
});

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
        config.accounts.forEach((a, i) => console.log(`[+] ${i + 1}번 ${a.email}${a.email === config.activeAccount ? ' (사용중)' : ''}`));
      } else if (choice === '4') await roomSettings();
      else if (choice === '5') {
        console.log(`\n[+] 계정: ${config.activeAccount || '없음'}`);
        console.log(`[+] 방: ${roomListToString(config.rooms)}`);
        console.log(`[+] 접두사: ${config.prefix}`);
        console.log(`[+] 채팅 통계: ${config.chatStats.length}건`);
        console.log(`[+] 입퇴장 로그: ${config.memberEvents.length}건`);
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
