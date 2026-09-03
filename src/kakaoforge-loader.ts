import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

export interface AuthPayload {
  userId: number;
  accessToken: string;
  refreshToken?: string;
  deviceUuid: string;
  savedAt?: string;
  raw?: unknown;
  authPath?: string;
}

export interface CreateAuthByQROptions {
  authPath?: string;
  deviceUuid?: string;
  deviceName?: string;
  modelName?: string;
  forced?: boolean;
  checkAllowlist?: boolean;
  enforceAllowlist?: boolean;
  appVer?: string;
  onQrUrl?: (url: string) => void;
  onPasscode?: (passcode: string) => void;
  save?: boolean;
}

export interface KakaoForgeModule {
  createAuthByQR(options?: CreateAuthByQROptions): Promise<AuthPayload>;
  createClient(config?: Record<string, unknown>): any;
}

function resolvePackageRoot(): string {
  let dir = process.cwd();
  while (true) {
    const candidate = join(dir, 'node_modules', 'kakaoforge');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    'KakaoForge is not installed. Run "npm install" in loco-termux and retry.'
  );
}

function loadModule(): KakaoForgeModule {
  const packageRoot = resolvePackageRoot();
  const require = createRequire(join(packageRoot, 'package.json'));
  return require(packageRoot) as KakaoForgeModule;
}

export function getKakaoForge(): KakaoForgeModule {
  return loadModule();
}

export async function createAuthByQR(options?: CreateAuthByQROptions): Promise<AuthPayload> {
  return loadModule().createAuthByQR(options);
}

export function createClient(config?: Record<string, unknown>): any {
  return loadModule().createClient(config);
}

export function ensureKakaoForgeInstalled(): void {
  try {
    resolvePackageRoot();
    return;
  } catch {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const result = spawnSync(npm, ['install'], {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: { ...process.env, npm_config_fund: 'false', npm_config_audit: 'false' },
    });
    if (result.status !== 0) {
      throw new Error(`npm install failed with exit code ${result.status ?? 1}`);
    }
  }
  resolvePackageRoot();
}
