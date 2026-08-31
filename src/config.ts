import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export type Account = {
  name: string;
  email: string;
  password: string;
  deviceUuid: string;
};

export type Config = {
  prefix: string;
  rooms: string[];
  accounts: Account[];
  activeAccount: string | null;
};

const DATA_DIR = path.join(os.homedir(), '.loco-termux');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

export function ensureDataDir(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
}

export function loadConfig(): Config {
  ensureDataDir();
  if (!fs.existsSync(CONFIG_FILE)) {
    return { prefix: '!', rooms: [], accounts: [], activeAccount: null };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) as Partial<Config>;
    return {
      prefix: parsed.prefix || '!',
      rooms: Array.isArray(parsed.rooms) ? parsed.rooms.filter(Boolean) : [],
      accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
      activeAccount: parsed.activeAccount || null,
    };
  } catch {
    return { prefix: '!', rooms: [], accounts: [], activeAccount: null };
  }
}

export function saveConfig(config: Config): void {
  ensureDataDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
  try { fs.chmodSync(CONFIG_FILE, 0o600); } catch { /* Android/Termux may reject chmod */ }
}

export function parseRoomList(input: string): string[] {
  return input.split(',').map(v => v.trim()).filter(Boolean);
}

export function roomListToString(rooms: string[]): string {
  return `,${rooms.join(',')},`;
}
