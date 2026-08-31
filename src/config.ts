import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export type Account = {
  name: string;
  email: string;
  password: string;
  deviceUuid: string;
};

export type RoomConfig = { name: string; enabled: boolean };

export type Config = {
  prefix: string;
  rooms: string[];
  accounts: Account[];
  activeAccount: string | null;
  roomConfigs: Record<string, RoomConfig>;
  admins: string[];
  moderators: string[];
  logLevel: 'info' | 'debug';
};

const DATA_DIR = path.join(os.homedir(), '.loco-termux');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

export function ensureDataDir(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
}

export function loadConfig(): Config {
  ensureDataDir();
  const defaults: Config = { prefix: '!', rooms: [], accounts: [], activeAccount: null, roomConfigs: {}, admins: [], moderators: [], logLevel: 'info' };
  if (!fs.existsSync(CONFIG_FILE)) return defaults;
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) as Partial<Config>;
    return {
      ...defaults, ...parsed,
      rooms: Array.isArray(parsed.rooms) ? [...new Set(parsed.rooms.filter(Boolean))] : [],
      accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
      roomConfigs: parsed.roomConfigs && typeof parsed.roomConfigs === 'object' ? parsed.roomConfigs : {},
      admins: Array.isArray(parsed.admins) ? parsed.admins.filter(Boolean) : [],
      moderators: Array.isArray(parsed.moderators) ? parsed.moderators.filter(Boolean) : [],
    };
  } catch { return defaults; }
}

export function saveConfig(config: Config): void {
  ensureDataDir();
  const tmp = `${CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_FILE);
  try { fs.chmodSync(CONFIG_FILE, 0o600); } catch { /* Termux */ }
}

export function parseRoomList(input: string): string[] {
  return [...new Set(input.split(',').map(v => v.trim()).filter(Boolean))];
}

export function roomListToString(rooms: string[]): string { return `,${rooms.join(',')},`; }
