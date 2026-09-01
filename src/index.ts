import 'dotenv/config';
import crypto from 'node:crypto';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { AuthApiClient, TalkClient } from 'node-kakao';
import { loadConfig, saveConfig, parseRoomList, roomListToString, type Account, type ChatStat } from './config';
import { RoomAnalyzer } from './analyzer';

const config = loadConfig();
const client = new TalkClient();
const analyzer = new RoomAnalyzer(config);
let activeAccount: Account | null = null;
let running = false;
let pendingRegistration: { code: string; expiresAt: number } | null = null;
let saveTimer: NodeJS.Timeout | null = null;

function scheduleSave(): void { if (saveTimer) return; saveTimer = setTimeout(() => { saveTimer = null; saveConfig(config); }, 1000); }
function banner(): void { console.clear(); console.log('╔══════════════════════════════════╗'); console.log('║          LOCO TERMUX BOT         ║'); console.log('╚══════════════════════════════════╝'); }
function isAllowedRoom(roomName: string): boolean { return config.rooms.length === 0 || config.rooms.includes(roomName); }
function generateCode(): string { return crypto.randomInt(10_000_000, 100_000_000).toString(); }
function printBotRegistrationCode(): void { const code = generateCode(); pendingRegistration = { code, expiresAt: Date.now() + 5 * 60_000 }; console.log(`\n[+] 봇등록 코드: ${code}`); console.log('[+] 유효시간: 5분'); }

async function registerAccount(): Promise<void> {
  const rl = readline.createInterface({ input, output });
  try {
    const email = (await rl.question('카카오 계정 이메일/전화번호: ')).trim();
    const password = await rl.question('비밀번호: ');
    if (!email || !password) { console.log('[!] 이메일과 비밀번호를 모두 입력해야 합니다.'); return; }
    const existing = config.accounts.findIndex(a => a.email === email);
    const deviceUuid = existing >= 0 ? config.accounts[existing].deviceUuid : crypto.randomUUID();
    const account: Account = { email, password, deviceUuid };
    if (existing >= 0) config.accounts[existing] = account; else config.accounts.push(account);
    config.activeAccount = email; activeAccount = account; saveConfig(config);
    console.log(`[✓] ${email} 계정이 등록되었습니다.`);
  } finally { rl.close(); }
}

async function chooseAccount(): Promise<Account | null> {
  if (!config.accounts.length) { console.log('[!] 등록된 계정이 없습니다.'); return null; }
  config.accounts.forEach((a, i) => console.log(`[+] ${i + 1}번 ${a.email}${a.email === config.activeAccount ? ' (사용중)' : ''}`));
  const rl = readline.createInterface({ input, output });
  try { const n = Number(await rl.question('선택 > ')); const account = config.accounts[n - 1]; if (!account) return null; config.activeAccount = account.email; saveConfig(config); return account; }
  finally { rl.close(); }
}
async function roomSettings(): Promise<void> { const rl = readline.createInterface({ input, output }); try { const value = await rl.question(`현재 방: ${roomListToString(config.rooms)}\n방 이름 (,이름,이름,) : `); config.rooms = parseRoomList(value); saveConfig(config); console.log(`[✓] ${config.rooms.length}개 방 등록 완료`); } finally { rl.close(); } }
async function adminSettings(): Promise<void> { const rl = readline.createInterface({ input, output }); try { const value = await rl.question(`현재 관리자 ID: ${config.admins.join(', ') || '없음'}\n관리자 사용자 ID (,ID,ID,) : `); config.admins = [...new Set(value.split(',').map(v => v.trim()).filter(Boolean))]; saveConfig(config); console.log(`[✓] 관리자 ${config.admins.length}명 저장`); } finally { rl.close(); } }
function roomNameOf(channel: any): string { return channel?.getDisplayName?.() || channel?.getName?.() || ''; }
function userNameOf(user: any): string { return user?.nickname || user?.userInfo?.nickname || user?.UserInfo?.Nickname || '알 수 없음'; }
function userKeyOf(user: any): string { const id = user?.userId ?? user?.userID ?? user?.id ?? user?.UserId; return id != null ? String(id) : userNameOf(user); }
function timeOf(iso = new Date().toISOString()): string { return new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso)); }
function recordChat(room: string, user: any): void { const userKey = userKeyOf(user), userName = userNameOf(user), now = new Date().toISOString(); const stat = config.chatStats.find(s => s.room === room && s.userKey === userKey); if (stat) { stat.count++; stat.userName = userName; stat.lastSeenAt = now; } else config.chatStats.push({ room, userKey, userName, count: 1, firstSeenAt: now, lastSeenAt: now }); if (config.chatStats.length > 5000) config.chatStats.splice(0, config.chatStats.length - 5000); }
function overview(title: string, body: string): string { return [`📋 ${title}`, '', '[전체보기]', '', body].join('\n'); }
function formatChatRanking(room: string): string { const ranking: ChatStat[] = config.chatStats.filter(s => s.room === room).sort((a, b) => b.count - a.count).slice(0, 20); return overview('채팅 활동', ranking.length ? ranking.map((x, i) => `${i + 1}위 ${x.userName} — ${x.count}회`).join('\n') : '아직 채팅 기록이 없습니다.'); }
function formatMemberLogs(room: string, limit = 100): string { const logs = config.memberEvents.filter(e => e.room === room).slice(-limit).reverse(); return overview('입퇴장 기록', logs.length ? logs.map(e => `${e.type === 'JOIN' ? '🟢' : '🔴'} ${timeOf(e.at)} ${e.userName} — ${e.type === 'JOIN' ? `입장 (${e.count}번째)` : '퇴장'}`).join('\n') : '아직 입퇴장 기록이 없습니다.'); }
function formatBotInfo(room: string): string { return overview('봇 정보', [`방: ${room}`, `등록 방 수: ${config.rooms.length}`, `관리자: ${config.admins.length}명`, `채팅 기록: ${config.chatStats.filter(x => x.room === room).length}명`, `입퇴장 기록: ${config.memberEvents.filter(x => x.room === room).length}건`, `관리 명령 로그: ${config.commandLogs.filter(x => x.room === room).length}건`, `상태: ${running ? '실행 중' : '대기'}`].join('\n')); }
function commandHelp(): string { return overview('명령어', ['!핑 - 응답 확인', '!명령어 - 명령어 목록', '!echo <내용> - 내용 반복', '!채팅순위 - 채팅 활동 전체보기', '!입퇴장로그 - 입퇴장 기록 전체보기', '!봇정보 - 봇 상태 전체보기', '!봇등록 - 8자리 방 등록 코드', '!방등록해제 - 방 등록 해제', '', '※ 게임 관련 기능은 포함하지 않습니다.'].join('\n')); }
function extractReplyId(data: any): string | undefined { const r = data?.reply ?? data?.replyTo ?? data?.replyMessage ?? data?.quote; if (r == null) return undefined; if (typeof r === 'string' || typeof r === 'number') return String(r); const id = r?.messageId ?? r?.logId ?? r?.id ?? r?.message?.id ?? r?.message?.logId; return id == null ? undefined : String(id); }
function extractSentMessageId(result: any): string | undefined { const id = result?.messageId ?? result?.logId ?? result?.id ?? result?.logIdStr; return id == null ? undefined : String(id); }
async function trySupportedKick(channel: any, targetUserKey: string): Promise<boolean> { const fn = channel?.kick ?? channel?.removeUser ?? channel?.deleteUser; if (typeof fn !== 'function') return false; await fn.call(channel, targetUserKey); return true; }
async function handleKickReply(data: any, channel: any, roomName: string): Promise<boolean> { if (data.text?.trim().toLowerCase() !== 'kick') return false; const actor = data.getSenderInfo?.(channel); if (!actor) return true; const actorKey = userKeyOf(actor), actorName = userNameOf(actor); if (!analyzer.isAdmin(actorKey)) { analyzer.logCommand(roomName, actorKey, actorName, 'kick', 'DENIED_ADMIN_ONLY'); await channel.sendChat(overview('강퇴', '⛔ 관리자만 가능합니다.')); return true; } const replyId = extractReplyId(data); const target = replyId ? analyzer.findLeaveByMessage(roomName, replyId) : undefined; if (!target) { analyzer.logCommand(roomName, actorKey, actorName, 'kick', 'DENIED_TARGET_NOT_FOUND'); await channel.sendChat(overview('강퇴', '⚠️ 퇴장 안내 메시지에 답장해서 kick을 입력해주세요.')); return true; } try { if (!(await trySupportedKick(channel, target.userKey))) { analyzer.logCommand(roomName, actorKey, actorName, 'kick', 'UNSUPPORTED_TRANSPORT'); await channel.sendChat(overview('강퇴', '⚠️ 현재 채널에서 지원되는 관리자 강퇴 기능을 찾지 못했습니다.')); return true; } analyzer.logCommand(roomName, actorKey, actorName, 'kick', `SUCCESS:${target.userKey}`); await channel.sendChat(overview('강퇴', `✓ ${target.userName}님을 내보냈습니다.\n실행자: ${actorName}`)); } catch (error) { console.error('[KICK]', error); analyzer.logCommand(roomName, actorKey, actorName, 'kick', 'FAILED'); await channel.sendChat(overview('강퇴', `❌ ${target.userName}님 내보내기에 실패했습니다.`)); } return true; }

async function loginMenu(): Promise<'success' | 'back'> {
  while (true) {
    console.log('\n╔══════════════════════════════╗');
    console.log('║          LOCO LOGIN          ║');
    console.log('╠══════════════════════════════╣');
    console.log('║  1. 기본 로그인              ║');
    console.log('║  2. QR 로그인                ║');
    console.log('║  3. 카카오톡 간편 로그인     ║');
    console.log('║  4. 테스트 가짜 로그인       ║');
    console.log('║  5. 뒤로가기                 ║');
    console.log('╚══════════════════════════════╝');
    const rl = readline.createInterface({ input, output }); const choice = (await rl.question('선택 > ')).trim(); rl.close();
    if (choice === '5') return 'back';
    if (choice === '4') { const mockId = `mock_${crypto.randomUUID().slice(0, 8)}`; activeAccount = { email: mockId, password: '', deviceUuid: `mock_device_${crypto.randomUUID()}` }; running = true; console.log(`[✓] 테스트 로그인 성공: ${mockId}`); console.log('[!] MOCK 모드: 실제 Kakao 서버에는 로그인하지 않습니다.'); return 'success'; }
    if (choice === '1') {
      const account = config.accounts.find(a => a.email === config.activeAccount) || await chooseAccount(); if (!account) continue;
      try {
        console.log('[LOGIN] 기본 로그인 시도 중...');
        const api = await AuthApiClient.create('loco-termux', account.deviceUuid);
        const loginRes = await api.login({ email: account.email, password: account.password });
        if (!loginRes.success) { console.error(`[LOGIN] 서버 로그인 거부: status=${loginRes.status}`); console.error('[LOGIN] -999 발생 시 임의 세션을 생성하지 않습니다.'); continue; }
        const result = await client.login(loginRes.result);
        if (!result.success) { console.error(`[LOGIN] KakaoTalk login failed: ${result.status}`); continue; }
        activeAccount = account; running = true; console.log('[✓] 로그인 성공. 봇 실행 중'); return 'success';
      } catch (error) { console.error('[LOGIN] 예외:', error instanceof Error ? error.message : error); continue; }
    }
    if (choice === '2') { console.log('[QR] 현재 인증 라이브러리에 독립적인 QR 로그인 API가 노출되어 있지 않습니다.'); console.log('[QR] 지원되지 않는 API를 추측 호출하지 않습니다.'); continue; }
    if (choice === '3') { console.log('[간편 로그인] 카카오톡 기반 간편 인증은 실제 OAuth 엔드포인트와 등록된 redirect URI가 필요합니다.'); console.log('[간편 로그인] 기존 redirect_uri는 변경하지 않습니다.'); continue; }
    console.log('[!] 올바른 메뉴를 선택하세요.');
  }
}

async function startBot(): Promise<void> { if (running) return console.log('[!] 이미 실행 중입니다.'); const result = await loginMenu(); if (result === 'back') return; if (!running || !activeAccount) return; }

client.on('chat', async (data, channel) => { try { const roomName = roomNameOf(channel), text = data.text?.trim(); if (!roomName || !text || !isAllowedRoom(roomName)) return; const sender = data.getSenderInfo?.(channel); if (sender) { recordChat(roomName, sender); scheduleSave(); } if (text.toLowerCase() === 'kick') { await handleKickReply(data, channel, roomName); return; } if (text === `${config.prefix}봇등록`) { printBotRegistrationCode(); return; } if (/^\d{8}$/.test(text) && pendingRegistration && Date.now() < pendingRegistration.expiresAt && text === pendingRegistration.code) { if (!config.rooms.includes(roomName)) config.rooms.push(roomName); pendingRegistration = null; saveConfig(config); await channel.sendChat(overview('방 등록', '✓ 이 채팅방이 봇 방으로 등록되었습니다.')); return; } if (!text.startsWith(config.prefix)) return; const [command, ...args] = text.slice(config.prefix.length).trim().split(/\s+/), cmd = command?.toLowerCase(); if (cmd === 'ping' || cmd === '핑') await channel.sendChat(overview('핑', 'Pong!')); else if (cmd === 'help' || cmd === '명령어') await channel.sendChat(commandHelp()); else if (cmd === 'echo') await channel.sendChat(overview('Echo', args.join(' ') || '사용법: !echo <내용>')); else if (cmd === '채팅순위') await channel.sendChat(formatChatRanking(roomName)); else if (cmd === '입퇴장로그') await channel.sendChat(formatMemberLogs(roomName, 100)); else if (cmd === '봇정보') await channel.sendChat(formatBotInfo(roomName)); else if (cmd === '방등록해제') { const i = config.rooms.indexOf(roomName); if (i < 0) return void await channel.sendChat(overview('방 등록', '이 채팅방은 등록되어 있지 않습니다.')); config.rooms.splice(i, 1); saveConfig(config); await channel.sendChat(overview('방 등록 해제', `${roomName}의 봇 등록을 해제했습니다.`)); } } catch (error) { console.error('[CHAT]', error); } });
client.on('user_join', async (_joinLog, channel, user) => { try { const roomName = roomNameOf(channel); if (!roomName || !isAllowedRoom(roomName)) return; const key = userKeyOf(user), name = userNameOf(user); const count = analyzer.recordJoin(roomName, key, name); await channel.sendChat(overview('입장 알림', `${name}님이 방에 입장하셨습니다.\n\n${name} 님이 ${timeOf()}에 입장하셨습니다.\n${count}번째 입장`)); } catch (error) { console.error('[JOIN]', error); } });
client.on('user_left', async (_leftLog, channel, user) => { try { const roomName = roomNameOf(channel); if (!roomName || !isAllowedRoom(roomName)) return; const name = userNameOf(user), key = userKeyOf(user); const record = analyzer.recordLeave(roomName, key, name); const result = await channel.sendChat(analyzer.leaveText(record)); const messageId = extractSentMessageId(result); if (messageId) analyzer.setLeaveMessageId(roomName, key, messageId); } catch (error) { console.error('[LEAVE]', error); } });
client.on('error', error => console.error('[node-kakao] error:', error));
client.on('disconnected', reason => { running = false; console.error('[node-kakao] disconnected:', reason); });

async function menu(): Promise<void> {
  while (true) {
    banner();
    console.log('[+] 1번 봇 시작'); console.log('[+] 2번 계정 등록'); console.log('[+] 3번 계정 목록'); console.log('[+] 4번 방 설정'); console.log('[+] 5번 관리자 설정'); console.log('[+] 6번 설정 확인'); console.log('[+] 7번 종료');
    const rl = readline.createInterface({ input, output }); const choice = (await rl.question('선택 > ')).trim(); rl.close();
    try {
      if (choice === '1') await startBot();
      else if (choice === '2') await registerAccount();
      else if (choice === '3') config.accounts.forEach((a, i) => console.log(`${i + 1}. ${a.email}${a.email === config.activeAccount ? ' (사용중)' : ''}`));
      else if (choice === '4') await roomSettings();
      else if (choice === '5') await adminSettings();
      else if (choice === '6') console.log(`계정: ${config.activeAccount || '없음'}\n방: ${roomListToString(config.rooms)}\n관리자: ${config.admins.join(', ') || '없음'}\n채팅 기록: ${config.chatStats.length}\n입퇴장 기록: ${config.memberEvents.length}\n관리 명령 로그: ${config.commandLogs.length}\n상태: ${running ? '실행 중' : '대기'}`);
      else if (choice === '7') { if (saveTimer) clearTimeout(saveTimer); saveConfig(config); process.exit(0); }
      else console.log('[!] 올바른 메뉴를 선택하세요.');
    } catch (error) { running = false; console.error('[ERROR]', error instanceof Error ? error.message : error); }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}
menu().catch(error => { running = false; console.error('[FATAL]', error instanceof Error ? error.message : error); process.exitCode = 1; });
