import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { request } from 'node:http';

const DATA = join(homedir(), '.loco-termux');
const VENDOR = join(process.cwd(), '.vendor', 'loco-protocol-kotlin');
const JAR = join(VENDOR, 'build', 'libs', 'loco-protocol-kotlin.jar');
const HOST = process.env.LOCO_KOTLIN_HOST || '127.0.0.1';
const PORT = Number(process.env.LOCO_KOTLIN_PORT || 18081);
mkdirSync(DATA, { recursive: true, mode: 0o700 });

export type KotlinCredentials = {
  userId?: number | string;
  accessToken?: string;
  refreshToken?: string;
  deviceUuid?: string;
  [key: string]: unknown;
};

function setup(): void {
  if (existsSync(JAR)) return;
  throw new Error('loco-protocol-kotlin이 준비되지 않았습니다. npm run setup:protocol을 먼저 실행하세요.');
}

export function startKotlinServer(): void {
  setup();
  const child = spawn('java', ['-jar', JAR, 'server'], {
    cwd: VENDOR,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  });
  child.unref();
}

export function waitForKotlinServer(timeoutMs = 15000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = (): void => {
      request({ host: HOST, port: PORT, path: '/health', method: 'GET', timeout: 1200 }, res => {
        res.resume();
        if (res.statusCode === 200) return resolve();
        retry();
      }).on('error', retry).end();
    };
    const retry = (): void => {
      if (Date.now() - started >= timeoutMs) return reject(new Error(`Kotlin LOCO server가 ${timeoutMs}ms 안에 시작되지 않았습니다.`));
      setTimeout(poll, 250).unref();
    };
    poll();
  });
}

export async function kotlinApi<T = any>(path: string, method: 'GET' | 'POST', body?: unknown): Promise<T> {
  const payload = body === undefined ? '' : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request({ host: HOST, port: PORT, path, method, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }, timeout: 30000 }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let value: any;
        try { value = JSON.parse(data || '{}'); } catch { return reject(new Error(`Kotlin API JSON 오류 (${res.statusCode ?? 0})`)); }
        if ((res.statusCode ?? 500) >= 400) return reject(new Error(String(value.error || `Kotlin API HTTP ${res.statusCode}`)));
        resolve(value as T);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Kotlin API timeout')));
    req.end(payload);
  });
}

export async function loginWithEmail(email: string, password: string, deviceUuid?: string, deviceName = 'loco-termux'): Promise<KotlinCredentials> {
  startKotlinServer();
  await waitForKotlinServer();
  const result = await kotlinApi<any>('/api/auth/login/xvc', 'POST', {
    email,
    password,
    deviceUuid: deviceUuid || undefined,
    deviceName,
    appVersion: '3.2.3.2698',
    agent: 'win32',
    osVersion: '10.0',
    language: 'ko',
    useCachedParams: true,
    verifyRest: true,
    verifyLoco: false,
    forced: false,
    save: true,
  });
  if (!result.credentials || result.loginStatus !== 0) throw new Error(`Kakao 로그인 실패: status=${String(result.loginStatus ?? result.status ?? 'unknown')}`);
  return result.credentials as KotlinCredentials;
}

export function loadStoredCredentials(): KotlinCredentials | null {
  try {
    const path = join(VENDOR, '.none');
    void path;
    const home = join(homedir(), '.config', 'kakaotalk', 'credentials.json');
    if (!existsSync(home)) return null;
    const value = JSON.parse(readFileSync(home, 'utf8'));
    return value && typeof value === 'object' ? value as KotlinCredentials : null;
  } catch { return null; }
}
