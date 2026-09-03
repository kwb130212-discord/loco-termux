import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const CONFIG_DIR = path.join(process.env.HOME || process.cwd(), '.loco-termux');
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
export const AUTH_FILE = path.join(CONFIG_DIR, 'kakaoforge-auth.json');
export const DEFAULT_REDIRECT_URI = 'https://dino-web-2trw.onrender.com/dashboard/callback';

export interface Account {
  email: string;
  deviceUuid: string;
}

export interface RoomConfig {
  name: string;
  enabled: boolean;
}

export interface Config {
  prefix: string;
  accounts: Account[];
  rooms: string[];
  roomConfigs: Record<string, RoomConfig>;
  admins: string[];
  moderators: string[];
  logLevel: string;
  chatStats: unknown[];
  memberEvents: unknown[];
  commandLogs: unknown[];
  webhook: { enabled: boolean; url: string; username: string };
  kakao: { clientId: string; clientSecret: string; redirectUri: string };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string').map(v => v.trim()).filter(Boolean) : [];
}

export function loadConfig(): Config {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const defaults: Config = {
    prefix: '!', accounts: [], rooms: [],
    kakao: { clientId: '', clientSecret: '', redirectUri: DEFAULT_REDIRECT_URI },
    roomConfigs: {}, admins: [], moderators: [], logLevel: 'info',
    chatStats: [], memberEvents: [], commandLogs: [], webhook: { enabled: false, url: '', username: 'LOCO-Termux Logger' },
  };
  if (!fs.existsSync(CONFIG_FILE)) return defaults;
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) as any;
    const accounts: Account[] = Array.isArray(parsed.accounts)
      ? parsed.accounts.filter((a: any) => a && typeof a.email === 'string').map((a: any) => ({
          email: a.email.trim(),
          deviceUuid: typeof a.deviceUuid === 'string' && a.deviceUuid.trim() ? a.deviceUuid.trim() : crypto.randomUUID(),
        })).filter((a: Account) => a.email) : [];
    const rooms = stringList(parsed.rooms);
    const rawRoomConfigs = parsed.roomConfigs && typeof parsed.roomConfigs === 'object' ? parsed.roomConfigs : {};
    const roomConfigs: Record<string, RoomConfig> = {};
    for (const room of rooms) roomConfigs[room] = { name: room, enabled: rawRoomConfigs[room]?.enabled !== false };
    const rawKakao = parsed.kakao && typeof parsed.kakao === 'object' ? parsed.kakao : {};
    const rawWebhook = parsed.webhook && typeof parsed.webhook === 'object' ? parsed.webhook : {};
    return {
      ...defaults,
      prefix: typeof parsed.prefix === 'string' && parsed.prefix.trim() ? parsed.prefix.trim().slice(0, 8) : defaults.prefix,
      accounts,
      rooms,
      roomConfigs,
      admins: stringList(parsed.admins),
      moderators: stringList(parsed.moderators),
      logLevel: typeof parsed.logLevel === 'string' ? parsed.logLevel : defaults.logLevel,
      chatStats: Array.isArray(parsed.chatStats) ? parsed.chatStats : [],
      memberEvents: Array.isArray(parsed.memberEvents) ? parsed.memberEvents : [],
      commandLogs: Array.isArray(parsed.commandLogs) ? parsed.commandLogs : [],
      kakao: {
        clientId: typeof rawKakao.clientId === 'string' ? rawKakao.clientId : '',
        clientSecret: typeof rawKakao.clientSecret === 'string' ? rawKakao.clientSecret : '',
        redirectUri: typeof rawKakao.redirectUri === 'string' && rawKakao.redirectUri ? rawKakao.redirectUri : DEFAULT_REDIRECT_URI,
      },
      webhook: {
        enabled: rawWebhook.enabled === true,
        url: typeof rawWebhook.url === 'string' ? rawWebhook.url : '',
        username: typeof rawWebhook.username === 'string' && rawWebhook.username ? rawWebhook.username : defaults.webhook.username,
      },
    };
  } catch {
    return defaults;
  }
}

export function saveConfig(config: Config): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
}
