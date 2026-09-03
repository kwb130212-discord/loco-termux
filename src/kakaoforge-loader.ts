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
  throw new Error('KakaoForge is not installed. Run "npm install" and retry.');
}

function buildKakaoForge(packageRoot: string): void {
  const distEntry = join(packageRoot, 'dist', 'index.js');
  if (existsSync(distEntry)) return;

  console.log('[KakaoForge] dist/index.js is missing. Building the pinned source checkout...');

  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const env = {
    ...process.env,
    npm_config_fund: 'false',
    npm_config_audit: 'false',
  };

  // Do not invoke the root postinstall recursively. Install only KakaoForge's
  // own dependencies, then compile its checked-out TypeScript source.
  const install = spawnSync(npm, ['install', '--include=dev', '--ignore-scripts'], {
    cwd: packageRoot,
    stdio: 'inherit',
    env,
  });
  if (install.status !== 0) {
    throw new Error(`KakaoForge dependency installation failed (exit ${install.status ?? 1}).`);
  }

  const build = spawnSync(npm, ['run', 'build'], {
    cwd: packageRoot,
    stdio: 'inherit',
    env,
  });
  if (build.status !== 0) {
    throw new Error(`KakaoForge source build failed (exit ${build.status ?? 1}).`);
  }

  if (!existsSync(distEntry)) {
    throw new Error('KakaoForge build finished but dist/index.js was not produced.');
  }
}

function loadModule(): KakaoForgeModule {
  const packageRoot = resolvePackageRoot();
  buildKakaoForge(packageRoot);
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
  const packageRoot = resolvePackageRoot();
  buildKakaoForge(packageRoot);
}
