import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createAuthByQR, createClient } from './kakaoforge-loader';

const DATA_DIR = join(homedir(), '.loco-termux');
const AUTH_PATH = join(DATA_DIR, 'kakaoforge-auth.json');
const STATE_PATH = join(DATA_DIR, 'loco-transport.json');
const COMMAND_STATE_PATH = join(DATA_DIR, 'command-state.json');
const DEVELOPER_ID_PATH = join(DATA_DIR, 'developer-id');

function loadJson(path: string): Record<string, any> {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return value && typeof value === 'object' ? value : {};
  } catch { return {}; }
}

function saveJson(path: string, value: unknown) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
}

function saveState(patch: Record<string, unknown>) {
  const state = loadJson(STATE_PATH);
  saveJson(STATE_PATH, { ...state, ...patch, updatedAt: new Date().toISOString() });
}

function appendMemberEvent(type: 'JOIN' | 'LEAVE' | 'KICK', event: any) {
  const state = loadJson(STATE_PATH);
  const history = Array.isArray(state.memberEvents) ? state.memberEvents : [];
  const item = {
    type,
    at: new Date().toISOString(),
    roomId: String(event?.roomId ?? event?.chatId ?? event?.room?.id ?? event?.chat?.id ?? ''),
    roomName: String(event?.roomName ?? event?.room?.name ?? event?.chat?.name ?? ''),
    userId: String(event?.userId ?? event?.memberId ?? event?.sender?.id ?? event?.member?.id ?? ''),
    nickname: String(event?.nickname ?? event?.name ?? event?.member?.name ?? event?.sender?.name ?? '알 수 없음'),
  };
  history.push(item);
  saveJson(STATE_PATH, { ...state, memberEvents: history.slice(-1000), lastMemberEvent: item, updatedAt: new Date().toISOString() });
  return item;
}

function loadCommandState(): Record<string, any> { return loadJson(COMMAND_STATE_PATH); }
function saveCommandState(state: Record<string, any>) { saveJson(COMMAND_STATE_PATH, state); }

function ensureRoomState(state: Record<string, any>, roomId: string) {
  state.rooms ??= {};
  state.rooms[String(roomId)] ??= { registered: false, code: null, codeExpiresAt: 0, commands: 0, users: {} };
  return state.rooms[String(roomId)];
}

function developerId(client: any): string {
  const configured = String(process.env.LOCO_DEVELOPER_ID ?? '').trim();
  if (configured) return configured;
  try {
    return readFileSync(DEVELOPER_ID_PATH, 'utf8').trim();
  } catch {
    const id = String(client?.userId ?? '');
    if (id) {
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(DEVELOPER_ID_PATH, id, 'utf8');
    }
    return id;
  }
}

function isDeveloper(client: any, senderId: any): boolean {
  const id = String(senderId ?? '');
  return Boolean(id) && id === developerId(client);
}

function isManager(client: any): boolean {
  const type = Number(client?.type);
  return type === 1 || type === 4;
}

function formatTime(value: any): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value ?? '') : date.toLocaleString('ko-KR', { hour12: false });
}

function commandHelp() {
  return [
    '╭────── 🤖 LOCO-TERMUX ──────╮',
    '│',
    '│ 📌 기본',
    '│ !핑 · !명령어 · !echo <내용> · !봇정보',
    '│',
    '│ 📊 관리/분석',
    '│ !채팅순위 · !입퇴장로그',
    '│ !봇등록 · !방등록해제',
    '│ !kick @유저멘션',
    '│',
    '│ 🎰 게임',
    '│ !도박가입 · !도박 <포인트>',
    '│',
    '╰──────────────────────────╯',
  ].join('\n');
}

function extractMentionTarget(msg: any, rawArg: string): { id: string; name?: string } | null {
  const values = [msg?.message?.mentions, msg?.message?.mention, msg?.mentions, msg?.mention, msg?.message?.meta?.mentions, msg?.message?.metadata?.mentions];
  const mentions = values.flatMap((value: any) => Array.isArray(value) ? value : value ? [value] : []);
  const wanted = rawArg.replace(/^@/, '').trim();
  for (const mention of mentions) {
    const id = mention?.userId ?? mention?.id ?? mention?.memberId ?? mention?.user?.id;
    const name = mention?.name ?? mention?.nickname ?? mention?.user?.name ?? mention?.user?.nickname;
    if (id != null && (!wanted || !name || String(name).replace(/^@/, '') === wanted)) return { id: String(id), name: name == null ? undefined : String(name) };
  }
  return null;
}

async function sendToRoom(client: any, roomId: string, body: string) {
  try {
    const result = await client.getChatRooms();
    const rooms = Array.isArray(result?.chats) ? result.chats : Array.isArray(result) ? result : [];
    const room = rooms.find((r: any) => String(r?.id ?? r?.chatId ?? r?.c ?? '') === String(roomId));
    if (room?.sendText) { await room.sendText(roomId, body); return true; }
  } catch (error) { console.error('[EVENT] send failed:', error instanceof Error ? error.message : String(error)); }
  return false;
}

async function announceMemberEvent(client: any, type: 'JOIN' | 'LEAVE', event: any) {
  const item = appendMemberEvent(type, event);
  if (!item.roomId) return;
  const body = type === 'JOIN'
    ? `👋 @${item.nickname}님, 환영합니다!\n명령어: !명령어`
    : `🚪 ${item.nickname}님이 나가셨습니다.\n${formatTime(item.at)}`;
  await sendToRoom(client, item.roomId, body);
}

function collectKnownMembers(room: any): Array<{ id: string; name?: string }> {
  const users = room?.users && typeof room.users === 'object' ? Object.entries(room.users) : [];
  return users.map(([id, value]: [string, any]) => ({ id: String(id), name: value?.nickname ? String(value.nickname) : undefined }));
}

async function getAllMembers(client: any, chat: any, roomState: any): Promise<Array<{ id: string; name?: string }>> {
  const candidates: any[] = [chat, client];
  for (const target of candidates) {
    const fn = target?.getChatMembers ?? target?.getMembers ?? target?.openChatMembers;
    if (typeof fn !== 'function') continue;
    try {
      const result = await fn.call(target, String(chat?.id ?? ''));
      const raw = Array.isArray(result) ? result : Array.isArray(result?.members) ? result.members : Array.isArray(result?.users) ? result.users : [];
      const members = raw.map((m: any) => ({ id: String(m?.id ?? m?.userId ?? m?.memberId ?? ''), name: m?.name ?? m?.nickname })).filter((m: any) => m.id);
      if (members.length) return members;
    } catch (error) { console.error('[ALLKICK] member discovery failed:', error instanceof Error ? error.message : String(error)); }
  }
  return collectKnownMembers(roomState);
}

async function handleAllKick(client: any, chat: any, roomId: string, roomState: any, send: (body: string) => Promise<any>) {
  if (!chat?.isOpenChat) { await send('🔒 이 기능은 Open Chat에서만 사용할 수 있습니다.'); return; }
  if (!isDeveloper(client, roomState.__requesterId)) { await send('🔒 권한 없음.'); return; }
  if (!isManager(client)) { await send('❌ 봇이 Open Chat 방장/관리자가 아니어서 실행할 수 없습니다.'); return; }

  const members = await getAllMembers(client, chat, roomState);
  const botId = String(client.userId);
  const targets = members.filter(m => m.id && m.id !== botId);
  if (!targets.length) { await send('ℹ️ 현재 확인 가능한 대상이 없습니다.'); return; }

  await send(`⚠️ 개발자 전용 일괄 내보내기 시작\n대상 ${targets.length}명`);
  let success = 0;
  let failed = 0;
  for (const target of targets) {
    try {
      await chat.openChatKick(roomId, Number(target.id));
      appendMemberEvent('KICK', { roomId, roomName: chat?.name, userId: target.id, nickname: target.name ?? '알 수 없음' });
      success++;
    } catch (error) {
      failed++;
      console.error(`[ALLKICK] ${target.id}:`, error instanceof Error ? error.message : String(error));
    }
  }
  await send(`🛡️ 일괄 내보내기 완료\n성공 ${success}명 · 실패 ${failed}명`);
}

async function handleCommand(client: any, chat: any, msg: any) {
  const text = String(msg?.message?.text ?? '').trim();
  if (!text.startsWith('!') || String(msg?.sender?.id) === String(client?.userId)) return;
  const roomId = String(msg?.room?.id ?? chat?.id ?? '');
  if (!roomId) return;
  const parts = text.split(/\s+/);
  const command = parts[0].toLowerCase();
  const args = parts.slice(1);
  const state = loadCommandState();
  const room = ensureRoomState(state, roomId);
  const userId = String(msg?.sender?.id ?? '');
  room.__requesterId = userId;
  room.commands = Number(room.commands ?? 0) + 1;
  room.users[userId] ??= { nickname: String(msg?.sender?.name ?? ''), messages: 0, joined: false, points: 0 };
  room.users[userId].nickname = String(msg?.sender?.name ?? '');
  saveCommandState(state);
  const send = async (body: string) => chat.sendText(roomId, body);

  try {
    switch (command) {
      case '!핑': case '!ping': await send('🏓 pong!'); break;
      case '!명령어': case '!help': await send(commandHelp()); break;
      case '!echo': await send(args.length ? args.join(' ') : '사용법: !echo <내용>'); break;
      case '!봇정보': case '!info':
        await send(`🤖 LOCO-Termux\n전송: KakaoForge/LOCO\n방: ${String(msg.room?.name ?? roomId)}\nOpen Chat: ${msg.room?.isOpenChat === true ? 'YES' : 'NO'}\n등록: ${room.registered ? 'YES' : 'NO'}\nDeveloper Gate: ${isDeveloper(client, userId) ? 'ACTIVE' : 'LOCKED'}`);
        break;
      case '!채팅순위': {
        const rows = Object.values(room.users as Record<string, any>).sort((a: any, b: any) => Number(b.messages ?? 0) - Number(a.messages ?? 0)).slice(0, 10);
        await send(rows.length ? ['🏆 채팅순위', ...rows.map((x: any, i) => `${i + 1}. ${x.nickname || '알 수 없음'} — ${x.messages}회`)].join('\n') : '아직 수집된 채팅 데이터가 없습니다.');
        break;
      }
      case '!입퇴장로그': {
        const events = (Array.isArray(loadJson(STATE_PATH).memberEvents) ? loadJson(STATE_PATH).memberEvents : []).filter((e: any) => e.type === 'JOIN' || e.type === 'LEAVE').slice(-100).reverse();
        await send(events.length ? ['📜 입퇴장 로그', ...events.map((e: any) => `${e.type === 'JOIN' ? '[입장]' : '[퇴장]'} ${e.nickname} | ${formatTime(e.at)}`)].join('\n') : '수집된 로그가 없습니다.');
        break;
      }
      case '!봇등록': {
        if (!isManager(client)) { await send('❌ Open Chat 방장/관리자만 사용할 수 있습니다.'); break; }
        const now = Date.now();
        if (room.code && Number(room.codeExpiresAt) > now) { await send(`🔐 등록코드: ${room.code}\n남은 시간: ${Math.ceil((Number(room.codeExpiresAt) - now) / 1000)}초`); break; }
        room.code = String(Math.floor(10000000 + Math.random() * 90000000));
        room.codeExpiresAt = now + 5 * 60 * 1000;
        room.registered = true;
        saveCommandState(state);
        await send(`🔐 방 등록코드: ${room.code}\n5분 이내 Termux 패널에서 등록하세요.`);
        break;
      }
      case '!방등록해제':
        if (!isManager(client)) { await send('❌ Open Chat 방장/관리자만 사용할 수 있습니다.'); break; }
        room.registered = false; room.code = null; room.codeExpiresAt = 0; saveCommandState(state); await send('✅ 현재 방의 봇 등록을 해제했습니다.');
        break;
      case '!도박가입':
        if (room.users[userId].joined) { await send(`이미 가입되어 있습니다. 잔액: ${Number(room.users[userId].points ?? 0).toLocaleString()}P`); break; }
        room.users[userId].joined = true; room.users[userId].points = 1000; saveCommandState(state); await send(`🎰 ${room.users[userId].nickname}님 가입 완료! 시작 잔액: 1,000P`);
        break;
      case '!도박': {
        if (!room.users[userId].joined) { await send('먼저 !도박가입 을 입력하세요.'); break; }
        const amount = Number(args[0]); const balance = Number(room.users[userId].points ?? 0);
        if (!Number.isInteger(amount) || amount <= 0) { await send('사용법: !도박 <포인트>'); break; }
        if (amount > balance) { await send(`잔액 부족: ${balance.toLocaleString()}P`); break; }
        if (Math.random() < 0.5) { room.users[userId].points = balance + amount * 2; await send(`🎉 당첨! 총 지급 3배 (+${(amount * 2).toLocaleString()}P)\n잔액: ${Number(room.users[userId].points).toLocaleString()}P`); }
        else { room.users[userId].points = balance - amount; await send(`💥 낙첨! -${amount.toLocaleString()}P\n잔액: ${Number(room.users[userId].points).toLocaleString()}P`); }
        saveCommandState(state); break;
      }
      case '!kick': {
        if (!msg.room?.isOpenChat) { await send('❌ Open Chat에서만 사용할 수 있습니다.'); break; }
        if (!isManager(client)) { await send('❌ 봇이 Open Chat 방장/관리자가 아닙니다.'); break; }
        const rawTarget = args.join(' ').trim();
        if (!rawTarget.startsWith('@')) { await send('사용법: !kick @유저멘션'); break; }
        const target = extractMentionTarget(msg, rawTarget);
        if (!target) { await send('❌ 실제 카카오톡 @멘션을 포함해서 다시 입력하세요.'); break; }
        if (target.id === String(client.userId)) { await send('❌ 봇 자신은 내보낼 수 없습니다.'); break; }
        await chat.openChatKick(roomId, Number(target.id));
        appendMemberEvent('KICK', { roomId, roomName: msg.room?.name, userId: target.id, nickname: target.name });
        await send(`✅ ${target.name ? `@${target.name}` : `사용자 ${target.id}`} 내보내기 요청을 전송했습니다.`);
        break;
      }
      case '!allkick':
        await handleAllKick(client, chat, roomId, room, send);
        break;
      default: return;
    }
    saveCommandState(state);
    saveState({ lastCommand: { command, roomId, roomName: String(msg.room?.name ?? ''), userId, nickname: String(msg.sender?.name ?? ''), at: new Date().toISOString() } });
  } catch (error) {
    console.error('[COMMAND] failed:', error instanceof Error ? error.stack || error.message : String(error));
    try { await send(`❌ 명령 실행 실패: ${error instanceof Error ? error.message : String(error)}`); } catch {}
  }
}

async function qrLogin() {
  console.log('\n[LOCO] KakaoForge QR 인증을 시작합니다.');
  console.log('[LOCO] 본인 KakaoTalk 앱에서 직접 승인해야 합니다.');
  return createAuthByQR({ authPath: AUTH_PATH });
}

async function main() {
  mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(AUTH_PATH)) await qrLogin();
  const client: any = createClient({ authPath: AUTH_PATH, autoConnect: false, autoReconnect: true, debug: process.env.LOCO_DEBUG === '1' });

  client.onReady(async () => {
    const dev = developerId(client);
    console.log(`[LOCO] 연결 완료. 개발자 게이트: ${dev ? '설정됨' : '미설정'}`);
    saveState({ connected: true, userId: String(client.userId), developerId: dev });
    try {
      const result = await client.getChatRooms();
      const rooms = Array.isArray(result?.chats) ? result.chats : Array.isArray(result) ? result : [];
      const normalized = rooms.map((room: any) => ({ id: String(room.id ?? room.chatId ?? room.c ?? ''), name: String(room.name ?? room.roomName ?? room.title ?? ''), isOpenChat: room.isOpenChat === true, openLinkId: room.openLinkId != null ? String(room.openLinkId) : undefined })).filter((room: any) => room.id);
      saveState({ rooms: normalized, roomCount: normalized.length });
      console.log(`[LOCO] 방 ${normalized.length}개 동기화 완료.`);
      for (const room of normalized) console.log(`  - ${room.name || '(이름 없음)'} [${room.id}]${room.isOpenChat ? ' [OPENCHAT]' : ''}`);
    } catch (error) { console.error('[LOCO] 방 목록 동기화 실패:', error instanceof Error ? error.message : String(error)); }
  });

  client.onMessage(async (chat: any, msg: any) => {
    const room = msg?.room ?? chat;
    const event = { type: 'MESSAGE', at: new Date().toISOString(), roomId: String(room?.id ?? ''), roomName: String(room?.name ?? ''), messageId: String(msg?.message?.id ?? msg?.id ?? ''), userId: String(msg?.sender?.id ?? ''), nickname: String(msg?.sender?.name ?? ''), text: String(msg?.message?.text ?? ''), isOpenChat: room?.isOpenChat === true };
    saveState({ lastMessage: event });
    if (event.userId !== String(client.userId)) {
      const state = loadCommandState(); const roomState = ensureRoomState(state, event.roomId); const uid = event.userId;
      roomState.users[uid] ??= { nickname: event.nickname, messages: 0, joined: false, points: 0 };
      roomState.users[uid].nickname = event.nickname; roomState.users[uid].messages = Number(roomState.users[uid].messages ?? 0) + 1; saveCommandState(state);
    }
    await handleCommand(client, chat, msg);
  });
  client.onJoin((event: any) => { void announceMemberEvent(client, 'JOIN', event); });
  client.onLeave((event: any) => { void announceMemberEvent(client, 'LEAVE', event); });
  client.onKick((event: any) => { appendMemberEvent('KICK', event); });

  try { await client.connect(); saveState({ connected: true, startedAt: new Date().toISOString() }); }
  catch (error) { saveState({ connected: false, error: String(error) }); throw error; }
  await new Promise(() => {});
}

main().catch(error => { console.error('[FATAL]', error instanceof Error ? error.stack || error.message : String(error)); process.exitCode = 1; });
