import { existsSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = 'https://github.com/minjaemin2020/KakaoForge.git';
const PINNED = '4b774ea40b1347280fadb685415436584093118b';

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
  authPath?: string; deviceUuid?: string; deviceName?: string; modelName?: string;
  forced?: boolean; checkAllowlist?: boolean; enforceAllowlist?: boolean; appVer?: string;
  onQrUrl?: (url: string) => void; onPasscode?: (passcode: string) => void; save?: boolean;
}

type ForgeModule = {
  createAuthByQR(options?: CreateAuthByQROptions): Promise<AuthPayload>;
  createClient(config?: Record<string, unknown>): any;
  MemberType?: any;
};

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, {
    cwd, stdio: 'inherit', env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false' },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (exit ${result.status ?? 1})`);
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

function ensureBuilt(root: string): void {
  const entry = join(root, 'dist', 'index.js');
  if (existsSync(entry)) return;
  if (!existsSync(join(root, 'src', 'index.ts'))) {
    throw new Error(`KakaoForge ${PINNED.slice(0, 12)} 소스가 없습니다. npm install을 다시 실행하세요.`);
  }
  const config = join(root, 'tsconfig.json');
  if (!existsSync(config)) {
    writeFileSync(config, JSON.stringify({
      compilerOptions: { target: 'ES2020', module: 'CommonJS', moduleResolution: 'Node', rootDir: 'src', outDir: 'dist', declaration: true, esModuleInterop: true, skipLibCheck: true, forceConsistentCasingInFileNames: true, resolveJsonModule: true, strict: false, removeComments: true },
      include: ['src/**/*.ts'],
    }, null, 2) + '\n', 'utf8');
  }
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  console.log('[KakaoForge] dist/index.js 없음 → 설치된 pinned source를 빌드합니다.');
  run(npm, ['install', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'], root);
  run(npm, ['run', 'build'], root);
  if (!existsSync(entry)) throw new Error('KakaoForge 빌드 후 dist/index.js가 없습니다.');
}

export function getKakaoForge(): ForgeModule {
  const root = packageRoot();
  ensureBuilt(root);
  const require = createRequire(join(root, 'package.json'));
  return require(root) as ForgeModule;
}

export const createAuthByQR = (options?: CreateAuthByQROptions): Promise<AuthPayload> => getKakaoForge().createAuthByQR(options);
export const createClient = (config?: Record<string, unknown>): any => getKakaoForge().createClient(config);
export const getMemberType = (): any => getKakaoForge().MemberType;
export const ensureKakaoForgeBuilt = (): void => ensureBuilt(packageRoot());
