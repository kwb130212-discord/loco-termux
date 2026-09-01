import { saveConfig, type Config } from './config';

export type LeaveRecord = {
  room: string;
  userKey: string;
  userName: string;
  at: string;
  messageId?: string;
};

export type SessionDiagnostic = {
  userKey: string;
  sessionId?: string;
  at: string;
  status: string;
  errorCode?: string;
  detail?: string;
};

export type KickResult = {
  ok: boolean;
  reason?: string;
  action?: 'KICK_REQUEST';
  room?: string;
  targetUserKey?: string;
  targetUserName?: string;
};

/** Protocol-agnostic room state and diagnostics layer. */
export class RoomAnalyzer {
  private readonly maxEvents = 5000;
  private readonly maxLeaves = 500;
  private readonly maxDiagnostics = 1000;
  private readonly leaves = new Map<string, LeaveRecord>();
  private readonly online = new Map<string, { userKey: string; userName: string }>();
  private readonly joinCounts = new Map<string, number>();
  private readonly diagnostics: SessionDiagnostic[] = [];

  constructor(private readonly config: Config) {}

  private key(room: string, userKey: string): string { return `${String(room)}\x1f${String(userKey)}`; }

  private trimEvents(): void {
    if (this.config.memberEvents.length > this.maxEvents) {
      this.config.memberEvents.splice(0, this.config.memberEvents.length - this.maxEvents);
    }
  }

  recordJoin(room: string, userKey: string, userName: string): number {
    const r = String(room), k = String(userKey), n = String(userName), key = this.key(r, k);
    const count = (this.joinCounts.get(key) ?? 0) + 1;
    this.joinCounts.set(key, count);
    this.online.set(key, { userKey: k, userName: n });
    this.leaves.delete(key);
    this.config.memberEvents.push({ room: r, userKey: k, userName: n, type: 'JOIN', at: new Date().toISOString(), count });
    this.trimEvents();
    saveConfig(this.config);
    return count;
  }

  recordLeave(room: string, userKey: string, userName: string, messageId?: string): LeaveRecord {
    const record: LeaveRecord = {
      room: String(room), userKey: String(userKey), userName: String(userName), at: new Date().toISOString(),
      ...(messageId ? { messageId: String(messageId) } : {}),
    };
    const key = this.key(record.room, record.userKey);
    this.leaves.set(key, record);
    this.online.delete(key);
    this.config.memberEvents.push({ room: record.room, userKey: record.userKey, userName: record.userName, type: 'LEAVE', at: record.at, count: 0 });
    this.trimEvents();
    while (this.leaves.size > this.maxLeaves) {
      const oldest = this.leaves.keys().next().value as string | undefined;
      if (!oldest) break;
      this.leaves.delete(oldest);
    }
    saveConfig(this.config);
    return record;
  }

  setLeaveMessageId(room: string, userKey: string, messageId: string): boolean {
    const key = this.key(room, userKey), record = this.leaves.get(key);
    if (!record) return false;
    record.messageId = String(messageId);
    saveConfig(this.config);
    return true;
  }

  findLeave(room: string, userKey: string): LeaveRecord | undefined { return this.leaves.get(this.key(room, userKey)); }

  findLeaveByMessage(room: string, messageId: string): LeaveRecord | undefined {
    for (const record of this.leaves.values()) {
      if (record.room === String(room) && record.messageId === String(messageId)) return record;
    }
    return undefined;
  }

  isAdmin(userKey: string): boolean { return this.config.admins.some(id => String(id) === String(userKey)); }

  validateKick(actorKey: string, room: string, targetKey: string): KickResult {
    if (!this.isAdmin(actorKey)) return { ok: false, reason: 'ADMIN_ONLY' };
    const target = this.findLeave(room, targetKey);
    if (!target) return { ok: false, reason: 'TARGET_NOT_FOUND' };
    return { ok: true, action: 'KICK_REQUEST', room: target.room, targetUserKey: target.userKey, targetUserName: target.userName };
  }

  recordSessionDiagnostic(userKey: string, status: string, sessionId?: string, errorCode?: string, detail?: string): void {
    this.diagnostics.push({
      userKey: String(userKey), sessionId: sessionId ? String(sessionId) : undefined, at: new Date().toISOString(),
      status: String(status), errorCode: errorCode ? String(errorCode) : undefined, detail: detail ? String(detail) : undefined,
    });
    if (this.diagnostics.length > this.maxDiagnostics) this.diagnostics.splice(0, this.diagnostics.length - this.maxDiagnostics);
  }

  diagnose999(userKey: string): { userKey: string; observations: number; last?: SessionDiagnostic; recommendation: string } {
    const matches = this.diagnostics.filter(x => x.userKey === String(userKey));
    return {
      userKey: String(userKey), observations: matches.length, last: matches.at(-1),
      recommendation: 'Compare the real authentication response and session lifecycle. Local analyzer state cannot repair a server-side session or bypass authentication.',
    };
  }

  getOnline(room: string): Array<{ userKey: string; userName: string }> {
    const prefix = `${String(room)}\x1f`;
    return [...this.online.entries()].filter(([key]) => key.startsWith(prefix)).map(([, value]) => ({ ...value }));
  }

  logCommand(room: string, actorKey: string, actorName: string, command: string, result: string): void {
    this.config.commandLogs.push({ at: new Date().toISOString(), room: String(room), userKey: String(actorKey), userName: String(actorName), command: String(command), result: String(result) });
    if (this.config.commandLogs.length > 5000) this.config.commandLogs.splice(0, this.config.commandLogs.length - 5000);
    saveConfig(this.config);
  }

  leaveText(record: LeaveRecord): string {
    const time = new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(record.at));
    return [`${record.userName}님이 나가셨습니다.`, '', '[전체보기]', '', `${record.userName} 님이 ${time}에 나가셨습니다.`, '나간 사람을 내보내실려면 이 메시지에 답장으로 kick이라고 보내주세요.', '[관리자만 가능합니다]'].join('\n');
  }
}
