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

function dbPath(roomId: string): string {
  return join(roomDir(roomId), 'departed.json');
}

function load(roomId: string): DepartedRow[] {
  try {
    const value = JSON.parse(readFileSync(dbPath(roomId), 'utf8'));
    return Array.isArray(value) ? value : [];
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : '';
    if (code !== 'ENOENT') console.error(`[DEPARTED-DB] ${roomId} 읽기 실패:`, error instanceof Error ? error.message : String(error));
    return [];
  }
}

function save(roomId: string, rows: DepartedRow[]): void {
  mkdirSync(roomDir(roomId), { recursive: true, mode: 0o700 });
  writeFileSync(dbPath(roomId), JSON.stringify(rows, null, 2), { encoding: 'utf8', mode: 0o600 });
}

export function recordDepartures(roomId: string, roomName: string, ids: Array<string | number>, names: string[]): void {
  if (!ids.length) return;
  const rows = load(roomId);
  const now = new Date().toISOString();
  for (let i = 0; i < ids.length; i += 1) {
    const userId = String(ids[i]);
    const nickname = String(names[i] || names[0] || '알 수 없음');
    const index = rows.findIndex((row) => row.userId === userId);
    const row: DepartedRow = { userId, nickname, roomId: String(roomId), roomName, leftAt: now };
    if (index >= 0) rows[index] = row;
    else rows.push(row);
  }
  save(roomId, rows);
}

export function listDeparted(roomId: string): DepartedRow[] {
  return load(roomId).sort((a, b) => Date.parse(b.leftAt) - Date.parse(a.leftAt));
}

export function removeDeparted(roomId: string, userId: string): void {
  save(roomId, load(roomId).filter((row) => row.userId !== String(userId)));
}
