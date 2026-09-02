import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { saveConfig, type Config } from './config';

export type AnalyzerEventType = 'JOIN' | 'LEAVE' | 'READ' | 'KICK';
export type MemberEvent = { roomId: string; userId: string; nickname: string; event: AnalyzerEventType; at: string; count: number; messageId?: string };
export type PendingLeave = { roomId: string; userId: string; nickname: string; leftAt: string; messageId?: string };
export type SessionDiagnostic = { userId: string; sessionId?: string; observedAt: string; status: string; errorCode?: string; detail?: string };
export type MockSession = { userId: string; nickname: string; sessionId: string; createdAt: string; mode: 'MOCK'; authenticated: true };
export type KickResult = { ok: boolean; reason?: 'ADMIN_ONLY' | 'TARGET_NOT_FOUND'; action?: 'KICK_REQUEST'; roomId?: string; targetUserId?: string; targetNickname?: string };

type AnalyzerState = {
  version: 2;
  events: MemberEvent[];
  pendingLeaves: Record<string, PendingLeave>;
  reads: Record<string, Record<string, string>>;
  joinCounts: Record<string, number>;
  online: Record<string, { userId: string; nickname: string }>;
  sessionDiagnostics: SessionDiagnostic[];
};

/** TypeScript runtime equivalent of 분석기.py. */
export class RoomAnalyzer {
  readonly VALID_EVENTS = new Set<AnalyzerEventType>(['JOIN', 'LEAVE', 'READ', 'KICK']);
  private readonly dataFile: string;
  private readonly maxEvents: number;
  private readonly maxReads: number;
  private readonly maxDiagnostics: number;
  private readonly events: MemberEvent[] = [];
  private readonly pendingLeaves = new Map<string, PendingLeave>();
  private readonly reads = new Map<string, Map<string, string>>();
  private readonly joinCounts = new Map<string, number>();
  private readonly online = new Map<string, { userId: string; nickname: string }>();
  private readonly diagnostics: SessionDiagnostic[] = [];
  private readonly mockSessions = new Map<string, MockSession>();

  constructor(private readonly config: Config, options: { dataFile?: string; maxEvents?: number; maxReads?: number; maxDiagnostics?: number } = {}) {
    this.dataFile = path.resolve(options.dataFile ?? 'loco_analyzer.json');
    this.maxEvents = Math.max(1, Math.floor(options.maxEvents ?? 5000));
    this.maxReads = Math.max(1, Math.floor(options.maxReads ?? 5000));
    this.maxDiagnostics = Math.max(1, Math.floor(options.maxDiagnostics ?? 1000));
    this.load();
  }

  private now(): string { return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'); }
  private memberKey(roomId: string, userId: string): string { return `${String(roomId)}\x1f${String(userId)}`; }
  private appendEvent(event: MemberEvent): void { this.events.push(event); if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents); }
  private safeUser(user: any): { userId: string; nickname: string } {
    const userId = user?.user_id ?? user?.userId ?? user?.userID ?? user?.id ?? user?.UserId;
    const nickname = user?.nickname ?? user?.userInfo?.nickname ?? user?.UserInfo?.Nickname ?? '알 수 없음';
    return { userId: String(userId ?? nickname), nickname: String(nickname || '알 수 없음') };
  }

  private save(): void {
    const reads: Record<string, Record<string, string>> = {};
    for (const [messageId, bucket] of this.reads) reads[messageId] = Object.fromEntries(bucket);
    const payload: AnalyzerState = {
      version: 2,
      events: this.events.slice(-this.maxEvents),
      pendingLeaves: Object.fromEntries(this.pendingLeaves),
      reads: Object.fromEntries(Object.entries(reads).slice(-this.maxReads)),
      joinCounts: Object.fromEntries(this.joinCounts),
      online: Object.fromEntries(this.online),
      sessionDiagnostics: this.diagnostics.slice(-this.maxDiagnostics),
    };
    const tmp = `${this.dataFile}.${process.pid}.tmp`;
    try { fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 }); fs.renameSync(tmp, this.dataFile); }
    catch (error) { try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ } console.error('[Analyzer] save failed:', error instanceof Error ? error.message : error); }
  }

  private load(): void {
    if (!fs.existsSync(this.dataFile)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.dataFile, 'utf8')) as Partial<AnalyzerState>;
      if (Array.isArray(raw.events)) for (const x of raw.events as any[]) {
        const event = x.event;
        if (!this.VALID_EVENTS.has(event)) continue;
        this.events.push({ roomId: String(x.roomId ?? x.room_id ?? ''), userId: String(x.userId ?? x.user_id ?? ''), nickname: String(x.nickname ?? '알 수 없음'), event, at: String(x.at ?? this.now()), count: Number.isFinite(Number(x.count)) ? Math.max(0, Math.floor(Number(x.count))) : 0, ...(x.messageId != null || x.message_id != null ? { messageId: String(x.messageId ?? x.message_id) } : {}) });
      }
      if (raw.pendingLeaves && typeof raw.pendingLeaves === 'object') for (const [key, value] of Object.entries(raw.pendingLeaves)) {
        const x: any = value; if (!x) continue;
        this.pendingLeaves.set(key, { roomId: String(x.roomId ?? x.room_id ?? ''), userId: String(x.userId ?? x.user_id ?? ''), nickname: String(x.nickname ?? '알 수 없음'), leftAt: String(x.leftAt ?? x.left_at ?? this.now()), ...(x.messageId != null || x.message_id != null ? { messageId: String(x.messageId ?? x.message_id) } : {}) });
      }
      if (raw.reads && typeof raw.reads === 'object') for (const [messageId, value] of Object.entries(raw.reads)) {
        if (value && typeof value === 'object') this.reads.set(String(messageId), new Map(Object.entries(value).map(([id, name]) => [String(id), String(name)])));
      }
      if (raw.joinCounts && typeof raw.joinCounts === 'object') for (const [key, value] of Object.entries(raw.joinCounts)) this.joinCounts.set(String(key), Number(value) || 0);
      if (raw.online && typeof raw.online === 'object') for (const [key, value] of Object.entries(raw.online)) {
        const x: any = value; if (x && typeof x === 'object') this.online.set(key, { userId: String(x.userId ?? x.user_id ?? ''), nickname: String(x.nickname ?? '알 수 없음') });
      }
      if (Array.isArray(raw.sessionDiagnostics)) for (const x of raw.sessionDiagnostics as any[]) this.diagnostics.push({ userId: String(x.userId ?? x.user_id ?? ''), ...(x.sessionId != null || x.session_id != null ? { sessionId: String(x.sessionId ?? x.session_id) } : {}), observedAt: String(x.observedAt ?? x.observed_at ?? this.now()), status: String(x.status ?? 'UNKNOWN'), ...(x.errorCode != null || x.error_code != null ? { errorCode: String(x.errorCode ?? x.error_code) } : {}), ...(x.detail != null ? { detail: String(x.detail) } : {}) });
      this.events.splice(0, Math.max(0, this.events.length - this.maxEvents));
      while (this.reads.size > this.maxReads) this.reads.delete(this.reads.keys().next().value as string);
      this.diagnostics.splice(0, Math.max(0, this.diagnostics.length - this.maxDiagnostics));
    } catch (error) {
      console.error('[Analyzer] state load failed; starting clean:', error instanceof Error ? error.message : error);
      this.events.length = 0; this.pendingLeaves.clear(); this.reads.clear(); this.joinCounts.clear(); this.online.clear(); this.diagnostics.length = 0;
    }
  }

  mockLogin(userId: string, nickname: string, roomId = 'local', forceSuccess = true): MockSession {
    const id = String(userId).trim(), name = String(nickname).trim() || '알 수 없음', room = String(roomId).trim() || 'local';
    if (!id) throw new Error('userId must not be empty');
    const createdAt = this.now();
    const session: MockSession = { userId: id, nickname: name, sessionId: `mock_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`, createdAt, mode: 'MOCK', authenticated: true };
    this.mockSessions.set(session.sessionId, session);
    const key = this.memberKey(room, id), count = (this.joinCounts.get(key) ?? 0) + 1;
    this.joinCounts.set(key, count); this.online.set(key, { userId: id, nickname: name }); this.pendingLeaves.delete(key);
    this.appendEvent({ roomId: room, userId: id, nickname: name, event: 'JOIN', at: createdAt, count });
    if (forceSuccess) this.recordSessionDiagnostic(id, session.sessionId, 'RESOLVED_999', '-999', 'Local MOCK mode: -999 is recorded as a diagnostic only.');
    this.save(); return session;
  }

  mockLogout(sessionId: string): boolean {
    const session = this.mockSessions.get(String(sessionId)); if (!session) return false;
    this.mockSessions.delete(String(sessionId));
    for (const [key, member] of this.online) if (member.userId === session.userId) this.online.delete(key);
    this.save(); return true;
  }
  mockSessionsList(): MockSession[] { return [...this.mockSessions.values()]; }

  userJoined(roomId: string, user: any, messageId?: string): number {
    const room = String(roomId), { userId, nickname } = this.safeUser(user), key = this.memberKey(room, userId), count = (this.joinCounts.get(key) ?? 0) + 1;
    this.joinCounts.set(key, count); this.online.set(key, { userId, nickname }); this.pendingLeaves.delete(key);
    this.appendEvent({ roomId: room, userId, nickname, event: 'JOIN', at: this.now(), count, ...(messageId ? { messageId: String(messageId) } : {}) }); this.save(); return count;
  }

  userLeft(roomId: string, user: any, messageId?: string): PendingLeave {
    const room = String(roomId), { userId, nickname } = this.safeUser(user), leftAt = this.now(), key = this.memberKey(room, userId);
    const record: PendingLeave = { roomId: room, userId, nickname, leftAt, ...(messageId ? { messageId: String(messageId) } : {}) };
    this.pendingLeaves.set(key, record); this.online.delete(key);
    this.appendEvent({ roomId: room, userId, nickname, event: 'LEAVE', at: leftAt, count: 0, ...(messageId ? { messageId: String(messageId) } : {}) }); this.save(); return record;
  }

  setLeaveMessageId(roomId: string, userId: string, messageId: string): boolean {
    const record = this.pendingLeaves.get(this.memberKey(String(roomId), String(userId))); if (!record) return false;
    record.messageId = String(messageId); this.save(); return true;
  }

  recordRead(messageId: string, user: any): void {
    const { userId, nickname } = this.safeUser(user), id = String(messageId), bucket = this.reads.get(id) ?? new Map<string, string>();
    bucket.set(userId, nickname); this.reads.set(id, bucket); while (this.reads.size > this.maxReads) this.reads.delete(this.reads.keys().next().value as string); this.save();
  }

  recordSessionDiagnostic(userId: string, sessionId: string | undefined, status: string, errorCode?: string, detail?: string): void {
    this.diagnostics.push({ userId: String(userId), ...(sessionId ? { sessionId: String(sessionId) } : {}), observedAt: this.now(), status: String(status), ...(errorCode ? { errorCode: String(errorCode) } : {}), ...(detail ? { detail: String(detail) } : {}) });
    if (this.diagnostics.length > this.maxDiagnostics) this.diagnostics.splice(0, this.diagnostics.length - this.maxDiagnostics); this.save();
  }

  diagnose999(userId: string) {
    const matches = this.diagnostics.filter(x => x.userId === String(userId)), last = matches.at(-1);
    return { userId: String(userId), observations: matches.length, lastStatus: last?.status ?? null, lastErrorCode: last?.errorCode ?? null, lastSessionId: last?.sessionId ?? null, recommendation: 'Compare the real authentication response and session lifecycle. This analyzer cannot repair a server-side session or bypass authentication.' };
  }

  getLeaveDetail(userId: string, roomId?: string): PendingLeave | undefined {
    if (roomId != null) return this.pendingLeaves.get(this.memberKey(String(roomId), String(userId)));
    for (const leave of [...this.pendingLeaves.values()].reverse()) if (leave.userId === String(userId)) return leave;
    return undefined;
  }
  findLeave(roomId: string, userId: string): PendingLeave | undefined { return this.pendingLeaves.get(this.memberKey(String(roomId), String(userId))); }
  findLeaveByMessage(roomId: string, messageId: string): PendingLeave | undefined { for (const x of this.pendingLeaves.values()) if (x.roomId === String(roomId) && x.messageId === String(messageId)) return x; return undefined; }
  isAdmin(userId: string): boolean { return this.config.admins.some(id => String(id) === String(userId)); }
  validateKick(actorUserId: string, roomId: string, targetUserId: string): KickResult {
    if (!this.isAdmin(actorUserId)) return { ok: false, reason: 'ADMIN_ONLY' };
    const target = this.findLeave(roomId, targetUserId); if (!target) return { ok: false, reason: 'TARGET_NOT_FOUND' };
    return { ok: true, action: 'KICK_REQUEST', roomId: target.roomId, targetUserId: target.userId, targetNickname: target.nickname };
  }
  logCommand(room: string, actorKey: string, actorName: string, command: string, result: string): void {
    this.config.commandLogs.push({ at: this.now(), room: String(room), userKey: String(actorKey), userName: String(actorName), command: String(command), result: String(result) });
    if (this.config.commandLogs.length > 5000) this.config.commandLogs.splice(0, this.config.commandLogs.length - 5000); saveConfig(this.config);
  }
  getOnline(roomId: string): Array<{ userId: string; nickname: string }> { const prefix = `${String(roomId)}\x1f`; return [...this.online.entries()].filter(([key]) => key.startsWith(prefix)).map(([, value]) => ({ ...value })); }
  roomEvents(roomId: string, limit = 100): MemberEvent[] { return this.events.filter(x => x.roomId === String(roomId)).slice(-Math.max(0, Math.floor(limit))); }
  stats(roomId?: string) { const events = roomId == null ? this.events : this.events.filter(x => x.roomId === String(roomId)); return { events: events.length, joins: events.filter(x => x.event === 'JOIN').length, leaves: events.filter(x => x.event === 'LEAVE').length, reads: this.reads.size, online: roomId == null ? this.online.size : this.getOnline(roomId).length, diagnostics: this.diagnostics.length }; }
  leaveText(record: PendingLeave): string {
    let time = record.leftAt; try { time = new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(record.leftAt)); } catch { /* keep */ }
    return [`${record.nickname}님이 나가셨습니다.`, '', '[전체보기]', '', `${record.nickname} 님이 ${time}에 나가셨습니다.`, '나간 사람을 내보내실려면 이 메시지에 답장으로 kick이라고 보내주세요.', '[관리자만 가능합니다]'].join('\n');
  }
}
