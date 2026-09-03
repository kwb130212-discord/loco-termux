import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const KAKAO_FORGE_REPO = 'https://github.com/minjaemin2020/KakaoForge.git';
const KAKAO_FORGE_COMMIT = '4b774ea40b1347280fadb685415436584093118b';

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

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    env: {
      ...process.env,
      npm_config_fund: 'false',
      npm_config_audit: 'false',
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (exit ${result.status ?? 1}).`);
  }
}

function writeBuildConfig(buildRoot: string): void {
  const tsconfigPath = join(buildRoot, 'tsconfig.json');
  if (existsSync(tsconfigPath)) return;
  writeFileSync(
    tsconfigPath,
    JSON.stringify({
      compilerOptions: {
        target: 'ES2020',
        module: 'CommonJS',
        moduleResolution: 'Node',
        rootDir: 'src',
        outDir: 'dist',
        declaration: true,
        esModuleInterop: true,
        skipLibCheck: true,
        forceConsistentCasingInFileNames: true,
        resolveJsonModule: true,
        strict: false,
        removeComments: true,
      },
      include: ['src/**/*.ts'],
    }, null, 2) + '\n',
    'utf8',
  );
}

function clonePinnedSource(buildRoot: string): void {
  if (existsSync(join(buildRoot, 'src', 'index.ts'))) return;
  const parent = dirname(buildRoot);
  mkdirSync(parent, { recursive: true });
  if (existsSync(buildRoot)) rmSync(buildRoot, { recursive: true, force: true });

  console.log('[KakaoForge] source is not bundled by npm; cloning the pinned revision...');
  const git = process.platform === 'win32' ? 'git.exe' : 'git';

  try {
    run(git, ['clone', '--depth', '1', KAKAO_FORGE_REPO, buildRoot], parent);
  } catch {
    if (existsSync(buildRoot)) rmSync(buildRoot, { recursive: true, force: true });
    console.log('[KakaoForge] shallow clone failed; retrying with a full clone...');
    run(git, ['clone', KAKAO_FORGE_REPO, buildRoot], parent);
  }
  run(git, ['checkout', '--detach', KAKAO_FORGE_COMMIT], buildRoot);

  if (!existsSync(join(buildRoot, 'src', 'index.ts')) || !existsSync(join(buildRoot, 'package.json'))) {
    throw new Error('Pinned KakaoForge checkout is incomplete.');
  }
}

function buildKakaoForge(packageRoot: string): void {
  const distEntry = join(packageRoot, 'dist', 'index.js');
  if (existsSync(distEntry)) return;

  const buildRoot = join(dirname(packageRoot), '.kakaoforge-build');
  clonePinnedSource(buildRoot);
  writeBuildConfig(buildRoot);

  console.log('[KakaoForge] building the pinned source outside node_modules...');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  run(npm, ['install', '--include=dev', '--ignore-scripts'], buildRoot);
  run(npm, ['run', 'build'], buildRoot);

  const builtDist = join(buildRoot, 'dist');
  if (!existsSync(join(builtDist, 'index.js'))) {
    throw new Error('KakaoForge build finished but dist/index.js was not produced.');
  }

  const packageDist = join(packageRoot, 'dist');
  if (existsSync(packageDist)) rmSync(packageDist, { recursive: true, force: true });
  mkdirSync(packageRoot, { recursive: true });
  cpSync(builtDist, packageDist, { recursive: true });
  console.log('[KakaoForge] dist/index.js installed into node_modules/kakaoforge.');
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
