import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import QRCode from 'qrcode';
import { createAuthByQR, createClient, getMemberType } from './kakaoforge-runtime';
import { listDeparted, listLeaveHistory, recordDepartures, removeDeparted } from './departed-db';
import type { MessageEvent, MemberEvent, KakaoForgeClient } from './kakaoforge-types';

type State = Record<string, any>;
type EventKind = 'JOIN' | 'LEAVE' | 'KICK';
const DIR = process.env.LOCO_DATA_DIR ? join(process.env.LOCO_DATA_DIR) : join(homedir(), '.loco-termux');
const AUTH = join(DIR, 'kakaoforge-auth.json');
const STATE = join(DIR, 'loco-transport.json');
const CMD = join(DIR, 'command-state.json');
const DEV = join(DIR, 'developer-id');
const CODE_TTL = 300_000;
const MAX_EVENTS = 5_000;
const MAX_MESSAGES = 2_000;
const OWNER = String(process.env.LOCO_DEVELOPER_ID || '').trim();
const BRIDGE_TOKEN = String(process.env.LOCO_BRIDGE_TOKEN || '').trim();
const BRIDGE_PORT = Number(process.env.LOCO_BRIDGE_PORT || process.env.PORT || 8787);
let activeChat: any = null;
let macroTimer: NodeJS.Timeout | null = null;
let clientStarted = false;
let qrTask: Promise<void> | null = null;
let qrDataUrl: string | null = null;
let qrExpiresAt = 0;
let qrError: string | null = null;
mkdirSync(DIR, { recursive: true, mode: 0o700 });
const load = (path: string): State => { try { const value = JSON.parse(readFileSync(path, 'utf8')); return value && typeof value === 'object' ? value : {}; } catch (error) { console.error(`[STATE] ${path} 읽기 실패:`, error instanceof Error ? error.message : String(error)); return {}; } };
const save = (path: string, value: unknown): void => { try { writeFileSync(path, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 }); } catch (error) { console.error(`[STATE] ${path} 저장 실패:`, error instanceof Error ? error.message : String(error)); } };
const commandState = (): State => load(CMD);
function roomState(state: State, roomId: string): State { state.rooms ??= {}; state.rooms[roomId] ??= { registered: false, code: null, codeExpiresAt: 0, registeredAt: null, users: {}, admins: {}, readers: {}, messages: {} }; const room = state.rooms[roomId]; room.users ??= {}; room.admins ??= {}; room.readers ??= {}; room.messages ??= {}; return room; }
function textOf(message: MessageEvent): string { return String(message.message?.text ?? '').trim(); }
function userIdOf(message: MessageEvent): string { return String(message.sender.id); }
function isRoomManager(message: MessageEvent): boolean { const MemberType = getMemberType(); return message.sender.type === MemberType?.OpenChat?.Owner || message.sender.type === MemberType?.OpenChat?.Manager; }
function developerId(client: KakaoForgeClient): string { if (OWNER) return OWNER; try { const value = readFileSync(DEV, 'utf8').trim(); if (value) return value; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error('[AUTH] developer-id 읽기 실패:', error instanceof Error ? error.message : String(error)); } const id = String(client.userId); try { writeFileSync(DEV, id, { encoding: 'utf8', mode: 0o600 }); } catch (error) { console.error('[AUTH] developer-id 저장 실패:', error instanceof Error ? error.message : String(error)); } return id; }
function isAdmin(client: KakaoForgeClient, message: MessageEvent, room: State): boolean { const uid = userIdOf(message); return uid === developerId(client) || isRoomManager(message) || Boolean(room.admins?.[uid]); }
function chunks(value: string, size = 1_800): string[] { const result: string[] = []; for (let i = 0; i < value.length; i += size) result.push(value.slice(i, i + size)); return result.length ? result : ['']; }
async function send(chat: any, roomId: string | number, value: string): Promise<void> { for (const part of chunks(value)) await chat.sendText(roomId, part); }
function recordMemberEvent(type: EventKind, event: MemberEvent): State[] { const state = load(STATE); const history = Array.isArray(state.memberEvents) ? state.memberEvents : []; const ids = event.member?.ids ?? []; const names = event.member?.names ?? []; const rows = ids.map((id: string | number, index: number) => ({ type, at: new Date().toISOString(), roomId: String(event.room.id), roomName: event.room.name, userId: String(id), nickname: names[index] || names[0] || '알 수 없음' })); if (!rows.length) return []; history.push(...rows); save(STATE, { ...state, memberEvents: history.slice(-MAX_EVENTS), lastMemberEvent: rows.at(-1), updatedAt: new Date().toISOString() }); if (type === 'LEAVE') recordDepartures(String(event.room.id), event.room.name, ids, names); if (type === 'JOIN') for (const id of ids) removeDeparted(String(event.room.id), String(id)); return rows; }
function memberRows(roomId: string, type?: EventKind): State[] { const history = load(STATE).memberEvents; if (!Array.isArray(history)) return []; return history.filter((row: State) => String(row.roomId) === roomId && (!type || row.type === type)); }
function departed(roomId: string): State[] { return listDeparted(roomId).map((row) => ({ type: 'LEAVE', at: row.leftAt, roomId: row.roomId, roomName: row.roomName, userId: row.userId, nickname: row.nickname })); }
function fmt(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? '알 수 없음' : date.toLocaleString('ko-KR', { hour12: false }); }
function findMention(message: MessageEvent): { id: string; name: string } | null { const raw = message.raw as any; const candidates = [raw?.mentions, raw?.mention, raw?.message?.mentions, raw?.message?.mention, raw?.meta?.mentions, raw?.metadata?.mentions]; for (const candidate of candidates) { const list = Array.isArray(candidate) ? candidate : candidate ? [candidate] : []; for (const item of list) { const id = item?.userId ?? item?.id ?? item?.memberId ?? item?.user?.id; if (id !== undefined && id !== null) return { id: String(id), name: String(item?.name ?? item?.nickname ?? item?.user?.name ?? item?.user?.nickname ?? '') }; } } return null; }
function findReply(message: MessageEvent): any | null { const raw = message.raw as any; return raw?.replyTo ?? raw?.reply ?? raw?.message?.replyTo ?? raw?.message?.reply ?? raw?.message?.quote ?? raw?.quote ?? null; }
function targetFromReply(message: MessageEvent): { id: string; name: string } | null { const reply = findReply(message); if (!reply) return null; const id = reply?.userId ?? reply?.memberId ?? reply?.sender?.id ?? reply?.author?.id; if (id !== undefined && id !== null && String(id) !== String(message.sender.id)) return { id: String(id), name: String(reply?.nickname ?? reply?.name ?? reply?.sender?.name ?? reply?.author?.name ?? '') }; return targetFromLeaveLogReply(message); }
function replyTextCandidates(message: MessageEvent): string[] { const reply = findReply(message); if (!reply) return []; const values = [reply?.text, reply?.message?.text, reply?.content, reply?.body, reply?.quote?.text, reply?.message?.message?.text, reply?.replyTo?.text]; return values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0); }
function targetFromLeaveLogReply(message: MessageEvent): { id: string; name: string } | null { const roomId = String(message.room.id); const candidates = replyTextCandidates(message); if (!candidates.length) return null; const rows = listLeaveHistory(roomId); for (const text of candidates) { const idMatch = text.match(/(?:퇴장로그|퇴장|나감)[^\d]{0,120}(\d{3,})/i); if (idMatch) { const id = idMatch[1]; const row = rows.find((item) => String(item.userId) === id); if (row) return { id: String(row.userId), name: String(row.nickname || '') }; } const row = rows.find((item) => { const name = String(item.nickname || '').trim(); return name && text.includes(name); }); if (row) return { id: String(row.userId), name: String(row.nickname || '') }; } return null; }
function readInfo(value: unknown, depth = 0, seen = new Set<object>()): State | null { if (!value || typeof value !== 'object' || depth > 6 || seen.has(value as object)) return null; seen.add(value as object); for (const [key, raw] of Object.entries(value as Record<string, unknown>)) { const name = key.toLowerCase(); if (['readers', 'reader', 'readusers', 'readby', 'seenby', 'readmembers', 'readmember'].includes(name)) { const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? Object.values(raw) : []; const ids: string[] = []; const names: string[] = []; for (const item of list as any[]) { const id = item?.userId ?? item?.id ?? item?.memberId ?? item?.uid ?? (typeof item === 'string' || typeof item === 'number' ? item : undefined); const nickname = item?.name ?? item?.nickname ?? item?.nickName; if (id !== undefined) ids.push(String(id)); if (nickname) names.push(String(nickname)); } if (ids.length || names.length) return { ids: [...new Set(ids)], names: [...new Set(names)], source: key }; } if (['readercount', 'readcount', 'seencount', 'seen_count', 'readers_count'].includes(name)) { const count = Number(raw); if (Number.isFinite(count)) return { ids: [], names: [], count, source: key }; } } for (const child of Object.values(value as Record<string, unknown>)) { const result = readInfo(child, depth + 1, seen); if (result) return result; } return null; }
function recordMessage(room: State, message: MessageEvent): void { const rawId = message.message.logId ?? message.message.id; if (rawId === undefined || rawId === null) return; const id = String(rawId); const readers = readInfo(message.raw); room.messages[id] = { messageId: id, roomId: String(message.room.id), senderId: userIdOf(message), senderName: message.sender.name, text: textOf(message), readerIds: readers?.ids ?? [], readerNames: readers?.names ?? [], readerCount: readers?.count, available: Boolean(readers), at: new Date().toISOString() }; room.readers[id] = room.messages[id]; const ids = Object.keys(room.messages); if (ids.length > MAX_MESSAGES) for (const old of ids.slice(0, ids.length - MAX_MESSAGES)) delete room.messages[old]; }
function help(): string { return ['╭──── LOCO-TERMUX 명령어 전체보기 ────╮','│ !핑  !명령어  !봇정보  !봇상태','│ !관리자 @유저  !관리자해제 @유저  !관리자목록','│ !입장로그  !퇴장로그 전체출력  !입퇴장로그','│ !나간사람  !나간사람 올킥  !읽은사람  !채팅순위','│ !kick @유저 또는 대상 퇴장로그에 답장 후 !kick','│ !봇등록  !방등록해제','╰────────────────────────────╯'].join('\n'); }
async function kick(chat: any, roomId: string, target: { id: string; name: string }, reply: (text: string) => Promise<void>): Promise<boolean> { if (!/^\d+$/.test(target.id)) { await reply('❌ 대상 ID가 올바르지 않습니다.'); return false; } try { await chat.openChatKick(roomId, Number(target.id)); await reply(`✅ ${target.name ? `@${target.name}` : target.id} 내보내기 완료`); return true; } catch (error) { await reply(`❌ 내보내기 실패: ${error instanceof Error ? error.message : String(error)}`); return false; } }
async function handleCommand(client: KakaoForgeClient, chat: any, message: MessageEvent, state = commandState(), room = roomState(state, String(message.room.id))): Promise<void> { const value = textOf(message); if (!value.startsWith('!') || String(message.sender.id) === String(client.userId)) return; const roomId = String(message.room.id); const uid = userIdOf(message); const reply = (content: string) => send(chat, message.room.id, content); const [command, ...args] = value.split(/\s+/); const cmd = command.toLowerCase(); const admin = isAdmin(client, message, room); if (!room.registered && cmd !== '!봇등록') return; room.users[uid] ??= { nickname: message.sender.name, messages: 0, points: 1000, joined: true }; room.users[uid].nickname = message.sender.name; room.users[uid].messages = Number(room.users[uid].messages || 0) + 1; switch (cmd) {
case '!명령어': return reply(help()); case '!핑': return reply('🏓 pong!'); case '!봇정보': return reply(`🤖 LOCO-Termux\n방: ${message.room.name}\n전송계층: ${client.constructor.name}\n연결: ${client.connected ? 'YES' : 'NO'}\n관리자: ${Object.keys(room.admins).length}명`);
case '!관리자': case '!관리자해제': { if (!isRoomManager(message) && uid !== developerId(client)) return reply('❌ 실제 오픈채팅 방장/부방장만 사용할 수 있습니다.'); const target = findMention(message); if (!target) return reply(`사용법: ${command} @유저`); if (cmd === '!관리자') room.admins[target.id] = { id: target.id, name: target.name }; else delete room.admins[target.id]; save(CMD, state); return reply(`${cmd === '!관리자' ? '🛡️ 등록' : '✅ 해제'} 완료: ${target.name || target.id}`); }
case '!관리자목록': if (!admin) return reply('🔒 권한이 없습니다.'); return reply(Object.values(room.admins).length ? ['🛡️ 관리자 전체보기', ...Object.values(room.admins).map((x: any, i: number) => `${i + 1}. ${x.name || x.id}`)].join('\n') : '🛡️ 등록된 관리자가 없습니다.');
case '!입장로그': case '!퇴장로그': case '!입퇴장로그': { if (!admin) return reply('🔒 권한이 없습니다.'); if (cmd === '!퇴장로그' && String(args[0] || '').toLowerCase() === '전체출력') { const rows = listLeaveHistory(roomId); return reply(['📤 전체 퇴장 로그', ...(rows.length ? rows.map((x, i) => `${i + 1}. ${x.nickname} (${x.userId}) · ${fmt(x.leftAt)}`) : ['기록이 없습니다.'])].join('\n')); } const type = cmd === '!입장로그' ? 'JOIN' : cmd === '!퇴장로그' ? 'LEAVE' : undefined; const rows = memberRows(roomId, type as EventKind | undefined).reverse(); const title = cmd === '!입장로그' ? '📥 전체 입장 로그' : cmd === '!퇴장로그' ? '📤 퇴장 로그 사용법: !퇴장로그 전체출력' : '📋 전체 입퇴장 로그'; return reply([title, ...(rows.length ? rows.map((x, i) => `${i + 1}. ${x.nickname} (${x.userId}) · ${fmt(x.at)}`) : ['기록이 없습니다.'])].join('\n')); }
case '!나간사람': { if (!admin) return reply('🔒 권한이 없습니다.'); if (String(args[0] || '').toLowerCase() === '올킥') { const rows = listDeparted(roomId); if (!rows.length) return reply('🚪 현재 내보낼 나간 사람이 없습니다.'); let ok = 0; let fail = 0; for (const row of rows) { try { await chat.openChatKick(message.room.id, Number(row.userId)); removeDeparted(roomId, row.userId); ok++; } catch (error) { fail++; console.error(`[KakaoForge][departed-allkick] ${row.userId}:`, error instanceof Error ? error.message : String(error)); } } return reply(`🚪 나간 사람 올킥 완료\n성공: ${ok}명\n실패: ${fail}명`); } const rows = departed(roomId); return reply(rows.length ? ['🚪 현재 나간 사람 전체보기', ...rows.map((x, i) => `${i + 1}. ${x.nickname} (${x.userId}) · ${fmt(x.at)}`), '사용법: !나간사람 올킥'].join('\n') : '🚪 현재 나간 사람 기록이 없습니다.'); }
case '!읽은사람': { if (!admin) return reply('🔒 권한이 없습니다.'); const id = String(args[0] || message.message.logId || message.message.id || ''); const data = room.readers[id] ?? room.messages[id]; if (!data) return reply('❌ 해당 메시지의 읽음 데이터가 없습니다.'); const names = data.readerNames?.length ? data.readerNames : data.readerIds?.map((x: string) => room.users[x]?.nickname || x) || []; return reply(names.length ? `👀 읽은 사람 (${names.length}명)\n${names.map((x: string, i: number) => `${i + 1}. ${x}`).join('\n')}` : data.readerCount !== undefined ? `👀 읽은 사람 수: ${data.readerCount}명` : '👀 읽음 데이터가 없습니다.'); }
case '!채팅순위': { const rows = Object.values(room.users).sort((a: any, b: any) => Number(b.messages || 0) - Number(a.messages || 0)).slice(0, 20); return reply(['🏆 채팅순위', ...(rows.length ? rows.map((x: any, i: number) => `${i + 1}. ${x.nickname || x.id} · ${x.messages || 0}회`) : ['기록이 없습니다.'])].join('\n')); }
case '!kick': { if (!admin) return reply('🔒 권한이 없습니다.'); const target = findMention(message) || targetFromReply(message); if (!target) return reply('사용법: !kick @유저 또는 퇴장로그에 답장 후 !kick'); const success = await kick(chat, roomId, target, reply); if (success) removeDeparted(roomId, target.id); return; }
case '!봇등록': { if (uid !== developerId(client)) return reply('🔒 개발자 전용 명령어입니다.'); const code = String(randomInt(10_000_000, 100_000_000)); room.registered = true; room.code = code; room.codeExpiresAt = Date.now() + CODE_TTL; room.registeredAt = new Date().toISOString(); save(CMD, state); return reply(`✅ 방 등록 완료\n방: ${message.room.name}\n등록 코드: ${code}\n유효시간: 5분`); }
case '!방등록해제': if (uid !== developerId(client)) return reply('🔒 개발자 전용 명령어입니다.'); room.registered = false; room.code = null; room.codeExpiresAt = 0; save(CMD, state); return reply('✅ 현재 방 등록을 해제했습니다.');
case '!도박가입': { room.users[uid].points = Number(room.users[uid].points); if (!Number.isFinite(room.users[uid].points) || room.users[uid].points <= 0) room.users[uid].points = 1000; room.users[uid].joined = true; save(CMD, state); return reply(`🎰 가입 완료! 보유 포인트: ${room.users[uid].points}`); }
case '!도박': { const bet = Number(args[0]); if (!Number.isInteger(bet) || bet <= 0) return reply('사용법: !도박 <포인트>'); const points = Number(room.users[uid].points || 0); if (points < bet) return reply(`❌ 포인트 부족. 현재 ${points}P`); const win = randomInt(0, 2) === 1; room.users[uid].points = win ? points + bet * 3 : points - bet; save(CMD, state); return reply(win ? `🎉 당첨! +${bet * 3}P\n잔액: ${room.users[uid].points}P` : `💥 실패! -${bet}P\n잔액: ${room.users[uid].points}P`); }
case '!봇상태': return reply(`🤖 ${client.connected ? '🟢 연결됨' : '🔴 연결 끊김'}\nuserId: ${client.userId}\n방: ${message.room.name}`); default: return;
} save(CMD, state); }
async function sendLeaveLogs(chat: any, event: MemberEvent, rows: State[]): Promise<void> { for (const row of rows) { try { await send(chat, event.room.id, `📤 퇴장로그\n${row.nickname} (${row.userId})\n${fmt(row.at)}\n↩️ 이 메시지에 답장 후 !kick`); } catch (error) { console.error('[KakaoForge][leave-log]', error instanceof Error ? error.message : String(error)); } } }
function secureTokenMatches(candidate: string): boolean {
  const a = Buffer.from(BRIDGE_TOKEN);
  const b = Buffer.from(candidate);
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}
function observedRooms(): State[] {
  const state = commandState();
  return Object.entries(state.rooms || {}).filter(([, room]: [string, any]) => room && room.roomName)
    .map(([id, room]: [string, any]) => ({ id, name: String(room.roomName), isOpenChat: true, registered: room.registered === true }));
}
function saveMacroRows(rows: State[]): void {
  const state = load(STATE);
  save(STATE, { ...state, discordMacros: rows, updatedAt: new Date().toISOString() });
}
function getMacroRows(): State[] {
  const rows = load(STATE).discordMacros;
  return Array.isArray(rows) ? rows : [];
}
async function processMacros(): Promise<void> {
  if (!activeChat) return;
  const rows = getMacroRows();
  const now = Date.now();
  for (const macro of rows) {
    if (!macro || macro.enabled !== true || Number(macro.nextAt || 0) > now) continue;
    const room = commandState().rooms?.[String(macro.roomId)];
    if (!room || !room.roomName) {
      macro.enabled = false;
      macro.lastError = '방 관측 상태가 확인되지 않아 정지됨';
      continue;
    }
    try {
      await send(activeChat, macro.roomId, String(macro.message));
      macro.lastSentAt = new Date().toISOString();
      macro.nextAt = now + Number(macro.intervalMinutes) * 60_000;
      macro.lastError = null;
      console.log('[DiscordBridge] macro sent', macro.id, macro.roomId);
    } catch (error) {
      macro.enabled = false;
      macro.lastError = error instanceof Error ? error.message : String(error);
      console.error('[DiscordBridge] macro paused', macro.id, macro.lastError);
    }
  }
  saveMacroRows(rows);
}
async function requestQrImage(): Promise<State> {
  if (activeChat) throw new Error('이미 카카오 세션이 연결되어 있습니다.');
  if (existsSync(AUTH)) throw new Error('저장된 인증 파일이 있습니다. 기존 세션을 확인한 뒤 Termux에서 QR 재로그인을 진행하세요.');
  if (qrDataUrl && Date.now() < qrExpiresAt) return { qrDataUrl, expiresAt: new Date(qrExpiresAt).toISOString() };
  if (qrTask) throw new Error(qrError || 'QR 인증이 이미 진행 중입니다. 기존 QR을 사용하세요.');
  qrError = null;
  let resolveReady!: (value: string) => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<string>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  qrTask = createAuthByQR({
    authPath: AUTH,
    deviceUuid: createHash('sha256').update(randomUUID(), 'utf8').digest('hex'),
    deviceName: 'LOCO-Termux Discord Bridge',
    modelName: 'LOCO-Discord',
    forced: false,
    checkAllowlist: false,
    enforceAllowlist: false,
    save: true,
    onQrUrl: (url: string) => {
      void QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 2, width: 320 })
        .then((dataUrl: string) => {
          qrDataUrl = dataUrl;
          qrExpiresAt = Date.now() + 120_000;
          resolveReady(dataUrl);
        })
        .catch((error: unknown) => {
          qrError = error instanceof Error ? error.message : String(error);
          rejectReady(error instanceof Error ? error : new Error(qrError));
        });
    },
    onPasscode: () => console.log('[DiscordBridge] QR passcode requested.'),
  }).then(() => {
    qrTask = null;
    qrDataUrl = null;
    qrExpiresAt = 0;
    startKakaoClient();
  }).catch((error: unknown) => {
    qrTask = null;
    qrError = error instanceof Error ? error.message : String(error);
    console.error('[DiscordBridge] QR login failed:', qrError);
  });
  const timeout = new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('QR 생성 시간 초과')), 12_000));
  const dataUrl = await Promise.race([ready, timeout]);
  return { qrDataUrl: dataUrl, expiresAt: new Date(qrExpiresAt).toISOString() };
}
function startBridge(): void {
  if (!BRIDGE_TOKEN || BRIDGE_TOKEN.length < 32) {
    console.warn('[DiscordBridge] LOCO_BRIDGE_TOKEN 미설정 또는 32자 미만 — HTTP 브리지를 시작하지 않습니다.');
    return;
  }
  const server = createServer((req, res) => {
    const sendJson = (status: number, body: State): void => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/health') return sendJson(200, { ok: true, authenticated: Boolean(activeChat) });
    const auth = String(req.headers.authorization || '');
    if (!auth.startsWith('Bearer ') || !secureTokenMatches(auth.slice(7))) return sendJson(401, { error: 'Unauthorized' });
    if (req.method === 'POST' && url.pathname === '/v1/auth/qr') {
      void requestQrImage().then((payload) => sendJson(200, payload)).catch((error: unknown) => sendJson(409, { error: error instanceof Error ? error.message : String(error) }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/v1/auth/status') return sendJson(200, { authenticated: Boolean(activeChat) });
    if (req.method === 'GET' && url.pathname === '/v1/rooms') {
      if (!activeChat) return sendJson(503, { error: 'KakaoForge client is not ready' });
      return sendJson(200, { rooms: observedRooms(), completeness: 'observed-only', note: 'This list includes rooms seen by this runtime; it is not guaranteed to include every joined room.' });
    }
    if (req.method === 'GET' && url.pathname === '/v1/macros') return sendJson(200, { macros: getMacroRows() });
    if (req.method === 'POST' && url.pathname === '/v1/macros') {
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => { raw += chunk; if (raw.length > 12_000) req.destroy(); });
      req.on('end', () => {
        let body: State;
        try { body = JSON.parse(raw || '{}'); } catch { return sendJson(400, { error: 'Invalid JSON' }); }
        const roomId = String(body.roomId || '');
        const message = String(body.message || '').trim();
        const intervalMinutes = Number(body.intervalMinutes);
        if (!/^\d+$/.test(roomId) || !message || message.length > 1500 || /@everyone|@here/.test(message)) return sendJson(400, { error: 'Invalid room or message' });
        if (!Number.isInteger(intervalMinutes) || intervalMinutes < 10 || intervalMinutes > 1440) return sendJson(400, { error: 'intervalMinutes must be 10..1440' });
        const room = commandState().rooms?.[roomId];
        if (!activeChat || !room || !room.roomName) return sendJson(403, { error: 'Room must be observed by the LOCO-Termux runtime first' });
        const rows = getMacroRows();
        if (rows.some((item) => String(item.roomId) === roomId && item.enabled === true)) return sendJson(409, { error: 'Only one active macro per room is allowed' });
        const macro = { id: randomInt(1_000_000, 2_147_483_647).toString(), roomId, roomName: room.roomName, message, intervalMinutes, enabled: true, createdAt: new Date().toISOString(), createdBy: String(body.requestedBy || ''), nextAt: Date.now() + intervalMinutes * 60_000 };
        rows.push(macro);
        saveMacroRows(rows);
        return sendJson(201, { id: macro.id, roomId, roomName: macro.roomName, intervalMinutes, enabled: true, firstSendAfterMinutes: intervalMinutes });
      });
      return;
    }
    const match = url.pathname.match(/^\/v1\/macros\/([a-zA-Z0-9_-]+)$/);
    if (req.method === 'DELETE' && match) {
      const rows = getMacroRows();
      const found = rows.find((item) => String(item.id) === match[1]);
      if (!found) return sendJson(404, { error: 'Macro not found' });
      const requestedBy = String(url.searchParams.get('requestedBy') || '');
      if (!requestedBy || String(found.createdBy || '') !== requestedBy) return sendJson(403, { error: 'Only the macro creator can stop it' });
      found.enabled = false;
      found.stoppedAt = new Date().toISOString();
      saveMacroRows(rows);
      return sendJson(200, { ok: true });
    }
    return sendJson(404, { error: 'Not found' });
  });
  server.on('error', (error) => console.error('[DiscordBridge] HTTP error', error));
  server.listen(BRIDGE_PORT, process.env.LOCO_BRIDGE_HOST || '127.0.0.1', () => console.log('[DiscordBridge] listening on', process.env.LOCO_BRIDGE_HOST || '127.0.0.1', BRIDGE_PORT));
  macroTimer = setInterval(() => { void processMacros().catch((error) => console.error('[DiscordBridge] scheduler', error)); }, 5000);
  macroTimer.unref();
  const close = (): void => { if (macroTimer) clearInterval(macroTimer); server.close(); };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}
function startKakaoClient(): void {
  if (clientStarted || !existsSync(AUTH)) return;
  clientStarted = true;
  const client = createClient({ authPath: AUTH, autoConnect: true, autoReconnect: true, debug: false, sendIntervalMs: 400, pingIntervalMs: 60_000, socketKeepAliveMs: 30_000 }) as KakaoForgeClient;
  client.onReady((chat: any) => {
    activeChat = chat;
    console.log('[KakaoForge] READY userId=' + client.userId);
    console.log('[KakaoForge] transport=' + client.type + ' openChatOnly=true');
  });
  client.onMessage(async (chat: any, message: MessageEvent) => {
    const state = commandState();
    const room = roomState(state, String(message.room.id));
    room.roomName = String(message.room.name);
    recordMessage(room, message);
    const uid = userIdOf(message);
    room.users[uid] ??= { nickname: message.sender.name, messages: 0, points: 0, joined: true };
    room.users[uid].nickname = message.sender.name;
    save(CMD, state);
    try { await handleCommand(client, chat, message, state, room); }
    catch (error) { console.error('[KakaoForge][command]', error instanceof Error ? error.message : String(error)); }
  });
  client.onJoin((_chat: any, event: MemberEvent) => { recordMemberEvent('JOIN', event); });
  client.onLeave(async (chat: any, event: MemberEvent) => {
    const rows = recordMemberEvent('LEAVE', event);
    if (rows.length) await sendLeaveLogs(chat, event, rows);
  });
  client.onKick((_chat: any, event: MemberEvent) => { recordMemberEvent('KICK', event); });
  client.on('error', (error: unknown) => console.error('[KakaoForge][error]', error instanceof Error ? error.stack || error.message : String(error)));
  const shutdown = (): void => { try { client.disconnect?.(); } catch (error) { console.error('[KakaoForge][shutdown]', error instanceof Error ? error.message : String(error)); } };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
async function main(): Promise<void> {
  startBridge();
  if (existsSync(AUTH)) startKakaoClient();
  else console.log('[DiscordBridge] Waiting for QR login request.');
}
void main().catch((error) => { console.error('[KakaoForge][fatal]', error instanceof Error ? error.stack || error.message : String(error)); process.exitCode = 1; });