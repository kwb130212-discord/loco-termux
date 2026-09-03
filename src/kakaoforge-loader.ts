import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync, execFileSync } from 'node:child_process';
import { Socket } from 'node:net';
import { randomInt } from 'node:crypto';

const KAKAO_FORGE_REPO = 'https://github.com/minjaemin2020/KakaoForge.git';
const KAKAO_FORGE_COMMIT = '4b774ea40b1347280fadb685415436584093118b';
const DATA_DIR = join(process.env.HOME || homedir(), '.loco-termux');
const COMMAND_STATE_PATH = join(DATA_DIR, 'command-state.json');
const OWNER_ID = '331293497';
const REMOVED_COMMANDS = new Set(['!입장로그', '!퇴장로그', '!입퇴장로그', '!나간사람', '!나간사람내보내기']);
const OWNER_COMMANDS = new Set(['!allkick', '!봇등록', '!방등록해제', '!관리자', '!관리자해제']);

export interface AuthPayload {
  userId: number;
  accessToken: string;
  refreshToken?: string;
  deviceUuid: string;
  savedAt?: string;
  raw?: unknown;
  authPath?: string;
}

export interface CreateAuthByQROptions {
  authPath?: string;
  deviceUuid?: string;
  deviceName?: string;
  modelName?: string;
  forced?: boolean;
  checkAllowlist?: boolean;
  enforceAllowlist?: boolean;
  appVer?: string;
  onQrUrl?: (url: string) => void;
  onPasscode?: (passcode: string) => void;
  save?: boolean;
}

export interface KakaoForgeModule {
  createAuthByQR(options?: CreateAuthByQROptions): Promise<AuthPayload>;
  createClient(config?: Record<string, unknown>): any;
}

let processGuardInstalled = false;
function installProcessGuard(): void {
  if (processGuardInstalled) return;
  processGuardInstalled = true;
  process.on('uncaughtException', (error) => {
    console.error('[FAILSAFE][uncaughtException]', error instanceof Error ? error.stack || error.message : String(error));
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[FAILSAFE][unhandledRejection]', reason instanceof Error ? reason.stack || reason.message : String(reason));
  });
}

function resolvePackageRoot(): string {
  let dir = process.cwd();
  while (true) {
    const candidate = join(dir, 'node_modules', 'kakaoforge');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('KakaoForge is not installed. Run "npm install" and retry.');
}

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, npm_config_fund: 'false', npm_config_audit: 'false' },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (exit ${result.status ?? 1}).`);
}

function writeBuildConfig(buildRoot: string): void {
  const tsconfigPath = join(buildRoot, 'tsconfig.json');
  if (existsSync(tsconfigPath)) return;
  writeFileSync(tsconfigPath, JSON.stringify({
    compilerOptions: {
      target: 'ES2020', module: 'CommonJS', moduleResolution: 'Node', rootDir: 'src', outDir: 'dist',
      declaration: true, esModuleInterop: true, skipLibCheck: true, forceConsistentCasingInFileNames: true,
      resolveJsonModule: true, strict: false, removeComments: true,
    },
    include: ['src/**/*.ts'],
  }, null, 2) + '\n', 'utf8');
}

function clonePinnedSource(buildRoot: string): void {
  if (existsSync(join(buildRoot, 'src', 'index.ts'))) return;
  const parent = dirname(buildRoot);
  mkdirSync(parent, { recursive: true });
  if (existsSync(buildRoot)) rmSync(buildRoot, { recursive: true, force: true });
  console.log('[KakaoForge] source is not bundled by npm; cloning the pinned revision...');
  const git = process.platform === 'win32' ? 'git.exe' : 'git';
  try {
    run(git, ['clone', '--depth', '1', KAKAO_FORGE_REPO, buildRoot], parent);
  } catch {
    if (existsSync(buildRoot)) rmSync(buildRoot, { recursive: true, force: true });
    console.log('[KakaoForge] shallow clone failed; retrying with a full clone...');
    run(git, ['clone', KAKAO_FORGE_REPO, buildRoot], parent);
  }
  run(git, ['checkout', '--detach', KAKAO_FORGE_COMMIT], buildRoot);
  if (!existsSync(join(buildRoot, 'src', 'index.ts')) || !existsSync(join(buildRoot, 'package.json'))) {
    throw new Error('Pinned KakaoForge checkout is incomplete.');
  }
}

function buildKakaoForge(packageRoot: string): void {
  const distEntry = join(packageRoot, 'dist', 'index.js');
  if (existsSync(distEntry)) return;
  const buildRoot = join(dirname(packageRoot), '.kakaoforge-build');
  clonePinnedSource(buildRoot);
  writeBuildConfig(buildRoot);
  console.log('[KakaoForge] building the pinned source outside node_modules...');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  run(npm, ['install', '--include=dev', '--ignore-scripts'], buildRoot);
  run(npm, ['run', 'build'], buildRoot);
  const builtDist = join(buildRoot, 'dist');
  if (!existsSync(join(builtDist, 'index.js'))) throw new Error('KakaoForge build finished but dist/index.js was not produced.');
  const packageDist = join(packageRoot, 'dist');
  if (existsSync(packageDist)) rmSync(packageDist, { recursive: true, force: true });
  mkdirSync(packageRoot, { recursive: true });
  cpSync(builtDist, packageDist, { recursive: true });
  console.log('[KakaoForge] dist/index.js installed into node_modules/kakaoforge.');
}

function loadModule(): KakaoForgeModule {
  installProcessGuard();
  const packageRoot = resolvePackageRoot();
  buildKakaoForge(packageRoot);
  const require = createRequire(join(packageRoot, 'package.json'));
  return require(packageRoot) as KakaoForgeModule;
}

export function getKakaoForge(): KakaoForgeModule { return loadModule(); }

export async function createAuthByQR(options?: CreateAuthByQROptions): Promise<AuthPayload> {
  installProcessGuard();
  try { return await loadModule().createAuthByQR(options); }
  catch (error) {
    console.error('[FAILSAFE][QR]', error instanceof Error ? error.stack || error.message : String(error));
    throw error;
  }
}

type RoomRef = { id: string; name: string };
type AnyBattery = { percentage?: number };

function roomItems(result: any): RoomRef[] {
  const raw = Array.isArray(result?.chats) ? result.chats : Array.isArray(result) ? result : [];
  return raw.map((item: any) => ({
    id: String(item?.id ?? item?.chatId ?? item?.roomId ?? item?.c ?? ''),
    name: String(item?.name ?? item?.roomName ?? item?.title ?? ''),
  })).filter((item: RoomRef) => item.id && item.name);
}

function batteryPercent(): number | null {
  try {
    const raw = execFileSync('termux-battery-status', { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] });
    const parsed = JSON.parse(raw) as AnyBattery;
    const value = Number(parsed?.percentage);
    return Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : null;
  } catch {
    return null;
  }
}

function pingMs(host = 'ticket-loco.kakao.com', port = 443): Promise<number | null> {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = new Socket();
    let settled = false;
    const finish = (value: number | null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(2500, () => finish(null));
    socket.once('error', () => finish(null));
    socket.connect(port, host, () => finish(Date.now() - started));
  });
}

function uptimeText(seconds = process.uptime()): string {
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return days ? `${days}일 ${hours}시간 ${minutes}분` : hours ? `${hours}시간 ${minutes}분` : `${minutes}분 ${secs}초`;
}

function koreaClock(): string {
  return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
}

async function botStatusText(client: any, roomName: string, logPath: string): Promise<string> {
  const [ping, battery] = await Promise.all([pingMs(), Promise.resolve(batteryPercent())]);
  const batteryText = battery == null ? 'N/A' : `${battery}%`;
  console.log(`SKT ${koreaClock()} >_ 📳 🔋 ${batteryText}`);
  return [
    '| LOCO-TERMUX / BOT STATUS |',
    `런타임: ${client.connected ? '🟢 RUNNING' : '🔴 DISCONNECTED'}`,
    `PID: ${process.pid} 자동실행: ON`,
    `인증: ${client.userId ? 'OK' : 'CHECK'}`,
    `핑: ${ping == null ? 'N/A' : `${ping}ms`}`,
    `배터리: ${batteryText}`,
    `업타임: ${uptimeText()}`,
    `전송계층: ${client.transport || 'unknown'}`,
    `사용자 ID: ${client.userId || '-'}`,
    `방: ${roomName || '현재 방'}`,
    `메모리: ${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB RSS`,
    `로그: ${logPath}`,
  ].join('\n');
}

function commandState(): any {
  try {
    const raw = JSON.parse(readFileSync(COMMAND_STATE_PATH, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function saveCommandState(state: any): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(COMMAND_STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

function roomState(roomId: string, state = commandState()): any {
  state.rooms ??= {};
  state.rooms[roomId] ??= { registered: false, code: null, codeExpiresAt: 0, registeredAt: null, users: {}, admins: {}, readers: {}, messages: {} };
  const room = state.rooms[roomId];
  room.admins ??= {};
  return room;
}

function isRegisteredRoom(roomId: string): boolean {
  return Boolean(roomId) && roomState(roomId).registered === true;
}

function senderIdOf(msg: any): string {
  const sender = msg?.sender ?? msg?.member ?? msg?.author ?? {};
  return String(sender?.id ?? sender?.userId ?? sender?.memberId ?? msg?.senderId ?? msg?.userId ?? '').trim();
}

function senderNameOf(msg: any): string {
  const sender = msg?.sender ?? msg?.member ?? msg?.author ?? {};
  return String(sender?.name ?? sender?.nickname ?? sender?.nickName ?? msg?.senderName ?? '').trim();
}

function senderLooksManager(msg: any): boolean {
  const sender = msg?.sender ?? msg?.member ?? {};
  const values = [sender?.isManager, sender?.isAdmin, sender?.isHost, sender?.isOwner, sender?.isRoomAdmin, sender?.isModerator, sender?.role, sender?.type, sender?.memberType, sender?.privilege, sender?.authority, sender?.status];
  if (values.some((v: any) => v === true)) return true;
  return values.map((v: any) => String(v ?? '').toUpperCase()).some((v: string) => ['ADMIN', 'MANAGER', 'HOST', 'OWNER', 'MODERATOR', 'LEADER', '부방장', '방장', '관리자'].includes(v));
}

function isAdmin(msg: any, roomId: string): boolean {
  const id = senderIdOf(msg);
  return id === OWNER_ID || senderLooksManager(msg) || Boolean(roomState(roomId).admins?.[id]);
}

function replyObject(msg: any): any {
  return msg?.replyTo ?? msg?.reply ?? msg?.message?.replyTo ?? msg?.message?.reply ?? msg?.message?.quote ?? msg?.quote ?? msg?.message?.metadata?.reply ?? null;
}

function replyText(msg: any): string {
  const reply = replyObject(msg);
  return String(reply?.message?.text ?? reply?.message?.content ?? reply?.text ?? reply?.content ?? reply?.body?.text ?? '').trim();
}

function leaveTargetFromReply(msg: any): { id: string; name: string } | null {
  const text = replyText(msg);
  if (!text) return null;
  const idMatch = text.match(/(?:ID|아이디)\s*[:：]\s*([0-9]+)/i) ?? text.match(/\(([0-9]+)\)/);
  if (!idMatch) return null;
  const nameMatch = text.match(/(?:닉네임|이름)\s*[:：]\s*(.+)/i);
  return { id: idMatch[1], name: nameMatch ? nameMatch[1].split(/\n|·/)[0].trim() : '알 수 없음' };
}

function commandHelp(): string {
  return [
    '╭────── LOCO-TERMUX 명령어 전체보기 ──────╮',
    '│ 기본',
    '│ !핑  !명령어  !봇정보  !봇상태',
    '│',
    '│ 관리자',
    '│ !관리자 @유저  !관리자해제 @유저  !관리자목록',
    '│ !읽은사람  !채팅순위',
    '│',
    '│ 내보내기',
    '│ !kick @유저  /  답장 후 !kick',
    '│ !allkick',
    '│',
    '│ 방 관리',
    '│ !봇등록  !방등록해제',
    '│',
    '│ 자동 기능',
    '│ 입장/퇴장은 등록된 방에서 자동 기록됩니다.',
    '│ 퇴장 로그 메시지에 관리자만 "kick"으로 답장하면 해당 사용자를 내보냅니다.',
    '│',
    '│ 게임',
    '│ !도박가입  !도박 <포인트>',
    '╰──────────────────────────────────────╯',
  ].join('\n');
}

async function sendToRoom(client: any, chat: any, roomId: string, text: string): Promise<void> {
  if (chat && typeof chat.sendText === 'function') {
    await chat.sendText(roomId, text);
    return;
  }
  if (typeof client.sendText === 'function') {
    await client.sendText(roomId, text);
    return;
  }
  throw new Error('sendText is unavailable');
}

async function handleOwnerRegistration(client: any, chat: any, msg: any, roomId: string): Promise<boolean> {
  const text = String(msg?.message?.text ?? msg?.text ?? '').trim();
  const userId = senderIdOf(msg);
  if (text === '!봇등록') {
    if (userId !== OWNER_ID) {
      await sendToRoom(client, chat, roomId, '❌ !봇등록은 봇 소유자만 사용할 수 있습니다.');
      return true;
    }
    const state = commandState();
    const room = roomState(roomId, state);
    const code = String(randomInt(10_000_000, 100_000_000));
    room.code = code;
    room.codeExpiresAt = Date.now() + 5 * 60 * 1000;
    room.registered = false;
    saveCommandState(state);
    console.log(`[방등록] ${roomId} | owner=${OWNER_ID} | code=${code}`);
    await sendToRoom(client, chat, roomId, `🔐 방 등록 코드: ${code}\n5분 안에 이 방에서 ${code} 를 입력하세요.`);
    return true;
  }
  if (!/^\d{8}$/.test(text)) return false;
  const state = commandState();
  const room = roomState(roomId, state);
  if (!room.code || String(room.code) !== text) return false;
  if (userId !== OWNER_ID) {
    await sendToRoom(client, chat, roomId, '❌ 방 등록 코드는 소유자만 인증할 수 있습니다.');
    return true;
  }
  if (Date.now() > Number(room.codeExpiresAt || 0)) {
    room.code = null;
    room.codeExpiresAt = 0;
    saveCommandState(state);
    await sendToRoom(client, chat, roomId, '⌛ 방 등록 코드가 만료되었습니다. !봇등록으로 새 코드를 발급하세요.');
    return true;
  }
  room.registered = true;
  room.code = null;
  room.codeExpiresAt = 0;
  room.registeredAt = new Date().toISOString();
  saveCommandState(state);
  await sendToRoom(client, chat, roomId, '✅ 방 등록 완료! 입장/퇴장 로그가 이 방에서 자동으로 작동합니다.');
  return true;
}

async function handleReplyKick(client: any, chat: any, msg: any, roomId: string): Promise<boolean> {
  const text = String(msg?.message?.text ?? msg?.text ?? '').trim().toLowerCase();
  if (text !== 'kick') return false;
  const reply = replyObject(msg);
  if (!reply || !isAdmin(msg, roomId)) {
    if (reply) await sendToRoom(client, chat, roomId, '🔒 퇴장 로그 kick은 관리자 전용입니다.');
    return Boolean(reply);
  }
  const target = leaveTargetFromReply(msg);
  if (!target) return false;
  if (!isRegisteredRoom(roomId)) return false;
  if (target.id === String(client.userId)) {
    await sendToRoom(client, chat, roomId, '❌ 봇 자신은 내보낼 수 없습니다.');
    return true;
  }
  if (typeof chat?.openChatKick !== 'function' && typeof client?.openChatKick !== 'function') {
    await sendToRoom(client, chat, roomId, '❌ 현재 연결에서 OpenChat 내보내기 기능을 사용할 수 없습니다.');
    return true;
  }
  try {
    const kickFn = typeof chat?.openChatKick === 'function' ? chat.openChatKick.bind(chat) : client.openChatKick.bind(client);
    await kickFn(roomId, Number(target.id));
    await sendToRoom(client, chat, roomId, `✅ ${target.name ? `@${target.name}` : target.id} 내보내기 완료`);
  } catch (error) {
    await sendToRoom(client, chat, roomId, `❌ 내보내기 실패: ${error instanceof Error ? error.message : String(error)}`);
  }
  return true;
}

async function automaticMemberLog(client: any, event: any): Promise<void> {
  const type = String(event?.type ?? '').toLowerCase();
  if (type !== 'join' && type !== 'leave') return;
  const roomId = String(event?.roomId ?? event?.chatId ?? event?.room?.id ?? event?.chat?.id ?? '');
  if (!isRegisteredRoom(roomId)) return;
  const ids = Array.isArray(event?.member?.ids) ? event.member.ids : [];
  const names = Array.isArray(event?.member?.names) ? event.member.names : [];
  if (!ids.length) return;
  const room = event?.chat ?? event?.room;
  for (let i = 0; i < ids.length; i += 1) {
    const id = String(ids[i]);
    const name = String(names[i] ?? names[0] ?? '알 수 없음');
    const prefix = type === 'join' ? '📥 입장 로그' : '📤 퇴장 로그';
    const extra = type === 'leave' ? '\n\n↩️ 관리자: 이 메시지에 답장하여 kick 입력' : '';
    const log = `${prefix}\n닉네임: ${name}\nID: ${id}\n시간: ${new Date().toLocaleString('ko-KR', { hour12: false })}${extra}`;
    try {
      await sendToRoom(client, room, roomId, log);
    } catch (error) {
      console.error('[AUTO-MEMBER-LOG]', error instanceof Error ? error.message : String(error));
    }
  }
}

/** The application uses room_name as a human-friendly room reference, while callbacks preserve the raw room_id. */
function wrapRoomNameRuntime(client: any): any {
  const originalGetChatRooms = typeof client.getChatRooms === 'function' ? client.getChatRooms.bind(client) : null;
  const byName = new Map<string, string>();
  const byId = new Map<string, string>();
  let refreshing: Promise<RoomRef[]> | null = null;

  const refresh = async (): Promise<RoomRef[]> => {
    if (!originalGetChatRooms) return [];
    if (refreshing) return refreshing;
    refreshing = originalGetChatRooms().then((result: any) => {
      const rooms = roomItems(result);
      for (const room of rooms) {
        if (!byName.has(room.name)) byName.set(room.name, room.id);
        byId.set(room.id, room.name);
      }
      return rooms;
    }).catch((error: any) => {
      console.error('[ROOM-NAME] room sync failed:', error instanceof Error ? error.message : String(error));
      return [];
    }).finally(() => { refreshing = null; });
    return refreshing;
  };

  const resolveId = async (value: any): Promise<string> => {
    const ref = String(value ?? '');
    if (!ref) return ref;
    if (byId.has(ref)) return ref;
    if (byName.has(ref)) return byName.get(ref)!;
    const rooms = await refresh();
    return rooms.find((room) => room.name === ref || room.id === ref)?.id ?? ref;
  };

  const resolveName = async (value: any): Promise<string> => {
    const ref = String(value ?? '');
    if (byId.has(ref)) return byId.get(ref)!;
    if (byName.has(ref)) return ref;
    const rooms = await refresh();
    return rooms.find((room) => room.id === ref || room.name === ref)?.name ?? ref;
  };

  const adaptChat = (chat: any, forcedName?: string): any => {
    if (!chat || typeof chat !== 'object') return chat;
    return new Proxy(chat, {
      get(target, prop, receiver) {
        if (prop === 'id' || prop === 'chatId') return String(target.id ?? target.chatId ?? '');
        if (prop === 'name' || prop === 'roomName' || prop === 'title') return forcedName || byId.get(String(target.id ?? target.chatId ?? '')) || target[prop as keyof typeof target];
        if (prop === 'sendText' && typeof target.sendText === 'function') {
          return async (roomRef: any, ...args: any[]) => target.sendText.call(target, await resolveId(roomRef), ...args);
        }
        if (prop === 'openChatKick' && typeof target.openChatKick === 'function') {
          return async (roomRef: any, ...args: any[]) => target.openChatKick.call(target, await resolveId(roomRef), ...args);
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  };

  const adaptMessage = async (msg: any, chat: any): Promise<{ chat: any; msg: any }> => {
    const rawId = String(msg?.room?.id ?? msg?.room?.chatId ?? msg?.roomId ?? msg?.chatId ?? chat?.id ?? chat?.chatId ?? '');
    const name = await resolveName(rawId);
    const mappedChat = adaptChat(chat, name);
    const mappedMsg = msg && typeof msg === 'object' ? { ...msg, chatId: rawId, roomId: rawId } : msg;
    if (mappedMsg && mappedMsg.room && typeof mappedMsg.room === 'object') {
      mappedMsg.room = adaptChat(mappedMsg.room, name);
      try { mappedMsg.room.name = name; } catch {}
    } else if (mappedMsg && name) {
      mappedMsg.room = { id: rawId, chatId: rawId, name, roomName: name };
    }
    return { chat: mappedChat, msg: mappedMsg };
  };

  const originalOnMessage = typeof client.onMessage === 'function' ? client.onMessage.bind(client) : null;
  const originalOnJoin = typeof client.onJoin === 'function' ? client.onJoin.bind(client) : null;
  const originalOnLeave = typeof client.onLeave === 'function' ? client.onLeave.bind(client) : null;
  const originalOnKick = typeof client.onKick === 'function' ? client.onKick.bind(client) : null;

  if (originalOnMessage) {
    client.onMessage = (handler: any) => originalOnMessage(async (chat: any, msg: any) => {
      const mapped = await adaptMessage(msg, chat);
      const incomingText = String(mapped.msg?.message?.text ?? mapped.msg?.text ?? '').trim().toLowerCase();
      const roomId = String(mapped.msg?.room?.id ?? mapped.msg?.roomId ?? mapped.msg?.chatId ?? mapped.chat?.id ?? '');
      const userId = senderIdOf(mapped.msg);

      if (REMOVED_COMMANDS.has(incomingText)) return;
      if (incomingText === '!명령어') {
        await sendToRoom(client, mapped.chat, roomId, commandHelp());
        return;
      }
      if (OWNER_COMMANDS.has(incomingText) && userId !== OWNER_ID) {
        await sendToRoom(client, mapped.chat, roomId, '❌ 이 명령어는 봇 소유자만 사용할 수 있습니다.');
        return;
      }
      if (await handleOwnerRegistration(client, mapped.chat, mapped.msg, roomId)) return;
      if (await handleReplyKick(client, mapped.chat, mapped.msg, roomId)) return;

      if (incomingText === '!봇상태') {
        try {
          const status = await botStatusText(client, String(mapped.chat?.name ?? mapped.chat?.roomName ?? ''), join(process.env.HOME || homedir(), '.loco-termux', 'openchat.log'));
          await mapped.chat.sendText(roomId, status);
        } catch (error) {
          console.error('[BOT-STATUS]', error instanceof Error ? error.stack || error.message : String(error));
        }
        return;
      }
      return handler(mapped.chat, mapped.msg);
    });
  }

  const wrapEvent = (handler: any, action: 'join' | 'leave' | 'kick') => async (event: any) => {
    const rawId = String(event?.roomId ?? event?.chatId ?? event?.room?.id ?? event?.chat?.id ?? '');
    const name = await resolveName(rawId);
    const mapped = event && typeof event === 'object' ? { ...event, roomId: rawId, chatId: rawId, roomName: name } : event;
    if (mapped?.room && typeof mapped.room === 'object') mapped.room = adaptChat(mapped.room, name);
    if (mapped?.chat && typeof mapped.chat === 'object') mapped.chat = adaptChat(mapped.chat, name);

    if (action === 'join' || action === 'leave') {
      if (!isRegisteredRoom(rawId)) return;
      await automaticMemberLog(client, mapped);
    }
    return handler(mapped);
  };

  if (originalOnJoin) client.onJoin = (handler: any) => originalOnJoin(wrapEvent(handler, 'join'));
  if (originalOnLeave) client.onLeave = (handler: any) => originalOnLeave(wrapEvent(handler, 'leave'));
  if (originalOnKick) client.onKick = (handler: any) => originalOnKick(wrapEvent(handler, 'kick'));

  void refresh();
  return client;
}

export function createClient(config?: Record<string, unknown>): any {
  installProcessGuard();
  try { return wrapRoomNameRuntime(loadModule().createClient(config)); }
  catch (error) {
    console.error('[FAILSAFE][CLIENT]', error instanceof Error ? error.stack || error.message : String(error));
    throw error;
  }
}

export function ensureKakaoForgeInstalled(): void {
  installProcessGuard();
  const packageRoot = resolvePackageRoot();
  buildKakaoForge(packageRoot);
}