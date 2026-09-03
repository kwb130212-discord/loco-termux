import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createAuthByQR, createClient } from 'kakaoforge';

const DATA_DIR = join(homedir(), '.loco-termux');
const AUTH_PATH = join(DATA_DIR, 'kakaoforge-auth.json');
const STATE_PATH = join(DATA_DIR, 'loco-transport.json');
const COMMAND_STATE_PATH = join(DATA_DIR, 'command-state.json');

function saveState(patch: Record<string, unknown>) {
  mkdirSync(DATA_DIR, { recursive: true });
  let state: Record<string, unknown> = {};
  try { state = JSON.parse(readFileSync(STATE_PATH, 'utf8')); } catch {}
  state = { ...state, ...patch, updatedAt: new Date().toISOString() };
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

function loadCommandState(): Record<string, any> {
  try {
    const value = JSON.parse(readFileSync(COMMAND_STATE_PATH, 'utf8'));
    return value && typeof value === 'object' ? value : {};
  } catch { return {}; }
}

function saveCommandState(state: Record<string, any>) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(COMMAND_STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

function ensureRoomState(state: Record<string, any>, roomId: string) {
  const key = String(roomId);
  state.rooms ??= {};
  state.rooms[key] ??= { registered: false, code: null, codeExpiresAt: 0, commands: 0, users: {} };
  return state.rooms[key];
}

function commandHelp() {
  return [
    '📋 LOCO-TERMUX 명령어',
    '!핑 - 봇 응답 확인',
    '!명령어 - 명령어 목록',
    '!echo <내용> - 내용 출력',
    '!채팅순위 - 현재 수집된 메시지 기준 순위',
    '!입퇴장로그 - 최근 입장/퇴장 이벤트',
    '!봇정보 - 연결/방 정보',
    '!봇등록 - 현재 방 8자리 등록코드 발급',
    '!방등록해제 - 현재 방 등록 해제',
    '!도박가입 - 1000 포인트로 시작',
    '!도박 <포인트> - 50% 확률, 성공 시 3배',
    '!kick <userId> - Open Chat 관리자/방장만 사용',
  ].join('\n');
}

function isManager(client: any): boolean {
  const type = Number(client?.type);
  return type === 1 || type === 4;
}

function recentEvents(limit = 10): any[] {
  try {
    const raw = JSON.parse(readFileSync(join(process.cwd(), 'loco_analyzer.json'), 'utf8'));
    const events = Array.isArray(raw?.events) ? raw.events : [];
    return events.slice(-limit).reverse();
  } catch { return []; }
}

async function handleCommand(client: any, chat: any, msg: any) {
  const text = String(msg?.message?.text ?? '').trim();
  if (!text.startsWith('!')) return;
  if (String(msg?.sender?.id) === String(client?.userId)) return;

  const roomId = String(msg?.room?.id ?? '');
  if (!roomId) return;
  const parts = text.split(/\s+/);
  const command = parts[0].toLowerCase();
  const args = parts.slice(1);
  const state = loadCommandState();
  const room = ensureRoomState(state, roomId);
  room.commands = Number(room.commands ?? 0) + 1;
  const userId = String(msg?.sender?.id ?? '');
  room.users[userId] ??= { nickname: String(msg?.sender?.name ?? ''), messages: 0, joined: false, points: 0 };
  room.users[userId].nickname = String(msg?.sender?.name ?? '');
  saveCommandState(state);

  const send = async (body: string) => chat.sendText(roomId, body);

  try {
    switch (command) {
      case '!핑':
      case '!ping':
        await send('🏓 pong!');
        break;

      case '!명령어':
      case '!help':
        await send(commandHelp());
        break;

      case '!echo':
        await send(args.length ? args.join(' ') : '사용법: !echo <내용>');
        break;

      case '!봇정보':
      case '!info':
        await send(`🤖 LOCO-Termux\n전송: KakaoForge/LOCO\n방: ${String(msg.room?.name ?? roomId)}\nOpen Chat: ${msg.room?.isOpenChat === true ? 'YES' : 'NO'}\n등록: ${room.registered ? 'YES' : 'NO'}`);
        break;

      case '!채팅순위': {
        const rows = Object.values(room.users as Record<string, any>)
          .sort((a: any, b: any) => Number(b.messages ?? 0) - Number(a.messages ?? 0))
          .slice(0, 10);
        await send(rows.length
          ? ['🏆 채팅순위', ...rows.map((x: any, i) => `${i + 1}. ${x.nickname || '알 수 없음'} — ${x.messages}회`)].join('\n')
          : '아직 수집된 채팅 데이터가 없습니다.');
        break;
      }

      case '!입퇴장로그': {
        const events = recentEvents(10);
        await send(events.length
          ? ['📜 최근 입퇴장 로그', ...events.map((e: any) => `${String(e.event ?? '').toUpperCase()} | ${e.nickname ?? ''} | ${e.at ?? ''}`)].join('\n')
          : '수집된 입퇴장 로그가 없습니다.');
        break;
      }

      case '!봇등록': {
        if (!isManager(client)) { await send('❌ 봇 등록은 Open Chat 방장/관리자만 사용할 수 있습니다.'); break; }
        const now = Date.now();
        if (room.code && Number(room.codeExpiresAt) > now) {
          await send(`🔐 현재 등록코드: ${room.code}\n남은 시간: ${Math.ceil((Number(room.codeExpiresAt) - now) / 1000)}초`);
          break;
        }
        const code = String(Math.floor(10000000 + Math.random() * 90000000));
        room.code = code;
        room.codeExpiresAt = now + 5 * 60 * 1000;
        room.registered = true;
        saveCommandState(state);
        await send(`🔐 방 등록코드: ${code}\n5분 이내 Termux 패널에서 등록을 완료하세요.`);
        break;
      }

      case '!방등록해제':
        if (!isManager(client)) { await send('❌ 방 등록 해제는 Open Chat 방장/관리자만 사용할 수 있습니다.'); break; }
        room.registered = false;
        room.code = null;
        room.codeExpiresAt = 0;
        saveCommandState(state);
        await send('✅ 현재 방의 봇 등록을 해제했습니다.');
        break;

      case '!도박가입':
        if (room.users[userId].joined) {
          await send(`이미 가입되어 있습니다. 잔액: ${Number(room.users[userId].points ?? 0).toLocaleString()}P`);
          break;
        }
        room.users[userId].joined = true;
        room.users[userId].points = 1000;
        saveCommandState(state);
        await send(`🎰 ${room.users[userId].nickname}님 가입 완료! 시작 잔액: 1,000P`);
        break;

      case '!도박': {
        if (!room.users[userId].joined) { await send('먼저 !도박가입 을 입력하세요.'); break; }
        const amount = Number(args[0]);
        const balance = Number(room.users[userId].points ?? 0);
        if (!Number.isInteger(amount) || amount <= 0) { await send('사용법: !도박 <포인트>'); break; }
        if (amount > balance) { await send(`잔액 부족: ${balance.toLocaleString()}P`); break; }
        if (Math.random() < 0.5) {
          room.users[userId].points = balance + amount * 2;
          await send(`🎉 당첨! +${(amount * 2).toLocaleString()}P\n잔액: ${Number(room.users[userId].points).toLocaleString()}P`);
        } else {
          room.users[userId].points = balance - amount;
          await send(`💥 낙첨! -${amount.toLocaleString()}P\n잔액: ${Number(room.users[userId].points).toLocaleString()}P`);
        }
        saveCommandState(state);
        break;
      }

      case '!kick': {
        if (!msg.room?.isOpenChat) { await send('❌ !kick은 Open Chat에서만 사용할 수 있습니다.'); break; }
        if (!isManager(client)) { await send('❌ 봇이 Open Chat 방장/관리자가 아닙니다.'); break; }
        const target = args[0];
        if (!target || !/^\d+$/.test(target)) { await send('사용법: !kick <userId>'); break; }
        if (String(target) === String(client.userId)) { await send('❌ 봇 자신은 내보낼 수 없습니다.'); break; }
        await chat.openChatKick(roomId, Number(target));
        await send(`✅ 사용자 ${target} 내보내기 요청을 전송했습니다.`);
        break;
      }

      default:
        return;
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
  console.log('[LOCO] QR은 사용자가 본인 KakaoTalk 앱에서 직접 승인해야 합니다.');
  return createAuthByQR({ authPath: AUTH_PATH });
}

async function main() {
  mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(AUTH_PATH)) await qrLogin();

  const client: any = createClient({
    authPath: AUTH_PATH,
    autoConnect: false,
    autoReconnect: true,
    debug: process.env.LOCO_DEBUG === '1',
  });

  client.onReady(async () => {
    console.log('[LOCO] 연결 완료. Open Chat/채팅방 동기화를 시작합니다.');
    saveState({ connected: true, userId: String(client.userId), rooms: [] });
    try {
      const result = await client.getChatRooms();
      const rooms = Array.isArray(result?.chats) ? result.chats : (Array.isArray(result) ? result : []);
      const normalized = rooms.map((room: any) => ({
        id: String(room.id ?? room.chatId ?? room.c ?? ''),
        name: String(room.name ?? room.roomName ?? room.title ?? ''),
        isOpenChat: room.isOpenChat === true,
        openLinkId: room.openLinkId != null ? String(room.openLinkId) : undefined,
      })).filter((room: any) => room.id);
      saveState({ rooms: normalized, roomCount: normalized.length });
      console.log(`[LOCO] 방 ${normalized.length}개 동기화 완료.`);
      for (const room of normalized) console.log(`  - ${room.name || '(이름 없음)'} [${room.id}]${room.isOpenChat ? ' [OPENCHAT]' : ''}`);
    } catch (error) {
      console.error('[LOCO] 방 목록 동기화 실패:', error instanceof Error ? error.message : String(error));
      saveState({ connected: true, roomSyncError: String(error) });
    }
  });

  client.onMessage(async (chat: any, msg: any) => {
    const room = msg?.room ?? chat;
    const event = {
      type: 'MESSAGE', at: new Date().toISOString(), roomId: String(room?.id ?? msg?.room?.id ?? ''),
      roomName: String(room?.name ?? msg?.room?.name ?? ''), messageId: String(msg?.message?.id ?? msg?.id ?? ''),
      userId: String(msg?.sender?.id ?? ''), nickname: String(msg?.sender?.name ?? ''), text: String(msg?.message?.text ?? ''),
      isOpenChat: room?.isOpenChat === true,
    };
    saveState({ lastMessage: event });
    if (event.userId !== String(client.userId)) {
      const state = loadCommandState();
      const roomState = ensureRoomState(state, event.roomId);
      const uid = event.userId;
      roomState.users[uid] ??= { nickname: event.nickname, messages: 0, joined: false, points: 0 };
      roomState.users[uid].nickname = event.nickname;
      roomState.users[uid].messages = Number(roomState.users[uid].messages ?? 0) + 1;
      saveCommandState(state);
      await handleCommand(client, chat, msg);
    }
    if (process.env.LOCO_DEBUG === '1') console.log(`[MSG] [${event.roomName}] ${event.nickname}: ${event.text}`);
  });

  client.onJoin?.((chat: any, event: any) => saveState({ lastMemberEvent: { type: 'JOIN', at: new Date().toISOString(), raw: event } }));
  client.onLeave?.((chat: any, event: any) => saveState({ lastMemberEvent: { type: 'LEAVE', at: new Date().toISOString(), raw: event } }));
  client.onKick?.((chat: any, event: any) => saveState({ lastMemberEvent: { type: 'KICK', at: new Date().toISOString(), raw: event } }));
  client.on('error', (error: unknown) => {
    console.error('[LOCO] client error:', error instanceof Error ? error.message : String(error));
    saveState({ connected: false, error: String(error) });
  });

  await client.connect();
  saveState({ connected: true, transport: 'KakaoForge/LOCO' });
  console.log('[LOCO] 실시간 연결 유지 중. 종료하려면 Ctrl+C.');
  await new Promise<void>(() => {});
}

main().catch((error) => {
  console.error('[LOCO:FATAL]', error instanceof Error ? error.stack || error.message : String(error));
  saveState({ connected: false, fatal: String(error) });
  process.exitCode = 1;
});
