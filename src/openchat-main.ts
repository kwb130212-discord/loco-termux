import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createAuthByQR, createClient } from 'kakaoforge';

const DATA_DIR = join(homedir(), '.loco-termux');
const AUTH_PATH = join(DATA_DIR, 'kakaoforge-auth.json');
const STATE_PATH = join(DATA_DIR, 'loco-transport.json');

function saveState(patch: Record<string, unknown>) {
  mkdirSync(DATA_DIR, { recursive: true });
  let state: Record<string, unknown> = {};
  try { state = JSON.parse(readFileSync(STATE_PATH, 'utf8')); } catch {}
  state = { ...state, ...patch, updatedAt: new Date().toISOString() };
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
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
      for (const room of normalized) {
        console.log(`  - ${room.name || '(이름 없음)'} [${room.id}]${room.isOpenChat ? ' [OPENCHAT]' : ''}`);
      }
    } catch (error) {
      console.error('[LOCO] 방 목록 동기화 실패:', error instanceof Error ? error.message : String(error));
      saveState({ connected: true, roomSyncError: String(error) });
    }
  });

  client.onMessage(async (chat: any, msg: any) => {
    const room = msg?.room ?? chat;
    const event = {
      type: 'MESSAGE',
      at: new Date().toISOString(),
      roomId: String(room?.id ?? msg?.room?.id ?? ''),
      roomName: String(room?.name ?? msg?.room?.name ?? ''),
      messageId: String(msg?.message?.id ?? msg?.id ?? ''),
      userId: String(msg?.sender?.id ?? ''),
      nickname: String(msg?.sender?.name ?? ''),
      text: String(msg?.message?.text ?? ''),
      isOpenChat: room?.isOpenChat === true,
    };
    saveState({ lastMessage: event });
    if (process.env.LOCO_DEBUG === '1') console.log(`[MSG] [${event.roomName}] ${event.nickname}: ${event.text}`);
  });

  client.onJoin?.((event: any) => {
    saveState({ lastMemberEvent: { type: 'JOIN', at: new Date().toISOString(), raw: event } });
  });
  client.onLeave?.((event: any) => {
    saveState({ lastMemberEvent: { type: 'LEAVE', at: new Date().toISOString(), raw: event } });
  });
  client.onKick?.((event: any) => {
    saveState({ lastMemberEvent: { type: 'KICK', at: new Date().toISOString(), raw: event } });
  });
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
