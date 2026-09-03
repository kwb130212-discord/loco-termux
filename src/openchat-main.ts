import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomInt } from 'node:crypto';
import { createClient } from './kakaoforge-loader';

type M = Record<string, any>;
type EventKind = 'JOIN' | 'LEAVE' | 'KICK';

const DIR = join(homedir(), '.loco-termux');
const AUTH = join(DIR, 'kakaoforge-auth.json');
const STATE = join(DIR, 'loco-transport.json');
const CMD = join(DIR, 'command-state.json');
const DEV = join(DIR, 'developer-id');
const CODE_TTL = 300000;
const MAX_EVENTS = 5000;
const MAX_MESSAGES = 2000;
const SYNC = 30000;
const HEARTBEAT = 10000;
const OWNER = String(process.env.LOCO_DEVELOPER_ID || '').trim();

mkdirSync(DIR, { recursive: true });
const load = (p: string): M => { try { const v = JSON.parse(readFileSync(p, 'utf8')); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };
const save = (p: string, v: unknown) => writeFileSync(p, JSON.stringify(v, null, 2), 'utf8');
const state = () => load(CMD);
const room = (s: M, id: string): M => { s.rooms ??= {}; s.rooms[id] ??= { registered: false, code: null, codeExpiresAt: 0, registeredAt: null, users: {}, admins: {}, readers: {}, messages: {} }; const r = s.rooms[id]; r.users ??= {}; r.admins ??= {}; r.readers ??= {}; r.messages ??= {}; return r; };
const text = (m: any) => String(m?.message?.text ?? m?.text ?? '').trim();
const roomId = (c: any, m?: any) => String(m?.room?.id ?? m?.chatId ?? c?.id ?? c?.chatId ?? '');
const roomName = (c: any, m?: any) => String(m?.room?.name ?? c?.name ?? c?.roomName ?? c?.title ?? '');
const sender = (m: any) => m?.sender ?? m?.member ?? m?.author ?? {};
const senderId = (m: any) => String(sender(m)?.id ?? sender(m)?.userId ?? sender(m)?.memberId ?? m?.senderId ?? m?.userId ?? '').trim();
const senderName = (m: any) => String(sender(m)?.name ?? sender(m)?.nickname ?? sender(m)?.nickName ?? m?.senderName ?? '').trim();
const chunks = (s: string, n = 1800) => { const a: string[] = []; for (let i = 0; i < s.length; i += n) a.push(s.slice(i, i + n)); return a.length ? a : ['']; };
const manager = (m: any) => { const s = sender(m); const v = [s?.isManager, s?.isAdmin, s?.isHost, s?.isOwner, s?.isRoomAdmin, s?.isModerator, s?.role, s?.type, s?.memberType, s?.privilege, s?.authority, s?.status]; return v.some(x => x === true) || v.map(x => String(x ?? '').toUpperCase()).some(x => ['ADMIN','MANAGER','HOST','OWNER','MODERATOR','LEADER','부방장','방장','관리자'].includes(x)); };
const developerId = (client: any) => { if (OWNER) return OWNER; try { const v = readFileSync(DEV, 'utf8').trim(); if (v) return v; } catch {} const id = String(client?.userId ?? '').trim(); if (id) try { writeFileSync(DEV, id, 'utf8'); } catch {} return id; };
const admin = (client: any, m: any, r: M, id: string) => id === developerId(client) || manager(m) || Boolean(r.admins?.[id]);
const mentions = (m: any): any[] => [m?.message?.mentions,m?.message?.mention,m?.mentions,m?.mention,m?.message?.meta?.mentions,m?.message?.metadata?.mentions].flatMap(v => Array.isArray(v) ? v : v ? [v] : []);
const mentionTarget = (m: any) => { for (const x of mentions(m)) { const id = x?.userId ?? x?.id ?? x?.memberId ?? x?.user?.id; if (id != null) return { id: String(id), name: String(x?.name ?? x?.nickname ?? x?.user?.name ?? x?.user?.nickname ?? '') }; } return null; };
const reply = (m: any) => m?.replyTo ?? m?.reply ?? m?.message?.replyTo ?? m?.message?.reply ?? m?.message?.quote ?? m?.quote ?? m?.message?.metadata?.reply ?? null;
const replyTarget = (m: any) => { const r = reply(m); const id = r?.userId ?? r?.memberId ?? r?.sender?.id ?? r?.author?.id; return id == null ? null : { id: String(id), name: String(r?.nickname ?? r?.name ?? r?.sender?.name ?? r?.author?.name ?? '') }; };
const fmt = (v: any) => { const d = new Date(v); return Number.isNaN(d.getTime()) ? String(v ?? '') : d.toLocaleString('ko-KR', { hour12: false }); };
const events = (type: string, id: string) => { const h = load(STATE).memberEvents; return (Array.isArray(h) ? h : []).filter((x: M) => (!type || x.type === type) && String(x.roomId) === id); };
const departed = (id: string) => { const seen = new Set<string>(); return events('LEAVE', id).filter((x: M) => !seen.has(String(x.userId)) && (seen.add(String(x.userId)), true)).reverse(); };
const appendEvent = (type: EventKind, e: any) => { const s = load(STATE); const h = Array.isArray(s.memberEvents) ? s.memberEvents : []; const ids = Array.isArray(e?.member?.ids) ? e.member.ids : [e?.userId ?? e?.memberId ?? e?.sender?.id ?? e?.member?.id ?? '']; const names = Array.isArray(e?.member?.names) ? e.member.names : [e?.nickname ?? e?.name ?? e?.member?.name ?? e?.sender?.name ?? '알 수 없음']; const out = ids.map((id: any, i: number) => ({ type, at: new Date().toISOString(), roomId: String(e?.roomId ?? e?.chatId ?? e?.room?.id ?? e?.chat?.id ?? ''), roomName: String(e?.roomName ?? e?.room?.name ?? e?.chat?.name ?? ''), userId: String(id ?? ''), nickname: String(names[i] ?? names[0] ?? '알 수 없음') })).filter((x: M) => x.userId); if (!out.length) return null; h.push(...out); save(STATE, { ...s, memberEvents: h.slice(-MAX_EVENTS), lastMemberEvent: out.at(-1), updatedAt: new Date().toISOString() }); return out.at(-1); };
const reader = (v: any, depth = 0, seen = new Set<any>()): M | null => { if (!v || typeof v !== 'object' || depth > 6 || seen.has(v)) return null; seen.add(v); for (const [k, raw] of Object.entries(v)) { const n = k.toLowerCase(); if (['readers','reader','readusers','readby','seenby','readmembers','readmember'].includes(n)) { const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? Object.values(raw) : []; const ids: string[] = [], names: string[] = []; for (const x of list as any[]) { const id = x?.userId ?? x?.id ?? x?.memberId ?? x?.uid ?? (typeof x === 'string' || typeof x === 'number' ? x : undefined); const name = x?.name ?? x?.nickname ?? x?.nickName; if (id != null) ids.push(String(id)); if (name) names.push(String(name)); } if (ids.length || names.length) return { ids: [...new Set(ids)], names: [...new Set(names)], source: k }; } if (['readercount','readcount','seencount','seen_count','readers_count'].includes(n)) { const count = Number(raw); if (Number.isFinite(count)) return { ids: [], names: [], count, source: k }; } } for (const x of Object.values(v)) { const r = reader(x, depth + 1, seen); if (r) return r; } return null; };
const record = (c: any, m: any, r: M) => { const id = String(m?.message?.id ?? m?.message?.logId ?? m?.logId ?? m?.id ?? ''); if (!id) return; const x = reader(m) ?? reader(m?.message?.raw); r.messages[id] = { messageId: id, roomId: String(c?.id ?? ''), senderId: senderId(m), senderName: senderName(m), text: text(m), readerIds: x?.ids ?? [], readerNames: x?.names ?? [], readerCount: x?.count, available: Boolean(x), at: new Date().toISOString() }; r.readers[id] = r.messages[id]; const keys = Object.keys(r.messages); if (keys.length > MAX_MESSAGES) for (const k of keys.slice(0, keys.length - MAX_MESSAGES)) delete r.messages[k]; };
const help = () => ['╭──── LOCO-TERMUX 명령어 전체보기 ────╮','│ !핑 !명령어 !봇정보 !봇상태','│ !관리자 @유저 !관리자해제 @유저 !관리자목록','│ !입장로그 !퇴장로그 !입퇴장로그','│ !나간사람 !나간사람내보내기 !읽은사람 !채팅순위','│ !kick @유저 또는 답장 후 !kick','│ !allkick','│ !봇등록 !방등록해제','│ !도박가입 !도박 <포인트>','╰────────────────────────────╯'].join('\n');
const members = async (client: any, id: string, r: M) => { try { if (typeof client._resolveChatMembers === 'function') { const ids = await client._resolveChatMembers(id); const out = []; for (const x of ids ?? []) { let n = ''; try { if (typeof client.getUsernameById === 'function') n = String(await client.getUsernameById(id, x) || ''); } catch {} out.push({ id: String(x), name: n }); } if (out.length) return out; } } catch {} return Object.entries(r.users ?? {}).map(([i, v]: [string, any]) => ({ id: i, name: String(v?.nickname ?? '') })); };
const kick = async (client: any, chat: any, id: string, t: any, send: (s: string) => Promise<void>) => { if (!t?.id || t.id === String(client.userId)) return send('❌ 내보낼 대상을 확인할 수 없습니다.'); if (typeof chat?.openChatKick !== 'function') return send('❌ 현재 연결에서 내보내기 기능을 사용할 수 없습니다.'); if (!/^\d+$/.test(t.id)) return send('❌ 대상 ID가 올바르지 않습니다.'); try { await chat.openChatKick(id, Number(t.id)); appendEvent('KICK', { roomId: id, roomName: roomName(chat), userId: t.id, nickname: t.name || '알 수 없음' }); await send(`✅ ${t.name ? `@${t.name}` : t.id} 내보내기 완료`); } catch (e) { await send(`❌ 내보내기 실패: ${e instanceof Error ? e.message : String(e)}`); } };

async function command(client: any, chat: any, msg: any) {
  const t = text(msg), id = roomId(chat, msg), uid = senderId(msg); if (!t.startsWith('!') || !id || !uid || uid === String(client.userId)) return;
  const s = state(), r = room(s, id), name = senderName(msg); r.users[uid] ??= { nickname: name, messages: 0, points: 0, joined: true }; r.users[uid].nickname = name || r.users[uid].nickname; r.users[uid].messages = Number(r.users[uid].messages || 0) + 1;
  const send = async (v: string) => { for (const x of chunks(v)) await chat.sendText(id, x); };
  const [cmd, ...args] = t.split(/\s+/), a = admin(client, msg, r, uid);
  try {
    switch (cmd.toLowerCase()) {
      case '!명령어': await send(help()); break;
      case '!핑': await send('🏓 pong!'); break;
      case '!봇정보': await send(`🤖 LOCO-Termux\n방: ${roomName(chat, msg) || id}\n전송계층: ${client.transport || 'unknown'}\n연결: ${client.connected ? 'YES' : 'NO'}\n관리자: ${Object.keys(r.admins).length}명`); break;
      case '!관리자': case '!관리자해제': { if (!manager(msg) && uid !== developerId(client)) return send('❌ 실제 방장/부방장만 사용할 수 있습니다.'); const x = mentionTarget(msg); if (!x) return send(`사용법: ${cmd} @유저`); if (cmd.toLowerCase() === '!관리자') r.admins[x.id] = { id: x.id, name: x.name }; else delete r.admins[x.id]; save(CMD, s); await send(`${cmd.toLowerCase() === '!관리자' ? '🛡️ 등록' : '✅ 해제'} 완료: ${x.name || x.id}`); break; }
      case '!관리자목록': if (!a) return send('🔒 권한이 없습니다.'); await send(Object.values(r.admins).length ? ['🛡️ 관리자 전체보기', ...Object.values(r.admins).map((x: any, i) => `${i + 1}. ${x.name || x.id}`)].join('\n') : '🛡️ 등록된 관리자가 없습니다.'); break;
      case '!입장로그': case '!퇴장로그': case '!입퇴장로그': { if (!a) return send('🔒 권한이 없습니다.'); const type = cmd === '!입장로그' ? 'JOIN' : cmd === '!퇴장로그' ? 'LEAVE' : ''; const rows = events(type, id).reverse(); await send([cmd === '!입장로그' ? '📥 전체 입장 로그' : cmd === '!퇴장로그' ? '📤 전체 퇴장 로그' : '📋 전체 입퇴장 로그', ...(rows.length ? rows.map((x: M, i) => `${i + 1}. ${x.nickname} (${x.userId}) · ${fmt(x.at)}`) : ['기록이 없습니다.'])].join('\n')); break; }
      case '!나간사람': { if (!a) return send('🔒 권한이 없습니다.'); const rows = departed(id); await send(rows.length ? ['🚪 나간 사람 전체보기', ...rows.map((x: M, i) => `${i + 1}. ${x.nickname} (${x.userId}) · ${fmt(x.at)}`)].join('\n') : '🚪 나간 사람 기록이 없습니다.'); break; }
      case '!나간사람내보내기': { if (!a) return send('🔒 권한이 없습니다.'); const rows = departed(id); if (!rows.length) return send('🚪 내보낼 기록이 없습니다.'); let ok = 0; for (const x of rows) { try { if (typeof chat.openChatKick === 'function' && /^\d+$/.test(String(x.userId)) && String(x.userId) !== String(client.userId)) { await chat.openChatKick(id, Number(x.userId)); ok++; } } catch {} } await send(`🚪 내보내기 요청: ${ok}/${rows.length}명`); break; }
      case '!읽은사람': { if (!a) return send('🔒 권한이 없습니다.'); const mid = String(args[0] ?? msg?.message?.id ?? ''); const x = r.readers[mid] ?? r.messages[mid]; if (!x) return send('❌ 해당 메시지의 읽음 데이터가 없습니다.'); const names = Array.isArray(x.readerNames) ? x.readerNames.filter(Boolean) : []; await send(`👀 메시지 ${mid}\n읽은 사람: ${names.length ? names.join(', ') : '(읽음 목록 미제공)'}\n읽음 수: ${x.readerCount ?? names.length}`); break; }
      case '!채팅순위': { if (!a) return send('🔒 권한이 없습니다.'); const rows = Object.entries(r.users).sort((x: any, y: any) => Number(y[1]?.messages || 0) - Number(x[1]?.messages || 0)); await send(['🏆 채팅 순위', ...(rows.length ? rows.slice(0, 20).map(([i, x]: [string, any], n) => `${n + 1}. ${x.nickname || i} · ${Number(x.messages || 0)}회`) : ['기록이 없습니다.'])].join('\n')); break; }
      case '!kick': { if (!a) return send('🔒 권한이 없습니다.'); const x = mentionTarget(msg) ?? replyTarget(msg); if (!x) return send('사용법: !kick @유저 또는 대상 메시지에 답장 후 !kick'); await kick(client, chat, id, x, send); break; }
      case '!allkick': { if (uid !== developerId(client)) return send('🔒 !allkick은 개발자만 사용할 수 있습니다.'); const ms = await members(client, id, r); let ok = 0; for (const x of ms) { if (x.id === String(client.userId) || !/^\d+$/.test(x.id)) continue; try { if (typeof chat.openChatKick === 'function') { await chat.openChatKick(id, Number(x.id)); ok++; } } catch {} } await send(`⚠️ 전체 내보내기 요청: ${ok}/${Math.max(0, ms.length - 1)}명`); break; }
      case '!봇등록': { if (!manager(msg) && uid !== developerId(client)) return send('❌ 실제 방장/부방장만 등록할 수 있습니다.'); const code = String(randomInt(10000000, 100000000)); r.code = code; r.codeExpiresAt = Date.now() + CODE_TTL; r.registered = false; save(CMD, s); console.log(`[방등록] ${roomName(chat, msg) || id} | roomId=${id} | code=${code}`); await send(`🔐 방 등록 코드: ${code}\n5분 안에 이 방에서 ${code} 를 입력하세요.`); break; }
      case '!방등록해제': if (!a) return send('🔒 권한이 없습니다.'); r.registered = false; r.code = null; r.codeExpiresAt = 0; save(CMD, s); await send('✅ 이 방의 봇 등록을 해제했습니다.'); break;
      case '!도박가입': r.users[uid].points = Number(r.users[uid].points || 0) || 1000; save(CMD, s); await send(`🎰 가입 완료! 보유 포인트: ${r.users[uid].points}P`); break;
      case '!도박': { const n = Math.floor(Number(args[0])); const bal = Number(r.users[uid].points || 0); if (!Number.isFinite(n) || n <= 0) return send('사용법: !도박 <포인트>'); if (bal < n) return send(`❌ 포인트 부족. 현재 ${bal}P`); if (Math.random() < .5) { r.users[uid].points = bal + n * 2; await send(`🎉 당첨! +${n * 2}P\n보유: ${r.users[uid].points}P`); } else { r.users[uid].points = bal - n; await send(`💥 꽝! -${n}P\n보유: ${r.users[uid].points}P`); } save(CMD, s); break; }
    }
  } catch (e) { console.error('[COMMAND]', e instanceof Error ? e.stack || e.message : String(e)); try { await send('❌ 명령 처리 중 오류가 발생했습니다.'); } catch {} }
  save(CMD, s);
}

function verify(client: any, chat: any, msg: any) { const t = text(msg); if (!/^\d{8}$/.test(t)) return false; const id = roomId(chat, msg), uid = senderId(msg); if (!id || !uid || uid === String(client.userId)) return false; const s = state(), r = room(s, id); if (!r.code || Date.now() > Number(r.codeExpiresAt || 0)) { r.code = null; r.codeExpiresAt = 0; save(CMD, s); return false; } if (t !== String(r.code)) return false; r.registered = true; r.code = null; r.codeExpiresAt = 0; r.registeredAt = new Date().toISOString(); save(CMD, s); console.log(`[방등록] 인증 성공 | ${roomName(chat, msg) || id} | roomId=${id}`); return true; }

async function sync(client: any) { try { const x = await client.getChatRooms(), raw = Array.isArray(x?.chats) ? x.chats : Array.isArray(x) ? x : [], rooms = raw.map((v: any) => ({ id: String(v?.id ?? v?.chatId ?? v?.roomId ?? v?.c ?? ''), name: String(v?.name ?? v?.roomName ?? v?.title ?? ''), isOpenChat: v?.isOpenChat === true, isGroupChat: v?.isGroupChat === true })).filter((v: M) => v.id); const s = load(STATE); save(STATE, { ...s, connected: true, rooms, roomCount: rooms.length, lastRoomSyncAt: new Date().toISOString() }); return rooms.length; } catch (e) { const s = load(STATE); save(STATE, { ...s, connected: Boolean(client.connected), roomSyncError: String(e), updatedAt: new Date().toISOString() }); return 0; } }

async function main() {
  if (!existsSync(AUTH)) throw new Error(`인증 세션이 없습니다: ${AUTH}`);
  const client: any = createClient({ authPath: AUTH, autoConnect: false, autoReconnect: true, reconnectMinDelayMs: 1000, reconnectMaxDelayMs: 30000, pingIntervalMs: 60000, socketKeepAliveMs: 30000, memberRefreshIntervalMs: 60000, memberLookupTimeoutMs: 3000, sendIntervalMs: 400, debug: process.env.LOCO_DEBUG === '1' });
  const mark = (connected: boolean, extra: M = {}) => { const s = load(STATE); save(STATE, { ...s, connected, transport: client.transport || null, userId: String(client.userId || ''), developerId: developerId(client), heartbeatAt: new Date().toISOString(), ...extra }); };
  client.on('connected', () => mark(true, { lastConnectedAt: new Date().toISOString(), error: null }));
  client.on('disconnected', () => mark(false, { lastDisconnectedAt: new Date().toISOString() }));
  client.on('kickout', (p: any) => mark(false, { kickout: p }));
  client.on('error', (e: any) => { console.error('[LOCO]', e instanceof Error ? e.stack || e.message : String(e)); mark(Boolean(client.connected), { error: String(e) }); });
  client.onReady(async () => { console.log(`[LOCO] READY userId=${client.userId} transport=${client.transport || 'unknown'}`); mark(true, { readyAt: new Date().toISOString() }); await sync(client); });
  client.onMessage(async (chat: any, msg: any) => { const id = roomId(chat, msg); if (!id) return; const s = state(), r = room(s, id), uid = senderId(msg); if (uid && uid !== String(client.userId)) { r.users[uid] ??= { nickname: '', messages: 0, points: 0, joined: true }; r.users[uid].nickname = senderName(msg) || r.users[uid].nickname; } record(msg?.room ?? chat, msg, r); save(CMD, s); if (verify(client, chat, msg)) { try { await chat.sendText(id, '✅ 방 등록 완료! 이제 이 방에서 봇 기능을 사용할 수 있습니다.'); } catch {} return; } await command(client, chat, msg); });
  client.onJoin((e: any) => { const x = appendEvent('JOIN', e); if (x) console.log(`[JOIN] ${x.roomId} ${x.nickname} (${x.userId})`); });
  client.onLeave((e: any) => { const x = appendEvent('LEAVE', e); if (x) console.log(`[LEAVE] ${x.roomId} ${x.nickname} (${x.userId})`); });
  client.onKick((e: any) => { const x = appendEvent('KICK', e); if (x) console.log(`[KICK] ${x.roomId} ${x.nickname} (${x.userId})`); });
  await client.connect(); await sync(client);
  const timer = setInterval(() => void sync(client), SYNC), beat = setInterval(() => mark(Boolean(client.connected), { runtime: 'openchat', pid: process.pid }), HEARTBEAT);
  const shutdown = () => { clearInterval(timer); clearInterval(beat); try { client.disconnect(); } catch {} mark(false, { stoppedAt: new Date().toISOString() }); };
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
  console.log('[LOCO] OpenChat runtime is running.'); await new Promise<void>(() => undefined);
}

main().catch(e => { console.error('[FATAL] OpenChat runtime:', e instanceof Error ? e.stack || e.message : String(e)); const s = load(STATE); save(STATE, { ...s, connected: false, runtime: 'openchat', fatalError: String(e), fatalAt: new Date().toISOString() }); process.exitCode = 1; });
