import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type DepartedRow = {
  userId: string;
  nickname: string;
  roomId: string;
  roomName: string;
  leftAt: string;
};

const ROOT = join(homedir(), '.loco-termux', 'rooms');

function roomDir(roomId: string): string {
  const safe = String(roomId).replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(ROOT, safe);
}

function readRows(path: string): DepartedRow[] {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(value) ? value : [];
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : '';
    if (code !== 'ENOENT') console.error(`[DEPARTED-DB] ${path} 읽기 실패:`, error instanceof Error ? error.message : String(error));
    return [];
  }
}

function writeRows(path: string, rows: DepartedRow[]): void {
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(rows, null, 2), { encoding: 'utf8', mode: 0o600 });
}

function paths(roomId: string): { current: string; history: string } {
  const dir = roomDir(roomId);
  return { current: join(dir, 'departed.json'), history: join(dir, 'leave-log.json') };
}

export function recordDepartures(roomId: string, roomName: string, ids: Array<string | number>, names: string[]): void {
  if (!ids.length) return;
  const { current, history } = paths(roomId);
  const currentRows = readRows(current);
  const historyRows = readRows(history);
  const now = new Date().toISOString();
  const added: DepartedRow[] = [];
  for (let i = 0; i < ids.length; i += 1) {
    const row: DepartedRow = {
      userId: String(ids[i]),
      nickname: String(names[i] || names[0] || '알 수 없음'),
      roomId: String(roomId),
      roomName,
      leftAt: now,
    };
    const index = currentRows.findIndex((item) => item.userId === row.userId);
    if (index >= 0) currentRows[index] = row;
    else currentRows.push(row);
    added.push(row);
  }
  writeRows(current, currentRows);
  writeRows(history, [...historyRows, ...added].slice(-10000));
}

export function listDeparted(roomId: string): DepartedRow[] {
  return readRows(paths(roomId).current).sort((a, b) => Date.parse(b.leftAt) - Date.parse(a.leftAt));
}

export function listLeaveHistory(roomId: string): DepartedRow[] {
  return readRows(paths(roomId).history).sort((a, b) => Date.parse(b.leftAt) - Date.parse(a.leftAt));
}

export function removeDeparted(roomId: string, userId: string): void {
  const path = paths(roomId).current;
  writeRows(path, readRows(path).filter((row) => row.userId !== String(userId)));
}
