import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomInt } from 'node:crypto';
import { createClient } from './kakaoforge-loader';

type AnyMap = Record<string, any>;
type EventKind = 'JOIN' | 'LEAVE' | 'KICK';

const DATA_DIR = join(homedir(), '.loco-termux');
const AUTH_PATH = join(DATA_DIR, 'kakaoforge-auth.json');
const STATE_PATH = join(DATA_DIR, 'loco-transport.json');
const COMMAND_STATE_PATH = join(DATA_DIR, 'command-state.json');
const DEVELOPER_ID_PATH = join(DATA_DIR, 'developer-id');
const ROOM_VERIFY_TTL = 5 * 60 * 1000;
const MAX_EVENTS = 5000;
const MAX_MESSAGES_PER_ROOM = 2000;
const ROOM_SYNC_MS = 30_000;
const HEARTBEAT_MS = 10_000;

mkdirSync(DATA_DIR, { recursive: true });

function loadJson(path: string): AnyMap {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function saveJson(path: string, value: unknown): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
}

function patchState(patch: AnyMap): void {
  const state = loadJson(STATE_PATH);
  saveJson(STATE_PATH, { ...state, ...patch, updatedAt: new Date().toISOString() });
}

function commandState(): AnyMap {
  return loadJson(COMMAND_STATE_PATH);
}

function saveCommandState(state: AnyMap): void {
  saveJson(COMMAND_STATE_PATH, state);
}

function getRoomState(state: AnyMap, roomId: string): AnyMap {
  state.rooms ??= {};
  state.rooms[roomId] ??= {
    registered: false,
    code: null,
    codeExpiresAt: 0,
    registeredAt: null,
    users: {},
    admins: {},
    readers: {},
    messages: {},
  };
  const room = state.rooms[roomId];
  room.users ??= {};
  room.admins ??= {};
  room.readers ??= {};
  room.messages ??= {};
  return room;
}

function getDeveloperId(client: any): string {
  const env = String(process.env.LOCO_DEVELOPER_ID ?? '').trim();
  if (env) return env;
  try {
    return readFileSync(DEVELOPER_ID_PATH, 'utf8').trim();
  } catch {
    const id = String(client?.userId ?? '').trim();
    if (id) writeFileSync(DEVELOPER_ID_PATH, id, 'utf8');
    return id;
  }
}

function isDeveloper(client: any, userId: string): boolean {
  return Boolean(userId) && userId === getDeveloperId(client);
}

function senderLooksManager(msg: any): boolean {
  const sender = msg?.sender ?? msg?.member ?? {};
  const values = [
    sender?.isManager,
    sender?.isAdmin,
    sender?.isHost,
    sender?.isOwner,
    sender?.isRoomAdmin,
    sender?.isModerator,
    sender?.role,
    sender?.type,
    sender?.memberType,
    sender?.privilege,
    sender?.authority,
    sender?.status,
  ];
  if (values.some((v) => v === true)) return true;
  const normalized = values.map((v) => String(v ?? '').toUpperCase());
  return normalized.some((v) => ['ADMIN', 'MANAGER', 'HOST', 'OWNER', 'MODERATOR', 'LEADER', '부방장', '방장', '관리자'].includes(v));
}

function canModerate(client: any, msg: any, room: AnyMap, userId: string): boolean {
  return isDeveloper(client, userId) || senderLooksManager(msg) || Boolean(room?.admins?.[userId]);
}

function mentions(msg: any): any[] {
  const values = [
    msg?.message?.mentions,
    msg?.message?.mention,
    msg?.mentions,
    msg?.mention,
    msg?.message?.meta?.mentions,
    msg?.message?.metadata?.mentions,
  ];
  return values.flatMap((value) => Array.isArray(value) ? value : value ? [value] : []);
}

function mentionTarget(msg: any): { id: string; name: string } | null {
  for (const item of mentions(msg)) {
    const id = item?.userId ?? item?.id ?? item?.memberId ?? item?.user?.id;
    if (id == null) continue;
    const name = item?.name ?? item?.nickname ?? item?.user?.name ?? item?.user?.nickname ?? '';
    return { id: String(id), name: String(name) };
  }
  return null;
}

function replyTarget(msg: any): { id: string; name: string } | null {
  const reply = msg?.replyTo ?? msg?.reply ?? msg?.message?.replyTo ?? msg?.message?.reply ?? msg?.message?.quote ?? msg?.quote ?? msg?.message?.metadata?.reply;
  if (!reply) return null;
  const id = reply?.userId ?? reply?.memberId ?? reply?.sender?.id ?? reply?.author?.id;
  if (id == null) return null;
  const name = reply?.nickname ?? reply?.name ?? reply?.sender?.name ?? reply?.author?.name ?? '';
  return { id: String(id), name: String(name) };
}

function roomIdOf(chat: any, msg?: any): string {
  return String(msg?.room?.id ?? msg?.chatId ?? chat?.id ?? chat?.chatId ?? '');
}

function roomNameOf(chat: any, msg?: any): string {
  return String(msg?.room?.name ?? chat?.name ?? chat?.roomName ?? chat?.title ?? '');
}

function textOf(msg: any): string {
  return String(msg?.message?.text ?? msg?.text ?? '').trim();
}

function fmtTime(value: any): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value ?? '') : date.toLocaleString('ko-KR', { hour12: false });
}

function chunks(lines: string[], max = 1800): string[] {
  const output: string[] = [];
  let current = '';
  for (const line of lines) {
    if (current && current.length + line.length + 1 > max) {
      output.push(current);
      current = '';
    }
    current += `${current ? '\n' : ''}${line}`;
  }
  if (current) output.push(current);
  return output;
}

function appendMemberEvent(type: EventKind, event: any): AnyMap | null {
  const state = loadJson(STATE_PATH);
  const history = Array.isArray(state.memberEvents) ? state.memberEvents : [];
  const roomId = String(event?.roomId ?? event?.chatId ?? event?.room?.id ?? event?.chat?.id ?? '');
  const ids = Array.isArray(event?.member?.ids)
    ? event.member.ids
    : [event?.userId ?? event?.memberId ?? event?.sender?.id ?? event?.member?.id ?? ''];
  const names = Array.isArray(event?.member?.names)
    ? event.member.names
    : [event?.nickname ?? event?.name ?? event?.member?.name ?? event?.sender?.name ?? '알 수 없음'];
  const items = ids
    .map((id: any, index: number) => ({
      type,
      at: new Date().toISOString(),
      roomId,
      roomName: String(event?.roomName ?? event?.room?.name ?? event?.chat?.name ?? ''),
      userId: String(id ?? ''),
      nickname: String(names[index] ?? names[0] ?? '알 수 없음'),
    }))
    .filter((item: AnyMap) => item.userId);
  if (!items.length) return null;
  history.push(...items);
  saveJson(STATE_PATH, {
    ...state,
    memberEvents: history.slice(-MAX_EVENTS),
    lastMemberEvent: items.at(-1),
    updatedAt: new Date().toISOString(),
  });
  return items.at(-1) ?? null;
}

function eventHistory(type: string, roomId: string): AnyMap[] {
  const state = loadJson(STATE_PATH);
  const history = Array.isArray(state.memberEvents) ? state.memberEvents : [];
  return history.filter((item: AnyMap) => (!type || item.type === type) && String(item.roomId) === roomId);
}

function departedRows(roomId: string): AnyMap[] {
  const seen = new Set<string>();
  return eventHistory('LEAVE', roomId).filter((item) => {
    const id = String(item.userId);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  }).reverse();
}

function readerSnapshot(value: any, depth = 0, seen = new Set<any>()): AnyMap | null {
  if (!value || typeof value !== 'object' || depth > 6 || seen.has(value)) return null;
  seen.add(value);
  for (const [key, raw] of Object.entries(value)) {
    const normalized = key.toLowerCase();
    if (['readers', 'reader', 'readusers', 'readby', 'seenby', 'readmembers', 'readmember'].includes(normalized)) {
      const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? Object.values(raw) : [];
      const ids: string[] = [];
      const names: string[] = [];
      for (const item of list as any[]) {
        const id = item?.userId ?? item?.id ?? item?.memberId ?? item?.uid ?? (typeof item === 'string' || typeof item === 'number' ? item : undefined);
        const name = item?.name ?? item?.nickname ?? item?.nickName;
        if (id != null) ids.push(String(id));
        if (name) names.push(String(name));
      }
      if (ids.length || names.length) return { ids: [...new Set(ids)], names: [...new Set(names)], source: key };
    }
    if (['readercount', 'readcount', 'seencount', 'seen_count', 'readers_count'].includes(normalized)) {
      const count = Number(raw);
      if (Number.isFinite(count)) return { ids: [], names: [], count, source: key };
    }
  }
  for (const child of Object.values(value)) {
    const result = readerSnapshot(child, depth + 1, seen);
    if (result) return result;
  }
  return null;
}

function recordMessage(room: any, msg: any, roomState: AnyMap): void {
  const id = String(msg?.message?.id ?? msg?.message?.logId ?? msg?.logId ?? msg?.id ?? '');
  if (!id) return;
  const snapshot = readerSnapshot(msg) ?? readerSnapshot(msg?.message?.raw);
  roomState.messages[id] = {
    messageId: id,
    roomId: String(room?.id ?? ''),
    senderId: String(msg?.sender?.id ?? ''),
    senderName: String(msg?.sender?.name ?? ''),
    text: textOf(msg),
    readerIds: snapshot?.ids ?? [],
    readerNames: snapshot?.names ?? [],
    readerCount: snapshot?.count,
    available: Boolean(snapshot),
    at: new Date().toISOString(),
  };
  roomState.readers[id] = roomState.messages[id];
  const entries = Object.entries(roomState.messages);
  if (entries.length > MAX_MESSAGES_PER_ROOM) {
    for (const [oldId] of entries.slice(0, entries.length - MAX_MESSAGES_PER_ROOM)) delete roomState.messages[oldId];
  }
}

function helpText(): string {
  return [
    '╭────── LOCO-TERMUX 명령어 전체보기 ──────╮',
    '│ 기본',
    '│ !핑  !명령어  !봇정보',
    '│',
    '│ 관리자',
    '│ !관리자 @유저  !관리자해제 @유저  !관리자목록',
    '│ !입장로그  !퇴장로그  !입퇴장로그',
    '│ !나간사람  !나간사람내보내기  !읽은사람  !채팅순위',
    '│',
    '│ 내보내기',
    '│ !kick @유저  /  답장한 입퇴장 로그 대상도 지원',
    '│ !allkick',
    '│',
    '│ 방 관리',
    '│ !봇등록  !방등록해제',
    '│',
    '│ 게임',
    '│ !도박가입  !도박 <포인트>',
    '╰──────────────────────────────────────╯',
  ].join('\n');
}

async function kick(client: any, chat: any, roomId: string, target: { id: string; name?: string }, send: (text: string) => Promise<any>): Promise<void> {
  if (!target.id || target.id === String(client.userId)) {
    await send('❌ 내보낼 대상을 확인할 수 없습니다.');
    return;
  }
  if (typeof chat?.openChatKick !== 'function') {
    await send('❌ 현재 연결에서 OpenChat 내보내기 기능을 사용할 수 없습니다.');
    return;
  }
  try {
    await chat.openChatKick(roomId, Number(target.id));
    appendMemberEvent('KICK', { roomId, roomName: roomNameOf(chat), userId: target.id, nickname: target.name || '알 수 없음' });
    await send(`✅ ${target.name ? `@${target.name}` : target.id} 내보내기 완료`);
  } catch (error) {
    await send(`❌ 내보내기 실패: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function getMembers(client: any, roomId: string, room: AnyMap): Promise<{ id: string; name: string }[]> {
  try {
    if (typeof client._resolveChatMembers === 'function') {
      const ids = await client._resolveChatMembers(roomId);
      const result: { id: string; name: string }[] = [];
      for (const id of ids ?? []) {
        let name = '';
        if (typeof client.getUsernameById === 'function') {
          try { name = String(await client.getUsernameById(roomId, id) || ''); } catch {}
        }
        result.push({ id: String(id), name });
      }
      if (result.length) return result;
    }
  } catch (error) {
    console.error('[MEMBERS]', error instanceof Error ? error.message : String(error));
  }
  return Object.entries(room.users ?? {}).map(([id, value]: [string, any]) => ({ id, name: String(value?.nickname ?? '') }));
}

async function handleCommand(client: any, chat: any, msg: any): Promise<void> {
  const text = textOf(msg);
  if (!text.startsWith('!')) return;
  if (String(msg?.sender?.id ?? '') === String(client?.userId ?? '')) return;

  const roomId = roomIdOf(chat, msg);
  if (!roomId) return;

  const state = commandState();
  const room = getRoomState(state, roomId);
  const userId = String(msg?.sender?.id ?? '');
  const senderName = String(msg?.sender?.name ?? '');
  room.users[userId] ??= { nickname: senderName, messages: 0, points: 0, joined: true };
  room.users[userId].nickname = senderName || room.users[userId].nickname;
  room.users[userId].messages = Number(room.users[userId].messages || 0) + 1;

  const send = async (message: string) => {
    const pieces = chunks([message]);
    for (const piece of pieces) await chat.sendText(roomId, piece);
  };
  const parts = text.split(/\s+/);
  const command = parts[0].toLowerCase();
  const args = parts.slice(1);
  const moderator = canModerate(client, msg, room, userId);

  try {
    switch (command) {
      case '!명령어':
        await send(helpText());
        break;
      case '!핑':
        await send('🏓 pong!');
        break;
      case '!봇정보':
        await send(`🤖 LOCO-Termux\n방: ${roomNameOf(chat, msg) || roomId}\n전송계층: ${client.transport || 'offline'}\n연결: ${client.connected ? 'YES' : 'NO'}\n등록 관리자: ${Object.keys(room.admins).length}명`);
        break;
      case '!관리자': {
        if (!senderLooksManager(msg) && !isDeveloper(client, userId)) { await send('❌ 실제 방장/부방장만 등록할 수 있습니다.'); break; }
        const target = mentionTarget(msg);
        if (!target) { await send('사용법: !관리자 @유저'); break; }
        room.admins[target.id] = { id: target.id, name: target.name };
        saveCommandState(state);
        await send(`🛡️ ${target.name ? `@${target.name}` : target.id} 등록 완료`);
        break;
      }
      case '!관리자해제': {
        if (!senderLooksManager(msg) && !isDeveloper(client, userId)) { await send('❌ 실제 방장/부방장만 해제할 수 있습니다.'); break; }
        const target = mentionTarget(msg);
        if (!target) { await send('사용법: !관리자해제 @유저'); break; }
        delete room.admins[target.id];
        saveCommandState(state);
        await send(`✅ ${target.name ? `@${target.name}` : target.id} 해제 완료`);
        break;
      }
      case '!관리자목록':
        if (!moderator) { await send('🔒 권한이 없습니다.'); break; }
        await send(['🛡️ 등록 관리자 전체보기', ...Object.values(room.admins).map((item: any, i: number) => `${i + 1}. ${item.name || item.id}`)].join('\n') || '등록된 관리자가 없습니다.');
        break;
      case '!입장로그':
      case '!퇴장로그':
      case '!입퇴장로그': {
        if (!moderator) { await send('🔒 권한이 없습니다.'); break; }
        const type = command === '!입장로그' ? 'JOIN' : command === '!퇴장로그' ? 'LEAVE' : '';
        const rows = eventHistory(type, roomId).reverse();
        const title = type === 'JOIN' ? '📥 전체 입장 로그' : type === 'LEAVE' ? '📤 전체 퇴장 로그' : '📋 전체 입퇴장 로그';
        const lines = rows.length ? rows.map((item, i) => `${i + 1}. ${item.nickname} (${item.userId}) · ${fmtTime(item.at)}`) : ['기록이 없습니다.'];
        for (const piece of chunks([title, ...lines])) await send(piece);
        break;
      }
      case '!나간사람': {
        if (!moderator) { await send('🔒 권한이 없습니다.'); break; }
        const rows = departedRows(roomId);
        await send(rows.length ? ['🚪 나간 사람 전체보기', ...rows.map((item, i) => `${i + 1}. ${item.nickname} (${item.userId}) · ${fmtTime(item.at)}`)].join('\n') : '🚪 나간 사람 기록이 없습니다.');
        break;
      }
      case '!나간사람내보내기': {
        if (!moderator) { await send('🔒 권한이 없습니다.'); break; }
        const rows = departedRows(roomId);
        if (!rows.length) { await send('🚪 내보낼 나간 사람 기록이 없습니다.'); break; }
        let ok = 0;
        for (const item of rows) {
          try {
            if (typeof chat.openChatKick === 'function') {
              await chat.openChatKick(roomId, Number(item.userId));
              ok += 1;
            }
          } catch {}
        }
        await send(`🚪 요청 완료: ${ok}/${rows.length}명`);
        break;
      }
      case '!읽은사람': {
        if (!moderator) { await send('🔒 권한이 없습니다.'); break; }
        const messageId = String(args[0] ?? msg?.message?.id ?? '');
        const item = room.readers[messageId] ?? room.messages[messageId];
        if (!item) { await send('❌ 해당 메시지의 읽음 데이터가 없습니다.'); break; }
        const names = Array.isArray(item.readerNames) ? item.readerNames.filter(Boolean) : [];
        await send(`👀 메시지 ${messageId}\n읽은 사람: ${names.length ? names.join(', ') : '(이벤트에 읽음 목록이 포함되지 않음)'}\n읽음 수: ${item.readerCount ?? (names.length || 0)}`);
        break;
      }
      case '!채팅순위': {
        if (!moderator) { await send('🔒 권한이 없습니다.'); break; }
        const rows = Object.entries(room.users).sort((a: any, b: any) => Number(b[1]?.messages || 0) - Number(a[1]?.messages || 0));
        await send(['🏆 채팅 순위', ...rows.slice(0, 20).map(([id, value]: [string, any], i) => `${i + 1}. ${value.nickname || id} · ${Number(value.messages || 0)}회`)].join('\n') || '기록이 없습니다.');
        break;
      }
      case '!kick': {
        if (!moderator) { await send('🔒 권한이 없습니다.'); break; }
        const target = mentionTarget(msg) ?? replyTarget(msg);
        if (!target) { await send('사용법: !kick @유저 또는 대상 메시지에 답장 후 !kick'); break; }
        await kick(client, chat, roomId, target, send);
        break;
      }
      case '!allkick': {
        if (!moderator) { await send('🔒 권한이 없습니다.'); break; }
        const members = await getMembers(client, roomId, room);
        let ok = 0;
        for (const member of members) {
          if (member.id === String(client.userId)) continue;
          try {
            if (typeof chat.openChatKick === 'function') {
              await chat.openChatKick(roomId, Number(member.id));
              ok += 1;
            }
          } catch {}
        }
        await send(`⚠️ 전체 내보내기 요청 완료: ${ok}/${Math.max(0, members.length - 1)}명`);
        break;
      }
      case '!봇등록': {
        if (!senderLooksManager(msg) && !isDeveloper(client, userId)) { await send('❌ 실제 방장/부방장만 등록할 수 있습니다.'); break; }
        const code = String(randomInt(100, 1000));
        room.code = code;
        room.codeExpiresAt = Date.now() + ROOM_VERIFY_TTL;
        room.registered = false;
        saveCommandState(state);
        console.log(`[방등록] ${roomNameOf(chat, msg) || roomId} | roomId=${roomId} | code=${code} | expires=${new Date(room.codeExpiresAt).toISOString()}`);
        await send(`🔐 방 등록 코드: ${code}\n5분 안에 이 방에서 ${code} 를 입력하세요.`);
        break;
      }
      case '!방등록해제':
        if (!moderator) { await send('🔒 권한이 없습니다.'); break; }
        room.registered = false;
        room.code = null;
        room.codeExpiresAt = 0;
        saveCommandState(state);
        await send('✅ 이 방의 봇 등록을 해제했습니다.');
        break;
      case '!도박가입':
        if (!room.users[userId].points) room.users[userId].points = 1000;
        saveCommandState(state);
        await send(`🎰 가입 완료! 보유 포인트: ${room.users[userId].points}P`);
        break;
      case '!도박': {
        const amount = Math.floor(Number(args[0]));
        if (!Number.isFinite(amount) || amount <= 0) { await send('사용법: !도박 <포인트>'); break; }
        const balance = Number(room.users[userId].points || 0);
        if (balance < amount) { await send(`❌ 포인트 부족. 현재 ${balance}P`); break; }
        if (Math.random() < 0.5) {
          room.users[userId].points = balance + amount * 2;
          await send(`🎉 당첨! +${amount * 2}P\n보유: ${room.users[userId].points}P`);
        } else {
          room.users[userId].points = balance - amount;
          await send(`💥 꽝! -${amount}P\n보유: ${room.users[userId].points}P`);
        }
        saveCommandState(state);
        break;
      }
      default:
        break;
    }
  } catch (error) {
    console.error('[COMMAND]', error instanceof Error ? error.stack || error.message : String(error));
    try { await send('❌ 명령 처리 중 오류가 발생했습니다. 런타임 로그를 확인하세요.'); } catch {}
  }

  saveCommandState(state);
}

function verifyRoomCode(client: any, chat: any, msg: any): boolean {
  const text = textOf(msg);
  if (!/^\d{3}$/.test(text)) return false;
  const roomId = roomIdOf(chat, msg);
  const userId = String(msg?.sender?.id ?? '');
  if (!roomId || !userId || userId === String(client.userId)) return false;
  const state = commandState();
  const room = getRoomState(state, roomId);
  const code = String(room.code ?? '');
  const expires = Number(room.codeExpiresAt ?? 0);
  if (!code || !expires) return false;
  if (Date.now() > expires) {
    room.code = null;
    room.codeExpiresAt = 0;
    saveCommandState(state);
    return false;
  }
  if (text !== code) return false;
  room.registered = true;
  room.code = null;
  room.codeExpiresAt = 0;
  room.registeredAt = new Date().toISOString();
  saveCommandState(state);
  console.log(`[방등록] 인증 성공 | ${roomNameOf(chat, msg) || roomId} | roomId=${roomId}`);
  return true;
}

async function syncRooms(client: any): Promise<number> {
  try {
    const result = await client.getChatRooms();
    const raw = Array.isArray(result?.chats) ? result.chats : Array.isArray(result) ? result : [];
    const rooms = raw.map((item: any) => ({
      id: String(item?.id ?? item?.chatId ?? item?.roomId ?? item?.c ?? ''),
      name: String(item?.name ?? item?.roomName ?? item?.title ?? ''),
      isOpenChat: item?.isOpenChat === true,
      isGroupChat: item?.isGroupChat === true,
    })).filter((item: AnyMap) => item.id);
    patchState({ connected: true, rooms, roomCount: rooms.length, lastRoomSyncAt: new Date().toISOString() });
    return rooms.length;
  } catch (error) {
    console.error('[ROOM-SYNC]', error instanceof Error ? error.message : String(error));
    patchState({ connected: Boolean(client.connected), roomSyncError: String(error) });
    return 0;
  }
}

async function main(): Promise<void> {
  if (!existsSync(AUTH_PATH)) throw new Error(`인증 세션이 없습니다: ${AUTH_PATH}`);

  const client: any = createClient({
    authPath: AUTH_PATH,
    autoConnect: false,
    autoReconnect: true,
    reconnectMinDelayMs: 1000,
    reconnectMaxDelayMs: 30000,
    pingIntervalMs: 60000,
    socketKeepAliveMs: 30000,
    memberRefreshIntervalMs: 60000,
    memberLookupTimeoutMs: 3000,
    sendIntervalMs: 400,
    debug: process.env.LOCO_DEBUG === '1',
  });

  const mark = (connected: boolean, extra: AnyMap = {}) => {
    patchState({
      connected,
      transport: client.transport || null,
      userId: String(client.userId || ''),
      developerId: getDeveloperId(client),
      heartbeatAt: new Date().toISOString(),
      ...extra,
    });
  };

  client.on('connected', () => {
    console.log('[LOCO] Carriage connected');
    mark(true, { lastConnectedAt: new Date().toISOString(), error: null });
  });

  client.on('disconnected', () => {
    console.warn('[LOCO] Carriage disconnected; KakaoForge auto-reconnect remains active');
    mark(false, { lastDisconnectedAt: new Date().toISOString() });
  });

  client.on('kickout', (payload: any) => {
    console.error('[LOCO] KICKOUT', JSON.stringify(payload));
    mark(false, { kickout: payload });
  });

  client.on('error', (error: any) => {
    console.error('[LOCO] client error:', error instanceof Error ? error.stack || error.message : String(error));
    mark(Boolean(client.connected), { error: String(error) });
  });

  client.onReady(async () => {
    console.log(`[LOCO] READY userId=${client.userId} transport=${client.transport || 'unknown'}`);
    mark(true, { readyAt: new Date().toISOString() });
    await syncRooms(client);
  });

  client.onMessage(async (chat: any, msg: any) => {
    const roomId = roomIdOf(chat, msg);
    if (!roomId) return;
    const state = commandState();
    const room = getRoomState(state, roomId);
    const senderId = String(msg?.sender?.id ?? '');
    if (senderId && senderId !== String(client.userId)) {
      room.users[senderId] ??= { nickname: '', messages: 0, points: 0, joined: true };
      room.users[senderId].nickname = String(msg?.sender?.name ?? room.users[senderId].nickname ?? '');
    }
    recordMessage(msg?.room ?? chat, msg, room);
    saveCommandState(state);

    if (verifyRoomCode(client, chat, msg)) {
      try { await chat.sendText(roomId, '✅ 방 등록 완료! 이제 이 방에서 봇 기능을 사용할 수 있습니다.'); } catch {}
      return;
    }

    await handleCommand(client, chat, msg);
  });

  client.onJoin((event: any) => {
    const item = appendMemberEvent('JOIN', event);
    if (item) console.log(`[JOIN] ${item.roomId} ${item.nickname} (${item.userId})`);
  });

  client.onLeave((event: any) => {
    const item = appendMemberEvent('LEAVE', event);
    if (item) console.log(`[LEAVE] ${item.roomId} ${item.nickname} (${item.userId})`);
  });

  client.onKick((event: any) => {
    const item = appendMemberEvent('KICK', event);
    if (item) console.log(`[KICK] ${item.roomId} ${item.nickname} (${item.userId})`);
  });

  await client.connect();
  await syncRooms(client);

  const roomTimer = setInterval(() => { void syncRooms(client); }, ROOM_SYNC_MS);
  const heartbeat = setInterval(() => {
    mark(Boolean(client.connected), { runtime: 'openchat', pid: process.pid });
  }, HEARTBEAT_MS);

  const shutdown = () => {
    clearInterval(roomTimer);
    clearInterval(heartbeat);
    try { client.disconnect(); } catch {}
    mark(false, { stoppedAt: new Date().toISOString() });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  console.log('[LOCO] OpenChat runtime is running.');
  await new Promise<void>(() => undefined);
}

main().catch((error) => {
  console.error('[FATAL] OpenChat runtime:', error instanceof Error ? error.stack || error.message : String(error));
  patchState({ connected: false, runtime: 'openchat', fatalError: String(error), fatalAt: new Date().toISOString() });
  process.exitCode = 1;
});
