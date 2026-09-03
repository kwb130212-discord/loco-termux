import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { openSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DATA = join(homedir(), '.loco-termux');
const AUTH = join(DATA, 'kakaoforge-auth.json');
const PID = join(DATA, 'openchat.pid');
const WANT = join(DATA, 'openchat.desired');
const LOG = join(DATA, 'openchat.log');
const CHILD_ENV = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' };

mkdirSync(DATA, { recursive: true, mode: 0o700 });

class Back extends Error {
  constructor() {
    super('BACK');
  }
}

async function ask(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input, output });
  try {
    const value = (await rl.question(prompt)).trim();
    if (value === '00') throw new Back();
    return value;
  } finally {
    rl.close();
  }
}

function clear(): void {
  process.stdout.write('\x1b[2J\x1b[H\x1b[3J');
}

function pid(): number | null {
  try {
    const value = Number(readFileSync(PID, 'utf8').trim());
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function alive(value: number | null): boolean {
  if (!value) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch {
    return false;
  }
}

function want(): boolean {
  try {
    return readFileSync(WANT, 'utf8').trim() === '1';
  } catch {
    return false;
  }
}

function setWant(value: boolean): void {
  writeFileSync(WANT, value ? '1' : '0', 'utf8');
}

function start(): boolean {
  if (!existsSync(AUTH)) {
    console.log('QR 로그인 필요');
    return false;
  }

  const current = pid();
  if (alive(current)) {
    setWant(true);
    return true;
  }

  const logFd = openSync(LOG, 'a');
  const child = spawn(process.execPath, [
    '--max-old-space-size=384',
    '--max-semi-space-size=16',
    'dist/openchat-main.js',
  ], {
    cwd: process.cwd(),
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: CHILD_ENV,
  });

  if (!child.pid) {
    setWant(false);
    return false;
  }

  setWant(true);
  writeFileSync(PID, String(child.pid), 'utf8');
  child.unref();
  return true;
}

function stop(): boolean {
  setWant(false);
  const current = pid();
  if (!current || !alive(current)) {
    try { unlinkSync(PID); } catch {}
    return true;
  }

  try {
    process.kill(current, 'SIGTERM');
    setTimeout(() => {
      if (alive(current)) {
        try { process.kill(current, 'SIGKILL'); } catch {}
      }
      try { unlinkSync(PID); } catch {}
    }, 1800).unref();
    return true;
  } catch {
    return false;
  }
}

function header(): void {
  clear();
  console.log('╭────────────────────────────────────────────────────────────╮');
  console.log('│ LOCO-TERMUX  /  QR-FIRST BRIDGE                           │');
  console.log('╰────────────────────────────────────────────────────────────╯');
  console.log(`인증: ${existsSync(AUTH) ? 'QR OK' : 'QR 필요'}  런타임: ${alive(pid()) ? 'RUNNING' : want() ? 'CRASHED' : 'STOPPED'}  PID: ${pid() ?? '-'}\n`);
}

async function qr(): Promise<void> {
  header();
  console.log('공식/지원되는 QR 로그인 흐름을 시작합니다.');
  const result = spawnSync('npm', ['run', 'login:qr'], { stdio: 'inherit', env: { ...process.env } });
  if (result.status === 0 && existsSync(AUTH)) {
    console.log('✓ QR 인증 완료');
    start();
  } else {
    console.log('✗ QR 인증 실패');
  }
  await ask('엔터=메뉴 · 00=메인 패널');
}

async function main(): Promise<void> {
  while (true) {
    try {
      header();
      console.log('1. QR 로그인');
      console.log('2. 인증 상태');
      console.log('3. OpenChat 시작');
      console.log('4. OpenChat 정지');
      console.log('5. OpenChat 재시작');
      console.log('6. 로그 보기');
      console.log('0. 종료');

      const choice = await ask('\nLOCO > ');
      if (choice === '1') { await qr(); continue; }
      if (choice === '2') {
        console.log(`인증 파일: ${AUTH}`);
        console.log(`인증: ${existsSync(AUTH) ? 'OK' : '없음'}`);
        await ask('엔터=메뉴 · 00=메인 패널');
        continue;
      }
      if (choice === '3') {
        console.log(start() ? '✓ 시작' : '✗ 시작 실패');
        await ask('엔터=메뉴 · 00=메인 패널');
        continue;
      }
      if (choice === '4') {
        console.log(stop() ? '✓ 정지' : '✗ 정지 실패');
        await ask('엔터=메뉴 · 00=메인 패널');
        continue;
      }
      if (choice === '5') {
        stop();
        setTimeout(() => start(), 800).unref();
        console.log('✓ 재시작 예약');
        await ask('엔터=메뉴 · 00=메인 패널');
        continue;
      }
      if (choice === '6') {
        try {
          const lines = readFileSync(LOG, 'utf8').split(/\r?\n/).filter(Boolean);
          console.log(lines.slice(-100).join('\n') || '(로그 없음)');
        } catch {
          console.log('(로그 없음)');
        }
        await ask('엔터=메뉴 · 00=메인 패널');
        continue;
      }
      if (choice === '0') {
        setWant(false);
        process.exit(0);
      }
    } catch (error) {
      if (error instanceof Back) continue;
      console.error(error);
    }
  }
}

void main();
