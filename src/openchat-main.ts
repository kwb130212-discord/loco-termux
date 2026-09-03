import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomInt } from 'node:crypto';
import { createClient, MemberType, type MessageEvent, type MemberEvent, type KakaoForgeClient } from 'kakaoforge';

type State = Record<string, any>;
type EventKind = 'JOIN' | 'LEAVE' | 'KICK';

const DIR = join(homedir(), '.loco-termux');
const AUTH = join(DIR, 'kakaoforge-auth.json');
const STATE = join(DIR, 'loco-transport.json');
const CMD = join(DIR, 'command-state.json');
const DEV = join(DIR, 'developer-id');
const CODE_TTL = 300_000;
const MAX_EVENTS = 5_000;
const MAX_MESSAGES = 2_000;
const OWNER = String(process.env.LOCO_DEVELOPER_ID || '').trim();

mkdirSync(DIR, { recursive: true, mode: 0o700 });

const load = (path: string): State => {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
};

const save = (path: string, value: unknown): void => {
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
};

const commandState = (): State => load(CMD);

function roomState(state: State, roomId: string): State {
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

function textOf(message: MessageEvent): string {
  return message.message.text.trim();
}

function userIdOf(message: MessageEvent): string {
  return String(message.sender.id);
}

function isRoomManager(message: MessageEvent): boolean {
  return message.sender.type === MemberType.OpenChat.Owner || message.sender.type === MemberType.OpenChat.Manager;
}

function developerId(client: KakaoForgeClient): string {
  if (OWNER) return OWNER;
  try {
    const value = readFileSync(DEV, 'utf8').trim();
    if (value) return value;
  } catch {}
  const id = String(client.userId);
  try { writeFileSync(DEV, id, 'utf8'); } catch {}
  return id;
}

function isAdmin(client: KakaoForgeClient, message: MessageEvent, room: State): boolean {
  const uid = userIdOf(message);
  return uid === developerId(client) || isRoomManager(message) || Boolean(room.admins?.[uid]);
}

function chunks(value: string, size = 1_800): string[] {
  const result: string[] = [];
  for (let i = 0; i < value.length; i += size) result.push(value.slice(i, i + size));
  return result.length ? result : [''];
}

async function send(chat: any, roomId: string | number, value: string): Promise<void> {
  for (const part of chunks(value)) await chat.sendText(roomId, part);
}

function recordMemberEvent(type: EventKind, event: MemberEvent): State[] {
  const state = load(STATE);
  const history = Array.isArray(state.memberEvents) ? state.memberEvents : [];
  const ids = event.member?.ids ?? [];
  const names = event.member?.names ?? [];
  const rows = ids.map((id, index) => ({
    type,
    at: new Date().toISOString(),
    roomId: String(event.room.id),
    roomName: event.room.name,
    userId: String(id),
    nickname: names[index] || names[0] || '알 수 없음',
  }));
  if (!rows.length) return [];
  history.push(...rows);
  save(STATE, {
    ...state,
    memberEvents: history.slice(-MAX_EVENTS),
    lastMemberEvent: rows.at(-1),
    updatedAt: new Date().toISOString(),
  });
  return rows;
}

function memberRows(roomId: string, type?: EventKind): State[] {
  const history = load(STATE).memberEvents;
  if (!Array.isArray(history)) return [];
  return history.filter((row: State) => String(row.roomId) === roomId && (!type || row.type === type));
}

function departed(roomId: string): State[] {
  const seen = new Set<string>();
  return memberRows(roomId, 'LEAVE').reverse().filter((row) => {
    if (seen.has(row.userId)) return false;
    seen.add(row.userId);
    return true;
  });
}

function fmt(value: string): string {
  return new Date(value).toLocaleString('ko-KR', { hour12: false });
}

function findMention(message: MessageEvent): { id: string; name: string } | null {
  const raw = message.raw as any;
  const candidates = [raw?.mentions, raw?.mention, raw?.message?.mentions, raw?.message?.mention, raw?.meta?.mentions, raw?.metadata?.mentions];
  for (const candidate of candidates) {
    const list = Array.isArray(candidate) ? candidate : candidate ? [candidate] : [];
    for (const item of list) {
      const id = item?.userId ?? item?.id ?? item?.memberId ?? item?.user?.id;
      if (id !== undefined && id !== null) {
        return { id: String(id), name: String(item?.name ?? item?.nickname ?? item?.user?.name ?? item?.user?.nickname ?? '') };
      }
    }
  }
  return null;
}

function findReply(message: MessageEvent): any | null {
  const raw = message.raw as any;
  return raw?.replyTo ?? raw?.reply ?? raw?.message?.replyTo ?? raw?.message?.reply ?? raw?.message?.quote ?? raw?.quote ?? null;
}

function targetFromReply(message: MessageEvent): { id: string; name: string } | null {
  const reply = findReply(message);
  if (!reply) return null;
  const id = reply?.userId ?? reply?.memberId ?? reply?.sender?.id ?? reply?.author?.id;
  if (id !== undefined && id !== null && String(id) !== String(message.sender.id)) {
    return { id: String(id), name: String(reply?.nickname ?? reply?.name ?? reply?.sender?.name ?? reply?.author?.name ?? '') };
  }
  return targetFromLeaveLogReply(message);
}

function replyTextCandidates(message: MessageEvent): string[] {
  const reply = findReply(message);
  if (!reply) return [];
  const values = [
    reply?.text,
    reply?.message?.text,
    reply?.content,
    reply?.body,
    reply?.quote?.text,
    reply?.message?.message?.text,
    reply?.replyTo?.text,
  ];
  return values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
}

function targetFromLeaveLogReply(message: MessageEvent): { id: string; name: string } | null {
  const roomId = String(message.room.id);
  const candidates = replyTextCandidates(message);
  if (!candidates.length) return null;

  const rows = memberRows(roomId, 'LEAVE').reverse();
  for (const text of candidates) {
    const idMatch = text.match(/(?:퇴장로그|퇴장|나감)[^\d]{0,120}(\d{3,})/i);
    if (idMatch) {
      const id = idMatch[1];
      const row = rows.find((item) => String(item.userId) === id);
      if (row) return { id: String(row.userId), name: String(row.nickname || '') };
    }

    const row = rows.find((item) => {
      const name = String(item.nickname || '').trim();
      return name && text.includes(name);
    });
    if (row) return { id: String(row.userId), name: String(row.nickname || '') };
  }
  return null;
}

function readInfo(value: unknown, depth = 0, seen = new Set<object>()): State | null {
  if (!value || typeof value !== 'object' || depth > 6 || seen.has(value as object)) return null;
  seen.add(value as object);
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const name = key.toLowerCase();
    if (['readers', 'reader', 'readusers', 'readby', 'seenby', 'readmembers', 'readmember'].includes(name)) {
      const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? Object.values(raw) : [];
      const ids: string[] = [];
      const names: string[] = [];
      for (const item of list as any[]) {
        const id = item?.userId ?? item?.id ?? item?.memberId ?? item?.uid ?? (typeof item === 'string' || typeof item === 'number' ? item : undefined);
        const nickname = item?.name ?? item?.nickname ?? item?.nickName;
        if (id !== undefined) ids.push(String(id));
        if (nickname) names.push(String(nickname));
      }
      if (ids.length || names.length) return { ids: [...new Set(ids)], names: [...new Set(names)], source: key };
    }
    if (['readercount', 'readcount', 'seencount', 'seen_count', 'readers_count'].includes(name)) {
      const count = Number(raw);
      if (Number.isFinite(count)) return { ids: [], names: [], count, source: key };
    }
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    const result = readInfo(child, depth + 1, seen);
    if (result) return result;
  }
  return null;
}

function recordMessage(room: State, message: MessageEvent): void {
  const id = String(message.message.logId || message.message.id);
  const readers = readInfo(message.raw);
  room.messages[id] = {
    messageId: id,
    roomId: String(message.room.id),
    senderId: userIdOf(message),
    senderName: message.sender.name,
    text: textOf(message),
    readerIds: readers?.ids ?? [],
    readerNames: readers?.names ?? [],
    readerCount: readers?.count,
    available: Boolean(readers),
    at: new Date().toISOString(),
  };
  room.readers[id] = room.messages[id];
  const ids = Object.keys(room.messages);
  if (ids.length > MAX_MESSAGES) for (const old of ids.slice(0, ids.length - MAX_MESSAGES)) delete room.messages[old];
}

function help(): string {
  return [
    '╭──── LOCO-TERMUX 명령어 전체보기 ────╮',
    '│ !핑  !명령어  !봇정보  !봇상태',
    '│ !관리자 @유저  !관리자해제 @유저  !관리자목록',
    '│ !입장로그  !퇴장로그  !입퇴장로그',
    '│ !나간사람  !읽은사람  !채팅순위',
    '│ !kick @유저 또는 대상 퇴장로그에 답장 후 !kick',
    '│ !allkick',
    '│ !봇등록  !방등록해제',
    '│ !도박가입  !도박 <포인트>',
    '╰────────────────────────────╯',
  ].join('\n');
}

async function kick(chat: any, roomId: string, target: { id: string; name: string }, reply: (text: string) => Promise<void>): Promise<void> {
  if (!/^\d+$/.test(target.id)) return reply('❌ 대상 ID가 올바르지 않습니다.');
  try {
    await chat.openChatKick(roomId, Number(target.id));
    await reply(`✅ ${target.name ? `@${target.name}` : target.id} 내보내기 완료`);
  } catch (error) {
    await reply(`❌ 내보내기 실패: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function handleCommand(client: KakaoForgeClient, chat: any, message: MessageEvent): Promise<void> {
  const value = textOf(message);
  if (!value.startsWith('!') || String(message.sender.id) === String(client.userId)) return;

  const roomId = String(message.room.id);
  const uid = userIdOf(message);
  const state = commandState();
  const room = roomState(state, roomId);
  room.users[uid] ??= { nickname: message.sender.name, messages: 0, points: 0, joined: true };
  room.users[uid].nickname = message.sender.name;
  room.users[uid].messages = Number(room.users[uid].messages || 0) + 1;
  const reply = (content: string) => send(chat, message.room.id, content);
  const [command, ...args] = value.split(/\s+/);
  const admin = isAdmin(client, message, room);

  switch (command.toLowerCase()) {
    case '!명령어':
      return reply(help());
    case '!핑':
      return reply('🏓 pong!');
    case '!봇정보':
      return reply(`🤖 LOCO-Termux\n방: ${message.room.name}\n전송계층: ${client.constructor.name}\n연결: ${client.connected ? 'YES' : 'NO'}\n관리자: ${Object.keys(room.admins).length}명`);
    case '!관리자':
    case '!관리자해제': {
      if (!isRoomManager(message) && uid !== developerId(client)) return reply('❌ 실제 오픈채팅 방장/부방장만 사용할 수 있습니다.');
      const target = findMention(message);
      if (!target) return reply(`사용법: ${command} @유저`);
      if (command.toLowerCase() === '!관리자') room.admins[target.id] = { id: target.id, name: target.name };
      else delete room.admins[target.id];
      save(CMD, state);
      return reply(`${command.toLowerCase() === '!관리자' ? '🛡️ 등록' : '✅ 해제'} 완료: ${target.name || target.id}`);
    }
    case '!관리자목록':
      if (!admin) return reply('🔒 권한이 없습니다.');
      return reply(Object.values(room.admins).length ? ['🛡️ 관리자 전체보기', ...Object.values(room.admins).map((x: any, i: number) => `${i + 1}. ${x.name || x.id}`)].join('\n') : '🛡️ 등록된 관리자가 없습니다.');
    case '!입장로그':
    case '!퇴장로그':
    case '!입퇴장로그': {
      if (!admin) return reply('🔒 권한이 없습니다.');
      const type = command === '!입장로그' ? 'JOIN' : command === '!퇴장로그' ? 'LEAVE' : undefined;
      const rows = memberRows(roomId, type as EventKind | undefined).reverse();
      const title = command === '!입장로그' ? '📥 전체 입장 로그' : command === '!퇴장로그' ? '📤 전체 퇴장 로그' : '📋 전체 입퇴장 로그';
      return reply([title, ...(rows.length ? rows.map((x, i) => `${i + 1}. ${x.nickname} (${x.userId}) · ${fmt(x.at)}`) : ['기록이 없습니다.'])].join('\n'));
    }
    case '!나간사람': {
      if (!admin) return reply('🔒 권한이 없습니다.');
      const rows = departed(roomId);
      return reply(rows.length ? ['🚪 나간 사람 전체보기', ...rows.map((x, i) => `${i + 1}. ${x.nickname} (${x.userId}) · ${fmt(x.at)}`)].join('\n') : '🚪 나간 사람 기록이 없습니다.');
    }
    case '!읽은사람': {
      if (!admin) return reply('🔒 권한이 없습니다.');
      const id = String(args[0] || message.message.logId || message.message.id);
      const data = room.readers[id] ?? room.messages[id];
      if (!data) return reply('❌ 해당 메시지의 읽음 데이터가 없습니다.');
      const names = data.readerNames?.length ? data.readerNames : data.readerIds?.map((x: string) => room.users[x]?.nickname || x) || [];
      return reply(names.length ? `👀 읽은 사람 (${names.length}명)\n${names.map((x: string, i: number) => `${i + 1}. ${x}`).join('\n')}` : data.readerCount !== undefined ? `👀 읽은 사람 수: ${data.readerCount}명` : '👀 읽음 데이터가 없습니다.');
    }
    case '!채팅순위': {
      const rows = Object.values(room.users).sort((a: any, b: any) => Number(b.messages || 0) - Number(a.messages || 0)).slice(0, 20);
      return reply(['🏆 채팅순위', ...(rows.length ? rows.map((x: any, i: number) => `${i + 1}. ${x.nickname || x.id} · ${x.messages || 0}회`) : ['기록이 없습니다.'])].join('\n'));
    }
    case '!kick': {
      if (!admin) return reply('🔒 권한이 없습니다.');
      const target = findMention(message) || targetFromReply(message);
      if (!target) return reply('사용법: !kick @유저 또는 퇴장로그에 답장 후 !kick');
      return kick(chat, roomId, target, reply);
    }
    case '!allkick': {
      if (uid !== developerId(client)) return reply('🔒 개발자 전용 명령어입니다.');
      const users = Object.keys(room.users).filter((id) => id !== String(client.userId) && /^\d+$/.test(id));
      let ok = 0;
      for (const target of users) { try { await chat.openChatKick(message.room.id, Number(target)); ok++; } catch {} }
      return reply(`⚠️ 전체 내보내기 요청: ${ok}/${users.length}명`);
    }
    case '!봇등록': {
      if (uid !== developerId(client)) return reply('🔒 개발자 전용 명령어입니다.');
      const code = String(randomInt(10_000_000, 100_000_000));
      room.registered = true;
      room.code = code;
      room.codeExpiresAt = Date.now() + CODE_TTL;
      room.registeredAt = new Date().toISOString();
      save(CMD, state);
      return reply(`✅ 방 등록 완료\n방: ${message.room.name}\n등록 코드: ${code}\n유효시간: 5분`);
    }
    case '!방등록해제':
      if (uid !== developerId(client)) return reply('🔒 개발자 전용 명령어입니다.');
      room.registered = false;
      room.code = null;
      room.codeExpiresAt = 0;
      save(CMD, state);
      return reply('✅ 현재 방 등록을 해제했습니다.');
    case '!도박가입':
      if (!room.users[uid].joined) room.users[uid].joined = true;
      if (!room.users[uid].points) room.users[uid].points = 1000;
      save(CMD, state);
      return reply(`🎰 가입 완료! 보유 포인트: ${room.users[uid].points}`);
    case '!도박': {
      const bet = Number(args[0]);
      if (!Number.isInteger(bet) || bet <= 0) return reply('사용법: !도박 <포인트>');
      const points = Number(room.users[uid].points || 0);
      if (points < bet) return reply(`❌ 포인트 부족. 현재 ${points}P`);
      const win = randomInt(0, 2) === 1;
      room.users[uid].points = win ? points + bet * 3 : points - bet;
      save(CMD, state);
      return reply(win ? `🎉 당첨! +${bet * 3}P\n잔액: ${room.users[uid].points}P` : `💥 실패! -${bet}P\n잔액: ${room.users[uid].points}P`);
    }
    case '!봇상태':
      return reply(`🤖 ${client.connected ? '🟢 연결됨' : '🔴 연결 끊김'}\nuserId: ${client.userId}\n방: ${message.room.name}`);
    default:
      return;
  }
}

async function sendLeaveLogs(chat: any, event: MemberEvent, rows: State[]): Promise<void> {
  for (const row of rows) {
    try {
      await send(chat, event.room.id, `📤 퇴장로그\n${row.nickname} (${row.userId})\n${fmt(row.at)}\n↩️ 이 메시지에 답장 후 !kick`);
    } catch (error) {
      console.error('[KakaoForge][leave-log]', error instanceof Error ? error.message : String(error));
    }
  }
}

async function main(): Promise<void> {
  if (!existsSync(AUTH)) throw new Error(`QR 로그인이 필요합니다: ${AUTH}`);

  const client = createClient({
    authPath: AUTH,
    autoConnect: true,
    autoReconnect: true,
    debug: false,
    sendIntervalMs: 400,
    pingIntervalMs: 60_000,
    socketKeepAliveMs: 30_000,
  });

  client.onReady((chat) => {
    console.log(`[KakaoForge] READY userId=${client.userId}`);
    console.log(`[KakaoForge] transport=${client.type} openChatOnly=true`);
    void chat;
  });

  client.onMessage(async (chat, message) => {
    const state = commandState();
    const room = roomState(state, String(message.room.id));
    recordMessage(room, message);
    const uid = userIdOf(message);
    room.users[uid] ??= { nickname: message.sender.name, messages: 0, points: 0, joined: true };
    room.users[uid].nickname = message.sender.name;
    save(CMD, state);
    try { await handleCommand(client, chat, message); } catch (error) { console.error('[KakaoForge][command]', error); }
  });

  client.onJoin((_chat, event) => {
    recordMemberEvent('JOIN', event);
  });

  client.onLeave(async (chat, event) => {
    const rows = recordMemberEvent('LEAVE', event);
    if (rows.length) await sendLeaveLogs(chat, event, rows);
  });

  client.onKick((_chat, event) => {
    recordMemberEvent('KICK', event);
  });

  client.on('error', (error) => {
    console.error('[KakaoForge][error]', error instanceof Error ? error.stack || error.message : String(error));
  });

  const shutdown = (): void => {
    try { client.disconnect?.(); } catch {}
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

void main().catch((error) => {
  console.error('[KakaoForge][fatal]', error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
