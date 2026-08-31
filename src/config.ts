import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export type Account = { email: string; password: string; deviceUuid: string };
export type RoomConfig = { name: string; enabled: boolean };
export type ChatStat = { room: string; userKey: string; userName: string; count: number; firstSeenAt: string; lastSeenAt: string };
export type MemberEvent = { room: string; userKey: string; userName: string; type: 'JOIN' | 'LEAVE'; at: string; count: number };
export type CommandLog = { at: string; room: string; userKey: string; userName: string; command: string; result: string };
export type Config = {
  prefix: string; rooms: string[]; accounts: Account[]; activeAccount: string | null;
  roomConfigs: Record<string, RoomConfig>; admins: string[]; moderators: string[];
  logLevel: 'info' | 'debug'; chatStats: ChatStat[]; memberEvents: MemberEvent[]; commandLogs: CommandLog[];
};

const DATA_DIR = path.join(os.homedir(), '.loco-termux');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

export function ensureDataDir(): void { fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 }); }

export function loadConfig(): Config {
  ensureDataDir();
  const defaults: Config = { prefix: '!', rooms: [], accounts: [], activeAccount: null, roomConfigs: {}, admins: [], moderators: [], logLevel: 'info', chatStats: [], memberEvents: [], commandLogs: [] };
  if (!fs.existsSync(CONFIG_FILE)) return defaults;
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) as Partial<Config> & { accounts?: Array<Account & { name?: string }> };
    const accounts: Account[] = Array.isArray(parsed.accounts) ? parsed.accounts.filter(a => a && typeof a.email === 'string' && typeof a.password === 'string').map(a => ({ email: a.email.trim(), password: a.password, deviceUuid: typeof a.deviceUuid === 'string' && a.deviceUuid ? a.deviceUuid : crypto.randomUUID() })) : [];
    return {
      ...defaults, ...parsed,
      rooms: Array.isArray(parsed.rooms) ? [...new Set(parsed.rooms.filter(Boolean))] : [],
      accounts, activeAccount: typeof parsed.activeAccount === 'string' ? parsed.activeAccount : accounts[0]?.email ?? null,
      roomConfigs: parsed.roomConfigs && typeof parsed.roomConfigs === 'object' ? parsed.roomConfigs : {},
      admins: Array.isArray(parsed.admins) ? parsed.admins.filter(Boolean) : [], moderators: Array.isArray(parsed.moderators) ? parsed.moderators.filter(Boolean) : [],
      chatStats: Array.isArray(parsed.chatStats) ? parsed.chatStats : [], memberEvents: Array.isArray(parsed.memberEvents) ? parsed.memberEvents : [], commandLogs: Array.isArray(parsed.commandLogs) ? parsed.commandLogs : [],
    };
  } catch { return defaults; }
}

export function saveConfig(config: Config): void {
  ensureDataDir(); const tmp = `${CONFIG_FILE}.tmp`; fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 }); fs.renameSync(tmp, CONFIG_FILE); try { fs.chmodSync(CONFIG_FILE, 0o600); } catch { /* Termux */ }
}
export function parseRoomList(input: string): string[] { return [...new Set(input.split(',').map(v => v.trim()).filter(Boolean))]; }
export function roomListToString(rooms: string[]): string { return `,${rooms.join(',')},`; }
