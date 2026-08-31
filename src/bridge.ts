import http from 'node:http';
import crypto from 'node:crypto';
import { loadConfig, saveConfig, roomListToString, type ChatStat } from './config';

export type BridgeUser = { id?: string | number; name?: string };
export type BridgeEvent = {
  type: 'chat' | 'member_join' | 'member_leave';
  room: string;
  user?: BridgeUser;
  text?: string;
  timestamp?: number;
};

export type BridgeResponse = {
  type: 'send_message';
  room: string;
  text: string;
};

const config = loadConfig();
const host = process.env.BRIDGE_HOST || '127.0.0.1';
const port = Number(process.env.BRIDGE_PORT || 18080);
const token = process.env.BRIDGE_TOKEN || '';

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

function allowedRoom(room: string): boolean {
  return config.rooms.length === 0 || config.rooms.includes(room);
}

function userKey(user: BridgeUser | undefined): string {
  return String(user?.id ?? user?.name ?? 'unknown');
}

function userName(user: BridgeUser | undefined): string {
  return user?.name || '알 수 없음';
}

function nowText(ts = Date.now()): string {
  return new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ts));
}

function addChat(room: string, user: BridgeUser | undefined): void {
  const key = userKey(user);
  const name = userName(user);
  const current = config.chatStats.find((s: ChatStat) => s.room === room && s.userKey === key);
  const now = new Date().toISOString();
  if (current) {
    current.count += 1;
    current.userName = name;
    current.lastSeenAt = now;
  } else {
    config.chatStats.push({ room, userKey: key, userName: name, count: 1, firstSeenAt: now, lastSeenAt: now });
  }
}

function memberLog(room: string, user: BridgeUser | undefined, type: 'JOIN' | 'LEAVE', timestamp: number): string {
  const key = userKey(user);
  const name = userName(user);
  const joins = config.memberEvents.filter(e => e.room === room && e.userKey === key && e.type === 'JOIN').length;
  const count = joins + (type === 'JOIN' ? 1 : 0);
  config.memberEvents.push({ room, userKey: key, userName: name, type, at: new Date(timestamp).toISOString(), count });
  if (config.memberEvents.length > 2000) config.memberEvents.splice(0, config.memberEvents.length - 2000);
  return type === 'JOIN'
    ? `@${name}님이 ${room}에 입장하셨습니다.\n\n[+] ${nowText(timestamp)} ${count === 1 ? '첫 입장' : '입장'}\n[+] ${count}번째 입장`
    : `@${name}님이 ${room}에서 나가셨습니다.\n\n[+] ${nowText(timestamp)} 퇴장`;
}

function help(): string {
  return ['📖 명령어', '', '!핑', '!명령어', '!채팅순위', '!입퇴장로그', '!전체보기', '!봇정보', '!봇등록', '!방등록해제'].join('\n');
}

function command(room: string, text: string): string | null {
  if (!text.startsWith(config.prefix) || !allowedRoom(room)) return null;
  const [raw, ...args] = text.slice(config.prefix.length).trim().split(/\s+/);
  const cmd = (raw || '').toLowerCase();
  if (cmd === '핑' || cmd === 'ping') return 'Pong!';
  if (cmd === '명령어' || cmd === 'help') return help();
  if (cmd === 'echo') return args.join(' ') || '사용법: !echo <내용>';
  if (cmd === '봇정보') return `🤖 BRIDGE BOT\n방: ${room}\n등록 방: ${roomListToString(config.rooms)}\n상태: 브리지 대기 중`;
  if (cmd === '방등록해제') {
    const i = config.rooms.indexOf(room);
    if (i < 0) return 'ℹ️ 이 채팅방은 등록되어 있지 않습니다.';
    config.rooms.splice(i, 1);
    saveConfig(config);
    return '✓ 이 채팅방의 봇 등록을 해제했습니다.';
  }
  if (cmd === '봇등록') return 'ℹ️ 봇등록 코드는 메인 메뉴에서 생성하세요.';
  if (cmd === '채팅순위') {
    const rows = config.chatStats.filter(s => s.room === room).sort((a, b) => b.count - a.count).slice(0, 20);
    return rows.length ? ['📊 채팅 순위', ...rows.map((s, i) => `${i + 1}위 ${s.userName} — ${s.count}회`)].join('\n') : '📊 아직 채팅 기록이 없습니다.';
  }
  if (cmd === '입퇴장로그' || cmd === '전체보기') {
    const rows = config.memberEvents.filter(e => e.room === room).slice(cmd === '전체보기' ? -100 : -50).reverse();
    return rows.length ? ['📋 입퇴장 로그', ...rows.map(e => `${e.type === 'JOIN' ? '[+]' : '[-]'} ${nowText(new Date(e.at).getTime())} ${e.userName} — ${e.type === 'JOIN' ? `입장 (${e.count}번째)` : '퇴장'}`)].join('\n') : '📋 아직 입퇴장 기록이 없습니다.';
  }
  return null;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 512 * 1024) reject(new Error('request too large'));
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== 'POST' || req.url !== '/event') return json(res, 404, { error: 'not found' });
    if (token && req.headers.authorization !== `Bearer ${token}`) return json(res, 401, { error: 'unauthorized' });

    const event = JSON.parse(await readBody(req)) as BridgeEvent;
    if (!event.room || !['chat', 'member_join', 'member_leave'].includes(event.type)) return json(res, 400, { error: 'invalid event' });

    const timestamp = event.timestamp || Date.now();
    const responses: BridgeResponse[] = [];

    if (event.type === 'chat') {
      addChat(event.room, event.user);
      if (allowedRoom(event.room)) {
        const reply = command(event.room, event.text?.trim() || '');
        if (reply) responses.push({ type: 'send_message', room: event.room, text: reply });
      }
    } else if (allowedRoom(event.room)) {
      const text = memberLog(event.room, event.user, event.type === 'member_join' ? 'JOIN' : 'LEAVE', timestamp);
      responses.push({ type: 'send_message', room: event.room, text });
    }

    saveConfig(config);
    return json(res, 200, { ok: true, responses, requestId: crypto.randomUUID() });
  } catch (error) {
    return json(res, 400, { error: error instanceof Error ? error.message : 'bad request' });
  }
});

server.listen(port, host, () => {
  console.log(`[BRIDGE] listening on http://${host}:${port}`);
  console.log(`[BRIDGE] rooms: ${roomListToString(config.rooms)}`);
});
