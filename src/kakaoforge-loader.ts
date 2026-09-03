import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const KAKAO_FORGE_REPO = 'https://github.com/minjaemin2020/KakaoForge.git';
const KAKAO_FORGE_COMMIT = '4b774ea40b1347280fadb685415436584093118b';

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

function roomItems(result: any): RoomRef[] {
  const raw = Array.isArray(result?.chats) ? result.chats : Array.isArray(result) ? result : [];
  return raw.map((item: any) => ({
    id: String(item?.id ?? item?.chatId ?? item?.roomId ?? item?.c ?? ''),
    name: String(item?.name ?? item?.roomName ?? item?.title ?? ''),
  })).filter((item: RoomRef) => item.id && item.name);
}

/** The application uses room_name as its canonical room reference. */
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
        if (prop === 'id' || prop === 'chatId') return forcedName || byId.get(String(target.id ?? target.chatId ?? '')) || target[prop as keyof typeof target];
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
    const rawId = String(msg?.room?.id ?? msg?.chatId ?? chat?.id ?? chat?.chatId ?? '');
    const name = await resolveName(rawId);
    const mappedChat = adaptChat(chat, name);
    const mappedMsg = msg && typeof msg === 'object' ? { ...msg, chatId: name } : msg;
    if (mappedMsg && mappedMsg.room && typeof mappedMsg.room === 'object') mappedMsg.room = adaptChat(mappedMsg.room, name);
    else if (mappedMsg && name) mappedMsg.room = { id: name, name };
    return { chat: mappedChat, msg: mappedMsg };
  };

  const originalOnMessage = typeof client.onMessage === 'function' ? client.onMessage.bind(client) : null;
  const originalOnJoin = typeof client.onJoin === 'function' ? client.onJoin.bind(client) : null;
  const originalOnLeave = typeof client.onLeave === 'function' ? client.onLeave.bind(client) : null;
  const originalOnKick = typeof client.onKick === 'function' ? client.onKick.bind(client) : null;

  if (originalOnMessage) {
    client.onMessage = (handler: any) => originalOnMessage(async (chat: any, msg: any) => {
      const mapped = await adaptMessage(msg, chat);
      return handler(mapped.chat, mapped.msg);
    });
  }
  const wrapEvent = (handler: any) => async (event: any) => {
    const rawId = String(event?.roomId ?? event?.chatId ?? event?.room?.id ?? event?.chat?.id ?? '');
    const name = await resolveName(rawId);
    const mapped = event && typeof event === 'object' ? { ...event, roomId: name, roomName: name } : event;
    if (mapped?.room && typeof mapped.room === 'object') mapped.room = adaptChat(mapped.room, name);
    if (mapped?.chat && typeof mapped.chat === 'object') mapped.chat = adaptChat(mapped.chat, name);
    return handler(mapped);
  };
  if (originalOnJoin) client.onJoin = (handler: any) => originalOnJoin(wrapEvent(handler));
  if (originalOnLeave) client.onLeave = (handler: any) => originalOnLeave(wrapEvent(handler));
  if (originalOnKick) client.onKick = (handler: any) => originalOnKick(wrapEvent(handler));

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
