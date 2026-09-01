import { saveConfig, type Config } from './config';

export type LeaveRecord = {
  room: string;
  userKey: string;
  userName: string;
  at: string;
  messageId?: string;
};

export type KickResult = {
  ok: boolean;
  reason?: string;
  room?: string;
  targetUserKey?: string;
  targetUserName?: string;
};

export class RoomAnalyzer {
  private readonly maxLeaves = 500;
  private readonly leaves = new Map<string, LeaveRecord>();

  constructor(private readonly config: Config) {}

  recordLeave(room: string, userKey: string, userName: string, messageId?: string): LeaveRecord {
    const record: LeaveRecord = {
      room,
      userKey,
      userName,
      at: new Date().toISOString(),
      ...(messageId ? { messageId } : {}),
    };
    this.leaves.set(`${room}:${userKey}`, record);
    while (this.leaves.size > this.maxLeaves) {
      const oldest = this.leaves.keys().next().value;
      if (oldest) this.leaves.delete(oldest);
      else break;
    }
    return record;
  }

  findLeave(room: string, userKey: string): LeaveRecord | undefined {
    return this.leaves.get(`${room}:${userKey}`);
  }

  findLeaveByMessage(room: string, messageId: string): LeaveRecord | undefined {
    for (const record of this.leaves.values()) {
      if (record.room === room && record.messageId === messageId) return record;
    }
    return undefined;
  }

  isAdmin(userKey: string): boolean {
    return this.config.admins.some(id => String(id) === String(userKey));
  }

  validateKick(actorKey: string, room: string, targetKey: string): KickResult {
    if (!this.isAdmin(actorKey)) return { ok: false, reason: 'ADMIN_ONLY' };
    const target = this.findLeave(room, targetKey);
    if (!target) return { ok: false, reason: 'TARGET_NOT_FOUND' };
    return { ok: true, room, targetUserKey: target.userKey, targetUserName: target.userName };
  }

  logCommand(room: string, actorKey: string, actorName: string, command: string, result: string): void {
    this.config.commandLogs.push({
      at: new Date().toISOString(), room, userKey: actorKey, userName: actorName, command, result,
    });
    if (this.config.commandLogs.length > 5000) {
      this.config.commandLogs.splice(0, this.config.commandLogs.length - 5000);
    }
    saveConfig(this.config);
  }

  leaveText(record: LeaveRecord): string {
    const time = new Intl.DateTimeFormat('ko-KR', {
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(record.at));

    return [
      `${record.userName}님이 나가셨습니다.`,
      '',
      '[전체보기]',
      '',
      `${record.userName} 님이 ${time}에 나가셨습니다.`,
      '나간 사람을 내보내실려면 이 메시지에 답장으로 kick이라고 보내주세요.',
      '[관리자만 가능합니다]',
    ].join('\n');
  }
}
