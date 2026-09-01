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
import { RoomAnalyzer } from './analyzer';

const config = loadConfig();
const client = new TalkClient();
const analyzer = new RoomAnalyzer(config);
let activeAccount: Account | null = null;
let running = false;
let pendingRegistration: { code: string; expiresAt: number } | null = null;
let saveTimer: NodeJS.Timeout | null = null;

function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveConfig(config); }, 1000);
}

function banner(): void {
  console.clear();
  console.log('╔══════════════════════════════════╗');
  console.log('║          LOCO TERMUX BOT         ║');
  console.log('╚══════════════════════════════════╝');
}

function isAllowedRoom(roomName: string): boolean {
  return config.rooms.length === 0 || config.rooms.includes(roomName);
}

function generateCode(): string { return crypto.randomInt(10_000_000, 100_000_000).toString(); }

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
    const password = await rl.question('비밀번호: ');
    if (!email || !password) { console.log('[!] 이메일과 비밀번호를 모두 입력해야 합니다.'); return; }
    const existing = config.accounts.findIndex(a => a.email === email);
    const oldUuid = existing >= 0 ? config.accounts[existing].deviceUuid : crypto.randomUUID();
    const account: Account = { email, password, deviceUuid: oldUuid };
    if (existing >= 0) config.accounts[existing] = account; else config.accounts.push(account);
    config.activeAccount = email;
    saveConfig(config);
    activeAccount = account;
    console.log(`[✓] ${email} 계정이 로컬에 등록되었습니다.`);
  } finally { rl.close(); }
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
  } finally { rl.close(); }
}

async function adminSettings(): Promise<void> {
  const rl = readline.createInterface({ input, output });
  try {
    console.log(`\n현재 관리자 ID: ${config.admins.join(', ') || '없음'}`);
    const value = await rl.question('관리자 사용자 ID (,ID,ID,) : ');
    config.admins = [...new Set(value.split(',').map(v => v.trim()).filter(Boolean))];
    saveConfig(config);
    console.log(`[✓] 관리자 ${config.admins.length}명 저장`);
  } finally { rl.close(); }
}

async function chooseAccount(): Promise<Account | null> {
  if (!config.accounts.length) { console.log('[!] 등록된 계정이 없습니다.'); return null; }
  config.accounts.forEach((a, i) => console.log(`[+] ${i + 1}번 ${a.email}${a.email === config.activeAccount ? ' (사용중)' : ''}`));
  const rl = readline.createInterface({ input, output });
  try {
    const n = Number(await rl.question('선택 > '));
    const account = config.accounts[n - 1];
    if (!account) { console.log('[!] 잘못된 번호입니다.'); return null; }
    config.activeAccount = account.email; saveConfig(config); return account;
  } finally { rl.close(); }
}

function roomNameOf(channel: any): string { return channel?.getDisplayName?.() || channel?.getName?.() || ''; }
function userNameOf(user: any): string { return user?.nickname || user?.userInfo?.nickname || user?.UserInfo?.Nickname || '알 수 없음'; }
function userKeyOf(user: any): string {
  const id = user?.userId ?? user?.userID ?? user?.id ?? user?.UserId;
  return id != null ? String(id) : userNameOf(user);
}
function nowText(): string { return new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()); }

function recordChat(room: string, user: any): void {
  const userKey = userKeyOf(user); const userName = userNameOf(user); const now = new Date().toISOString();
  const stat = config.chatStats.find(s => s.room === room && s.userKey === userKey);
  if (stat) { stat.count += 1; stat.userName = userName; stat.lastSeenAt = now; }
  else config.chatStats.push({ room, userKey, userName, count: 1, firstSeenAt: now, lastSeenAt: now });
}

function recordMemberEvent(room: string, user: any, type: 'JOIN' | 'LEAVE'): number {
  const userKey = userKeyOf(user); const userName = userNameOf(user);
  const count = config.memberEvents.filter(e => e.room === room && e.userKey === userKey && e.type === 'JOIN').length + (type === 'JOIN' ? 1 : 0);
  config.memberEvents.push({ room, userKey, userName, type, at: new Date().toISOString(), count });
  if (config.memberEvents.length > 2000) config.memberEvents.splice(0, config.memberEvents.length - 2000);
  return count;
}

function getRoomChatRanking(room: string): ChatStat[] {
  return config.chatStats.filter(s => s.room === room).sort((a, b) => b.count - a.count).slice(0, 20);
}
function formatChatRanking(room: string): string {
  const ranking = getRoomChatRanking(room); if (!ranking.length) return '📊 아직 채팅 기록이 없습니다.';
  const lines = ['📊 채팅 순위', ''];
  ranking.forEach((item, index) => { const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}위`; lines.push(`${medal} ${item.userName} — ${item.count}회`); });
  return lines.join('\n');
}
function formatMemberLogs(room: string, limit = 100): string {
  const logs = config.memberEvents.filter(e => e.room === room).slice(-limit).reverse(); if (!logs.length) return '📋 아직 입퇴장 기록이 없습니다.';
  const lines = ['📋 입퇴장 로그', ''];
  for (const event of logs) { const time = new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(event.at)); const mark = event.type === 'JOIN' ? '[+]' : '[-]'; const extra = event.type === 'JOIN' ? ` (${event.count}번째 입장)` : ''; lines.push(`${mark} ${time} ${event.userName} — ${event.type === 'JOIN' ? '입장' : '퇴장'}${extra}`); }
  return lines.join('\n');
}
function commandHelp(): string {
  return ['📖 명령어', '', '!핑 - 응답 확인', '!명령어 - 명령어 목록', '!echo <내용> - 내용 반복', '!채팅순위 - 채팅 순위', '!입퇴장로그 - 최근 입퇴장 로그', '!전체보기 - 전체 입퇴장 로그', '!봇정보 - 봇 상태', '!봇등록 - 8자리 방 등록 코드', '!방등록해제 - 방 등록 해제'].join('\n');
}

function extractReplyId(data: any): string | undefined {
  const r = data?.reply ?? data?.replyTo ?? data?.replyMessage ?? data?.quote;
  if (r == null) return undefined;
  if (typeof r === 'string' || typeof r === 'number') return String(r);
  return String(r?.messageId ?? r?.logId ?? r?.id ?? r?.message?.id ?? r?.message?.logId ?? '');
}

function extractSentMessageId(result: any): string | undefined {
  if (!result) return undefined;
  return String(result?.messageId ?? result?.logId ?? result?.id ?? result?.logIdStr ?? '') || undefined;
}

async function trySupportedKick(channel: any, targetUserKey: string): Promise<boolean> {
  // Use only an explicitly exposed client/channel kick operation. No packet forging.
  const fn = channel?.kick ?? channel?.removeUser ?? channel?.deleteUser;
  if (typeof fn !== 'function') return false;
  await fn.call(channel, targetUserKey);
  return true;
}

async function handleKickReply(data: any, channel: any, roomName: string): Promise<boolean> {
  const text = data.text?.trim().toLowerCase(); if (text !== 'kick') return false;
  const actor = data.getSenderInfo?.(channel); if (!actor) return true;
  const actorKey = userKeyOf(actor); const actorName = userNameOf(actor);
  if (!analyzer.isAdmin(actorKey)) { analyzer.logCommand(roomName, actorKey, actorName, 'kick', 'DENIED_ADMIN_ONLY'); await channel.sendChat('⛔ 관리자만 가능합니다.'); return true; }

  const replyId = extractReplyId(data);
  let target: any = undefined;
  if (replyId) {
    for (const event of config.memberEvents.slice().reverse()) {
      if (event.room !== roomName || event.type !== 'LEAVE') continue;
      const leave = analyzer.findLeave(roomName, event.userKey);
      if (leave?.messageId === replyId) { target = leave; break; }
    }
  }
  if (!target) {
    analyzer.logCommand(roomName, actorKey, actorName, 'kick', 'DENIED_TARGET_NOT_FOUND');
    await channel.sendChat('⚠️ 답장한 퇴장 안내 메시지의 대상을 찾지 못했습니다.'); return true;
  }

  try {
    const supported = await trySupportedKick(channel, target.userKey);
    if (!supported) {
      analyzer.logCommand(roomName, actorKey, actorName, 'kick', 'UNSUPPORTED_TRANSPORT');
      await channel.sendChat('⚠️ 현재 연결된 node-kakao 채널에서 지원되는 강퇴 API를 찾지 못했습니다.');
      return true;
    }
    analyzer.logCommand(roomName, actorKey, actorName, 'kick', `SUCCESS:${target.userKey}`);
    await channel.sendChat(`✓ ${target.userName}님을 내보냈습니다.\n실행자: ${actorName}`);
  } catch (error) {
    console.error('[KICK]', error);
    analyzer.logCommand(roomName, actorKey, actorName, 'kick', 'FAILED');
    await channel.sendChat(`❌ ${target.userName}님 내보내기에 실패했습니다.`);
  }
  return true;
}

async function startBot(): Promise<void> {
  if (running) { console.log('[!] 이미 실행 중입니다.'); return; }
  activeAccount = config.accounts.find(a => a.email === config.activeAccount) || await chooseAccount(); if (!activeAccount) return;
  running = true;
  console.log(`[+] 계정: ${activeAccount.email}`); console.log(`[+] 등록 방: ${roomListToString(config.rooms)}`); console.log('[+] node-kakao 연결 중...');
  try {
    const api = await AuthApiClient.create('loco-termux', activeAccount.deviceUuid);
    const loginRes = await api.login({ email: activeAccount.email, password: activeAccount.password });
    if (!loginRes.success) throw new Error(`Web login failed: ${loginRes.status}`);
    const result = await client.login(loginRes.result);
    if (!result.success) throw new Error(`KakaoTalk login failed: ${result.status}`);
    console.log('[✓] 로그인 성공. 봇 실행 중');
  } catch (error) { running = false; throw error; }
}

client.on('chat', async (data, channel) => {
  const roomName = roomNameOf(channel); const text = data.text?.trim(); if (!roomName || !text) return;
  const sender = data.getSenderInfo?.(channel); if (sender) { recordChat(roomName, sender); scheduleSave(); }
  if (text.toLowerCase() === 'kick') { await handleKickReply(data, channel, roomName); return; }
  if (text === `${config.prefix}봇등록`) { printBotRegistrationCode(); return; }
  if (/^\d{8}$/.test(text) && pendingRegistration && Date.now() < pendingRegistration.expiresAt && text === pendingRegistration.code) {
    if (!config.rooms.includes(roomName)) config.rooms.push(roomName); saveConfig(config); pendingRegistration = null; console.log(`[✓] 자동 방 등록: ${roomName}`); await channel.sendChat('✓ 이 채팅방이 봇 방으로 등록되었습니다.'); return;
  }
  if (!isAllowedRoom(roomName) || !text.startsWith(config.prefix)) return;
  const [command, ...args] = text.slice(config.prefix.length).trim().split(/\s+/); const cmd = command?.toLowerCase();
  if (cmd === 'ping' || cmd === '핑') await channel.sendChat('Pong!');
  else if (cmd === 'help' || cmd === '명령어') await channel.sendChat(commandHelp());
  else if (cmd === 'echo') await channel.sendChat(args.join(' ') || '사용법: !echo <내용>');
  else if (cmd === '채팅순위') await channel.sendChat(formatChatRanking(roomName));
  else if (cmd === '입퇴장로그') await channel.sendChat(formatMemberLogs(roomName, 50));
  else if (cmd === '전체보기') await channel.sendChat(formatMemberLogs(roomName, 100));
  else if (cmd === '봇정보') await channel.sendChat(['🤖 LOCO TERMUX BOT', `방: ${roomName}`, `등록 방 수: ${config.rooms.length}`, `관리자: ${config.admins.length}명`, `채팅 기록: ${config.chatStats.filter(s => s.room === roomName).length}명`, `입퇴장 기록: ${config.memberEvents.filter(s => s.room === roomName).length}건`, `명령 로그: ${config.commandLogs.filter(s => s.room === roomName).length}건`, '상태: 실행 중'].join('\n'));
  else if (cmd === '방등록해제') {
    const index = config.rooms.indexOf(roomName); if (index === -1) { await channel.sendChat('ℹ️ 이 채팅방은 등록되어 있지 않습니다.'); return; }
    config.rooms.splice(index, 1); saveConfig(config); console.log(`[✓] 방 등록 해제: ${roomName}`); await channel.sendChat('✓ 이 채팅방의 봇 등록을 해제했습니다.');
  }
});

client.on('user_join', async (_joinLog, channel, user) => {
  const roomName = roomNameOf(channel); if (!roomName || !isAllowedRoom(roomName)) return;
  const count = recordMemberEvent(roomName, user, 'JOIN'); saveConfig(config); const name = userNameOf(user);
  const message = count === 1 ? `@${name}님이 ${roomName}에 입장하셨습니다.\n\n[+] ${nowText()} 첫 입장\n[+] 1번째 입장` : `@${name}님이 ${roomName}에 입장하셨습니다.\n\n[+] ${nowText()} 입장\n[+] ${count}번째 입장`;
  console.log(`[JOIN] ${roomName} / ${name} / ${count}번째 입장`); await channel.sendChat(message);
});

client.on('user_left', async (_leftLog, channel, user) => {
  const roomName = roomNameOf(channel); if (!roomName || !isAllowedRoom(roomName)) return;
  recordMemberEvent(roomName, user, 'LEAVE');
  const name = userNameOf(user); const key = userKeyOf(user);
  console.log(`[LEAVE] ${roomName} / ${name}`);
  const result = await channel.sendChat(`${name}님이 나가셨습니다.\n\n[전체보기]\n\n${name} 님이 ${nowText()}에 나가셨습니다.\n나간사람을 내보내실려면 이 메시지에 답장으로 kick이라고 보내주세요.\n[관리자만 가능합니다]`);
  const messageId = extractSentMessageId(result);
  analyzer.recordLeave(roomName, key, name, messageId);
  saveConfig(config);
});

client.on('error', error => console.error('[node-kakao] error:', error));
client.on('disconnected', reason => { running = false; console.error('[node-kakao] disconnected:', reason); });

async function menu(): Promise<void> {
  while (true) {
    banner();
    console.log('[+] 1번 봇 시작'); console.log('[+] 2번 계정 등록'); console.log('[+] 3번 계정 목록'); console.log('[+] 4번 방 설정'); console.log('[+] 5번 관리자 설정'); console.log('[+] 6번 설정 확인'); console.log('[+] 7번 종료');
    const rl = readline.createInterface({ input, output }); const choice = (await rl.question('\n선택 > ')).trim(); rl.close();
    try {
      if (choice === '1') await startBot();
      else if (choice === '2') await registerAccount();
      else if (choice === '3') { console.log('\n[+] 등록 계정'); config.accounts.forEach((a, i) => console.log(`[+] ${i + 1}번 ${a.email}${a.email === config.activeAccount ? ' (사용중)' : ''}`)); }
      else if (choice === '4') await roomSettings();
      else if (choice === '5') await adminSettings();
      else if (choice === '6') { console.log(`\n[+] 계정: ${config.activeAccount || '없음'}`); console.log(`[+] 방: ${roomListToString(config.rooms)}`); console.log(`[+] 관리자: ${config.admins.join(', ') || '없음'}`); console.log(`[+] 채팅 통계: ${config.chatStats.length}건`); console.log(`[+] 입퇴장 로그: ${config.memberEvents.length}건`); console.log(`[+] 명령 로그: ${config.commandLogs.length}건`); }
      else if (choice === '7') { if (saveTimer) clearTimeout(saveTimer); saveConfig(config); console.log('[✓] 종료합니다.'); process.exit(0); }
      else console.log('[!] 1~7번 중에서 선택하세요.');
    } catch (error) { running = false; console.error('[FATAL]', error); }
    await new Promise(resolve => setTimeout(resolve, 800));
  }
}

menu().catch(error => { console.error('[FATAL]', error); process.exitCode = 1; });
