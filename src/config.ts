import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export type Account = { email: string; deviceUuid: string };
export type KakaoOAuthConfig = { clientId: string; clientSecret: string; redirectUri: string };
export type RoomConfig = { name: string; enabled: boolean };
export type ChatStat = { room: string; userKey: string; userName: string; count: number; firstSeenAt: string; lastSeenAt: string };
export type MemberEvent = { room: string; userKey: string; userName: string; type: 'JOIN' | 'LEAVE'; at: string; count: number };
export type CommandLog = { at: string; room: string; userKey: string; userName: string; command: string; result: string };
export type WebhookConfig = { enabled: boolean; url: string; username: string };
export type Config = {
  prefix: string; rooms: string[]; accounts: Account[]; activeAccount: string | null; kakao: KakaoOAuthConfig;
  roomConfigs: Record<string, RoomConfig>; admins: string[]; moderators: string[]; logLevel: 'info' | 'debug';
  chatStats: ChatStat[]; memberEvents: MemberEvent[]; commandLogs: CommandLog[]; webhook: WebhookConfig;
};
const DATA_DIR = path.join(os.homedir(), '.loco-termux');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const DEFAULT_REDIRECT_URI = 'http://127.0.0.1:8765/callback';
const MAX_STATS = 5000, MAX_EVENTS = 5000, MAX_COMMAND_LOGS = 5000;
export function ensureDataDir(): void { fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 }); try { fs.chmodSync(DATA_DIR, 0o700); } catch {} }
function stringList(value: unknown): string[] { if (!Array.isArray(value)) return []; return [...new Set(value.filter((v): v is string => typeof v === 'string').map(v => v.trim()).filter(Boolean))]; }
function safeIso(value: unknown): string { if (typeof value !== 'string') return new Date().toISOString(); const date = new Date(value); return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString(); }
function normalizeStats(value: unknown): ChatStat[] { if (!Array.isArray(value)) return []; return value.filter(Boolean).map((x: any) => ({ room: String(x.room ?? '').trim(), userKey: String(x.userKey ?? '').trim(), userName: String(x.userName ?? '알 수 없음'), count: Number.isFinite(Number(x.count)) ? Math.max(0, Math.floor(Number(x.count))) : 0, firstSeenAt: safeIso(x.firstSeenAt), lastSeenAt: safeIso(x.lastSeenAt) })).filter(x => x.room && x.userKey).slice(-MAX_STATS); }
function normalizeEvents(value: unknown): MemberEvent[] { if (!Array.isArray(value)) return []; return value.filter(Boolean).map((x: any): MemberEvent => ({ room: String(x.room ?? '').trim(), userKey: String(x.userKey ?? '').trim(), userName: String(x.userName ?? '알 수 없음'), type: x.type === 'JOIN' ? 'JOIN' : 'LEAVE', at: safeIso(x.at), count: Number.isFinite(Number(x.count)) ? Math.max(0, Math.floor(Number(x.count))) : 0 })).filter(x => x.room && x.userKey).slice(-MAX_EVENTS); }
function normalizeCommandLogs(value: unknown): CommandLog[] { if (!Array.isArray(value)) return []; return value.filter(Boolean).map((x: any) => ({ at: safeIso(x.at), room: String(x.room ?? '').trim(), userKey: String(x.userKey ?? '').trim(), userName: String(x.userName ?? '알 수 없음'), command: String(x.command ?? '').trim(), result: String(x.result ?? '').trim() })).filter(x => x.room && x.command).slice(-MAX_COMMAND_LOGS); }
export function loadConfig(): Config {
  ensureDataDir(); const defaults: Config = { prefix: '!', rooms: [], accounts: [], activeAccount: null, kakao: { clientId: '', clientSecret: '', redirectUri: DEFAULT_REDIRECT_URI }, roomConfigs: {}, admins: [], moderators: [], logLevel: 'info', chatStats: [], memberEvents: [], commandLogs: [], webhook: { enabled: false, url: '', username: 'LOCO-Termux Logger' } };
  if (!fs.existsSync(CONFIG_FILE)) return defaults;
  try { const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) as any; const accounts: Account[] = Array.isArray(parsed.accounts) ? parsed.accounts.filter((a: any) => a && typeof a.email === 'string').map((a: any) => ({ email: a.email.trim(), deviceUuid: typeof a.deviceUuid === 'string' && a.deviceUuid.trim() ? a.deviceUuid.trim() : crypto.randomUUID() })).filter((a: Account) => a.email) : [];
    const rooms = stringList(parsed.rooms); const rawRoomConfigs = parsed.roomConfigs && typeof parsed.roomConfigs === 'object' ? parsed.roomConfigs : {}; const roomConfigs: Record<string, RoomConfig> = {}; for (const room of rooms) roomConfigs[room] = { name: room, enabled: rawRoomConfigs[room]?.enabled !== false };
    const rawKakao = parsed.kakao && typeof parsed.kakao === 'object' ? parsed.kakao : {}; const rawWebhook = parsed.webhook && typeof parsed.webhook === 'object' ? parsed.webhook : {};
    return { ...defaults, prefix: typeof parsed.prefix === 'string' && parsed.prefix.trim() ? parsed.prefix.trim().slice(0, 8) : defaults.prefix, rooms, accounts, activeAccount: typeof parsed.activeAccount === 'string' && accounts.some((a: Account) => a.email === parsed.activeAccount) ? parsed.activeAccount : accounts[0]?.email ?? null, kakao: { clientId: typeof rawKakao.clientId === 'string' ? rawKakao.clientId.trim() : '', clientSecret: typeof rawKakao.clientSecret === 'string' ? rawKakao.clientSecret.trim() : '', redirectUri: typeof rawKakao.redirectUri === 'string' && rawKakao.redirectUri.trim() ? rawKakao.redirectUri.trim() : DEFAULT_REDIRECT_URI }, roomConfigs, admins: stringList(parsed.admins), moderators: stringList(parsed.moderators), logLevel: parsed.logLevel === 'debug' ? 'debug' : 'info', chatStats: normalizeStats(parsed.chatStats), memberEvents: normalizeEvents(parsed.memberEvents), commandLogs: normalizeCommandLogs(parsed.commandLogs), webhook: { enabled: rawWebhook.enabled === true, url: typeof rawWebhook.url === 'string' ? rawWebhook.url.trim() : '', username: typeof rawWebhook.username === 'string' && rawWebhook.username.trim() ? rawWebhook.username.trim().slice(0, 80) : defaults.webhook.username } };
  } catch (error) { console.error('[CONFIG] config.json 읽기 실패. 기본 설정으로 시작합니다:', error instanceof Error ? error.message : error); return defaults; }
}
export function saveConfig(config: Config): void { ensureDataDir(); const tmp = `${CONFIG_FILE}.${process.pid}.tmp`; const safe: Config = { ...config, rooms: stringList(config.rooms), admins: stringList(config.admins), moderators: stringList(config.moderators), chatStats: config.chatStats.slice(-MAX_STATS), memberEvents: config.memberEvents.slice(-MAX_EVENTS), commandLogs: config.commandLogs.slice(-MAX_COMMAND_LOGS), kakao: { clientId: String(config.kakao.clientId ?? '').trim(), clientSecret: String(config.kakao.clientSecret ?? '').trim(), redirectUri: String(config.kakao.redirectUri ?? DEFAULT_REDIRECT_URI).trim() || DEFAULT_REDIRECT_URI }, webhook: { enabled: config.webhook.enabled === true, url: String(config.webhook.url ?? '').trim(), username: String(config.webhook.username ?? 'LOCO-Termux Logger').slice(0, 80) } }; fs.writeFileSync(tmp, JSON.stringify(safe, null, 2), { encoding: 'utf8', mode: 0o600 }); try { fs.chmodSync(tmp, 0o600); } catch {} fs.renameSync(tmp, CONFIG_FILE); try { fs.chmodSync(CONFIG_FILE, 0o600); } catch {} }
export function parseRoomList(input: string): string[] { return stringList(input.split(',')); }
export function roomListToString(rooms: string[]): string { return `,${rooms.join(',')},`; }
