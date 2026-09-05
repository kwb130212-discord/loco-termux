import { existsSync, mkdirSync, rmSync, cpSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

const REPO = 'https://github.com/minjaemin2020/KakaoForge.git';
const PINNED = '4b774ea40b1347280fadb685415436584093118b';
const DATA_DIR = join(process.env.HOME || homedir(), '.loco-termux');
const BUILD_DIR = join(DATA_DIR, 'kakaoforge-build');

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

type ForgeModule = {
  createAuthByQR(options?: CreateAuthByQROptions): Promise<AuthPayload>;
  createClient(config?: Record<string, unknown>): any;
  MemberType?: any;
};

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    env: {
      ...process.env,
      npm_config_audit: 'false',
      npm_config_fund: 'false',
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (exit ${result.status ?? 1})`);
  }
}

function packageRoot(): string {
  let dir = process.cwd();
  while (true) {
    const candidate = join(dir, 'node_modules', 'kakaoforge');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('KakaoForge가 설치되지 않았습니다. npm install을 먼저 실행하세요.');
}

function clonePinned(): string {
  mkdirSync(dirname(BUILD_DIR), { recursive: true });
  if (existsSync(BUILD_DIR)) rmSync(BUILD_DIR, { recursive: true, force: true });
  const git = process.platform === 'win32' ? 'git.exe' : 'git';
  console.log('[KakaoForge] pinned source를 내려받습니다.');
  run(git, ['clone', '--depth', '1', REPO, BUILD_DIR], dirname(BUILD_DIR));
  run(git, ['fetch', '--depth', '1', 'origin', PINNED], BUILD_DIR);
  run(git, ['checkout', '--detach', PINNED], BUILD_DIR);
  return BUILD_DIR;
}

function ensureBuilt(root: string): void {
  const entry = join(root, 'dist', 'index.js');
  if (existsSync(entry)) return;

  let buildRoot = root;
  if (!existsSync(join(buildRoot, 'src', 'index.ts'))) buildRoot = clonePinned();

  const config = join(buildRoot, 'tsconfig.json');
  if (!existsSync(config)) {
    writeFileSync(
      config,
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

  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  console.log('[KakaoForge] dist/index.js 없음 → pinned source를 빌드합니다.');
  run(npm, ['install', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'], buildRoot);
  run(npm, ['run', 'build'], buildRoot);

  const built = join(buildRoot, 'dist', 'index.js');
  if (!existsSync(built)) throw new Error('KakaoForge 빌드 후 dist/index.js가 생성되지 않았습니다.');

  if (buildRoot !== root) {
    const target = join(root, 'dist');
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    cpSync(join(buildRoot, 'dist'), target, { recursive: true });
  }
}

export function getKakaoForge(): ForgeModule {
  const root = packageRoot();
  ensureBuilt(root);
  const require = createRequire(join(root, 'package.json'));
  return require(root) as ForgeModule;
}

export function getMemberType(): any {
  return getKakaoForge().MemberType;
}

export const createAuthByQR = (options?: CreateAuthByQROptions): Promise<AuthPayload> =>
  getKakaoForge().createAuthByQR(options);

export const createClient = (config?: Record<string, unknown>): any =>
  getKakaoForge().createClient(config);
